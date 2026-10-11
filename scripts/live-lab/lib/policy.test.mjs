import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CONTROL_UNREACHABLE_LIMIT_MS,
  DEFAULT_POLICY_PATH,
  canStart,
  inspectPolicyAccess,
  loadPolicy,
  mustStop,
  policyPath,
  reportsRepoFromKillSwitchUrl,
  validatePolicy
} from './policy.mjs'

const KILL_SWITCH_URL =
  'https://raw.githubusercontent.com/example-org/lab-reports/main/control.json'

export function examplePolicy(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    channelHandle: '@VideorcApp',
    visibility: { default: 'unlisted', allowPublic: false },
    titlePrefix: 'Automated test',
    onDemand: { maxRunMinutes: 60, maxRunsPerDay: 8, allowedBuilds: ['release', 'candidate'] },
    schedule: { enabled: true, timezone: 'Europe/Madrid' },
    quota: { labProjectMaxUnitsPerDay: 8000, bundledClientMaxUnitsPerDay: 0 },
    faults: { network: false, process: true },
    camera: false,
    killSwitchUrl: KILL_SWITCH_URL,
    ...overrides
  }
}

function valid(overrides) {
  const { policy, problems } = validatePolicy(examplePolicy(overrides))
  assert.deepEqual(problems, [])
  return policy
}

function request(overrides = {}) {
  return {
    trigger: 'on-demand',
    scenario: 'first-light',
    build: 'release',
    privacy: 'unlisted',
    plannedMinutes: 20,
    estimatedQuotaUnits: 300,
    usesBundledClient: false,
    ...overrides
  }
}

function state(overrides = {}) {
  return {
    runsToday: 0,
    quotaUnitsToday: 0,
    bundledUnitsToday: 0,
    lockHeld: false,
    controlEnabled: true,
    stopFilePresent: false,
    ...overrides
  }
}

function liveState(overrides = {}) {
  return {
    policyProblems: [],
    interrupted: false,
    stopFilePresent: false,
    studioEnded: false,
    controlEnabled: true,
    controlUnreachableForMs: 0,
    trigger: 'on-demand',
    build: 'release',
    privacy: 'unlisted',
    plannedMinutes: 20,
    elapsedMinutes: 5,
    quotaUnitsToday: 100,
    bundledUnitsToday: 0,
    ...overrides
  }
}

test('policy path defaults to the owner-owned file and honours the test override', () => {
  assert.equal(policyPath({}), DEFAULT_POLICY_PATH)
  assert.equal(DEFAULT_POLICY_PATH, '/Library/Application Support/VideorcLab/policy.json')
  assert.equal(policyPath({ VIDEORC_LIVE_LAB_POLICY: '/tmp/p.json' }), '/tmp/p.json')
})

test('the plan 178 example policy validates and comes back frozen', () => {
  const policy = valid()
  assert.ok(Object.isFrozen(policy))
  assert.ok(Object.isFrozen(policy.onDemand))
  assert.throws(() => {
    policy.onDemand.maxRunsPerDay = 999
  })
})

test('clipPull is optional, false when absent, and must be a boolean when present', () => {
  const absent = validatePolicy(examplePolicy())
  assert.equal(absent.policy.clipPull, false)
  assert.equal(validatePolicy(examplePolicy({ clipPull: true })).policy.clipPull, true)
  const bad = validatePolicy(examplePolicy({ clipPull: 'yes' }))
  assert.equal(bad.policy, null)
  assert.match(bad.problems[0], /clipPull must be true or false/)
})

