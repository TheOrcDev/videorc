import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFakeClock } from './harness-test-fakes.mjs'
import {
  EXIT,
  buildKindOf,
  buildManifest,
  countRunsToday,
  executeRun,
  gatherMachineFacts,
  osReleaseName,
  parseRunArgs,
  sha256
} from './harness.mjs'
import { validatePolicy } from './policy.mjs'
import { examplePolicy } from './policy.test.mjs'
import { createWaitFor, defineScenario } from './step-engine.mjs'
import { teardown } from './teardown.mjs'

const POLICY_TEXT = '{"policy":"bytes"}\n'
const INSTALL = {
  schema: 1,
  source: 'release',
  version: '0.9.142',
  sha: null,
  feedUrl: 'https://www.videorc.com/api/updates',
  teamId: 'C2PA37RB58',
  appPath: '/Applications/Videorc.app',
  installedAt: '2026-10-12T05:00:00.000Z'
}
const MACHINE = {
  harness: { commit: 'abc123', dirty: false },
  macOS: { productVersion: '15.5', buildVersion: '24F74' },
  hardware: { model: 'Mac14,3', chip: 'Apple M2', memoryBytes: 17179869184, logicalCpus: 8 }
}

function policy(overrides) {
  const { policy: validated, problems } = validatePolicy(examplePolicy(overrides))
  assert.deepEqual(problems, [])
  return validated
}

function scenario(steps, overrides = {}) {
  return defineScenario({
    name: 'unit',
    plannedMinutes: 10,
    estimatedQuotaUnits: 0,
    usesBundledClient: false,
    destination: 'local-sink',
    steps,
    ...overrides
  })
}

// A fake remote whose streamStop reaches idle 2 s later on the fake clock.
function fakeRemote({ bus, clock, live = true }) {
  let state = {
    sessionState: live ? 'streaming' : 'idle',
    sessionActive: live,
    layoutPreset: 'screen-only'
  }
  bus.emit('remote.state', state)
  const intents = []
  return {
    intents,
    state: () => state,
    async intent(kind) {
      intents.push({ kind, at: clock.now() })
      if (kind === 'streamStop') {
        clock.setTimeout(() => {
          state = { ...state, sessionState: 'idle', sessionActive: false }
          bus.emit('remote.state', state)
        }, 2000)
      }
      return { accepted: true, ok: true }
    }
  }
}

async function rig({
  workDir,
  clock = createFakeClock(),
  scenarios = {},
  overrides = {},
  session = {}
} = {}) {
  const out = []
  const calls = { startSession: 0, teardown: 0, released: [] }
  let currentPolicy = policy()
  let lock = null
  const events = {}
  const started = new Promise((resolve) => (events.started = resolve))
  const deps = {
    clock,
    workDir,
    out: (line) => out.push(line),
    random: () => 'a1b2c3',
    loadPolicy: async () => ({
      policy: currentPolicy,
      problems: currentPolicy ? [] : ['missing'],
      path: '/policy.json'
    }),
    readPolicyText: async () => POLICY_TEXT,
    readInstallRecord: async () => INSTALL,
    loadScenario: async (name) => scenarios[name] ?? null,
    quotaUnitsToday: () => 0,
    fetchControl: async () => ({ enabled: true }),
    stopFilePath: join(workDir, 'STOP'),
    stopFileExists: async () => false,
    readRunLock: async () => lock,
    acquireRunLock: async ({ runId }) => {
      lock = { pid: process.pid, runId, startedAt: new Date(clock.now()).toISOString() }
      return { ok: true, lock, clearedStale: null }
    },
    releaseRunLock: async ({ runId }) => {
      calls.released.push(runId)
      lock = null
      return { released: true }
    },
    processAlive: () => true,
    countRunsToday: async () => 0,
    machineFacts: async () => MACHINE,
    async startSession({ bus }) {
      calls.startSession += 1
      const remote = fakeRemote({ bus, clock, live: session.live ?? false })
      calls.remote = remote
      events.started()
      return {
        ctx: { remote, card: { setStep: () => {} }, ownedPids: () => ({}) },
        summary: () => ({ appVersion: '0.9.142' }),
        async teardown() {
          calls.teardown += 1
          const result = await teardown({
            remote,
            waitFor: createWaitFor({ bus, clock }),
            quitApp: async () => ({ state: 'terminated' }),
            ledgerPaths: [],
            clock
          })
          calls.teardownDoneAt = clock.now()
          return session.dirtyTeardown ? { ...result, clean: false } : result
        }
      }
    },
    ...overrides
  }
  return {
    deps,
    out,
    calls,
    started,
    setPolicy: (value) => (currentPolicy = value),
    setLock: (value) => (lock = value)
  }
}

