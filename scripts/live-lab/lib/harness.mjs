import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { finalizeRunFolder } from './finalize.mjs'
import { CONTROL_FETCH_INTERVAL_MS, createKillSwitch } from './kill-switch.mjs'
import { BUILDS, PRIVACIES, TRIGGERS, canStart } from './policy.mjs'
import {
  StoppedError,
  createEventBus,
  parseScenarioParams,
  resolveScenario,
  runScenarioSteps,
  systemClock
} from './step-engine.mjs'

// Plan 178 U6. One live-lab run, start to finish, with every outside thing
// injected (tests drive it with fakes; run.mjs wires the real ones):
//
//   loadPolicy -> canStart (real state: STOP file, control.json, run lock,
//   on-demand/manual runs today from run manifests, lab quota from the U8
//   ledger) -> acquire the run lock -> run folder + manifest -> kill switch
//   (checked before every step and every 15 s) -> session (launch, seed,
//   observe) -> steps -> teardown -> manifest -> release the lock.
//
// CLI contract (U11 schedule and U13 faults build on it):
//   node scripts/live-lab/run.mjs --scenario <name> --trigger schedule|on-demand|manual
//        [--build release|candidate] [--privacy unlisted|public|private] [--json]
//   exit 0  run completed, no failed step, clean teardown
//   exit 1  run completed with failures, crashed, or teardown was not clean
//   exit 2  refused before going live; prints `REFUSED (<reason>)`
//   exit 3  stopped by a kill switch mid-run, after a clean teardown
//   The last stdout line is `RUN_DIR=<absolute path>` whenever a run folder exists.
//   Scenario params come as a JSON object in VIDEORC_LIVE_LAB_SCENARIO_PARAMS
//   (U11); invalid JSON is exit 2 `REFUSED (bad-scenario-params)`. They reach
//   steps as ctx.params and may size plannedMinutes / estimatedQuotaUnits.

// Plan 179: what an install record's `source` counts as for the policy's
// allowedBuilds. Only a build checked against the public feed (macOS: also
// notarized) is a release. A Linux `file:` AppImage is checked only against a
// hash that sits next to it and a `local-build` against nothing, so both are
// candidates; an owner who allows only releases keeps them off the air.
export function buildKindOf(source) {
  if (source === 'release') return 'release'
  if (source === 'candidate' || source === 'file' || source === 'local-build') return 'candidate'
  return null
}

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2, stopped: 3 })
export const MANIFEST_SCHEMA = 1
export const KILL_SWITCH_TICK_MS = 15_000
// U4 fetches control.json and reloads the policy at this cadence; 45 s plus
// the 15 s tick keeps detection + stream stop inside the 60 s promise.
export const CONTROL_INTERVAL_MS = Math.min(CONTROL_FETCH_INTERVAL_MS, 45_000)
const LIMITED_TRIGGERS = Object.freeze(['on-demand', 'manual'])
const execFileAsync = promisify(execFile)

export class RunRefused extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'RunRefused'
  }
}