test('schema v1: each bad field is a named problem, unknown fields are refused', () => {
  const cases = [
    [{ version: 2 }, /version must be 1/],
    [{ enabled: 'yes' }, /enabled must be/],
    [{ channelHandle: 'VideorcApp' }, /channelHandle/],
    [{ titlePrefix: '' }, /titlePrefix/],
    [{ visibility: { default: 'secret', allowPublic: false } }, /visibility.default/],
    [{ visibility: { default: 'public', allowPublic: false } }, /allowPublic is not true/],
    [{ onDemand: { maxRunMinutes: 0, maxRunsPerDay: 8, allowedBuilds: [] } }, /maxRunMinutes/],
    [{ onDemand: { maxRunMinutes: 60, maxRunsPerDay: -1, allowedBuilds: [] } }, /maxRunsPerDay/],
    [
      { onDemand: { maxRunMinutes: 60, maxRunsPerDay: 8, allowedBuilds: ['nightly'] } },
      /allowedBuilds/
    ],
    [{ schedule: { enabled: true, timezone: 'Mars/Olympus' } }, /timezone/],
    [
      { quota: { labProjectMaxUnitsPerDay: 1.5, bundledClientMaxUnitsPerDay: 0 } },
      /labProjectMaxUnitsPerDay/
    ],
    [{ faults: { network: 'no', process: true } }, /faults.network/],
    [{ camera: true }, /camera must be false/],
    [{ killSwitchUrl: 'http://example.com/control.json' }, /https/],
    [
      { killSwitchUrl: 'https://raw.githubusercontent.com/<reports-repo>/main/control.json' },
      /placeholder/
    ],
    [{ killSwitchUrl: 'https://user:pw@example.com/control.json' }, /credentials/],
    [{ maxRunsPerDay: 100 }, /unknown field "maxRunsPerDay"/]
  ]
  for (const [overrides, pattern] of cases) {
    const { policy, problems } = validatePolicy(examplePolicy(overrides))
    assert.equal(policy, null, JSON.stringify(overrides))
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `${JSON.stringify(overrides)}: ${problems}`
    )
  }
  const missing = validatePolicy({ version: 1 })
  assert.ok(missing.problems.some((problem) => problem === 'missing field "enabled"'))
  assert.ok(
    !missing.problems.some((problem) => /enabled must be/.test(problem)),
    'missing is reported once'
  )
  assert.equal(validatePolicy('nope').policy, null)
  assert.equal(validatePolicy(null).policy, null)
})

test('access check: owned by me, group/other writable, access() yes, missing, not a file', () => {
  const base = {
    path: '/Library/Application Support/VideorcLab/policy.json',
    fileStat: { uid: 501, mode: 0o100644, isFile: true },
    dirStat: { uid: 501, mode: 0o40755 },
    uid: 502,
    fileWritable: false,
    dirWritable: false
  }
  assert.deepEqual(inspectPolicyAccess(base), [])
  assert.match(inspectPolicyAccess({ ...base, uid: 501 })[0], /owned by the current user/)
  assert.match(
    inspectPolicyAccess({ ...base, fileStat: { ...base.fileStat, mode: 0o100666 } })[0],
    /0666; it must not be group- or other-writable/
  )
  assert.match(
    inspectPolicyAccess({ ...base, fileStat: { ...base.fileStat, mode: 0o100664 } })[0],
    /0664/
  )
  assert.match(
    inspectPolicyAccess({ ...base, dirStat: { ...base.dirStat, mode: 0o40777 } })[0],
    /VideorcLab is 0777/
  )
  assert.match(
    inspectPolicyAccess({ ...base, fileWritable: true })[0],
    /writable by the current user/
  )
  assert.match(inspectPolicyAccess({ ...base, dirWritable: true })[0], /VideorcLab is writable/)
  assert.match(inspectPolicyAccess({ ...base, fileStat: null })[0], /policy.json is missing/)
  assert.match(inspectPolicyAccess({ ...base, dirStat: null })[0], /VideorcLab is missing/)
  assert.match(
    inspectPolicyAccess({ ...base, fileStat: { ...base.fileStat, isFile: false } })[0],
    /not a regular file/
  )
})

test('loadPolicy refuses a file the current user owns (the real fs, real uid)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-lab-policy-'))
  const path = join(dir, 'policy.json')
  await writeFile(path, JSON.stringify(examplePolicy()))
  await chmod(path, 0o644)
  const mine = await loadPolicy({ path })
  assert.equal(mine.policy, null)
  assert.ok(mine.problems.some((problem) => /owned by the current user/.test(problem)))
  assert.ok(mine.problems.some((problem) => /writable by the current user/.test(problem)))
})