async function tmpWork() {
  return mkdtemp(join(tmpdir(), 'videorc-live-run-'))
}

test('parseRunArgs follows the CLI contract', () => {
  assert.deepEqual(parseRunArgs(['--scenario', 'dry', '--trigger', 'manual']), {
    scenario: 'dry',
    trigger: 'manual',
    build: null,
    privacy: null,
    json: false
  })
  assert.throws(
    () => parseRunArgs(['--scenario', 'dry']),
    /--trigger must be one of schedule, on-demand, manual/
  )
  assert.throws(() => parseRunArgs(['--scenario', '../x', '--trigger', 'manual']), /--scenario/)
  assert.throws(
    () => parseRunArgs(['--scenario', 'dry', '--trigger', 'manual', '--build', 'nightly']),
    /--build/
  )
  assert.throws(() => parseRunArgs(['--scenario', 'dry', '--trigger', 'manual', '--fast']), /usage/)
})

test('refusals exit 2 before anything starts and print REFUSED (reason)', async () => {
  const workDir = await tmpWork()
  const dry = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }])
  const cases = [
    { argv: ['--scenario', 'nope', '--trigger', 'manual'], reason: 'unknown-scenario' },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      params: '{bad',
      reason: 'bad-scenario-params'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      params: '[1]',
      reason: 'bad-scenario-params'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      policy: null,
      reason: /^policy missing or invalid/
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      policy: policy({ enabled: false }),
      reason: 'policy disabled (enabled is false)'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: { stopFileExists: async () => true },
      reason: 'STOP file present'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: { fetchControl: async () => ({ enabled: false }) },
      reason: 'control.json says enabled: false'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: {
        fetchControl: async () => {
          throw new Error('offline')
        }
      },
      reason: 'control.json unreachable or unreadable'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      lock: { pid: 4242, runId: 'other', startedAt: 'x' },
      reason: 'run lock held (other, pid 4242)'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: { countRunsToday: async () => 8 },
      reason: 'daily run count reached (8 of 8)'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual', '--privacy', 'public'],
      reason: 'public not allowed (visibility.allowPublic is false)'
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual', '--build', 'candidate'],
      reason: /^installed build is release, not candidate/
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: { readInstallRecord: async () => null },
      reason: /^no installed build recorded/
    },
    {
      argv: ['--scenario', 'unit', '--trigger', 'manual'],
      deps: { acquireRunLock: async () => ({ ok: false, reason: 'raced' }) },
      reason: 'raced'
    }
  ]
  for (const entry of cases) {
    const r = await rig({
      workDir,
      scenarios: { unit: dry },
      overrides: { scenarioParamsText: entry.params, ...entry.deps }
    })
    if ('policy' in entry) r.setPolicy(entry.policy)
    if (entry.lock) r.setLock(entry.lock)
    const result = await executeRun({ argv: entry.argv, deps: r.deps })
    assert.equal(result.exitCode, EXIT.refused, JSON.stringify(entry.reason))
    if (entry.reason instanceof RegExp) assert.match(result.refusal, entry.reason)
    else assert.equal(result.refusal, entry.reason)
    assert.equal(r.out.at(-1), `REFUSED (${result.refusal})`)
    assert.equal(r.calls.startSession, 0)
    assert.equal(result.runDir, null)
  }
  assert.deepEqual(await readdir(workDir), [], 'no run folder for a refusal')
})