export function parseRunArgs(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        scenario: { type: 'string' },
        trigger: { type: 'string' },
        build: { type: 'string' },
        privacy: { type: 'string' },
        json: { type: 'boolean', default: false }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    throw new RunRefused(`usage: ${error.message}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(parsed.scenario ?? '')) {
    throw new RunRefused('usage: --scenario <name> is required')
  }
  if (!TRIGGERS.includes(parsed.trigger)) {
    throw new RunRefused(`usage: --trigger must be one of ${TRIGGERS.join(', ')}`)
  }
  if (parsed.build !== undefined && !BUILDS.includes(parsed.build)) {
    throw new RunRefused(`usage: --build must be one of ${BUILDS.join(', ')}`)
  }
  if (parsed.privacy !== undefined && !PRIVACIES.includes(parsed.privacy)) {
    throw new RunRefused(`usage: --privacy must be one of ${PRIVACIES.join(', ')}`)
  }
  return {
    scenario: parsed.scenario,
    trigger: parsed.trigger,
    build: parsed.build ?? null,
    privacy: parsed.privacy ?? null,
    json: parsed.json
  }
}

export function localDay(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms))
}

export function newRunId({
  nowMs,
  scenario,
  timeZone,
  random = () => randomBytes(3).toString('hex')
}) {
  return `${localDay(nowMs, timeZone)}-${scenario}-${random()}`
}

export function runsDirOf(workDir) {
  return join(workDir, 'runs')
}

/**
 * On-demand and manual runs started on `day` (policy timezone), read from the
 * run manifests (policy.mjs counting rules: scheduled runs do not count). An
 * unreadable manifest counts as a run: a broken folder never frees a slot.
 */
export async function countRunsToday({
  runsDir,
  day,
  timeZone,
  list = readdir,
  read = (path) => readFile(path, 'utf8')
}) {
  let names
  try {
    names = await list(runsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  let count = 0
  for (const name of names) {
    if (!name.startsWith(`${day}-`)) continue
    try {
      const manifest = JSON.parse(await read(join(runsDir, name, 'manifest.json')))
      const started = Date.parse(manifest.startedAt)
      if (
        LIMITED_TRIGGERS.includes(manifest.trigger) &&
        Number.isFinite(started) &&
        localDay(started, timeZone) === day
      ) {
        count += 1
      }
    } catch {
      count += 1
    }
  }
  return count
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function pick(record, keys) {
  if (!record) return null
  return Object.fromEntries(
    keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])
  )
}

/** The run manifest (pure). No secrets, no home paths. */
export function buildManifest({
  runId,
  scenario,
  request,
  privacy,
  install,
  machine,
  policyFile,
  startedAtMs,
  endedAtMs = null,
  outcome = 'running',
  exitCode = null,
  stopReason = null,
  steps = [],
  teardown = null,
  clearedStaleLock = null,
  session = null,
  params = null
}) {
  return {
    schema: MANIFEST_SCHEMA,
    runId,
    scenario: scenario.name,
    trigger: request.trigger,
    privacy,
    destination: scenario.destination,
    plannedMinutes: scenario.plannedMinutes,
    estimatedQuotaUnits: scenario.estimatedQuotaUnits,
    usesBundledClient: scenario.usesBundledClient,
    usesLabYoutubeClient: scenario.usesLabYoutubeClient,
    params: params ?? {},
    build: pick(install, [
      'source',
      'version',
      'sha',
      'ref',
      'runId',
      'teamId',
      'appPath',
      'installedAt'
    ]),
    harness: machine?.harness ?? null,
    macOS: machine?.macOS ?? null,
    ...(machine?.linux ? { linux: machine.linux } : {}),
    hardware: machine?.hardware ?? null,
    policy: policyFile ? { sha256: policyFile.sha256 } : null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
    outcome,
    exitCode,
    stopReason,
    clearedStaleLock: clearedStaleLock
      ? pick(clearedStaleLock, ['runId', 'pid', 'startedAt'])
      : null,
    session,
    steps,
    teardown
  }
}

async function run(exec, command, args) {
  try {
    const { stdout } = await exec(command, args, { timeout: 15_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

// Plan 179: `PRETTY_NAME` from /etc/os-release (pure).
export function osReleaseName(text) {
  const match = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(String(text ?? ''))
  return match ? match[1].trim() || null : null
}

/** Build, OS and hardware facts for the manifest. */
export async function gatherMachineFacts({
  repoRoot,
  exec = execFileAsync,
  platform = process.platform,
  readText = (path) => readFile(path, 'utf8').catch(() => null)
}) {
  if (platform === 'linux') {
    const [commit, status, kernel, osRelease, model] = await Promise.all([
      run(exec, 'git', ['-C', repoRoot, 'rev-parse', 'HEAD']),
      run(exec, 'git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no']),
      run(exec, 'uname', ['-r']),
      readText('/etc/os-release'),
      readText('/sys/class/dmi/id/product_name')
    ])
    return {
      harness: { commit, dirty: status === null ? null : status.length > 0 },
      macOS: null,
      linux: { distro: osReleaseName(osRelease), kernel },
      hardware: {
        model: model?.trim() || null,
        chip: cpus()[0]?.model ?? null,
        memoryBytes: totalmem(),
        logicalCpus: cpus().length
      }
    }
  }
  const [commit, status, productVersion, buildVersion, model, chip, memsize] = await Promise.all([
    run(exec, 'git', ['-C', repoRoot, 'rev-parse', 'HEAD']),
    run(exec, 'git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no']),
    run(exec, 'sw_vers', ['-productVersion']),
    run(exec, 'sw_vers', ['-buildVersion']),
    run(exec, 'sysctl', ['-n', 'hw.model']),
    run(exec, 'sysctl', ['-n', 'machdep.cpu.brand_string']),
    run(exec, 'sysctl', ['-n', 'hw.memsize'])
  ])
  return {
    harness: { commit, dirty: status === null ? null : status.length > 0 },
    macOS: { productVersion, buildVersion },
    hardware: {
      model,
      chip,
      memoryBytes: memsize ? Number(memsize) : totalmem(),
      logicalCpus: cpus().length
    }
  }
}

function outcomeOf({ crashed, stopped, failed }) {
  if (crashed) return 'crashed'
  if (stopped) return 'stopped'
  return failed ? 'fail' : 'pass'
}

/**
 * Runs one scenario. Returns { exitCode, runDir, refusal, manifest }.
 * `deps` (all required unless noted):
 *   clock, workDir, loadPolicy(), readPolicyText(path), readConfig(),
 *   readInstallRecord(), loadScenario(name) -> scenario | null,
 *   scenarioParamsText (optional, the VIDEORC_LIVE_LAB_SCENARIO_PARAMS value),
 *   quotaUnitsToday() (sync), fetchControl(), stopFilePath, stopFileExists(),
 *   readRunLock(), acquireRunLock({ runId }), releaseRunLock({ runId }),
 *   processAlive(pid), machineFacts(), startSession(options) -> session,
 *   createKillSwitch (optional), attachSignals (optional, default false),
 *   out(line) (stdout), random (optional run id suffix)
 */
export async function executeRun({ argv, deps }) {
  const clock = deps.clock ?? systemClock
  const out = deps.out ?? ((line) => console.log(line))
  const refuse = (reason) => {
    out(`REFUSED (${reason})`)
    return { exitCode: EXIT.refused, runDir: null, refusal: reason, manifest: null }
  }

  let request
  try {
    request = parseRunArgs(argv)
  } catch (error) {
    return refuse(error.message)
  }
  let params
  try {
    params = parseScenarioParams(deps.scenarioParamsText)
  } catch {
    return refuse('bad-scenario-params')
  }
  let scenario
  try {
    const defined = await deps.loadScenario(request.scenario)
    if (!defined) return refuse('unknown-scenario')
    scenario = resolveScenario(defined, params)
  } catch (error) {
    return refuse(`bad-scenario: ${error.message}`)
  }

  const loaded = await deps.loadPolicy()
  if (!loaded.policy)
    return refuse(`policy missing or invalid: ${loaded.problems?.[0] ?? 'unknown problem'}`)
  const policy = loaded.policy

  const install = await deps.readInstallRecord()
  if (!install) return refuse('no installed build recorded; run pnpm live:install first')
  const installedKind = buildKindOf(install.source)
  if (!installedKind) return refuse(`installed build has an unknown source ${install.source}`)
  const build = request.build ?? installedKind
  if (request.build && installedKind !== request.build) {
    return refuse(
      `installed build is ${install.source}${installedKind === install.source ? '' : ` (${installedKind})`}, not ${request.build}; run pnpm live:install --build ${request.build}`
    )
  }

  let controlEnabled = null
  try {
    controlEnabled = (await deps.fetchControl()).enabled
  } catch {
    controlEnabled = null
  }
  const holder = await deps.readRunLock()
  const lockHeld =
    holder === null ? false : holder.corrupt ? true : deps.processAlive(holder.pid) ? holder : false
  const startedAtMs = clock.now()
  const day = localDay(startedAtMs, policy.schedule.timezone)
  const state = {
    stopFilePresent: await deps.stopFileExists(),
    controlEnabled,
    lockHeld,
    runsToday: await deps.countRunsToday(day, policy.schedule.timezone),
    quotaUnitsToday: deps.quotaUnitsToday(),
    // No scenario uses the bundled client before U15, which adds its counter.
    bundledUnitsToday: 0
  }
  const verdict = canStart(
    policy,
    {
      trigger: request.trigger,
      scenario: scenario.name,
      build,
      privacy: request.privacy ?? undefined,
      plannedMinutes: scenario.plannedMinutes,
      estimatedQuotaUnits: scenario.estimatedQuotaUnits,
      usesBundledClient: scenario.usesBundledClient
    },
    state
  )
  if (!verdict.ok) return refuse(verdict.reason)
  const privacy = verdict.privacy

  const runId = newRunId({
    nowMs: startedAtMs,
    scenario: scenario.name,
    timeZone: policy.schedule.timezone,
    random: deps.random
  })
  const lock = await deps.acquireRunLock({ runId })
  if (!lock.ok) return refuse(lock.reason)

  const runDir = join(runsDirOf(deps.workDir), runId)
  const bus = createEventBus()
  const abort = new AbortController()
  let killSwitch = null
  let tick = null
  let detachSignals = null
  let session = null
  let result = { results: [], stopped: null, failed: false }
  let crashed = null
  let teardownSummary = null
  let manifest = null
  const policyText = await deps.readPolicyText(loaded.path)
  const base = {
    runId,
    scenario,
    request,
    privacy,
    install,
    policyFile: { sha256: sha256(policyText) },
    startedAtMs,
    params,
    clearedStaleLock: lock.clearedStale ?? null
  }
  const writeManifest = (value) =>
    writeFile(join(runDir, 'manifest.json'), `${JSON.stringify(value, null, 2)}\n`)
  const log = (message) => {
    const line = `[${new Date(clock.now()).toISOString()}] ${message}`
    out(line)
    appendFile(join(runDir, 'run.log'), `${line}\n`).catch(() => {})
  }

  try {
    await mkdir(runDir, { recursive: true })
    base.machine = await deps.machineFacts()
    await writeManifest(buildManifest(base))
    log(
      `Run ${runId}: ${scenario.name}, ${request.trigger}, ${build} ${install.version ?? '?'}, ${privacy}.`
    )

    killSwitch = (deps.createKillSwitch ?? createKillSwitch)({
      policy,
      stopFilePath: deps.stopFilePath,
      fetchControl: deps.fetchControl,
      now: () => clock.now(),
      onStop: (reason) => {
        log(`Kill switch: ${reason}. Ending the stream and tearing down.`)
        abort.abort(new StoppedError(reason))
      },
      run: {
        trigger: request.trigger,
        build,
        privacy,
        plannedMinutes: scenario.plannedMinutes,
        startedAt: startedAtMs
      },
      reloadPolicy: () => deps.loadPolicy(),
      quota: () => ({ quotaUnitsToday: deps.quotaUnitsToday(), bundledUnitsToday: 0 }),
      exists: () => deps.stopFileExists(),
      controlIntervalMs: CONTROL_INTERVAL_MS
    })
    if (deps.attachSignals) detachSignals = killSwitch.attachSignals()
    tick = clock.setInterval(() => {
      killSwitch.check().catch(() => {})
    }, KILL_SWITCH_TICK_MS)
    const first = await killSwitch.check({ force: true })
    if (first.stop) throw new StoppedError(first.reason)

    const runInfo = {
      runId,
      scenario: scenario.name,
      trigger: request.trigger,
      build,
      privacy,
      titlePrefix: policy.titlePrefix,
      startedAt: startedAtMs,
      appVersion: install.version ?? null
    }
    session = await deps.startSession({
      runInfo,
      scenario,
      params,
      policy,
      runDir,
      bus,
      signal: abort.signal,
      log,
      killSwitch
    })
    if (abort.signal.aborted) throw abort.signal.reason
    // The observer (U8, wired by U9) reports a broadcast ended from Studio.
    session.ctx.observer?.attach?.({ onStudioEnded: () => killSwitch.notifyStudioEnded() })

    result = await runScenarioSteps({
      scenario,
      bus,
      clock,
      signal: abort.signal,
      check: () => killSwitch.check(),
      ctx: { ...session.ctx, run: runInfo, params, policy, killSwitch, runDir, log, events: bus },
      onStepStart: ({ index, total, step }) => {
        log(`Step ${index + 1}/${total} ${step.id}`)
        session.ctx.card?.setStep({
          index: index + 1,
          total,
          name: step.title ?? step.id,
          sceneId: step.sceneId ?? 0
        })
      },
      onStepEnd: ({ step, result: stepResult }) => {
        log(
          `Step ${step.id}: ${stepResult.status}${stepResult.reason ? ` (${stepResult.reason})` : ''}`
        )
        appendFile(join(runDir, 'steps.ndjson'), `${JSON.stringify(stepResult)}\n`).catch(() => {})
      }
    })
  } catch (error) {
    if (error instanceof StoppedError || abort.signal.aborted) {
      result = {
        ...result,
        stopped: abort.signal.aborted
          ? (abort.signal.reason?.reason ?? error.message)
          : error.reason
      }
    } else {
      crashed = error
      log(`Run crashed: ${error?.message ?? error}`)
    }
  } finally {
    if (tick !== null) clock.clearInterval(tick)
    detachSignals?.()
    if (session) {
      try {
        teardownSummary = await session.teardown({
          reason: result.stopped ?? (crashed ? 'crashed' : 'done')
        })
      } catch (error) {
        teardownSummary = {
          clean: false,
          steps: [{ name: 'teardown', ok: false, detail: error.message }]
        }
      }
    }
    const stopped = result.stopped ?? null
    const teardownClean = teardownSummary ? teardownSummary.clean : true
    let exitCode
    if (crashed || !teardownClean) exitCode = EXIT.failed
    else if (stopped) exitCode = EXIT.stopped
    else exitCode = result.failed ? EXIT.failed : EXIT.ok
    manifest = buildManifest({
      ...base,
      endedAtMs: clock.now(),
      outcome: outcomeOf({ crashed, stopped, failed: result.failed }),
      exitCode,
      stopReason: stopped,
      steps: result.results,
      teardown: teardownSummary,
      session: session?.summary?.() ?? null
    })
    try {
      await writeManifest(manifest)
    } catch (error) {
      out(`Could not write the manifest: ${error.message}`)
    }
    // Plan 178 U9: verdict.json, report.md and charts for every run, after
    // teardown and before the lock goes. A verdict failure never changes the
    // run's exit code; it is logged and the folder keeps its raw evidence.
    if (deps.finalizeRun !== null) {
      try {
        const { verdict } = await (deps.finalizeRun ?? finalizeRunFolder)({ runDir })
        log(
          `Verdict ${verdict.outcome}: ${verdict.incidents.length} incident(s), ${verdict.needsEyes.length} needs-eyes (report.md).`
        )
      } catch (error) {
        log(`Verdict failed: ${error.message}`)
      }
    }
    const released = await deps.releaseRunLock({ runId })
    if (!released.released) log(`Run lock not released: ${released.reason}`)
    log(`Run ${runId}: ${manifest.outcome} (exit ${exitCode}).`)
    if (request.json) {
      out(
        JSON.stringify({
          runId,
          outcome: manifest.outcome,
          exitCode,
          stopReason: stopped,
          failedSteps: result.results
            .filter((step) => step.status === 'fail' || step.status === 'timeout')
            .map((step) => step.id)
        })
      )
    }
    out(`RUN_DIR=${runDir}`)
    // eslint-disable-next-line no-unsafe-finally
    return { exitCode, runDir, refusal: null, manifest }
  }
}