test('loadPolicy with injected stat/access: owner-owned read-only file passes, 0666 and bad JSON fail', async () => {
  const path = '/Library/Application Support/VideorcLab/policy.json'
  const ownerStat = (mode) => async (target) => ({
    uid: 0,
    mode: target === path ? mode : 0o40755,
    isFile: () => target === path
  })
  const denied = async () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
  }
  const good = await loadPolicy({
    path,
    uid: 502,
    stat: ownerStat(0o100644),
    access: denied,
    read: async () => JSON.stringify(examplePolicy())
  })
  assert.deepEqual(good.problems, [])
  assert.equal(good.policy.channelHandle, '@VideorcApp')

  const loose = await loadPolicy({
    path,
    uid: 502,
    stat: ownerStat(0o100666),
    access: async () => undefined,
    read: async () => JSON.stringify(examplePolicy())
  })
  assert.equal(loose.policy, null)
  assert.ok(loose.problems.some((problem) => /0666/.test(problem)))
  assert.ok(loose.problems.some((problem) => /writable by the current user/.test(problem)))

  const broken = await loadPolicy({
    path,
    uid: 502,
    stat: ownerStat(0o100644),
    access: denied,
    read: async () => '{ "version": 1,'
  })
  assert.equal(broken.policy, null)
  assert.match(broken.problems[0], /not valid JSON/)

  const disabledSchema = await loadPolicy({
    path,
    uid: 502,
    stat: ownerStat(0o100644),
    access: denied,
    read: async () => JSON.stringify(examplePolicy({ camera: true }))
  })
  assert.equal(disabledSchema.policy, null)
  assert.match(disabledSchema.problems[0], /camera/)

  const missing = await loadPolicy({
    path,
    uid: 502,
    stat: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    access: denied,
    read: async () => ''
  })
  assert.equal(missing.policy, null)
  assert.match(missing.problems[0], /policy.json is missing/)
})

test('loadPolicy reports a directory the lab user could write even when the file is fine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'live-lab-policy-dir-'))
  const dir = join(root, 'VideorcLab')
  await mkdir(dir)
  await chmod(dir, 0o777)
  const path = join(dir, 'policy.json')
  await writeFile(path, JSON.stringify(examplePolicy()))
  const result = await loadPolicy({ path, uid: 0 })
  assert.equal(result.policy, null)
  assert.ok(
    result.problems.some((problem) => /must not be group- or other-writable \(0755\)/.test(problem))
  )
})

test('canStart allows the example request and resolves the default privacy', () => {
  const policy = valid()
  assert.deepEqual(canStart(policy, request(), state()), {
    ok: true,
    reason: null,
    privacy: 'unlisted'
  })
  assert.equal(canStart(policy, request({ privacy: undefined }), state()).privacy, 'unlisted')
  assert.equal(
    canStart(policy, request({ trigger: 'schedule', plannedMinutes: 480 }), state()).ok,
    true
  )
  assert.equal(canStart(policy, request({ trigger: 'manual' }), state()).ok, true)
})