test('a clean run exits 0 with a complete manifest and releases the lock', async () => {
  const workDir = await tmpWork()
  const clock = createFakeClock()
  const unit = scenario(
    [
      {
        id: 'one',
        deadlineMs: 1000,
        run: (ctx) => ({ prefix: ctx.run.titlePrefix, params: ctx.params })
      },
      { id: 'two', deadlineMs: 1000, run: () => 'ok' }
    ],
    { plannedMinutes: (params) => params.minutes }
  )
  const r = await rig({
    workDir,
    clock,
    scenarios: { unit },
    overrides: { scenarioParamsText: '{"minutes":7}' }
  })
  const result = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'on-demand', '--json'],
    deps: r.deps
  })
  assert.equal(result.exitCode, EXIT.ok)
  const runId = '2026-10-12-unit-a1b2c3'
  assert.equal(result.runDir, join(workDir, 'runs', runId))
  assert.equal(r.out.at(-1), `RUN_DIR=${result.runDir}`)
  assert.deepEqual(JSON.parse(r.out.at(-2)), {
    runId,
    outcome: 'pass',
    exitCode: 0,
    stopReason: null,
    failedSteps: []
  })
  assert.deepEqual(r.calls.released, [runId])

  const manifest = JSON.parse(await readFile(join(result.runDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.runId, runId)
  assert.equal(manifest.scenario, 'unit')
  assert.equal(manifest.trigger, 'on-demand')
  assert.equal(manifest.privacy, 'unlisted', 'privacy defaults to the policy visibility')
  assert.equal(manifest.plannedMinutes, 7, 'plannedMinutes resolved from params')
  assert.deepEqual(manifest.params, { minutes: 7 })
  assert.deepEqual(manifest.build, {
    source: 'release',
    version: '0.9.142',
    sha: null,
    teamId: 'C2PA37RB58',
    appPath: '/Applications/Videorc.app',
    installedAt: '2026-10-12T05:00:00.000Z'
  })
  assert.deepEqual(manifest.harness, MACHINE.harness)
  assert.deepEqual(manifest.macOS, MACHINE.macOS)
  assert.deepEqual(manifest.hardware, MACHINE.hardware)
  assert.deepEqual(manifest.policy, { sha256: sha256(POLICY_TEXT) })
  assert.equal(manifest.outcome, 'pass')
  assert.equal(manifest.exitCode, 0)
  assert.deepEqual(
    manifest.steps.map((step) => step.status),
    ['pass', 'pass']
  )
  assert.deepEqual(manifest.steps[0].evidence, { prefix: 'Automated test', params: { minutes: 7 } })
  assert.equal(manifest.teardown.clean, true)
  assert.deepEqual(manifest.session, { appVersion: '0.9.142' })
  assert.ok(!JSON.stringify(manifest).includes(workDir), 'the manifest holds no local paths')
  const steps = (await readFile(join(result.runDir, 'steps.ndjson'), 'utf8')).trim().split('\n')
  assert.equal(steps.length, 2)
})

test('a failed step exits 1; a dirty teardown exits 1', async () => {
  const workDir = await tmpWork()
  const failing = scenario([
    {
      id: 'one',
      deadlineMs: 1000,
      run: () => {
        throw new Error('dialog missing')
      }
    }
  ])
  const r = await rig({ workDir, scenarios: { unit: failing } })
  const result = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'manual'],
    deps: r.deps
  })
  assert.equal(result.exitCode, EXIT.failed)
  assert.equal(result.manifest.outcome, 'fail')
  assert.equal(r.calls.teardown, 1)

  const passing = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }])
  const dirty = await rig({
    workDir: await tmpWork(),
    scenarios: { unit: passing },
    session: { dirtyTeardown: true }
  })
  const second = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'manual'],
    deps: dirty.deps
  })
  assert.equal(second.exitCode, EXIT.failed)
})

test('a session that fails to start is a crash (exit 1) and still writes the manifest', async () => {
  const workDir = await tmpWork()
  const unit = scenario([{ id: 'one', deadlineMs: 1000, run: () => 1 }])
  const r = await rig({
    workDir,
    scenarios: { unit },
    overrides: {
      startSession: async () => {
        throw new Error('The lab display "Lab" is not connected.')
      }
    }
  })
  const result = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'schedule'],
    deps: r.deps
  })
  assert.equal(result.exitCode, EXIT.failed)
  assert.equal(result.manifest.outcome, 'crashed')
  assert.equal(r.out.at(-1), `RUN_DIR=${result.runDir}`)
  const log = await readFile(join(result.runDir, 'run.log'), 'utf8')
  assert.match(log, /Run crashed: The lab display "Lab" is not connected\./)
})

test('a policy flip to enabled:false mid-run ends the stream and tears down within 60 s', async () => {
  const workDir = await tmpWork()
  const clock = createFakeClock()
  const live = scenario([
    {
      id: 'live',
      deadlineMs: 600_000,
      run: (ctx) => ctx.waitFor(() => false, { deadlineMs: 600_000, label: 'forever' })
    },
    { id: 'after', deadlineMs: 1000, run: () => 1 }
  ])
  const r = await rig({ workDir, clock, scenarios: { unit: live }, session: { live: true } })
  const promise = executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'on-demand'],
    deps: r.deps
  })
  await r.started
  await clock.advance(1000)
  const flippedAt = clock.now()
  r.setPolicy(policy({ enabled: false }))
  for (let index = 0; index < 120 && r.calls.teardownDoneAt === undefined; index += 1) {
    await clock.advance(1000)
  }
  const result = await promise
  assert.equal(result.exitCode, EXIT.stopped)
  assert.equal(result.manifest.outcome, 'stopped')
  assert.equal(result.manifest.stopReason, 'policy disabled (enabled is false)')
  assert.deepEqual(
    result.manifest.steps.map((step) => step.status),
    ['stopped', 'skipped']
  )
  const stop = r.calls.remote.intents.find((intent) => intent.kind === 'streamStop')
  assert.ok(stop, 'teardown sent streamStop')
  assert.ok(
    r.calls.teardownDoneAt - flippedAt <= 60_000,
    `teardown done ${r.calls.teardownDoneAt - flippedAt} ms after the flip`
  )
  assert.equal(r.calls.remote.state().sessionState, 'idle')
  assert.equal(result.manifest.teardown.clean, true)
  assert.ok(result.manifest.teardown.streamEndedMs <= 5000)
})

test('a STOP file mid-run stops at the next 15 s tick', async () => {
  const workDir = await tmpWork()
  const clock = createFakeClock()
  let stopFile = false
  const live = scenario([
    {
      id: 'live',
      deadlineMs: 600_000,
      run: (ctx) => ctx.waitFor(() => false, { deadlineMs: 600_000 })
    }
  ])
  const r = await rig({
    workDir,
    clock,
    scenarios: { unit: live },
    session: { live: true },
    overrides: { stopFileExists: async () => stopFile }
  })
  const promise = executeRun({ argv: ['--scenario', 'unit', '--trigger', 'manual'], deps: r.deps })
  await r.started
  stopFile = true
  const placedAt = clock.now()
  for (let index = 0; index < 60 && r.calls.teardownDoneAt === undefined; index += 1)
    await clock.advance(1000)
  const result = await promise
  assert.equal(result.exitCode, EXIT.stopped)
  assert.equal(result.manifest.stopReason, 'STOP file present')
  assert.ok(r.calls.teardownDoneAt - placedAt <= 20_000)
})

test('countRunsToday counts on-demand and manual manifests of the policy day', async () => {
  const runsDir = join(await tmpWork(), 'runs')
  const write = async (name, manifest) => {
    await mkdir(join(runsDir, name), { recursive: true })
    await writeFile(
      join(runsDir, name, 'manifest.json'),
      manifest === null ? '{broken' : JSON.stringify(manifest)
    )
  }
  await write('2026-10-12-dry-aaaaaa', { trigger: 'manual', startedAt: '2026-10-12T08:00:00.000Z' })
  await write('2026-10-12-dry-bbbbbb', {
    trigger: 'on-demand',
    startedAt: '2026-10-12T09:00:00.000Z'
  })
  await write('2026-10-12-churn-cccccc', {
    trigger: 'schedule',
    startedAt: '2026-10-12T02:30:00.000Z'
  })
  await write('2026-10-12-dry-dddddd', null)
  await write('2026-10-11-dry-eeeeee', { trigger: 'manual', startedAt: '2026-10-11T08:00:00.000Z' })
  assert.equal(await countRunsToday({ runsDir, day: '2026-10-12', timeZone: 'Europe/Madrid' }), 3)
  assert.equal(
    await countRunsToday({
      runsDir: join(runsDir, 'none'),
      day: '2026-10-12',
      timeZone: 'Europe/Madrid'
    }),
    0
  )
})