test('canStart refuses every reason in the plan with a clear string', () => {
  const policy = valid()
  const refusals = [
    [null, request(), state(), /policy missing or invalid/],
    [valid({ enabled: false }), request(), state(), /policy disabled/],
    [policy, request(), state({ stopFilePresent: true }), /STOP file present/],
    [policy, request(), state({ controlEnabled: false }), /control.json says enabled: false/],
    [policy, request(), state({ controlEnabled: null }), /control.json unreachable/],
    [policy, request(), state({ controlEnabled: undefined }), /control.json unreachable/],
    [policy, request(), state({ controlEnabled: 'true' }), /control.json unreachable/],
    [policy, request(), state({ lockHeld: true }), /run lock held/],
    [
      policy,
      request(),
      state({ lockHeld: { runId: '2026-10-12-churn', pid: 4242 } }),
      /run lock held \(2026-10-12-churn, pid 4242\)/
    ],
    [policy, request({ trigger: 'cron' }), state(), /unknown trigger/],
    [
      valid({ schedule: { enabled: false, timezone: 'Europe/Madrid' } }),
      request({ trigger: 'schedule' }),
      state(),
      /schedule disabled/
    ],
    [policy, request({ scenario: '' }), state(), /scenario missing/],
    [policy, request({ build: 'nightly' }), state(), /unknown build/],
    [
      valid({ onDemand: { maxRunMinutes: 60, maxRunsPerDay: 8, allowedBuilds: ['release'] } }),
      request({ build: 'candidate' }),
      state(),
      /build candidate not allowed \(allowedBuilds: release\)/
    ],
    [policy, request({ privacy: 'public' }), state(), /public not allowed/],
    [policy, request({ privacy: 'hidden' }), state(), /unknown privacy/],
    [policy, request({ plannedMinutes: 0 }), state(), /plannedMinutes/],
    [
      policy,
      request({ plannedMinutes: 61 }),
      state(),
      /planned 61 min over onDemand.maxRunMinutes 60/
    ],
    [
      policy,
      request({ trigger: 'manual', plannedMinutes: 90 }),
      state(),
      /over onDemand.maxRunMinutes/
    ],
    [policy, request(), state({ runsToday: 8 }), /daily run count reached \(8 of 8\)/],
    [policy, request(), state({ runsToday: undefined }), /state.runsToday is missing/],
    [policy, request({ estimatedQuotaUnits: -1 }), state(), /estimatedQuotaUnits/],
    [policy, request({ usesBundledClient: 'no' }), state(), /usesBundledClient/],
    [
      policy,
      request(),
      state({ quotaUnitsToday: 7800 }),
      /over lab quota \(7800 used \+ 300 > 8000\)/
    ],
    [policy, request({ usesBundledClient: true }), state(), /bundled client not allowed/],
    [
      valid({ quota: { labProjectMaxUnitsPerDay: 8000, bundledClientMaxUnitsPerDay: 300 } }),
      request({ usesBundledClient: true }),
      state({ bundledUnitsToday: 1 }),
      /over bundled quota \(1 used \+ 300 > 300\)/
    ],
    [policy, request(), state({ quotaUnitsToday: undefined }), /state.quotaUnitsToday is missing/],
    [policy, request(), state({ bundledUnitsToday: null }), /state.bundledUnitsToday is missing/],
    [policy, request(), state({ stopFilePresent: undefined }), /state.stopFilePresent is missing/],
    [policy, request(), state({ lockHeld: undefined }), /state.lockHeld is missing/],
    [policy, request(), state({ lockHeld: null }), /state.lockHeld is missing/],
    [policy, request(), state({ lockHeld: 'yes' }), /state.lockHeld is missing/],
    [policy, null, state(), /request missing/],
    [policy, request(), null, /state missing/]
  ]
  for (const [pol, req, st, pattern] of refusals) {
    const verdict = canStart(pol, req, st)
    assert.equal(verdict.ok, false, `${pattern}`)
    assert.match(verdict.reason, pattern)
  }
})

test('canStart: the lockHeld key must be present (missing state is unsafe)', () => {
  const st = state()
  delete st.lockHeld
  const verdict = canStart(valid(), request(), st)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /state.lockHeld is missing/)
})

test('canStart: a schedule run ignores on-demand minutes and daily count but not quota or builds', () => {
  const policy = valid({
    onDemand: { maxRunMinutes: 10, maxRunsPerDay: 0, allowedBuilds: ['release'] }
  })
  assert.equal(
    canStart(
      policy,
      request({ trigger: 'schedule', plannedMinutes: 480 }),
      state({ runsToday: 50 })
    ).ok,
    true
  )
  assert.match(
    canStart(policy, request({ trigger: 'schedule', build: 'candidate' }), state()).reason,
    /not allowed/
  )
  assert.match(
    canStart(policy, request({ trigger: 'schedule', estimatedQuotaUnits: 9000 }), state()).reason,
    /over lab quota/
  )
  assert.match(
    canStart(policy, request({ plannedMinutes: 5 }), state()).reason,
    /daily run count reached \(0 of 0\)/
  )
})

test('mustStop lets a healthy run continue', () => {
  assert.deepEqual(mustStop(valid(), liveState()), { stop: false, reason: null })
  assert.equal(
    mustStop(valid(), liveState({ trigger: 'schedule', plannedMinutes: 480, elapsedMinutes: 400 }))
      .stop,
    false
  )
  assert.equal(
    mustStop(
      valid(),
      liveState({ controlEnabled: null, controlUnreachableForMs: CONTROL_UNREACHABLE_LIMIT_MS - 1 })
    ).stop,
    false
  )
})

test('mustStop covers every stop condition in the policy section', () => {
  const policy = valid()
  const stops = [
    [null, liveState(), /policy invalid: missing/],
    [
      policy,
      liveState({ policyProblems: ['policy.json is 0666'] }),
      /policy invalid: policy.json is 0666/
    ],
    [valid({ enabled: false }), liveState(), /policy disabled/],
    [policy, liveState({ interrupted: 'SIGINT' }), /interrupted/],
    [policy, liveState({ stopFilePresent: true }), /STOP file present/],
    [policy, liveState({ stopFilePresent: null }), /STOP file state unknown/],
    [
      policy,
      liveState({ studioEnded: true }),
      /ended from YouTube Studio \(incident, no restart\)/
    ],
    [policy, liveState({ controlEnabled: false }), /control.json says enabled: false/],
    [
      policy,
      liveState({ controlEnabled: null, controlUnreachableForMs: CONTROL_UNREACHABLE_LIMIT_MS }),
      /control.json unreachable for 5 min/
    ],
    [
      policy,
      liveState({ controlEnabled: null, controlUnreachableForMs: undefined }),
      /control.json state unknown/
    ],
    [policy, liveState({ trigger: 'cron' }), /unknown trigger/],
    [
      valid({ schedule: { enabled: false, timezone: 'Europe/Madrid' } }),
      liveState({ trigger: 'schedule' }),
      /schedule disabled/
    ],
    [
      valid({ onDemand: { maxRunMinutes: 60, maxRunsPerDay: 8, allowedBuilds: ['release'] } }),
      liveState({ build: 'candidate' }),
      /build "candidate" not allowed/
    ],
    [policy, liveState({ privacy: 'public' }), /public not allowed/],
    [policy, liveState({ privacy: 'hidden' }), /unknown privacy/],
    [policy, liveState({ elapsedMinutes: NaN }), /elapsed time unknown/],
    [policy, liveState({ plannedMinutes: 0 }), /planned minutes unknown/],
    [policy, liveState({ elapsedMinutes: 21 }), /over time \(21 min of 20 allowed\)/],
    [
      policy,
      liveState({ plannedMinutes: 120, elapsedMinutes: 61 }),
      /over time \(61 min of 60 allowed\)/
    ],
    [
      policy,
      liveState({ trigger: 'schedule', plannedMinutes: 480, elapsedMinutes: 481 }),
      /over time \(481 min of 480/
    ],
    [policy, liveState({ quotaUnitsToday: 8001 }), /over lab quota \(8001 > 8000\)/],
    [policy, liveState({ bundledUnitsToday: 1 }), /over bundled quota \(1 > 0\)/],
    [policy, liveState({ quotaUnitsToday: undefined }), /quota state unknown/],
    [policy, null, /run state missing/]
  ]
  for (const [pol, st, pattern] of stops) {
    const verdict = mustStop(pol, st)
    assert.equal(verdict.stop, true, `${pattern}`)
    assert.match(verdict.reason, pattern)
  }
})

test('reportsRepoFromKillSwitchUrl reads owner, repo, ref and path from a raw URL only', () => {
  assert.deepEqual(reportsRepoFromKillSwitchUrl(KILL_SWITCH_URL), {
    owner: 'example-org',
    repo: 'lab-reports',
    ref: 'main',
    path: 'control.json',
    name: 'example-org/lab-reports'
  })
  assert.equal(reportsRepoFromKillSwitchUrl('https://example.com/control.json'), null)
  assert.equal(reportsRepoFromKillSwitchUrl('https://raw.githubusercontent.com/o/r'), null)
  assert.equal(reportsRepoFromKillSwitchUrl('not a url'), null)
})