test('buildManifest keeps only allowlisted build fields', () => {
  const manifest = buildManifest({
    runId: 'r',
    scenario: scenario([{ id: 'one', deadlineMs: 1, run() {} }]),
    request: { trigger: 'manual' },
    privacy: 'unlisted',
    install: {
      ...INSTALL,
      feedUrl: 'https://example.invalid/secret-feed',
      previous: { version: '0.9.141' }
    },
    machine: MACHINE,
    policyFile: { sha256: 'x' },
    startedAtMs: 0
  })
  assert.equal(manifest.build.feedUrl, undefined)
  assert.equal(manifest.build.previous, undefined)
  assert.equal(manifest.outcome, 'running')
})

test('every run ends with verdict.json and report.md in the run folder (plan 178 U9)', async () => {
  const workDir = await tmpWork()
  const clock = createFakeClock()
  const unit = scenario([{ id: 'one', deadlineMs: 1000, run: () => 'ok' }])
  const r = await rig({ workDir, clock, scenarios: { unit } })
  const result = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'manual'],
    deps: r.deps
  })
  assert.equal(result.exitCode, EXIT.ok)
  const verdict = JSON.parse(await readFile(join(result.runDir, 'verdict.json'), 'utf8'))
  assert.equal(verdict.schema, 1)
  assert.equal(verdict.runId, '2026-10-12-unit-a1b2c3')
  assert.equal(verdict.outcome, 'pass')
  assert.equal(verdict.thresholdsMode, 'report')
  const report = await readFile(join(result.runDir, 'report.md'), 'utf8')
  assert.match(report, /Outcome: PASS/)
  assert.ok(r.out.some((line) => /Verdict pass/.test(line)))
  // The verdict is written before the lock is released and never changes the exit code.
  const broken = await rig({
    workDir,
    clock,
    scenarios: { unit },
    overrides: {
      random: () => 'b2c3d4',
      finalizeRun: async () => {
        throw new Error('verdict exploded')
      }
    }
  })
  const second = await executeRun({
    argv: ['--scenario', 'unit', '--trigger', 'manual'],
    deps: broken.deps
  })
  assert.equal(second.exitCode, EXIT.ok)
  assert.ok(broken.out.some((line) => /Verdict failed: verdict exploded/.test(line)))
})

test('plan 179: Linux install sources count as candidates for the policy', () => {
  assert.equal(buildKindOf('release'), 'release')
  assert.equal(buildKindOf('candidate'), 'candidate')
  assert.equal(buildKindOf('file'), 'candidate')
  assert.equal(buildKindOf('local-build'), 'candidate')
  assert.equal(buildKindOf('unknown'), null)
})

test('plan 179: Linux machine facts name the distro and kernel, never macOS', async () => {
  const exec = async (command, args) => {
    if (command === 'uname') return { stdout: '6.17.1-arch1-1\n' }
    if (command === 'git') return { stdout: args.includes('rev-parse') ? 'abc123\n' : '' }
    throw new Error(`unexpected ${command}`)
  }
  const facts = await gatherMachineFacts({
    repoRoot: '/r',
    exec,
    platform: 'linux',
    readText: async (path) =>
      path === '/etc/os-release'
        ? 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\n'
        : 'MacBookPro16,1\n'
  })
  assert.deepEqual(facts.harness, { commit: 'abc123', dirty: false })
  assert.equal(facts.macOS, null)
  assert.deepEqual(facts.linux, { distro: 'Arch Linux', kernel: '6.17.1-arch1-1' })
  assert.equal(facts.hardware.model, 'MacBookPro16,1')
  assert.equal(osReleaseName('PRETTY_NAME=Ubuntu 24.04.3 LTS\n'), 'Ubuntu 24.04.3 LTS')
})
