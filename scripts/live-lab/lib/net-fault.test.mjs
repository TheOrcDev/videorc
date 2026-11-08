import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { FAIL, PASS, SKIP, WARN, evaluateNetFaultsClean } from './doctor-checks.mjs'
import {
  ALLOWED_COMMANDS,
  DN_PIPE,
  MAX_FAULT_MS,
  PF_ANCHOR,
  PF_ANCHOR_FILE,
  WATCHDOG_GRACE_S,
  allowedCommandLines,
  applyNetFault,
  cleanupCommandLines,
  createNetFaultRegistry,
  labPipeLines,
  netFaultResidue,
  parseSudoersCommandLines,
  pfConfHooksAnchor,
  removeNetFaults,
  sudoRefused,
  watchdogScript
} from './net-fault.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUDOERS_EXAMPLE = join(
  HERE,
  '..',
  '..',
  '..',
  'config',
  'live-lab',
  'sudoers.live-lab.example'
)
const PF_ANCHOR_EXAMPLE = join(HERE, '..', '..', '..', 'config', 'live-lab', 'pf.anchor.example')

// The pf/dnctl tests pin macOS: CI runs this file on Linux, where the
// default platform would pick the plan 179 backend.
const MAC = 'darwin'

const ALLOWED_LINES = new Set(allowedCommandLines())

function lineOf({ command, args }) {
  return [command, ...args].join(' ')
}

// A pf/dummynet stand-in: remembers what is loaded and answers the read-backs
// the way the real tools print them. Every call is asserted to be an allowed
// command line, so no test can sneak a new sudo command past the sudoers file.
function fakeSystem({ refuse = false, failOn = null } = {}) {
  const state = { rules: '', pipe: '', calls: [] }
  const runner = async (entry) => {
    const line = lineOf(entry)
    assert.ok(ALLOWED_LINES.has(line), `runner got a command outside the allowlist: ${line}`)
    state.calls.push(line)
    if (refuse) return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
    if (failOn && line === lineOf(ALLOWED_COMMANDS[failOn])) {
      return { code: 1, stdout: '', stderr: 'pfctl: boom' }
    }
    switch (line) {
      case lineOf(ALLOWED_COMMANDS.pfLoadAnchor):
        state.rules = `dummynet out quick proto tcp from any to <videorc_lab_ingest> port = 443 pipe ${DN_PIPE}\ndummynet out quick proto tcp from any to <videorc_lab_ingest> port = 1935 pipe ${DN_PIPE}\n`
        return { code: 0, stdout: '', stderr: '' }
      case lineOf(ALLOWED_COMMANDS.pfFlushAnchor):
        state.rules = ''
        return { code: 0, stdout: '', stderr: 'rules cleared\n' }
      case lineOf(ALLOWED_COMMANDS.pfShowAnchorRules):
        return { code: 0, stdout: state.rules, stderr: '' }
      case lineOf(ALLOWED_COMMANDS.pfShowIngestTable):
        return {
          code: 0,
          stdout: state.rules ? '   142.250.1.1\n   142.250.1.2\n' : '',
          stderr: ''
        }
      case lineOf(ALLOWED_COMMANDS.pfEnable):
        return { code: 0, stdout: 'Token : 1234\n', stderr: 'pf enabled\n' }
      case lineOf(ALLOWED_COMMANDS.dnPipeLoss):
        state.pipe = `0${DN_PIPE}: unlimited    0 ms   50 sl.plr 1.000000 0 queues (1 buckets) droptail\n`
        return { code: 0, stdout: '', stderr: '' }
      case lineOf(ALLOWED_COMMANDS.dnPipeThrottle):
        state.pipe = `0${DN_PIPE}:   1.000 Mbit/s    0 ms   50 sl. 0 queues (1 buckets) droptail\n`
        return { code: 0, stdout: '', stderr: '' }
      case lineOf(ALLOWED_COMMANDS.dnPipeDelete): {
        const existed = state.pipe !== ''
        state.pipe = ''
        return existed
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'dnctl: pipe delete: No such process' }
      }
      case lineOf(ALLOWED_COMMANDS.dnList):
        return { code: 0, stdout: `00001: 100.000 Mbit/s 0 ms 50 sl.\n${state.pipe}`, stderr: '' }
      default:
        return { code: 0, stdout: '', stderr: '' }
    }
  }
  return { state, runner }
}

function fakeClock(start = 1_000_000) {
  const timers = []
  const killed = []
  const spawned = []
  return {
    now: () => start,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      handle.cleared = true
    },
    kill: (pid, signal) => {
      killed.push({ pid, signal })
    },
    spawnWatchdog: (script) => {
      spawned.push(script)
      return 4242
    },
    resolve: async () => ['142.250.1.1', '142.250.1.2'],
    timers,
    killed,
    spawned
  }
}

test('sudoers example allows exactly the commands the code can run', async () => {
  const text = await readFile(SUDOERS_EXAMPLE, 'utf8')
  const inSudoers = parseSudoersCommandLines(text)
  assert.deepEqual([...inSudoers].sort(), [...ALLOWED_LINES].sort())
  assert.ok(!/\*/.test(inSudoers.join('\n')), 'no wildcard in any allowed command')
  assert.match(text, /videorc-lab ALL=\(root\) NOPASSWD: LIVE_LAB_FAULTS/)
  // The anchor file sudoers names is the one the code loads, with its space.
  assert.ok(inSudoers.includes(lineOf(ALLOWED_COMMANDS.pfLoadAnchor)))
  assert.ok(ALLOWED_COMMANDS.pfLoadAnchor.args.includes(PF_ANCHOR_FILE))
})

test('pf anchor example names the lab pipe and only the ingest table on 443/1935', async () => {
  const text = await readFile(PF_ANCHOR_EXAMPLE, 'utf8')
  const rules = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  assert.equal(rules.length, 2)
  assert.match(rules[0], /^table <videorc_lab_ingest> \{ a\.rtmps\.youtube\.com, /)
  assert.equal(
    rules[1],
    `dummynet out quick proto tcp from any to <videorc_lab_ingest> port { 443, 1935 } pipe ${DN_PIPE}`
  )
})

test('parseSudoersCommandLines handles continuations, escaped spaces and comments', () => {
  const lines = parseSudoersCommandLines(
    '# c\nCmnd_Alias X = \\\n  /a/b -x, \\\n  /c/d\\ e -y\n\nuser ALL=(root) NOPASSWD: X\n'
  )
  assert.deepEqual(lines, ['/a/b -x', '/c/d e -y'])
})

test('watchdog script waits past the deadline, then runs only allowed cleanup lines', () => {
  const script = watchdogScript(30_000)
  assert.equal(
    script,
    `sleep ${30 + WATCHDOG_GRACE_S}; sudo -n ${lineOf(ALLOWED_COMMANDS.pfFlushAnchor)}; sudo -n ${lineOf(ALLOWED_COMMANDS.dnPipeDelete)}; exit 0`
  )
  for (const part of script.split(';').filter((p) => p.includes('sudo -n'))) {
    assert.ok(ALLOWED_LINES.has(part.trim().replace(/^sudo -n /, '')))
  }
  assert.equal(
    watchdogScript(1),
    `sleep ${1 + WATCHDOG_GRACE_S}; ${script.split('; ').slice(1).join('; ')}`
  )
})

test('applyNetFault: clean slate, watchdog first, pipe then anchor, deadline timer', async () => {
  const sys = fakeSystem()
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  const watchdogs = []
  const logs = []
  const handle = await applyNetFault({
    platform: MAC,
    kind: 'loss',
    durationMs: 30_000,
    runner: sys.runner,
    registry,
    ...clock,
    onWatchdog: (entry) => watchdogs.push(entry),
    log: (line) => logs.push(line)
  })
  assert.deepEqual(sys.state.calls, [
    lineOf(ALLOWED_COMMANDS.pfFlushAnchor),
    lineOf(ALLOWED_COMMANDS.dnPipeDelete),
    lineOf(ALLOWED_COMMANDS.pfShowAnchorRules),
    lineOf(ALLOWED_COMMANDS.dnList),
    lineOf(ALLOWED_COMMANDS.pfEnable),
    lineOf(ALLOWED_COMMANDS.dnPipeLoss),
    lineOf(ALLOWED_COMMANDS.pfLoadAnchor),
    lineOf(ALLOWED_COMMANDS.pfShowAnchorRules),
    lineOf(ALLOWED_COMMANDS.pfShowIngestTable)
  ])
  assert.equal(clock.spawned.length, 1)
  assert.equal(clock.spawned[0], watchdogScript(30_000))
  assert.deepEqual(watchdogs, [
    { pid: 4242, label: 'live-lab-net-fault-watchdog', deadlineAt: 1_030_000 }
  ])
  assert.equal(handle.kind, 'loss')
  assert.equal(handle.startedAt, 1_000_000)
  assert.equal(handle.deadlineAt, 1_030_000)
  assert.equal(handle.watchdogPid, 4242)
  assert.equal(handle.rules.length, 2)
  assert.deepEqual(handle.ingest.missing, [])
  assert.equal(clock.timers.length, 1)
  assert.equal(clock.timers[0].ms, 30_000)
  assert.deepEqual(registry.active, {
    kind: 'loss',
    startedAt: 1_000_000,
    deadlineAt: 1_030_000,
    watchdogPid: 4242
  })
  assert.ok(sys.state.rules.includes(`pipe ${DN_PIPE}`))
  assert.ok(logs.some((line) => line.includes('loss installed for 30000 ms')))

  // The deadline timer removes everything and kills the watchdog group.
  sys.state.calls.length = 0
  clock.timers[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sys.state.rules, '')
  assert.equal(sys.state.pipe, '')
  assert.deepEqual(clock.killed, [{ pid: -4242, signal: 'SIGTERM' }])
  assert.equal(registry.active, null)
  assert.equal(registry.watchdogs.size, 0)
  assert.ok(sys.state.calls.includes(lineOf(ALLOWED_COMMANDS.pfFlushAnchor)))
  assert.ok(sys.state.calls.includes(lineOf(ALLOWED_COMMANDS.dnPipeDelete)))
})

test('applyNetFault throttle uses the one allowed bandwidth', async () => {
  const sys = fakeSystem()
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  await applyNetFault({
    platform: MAC,
    kind: 'throttle',
    durationMs: 30_000,
    kbps: 1000,
    runner: sys.runner,
    registry,
    ...clock
  })
  assert.ok(sys.state.calls.includes(lineOf(ALLOWED_COMMANDS.dnPipeThrottle)))
  assert.ok(!sys.state.calls.includes(lineOf(ALLOWED_COMMANDS.dnPipeLoss)))
  await assert.rejects(
    applyNetFault({
      platform: MAC,
      kind: 'throttle',
      durationMs: 1_000,
      kbps: 500,
      runner: sys.runner,
      registry: createNetFaultRegistry(),
      ...clock
    }),
    /only 1000 kbps/
  )
})

test('applyNetFault refuses bad requests before running anything', async () => {
  const sys = fakeSystem()
  const clock = fakeClock()
  for (const request of [
    { kind: 'jitter', durationMs: 1_000 },
    { kind: 'loss', durationMs: 0 },
    { kind: 'loss', durationMs: MAX_FAULT_MS + 1 },
    { kind: 'loss', durationMs: Number.NaN }
  ]) {
    await assert.rejects(
      applyNetFault({
        platform: MAC,
        ...request,
        runner: sys.runner,
        registry: createNetFaultRegistry(),
        ...clock
      }),
      /net-fault: (kind|durationMs)/
    )
  }
  assert.deepEqual(sys.state.calls, [])
  assert.deepEqual(clock.spawned, [])
})

test('applyNetFault refuses a second fault while one is active', async () => {
  const sys = fakeSystem()
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  await applyNetFault({
    platform: MAC,
    kind: 'loss',
    durationMs: 5_000,
    runner: sys.runner,
    registry,
    ...clock
  })
  await assert.rejects(
    applyNetFault({
      platform: MAC,
      kind: 'loss',
      durationMs: 5_000,
      runner: sys.runner,
      registry,
      ...clock
    }),
    /already installed/
  )
})

test('applyNetFault: sudo refused stops at the first command, nothing spawned', async () => {
  const sys = fakeSystem({ refuse: true })
  const clock = fakeClock()
  await assert.rejects(
    applyNetFault({
      platform: MAC,
      kind: 'loss',
      durationMs: 5_000,
      runner: sys.runner,
      registry: createNetFaultRegistry(),
      ...clock
    }),
    (error) => error.code === 'SUDO_REFUSED' && /sudoers\.live-lab\.example/.test(error.message)
  )
  assert.deepEqual(sys.state.calls, [lineOf(ALLOWED_COMMANDS.pfFlushAnchor)])
  assert.deepEqual(clock.spawned, [])
  assert.deepEqual(clock.timers, [])
})

test('applyNetFault: a failed anchor load removes the pipe and kills the watchdog', async () => {
  const sys = fakeSystem({ failOn: 'pfLoadAnchor' })
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  await assert.rejects(
    applyNetFault({
      platform: MAC,
      kind: 'loss',
      durationMs: 5_000,
      runner: sys.runner,
      registry,
      ...clock
    }),
    /anchor load exit 1: pfctl: boom/
  )
  assert.equal(sys.state.pipe, '')
  assert.equal(sys.state.rules, '')
  assert.deepEqual(clock.killed, [{ pid: -4242, signal: 'SIGTERM' }])
  assert.equal(registry.active, null)
  assert.equal(registry.watchdogs.size, 0)
  assert.deepEqual(clock.timers, [])
})

test('removeNetFaults is idempotent and tolerates a watchdog that already exited', async () => {
  const sys = fakeSystem()
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  const handle = await applyNetFault({
    platform: MAC,
    kind: 'loss',
    durationMs: 5_000,
    runner: sys.runner,
    registry,
    ...clock
  })
  const first = await handle.remove()
  assert.deepEqual(first.killedWatchdogs, [4242])
  assert.ok(clock.timers[0].cleared)
  const second = await removeNetFaults({
    platform: MAC,
    runner: sys.runner,
    registry,
    kill: clock.kill,
    clearTimer: clock.clearTimer
  })
  assert.deepEqual(second.killedWatchdogs, [])
  assert.deepEqual(second.residue, { rules: [], pipes: [] })
  assert.equal(clock.killed.length, 1)

  // A watchdog gone by the time we kill it (ESRCH) is not an error.
  registry.watchdogs.set(777, { kind: 'loss', deadlineAt: 0 })
  const gone = await removeNetFaults({
    platform: MAC,
    runner: sys.runner,
    registry,
    kill: () => {
      const error = new Error('gone')
      error.code = 'ESRCH'
      throw error
    }
  })
  assert.deepEqual(gone.killedWatchdogs, [])
  assert.equal(registry.watchdogs.size, 0)
})

test('removeNetFaults throws when the read-back still shows the lab rule or pipe', async () => {
  const stuck = async (entry) => {
    const line = lineOf(entry)
    assert.ok(ALLOWED_LINES.has(line))
    if (line === lineOf(ALLOWED_COMMANDS.pfShowAnchorRules)) {
      return {
        code: 0,
        stdout: `dummynet out proto tcp from any to any pipe ${DN_PIPE}\n`,
        stderr: ''
      }
    }
    if (line === lineOf(ALLOWED_COMMANDS.dnList)) {
      return { code: 0, stdout: `0${DN_PIPE}: unlimited 0 ms 50 sl.plr 1.000000\n`, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    removeNetFaults({
      platform: MAC,
      runner: stuck,
      registry: createNetFaultRegistry(),
      kill: () => {}
    }),
    (error) =>
      error.code === 'NET_FAULT_RESIDUE' &&
      error.residue.rules.length === 1 &&
      error.residue.pipes.length === 1 &&
      cleanupCommandLines().every((line) => error.message.includes(line))
  )
})

test('residue parsing: only the lab pipe number and real rule lines count', () => {
  assert.deepEqual(labPipeLines(`00001: 1 Mbit/s\n0${DN_PIPE}: x\n1${DN_PIPE}: y\n`), [
    `0${DN_PIPE}: x`
  ])
  assert.deepEqual(labPipeLines(''), [])
  assert.deepEqual(netFaultResidue({ pfRules: '\n# comment\n  \n', dnctlList: '' }), {
    rules: [],
    pipes: []
  })
  assert.equal(sudoRefused({ code: 1, stdout: '', stderr: 'sudo: a password is required' }), true)
  assert.equal(sudoRefused({ code: 1, stdout: '', stderr: 'pfctl: boom' }), false)
  assert.equal(sudoRefused({ code: 0, stdout: '', stderr: '' }), false)
})

test('pfConfHooksAnchor needs both the dummynet-anchor and the anchor line', () => {
  assert.deepEqual(pfConfHooksAnchor(`anchor "com.apple/*"\n`), {
    dummynetAnchor: false,
    anchor: false
  })
  assert.deepEqual(pfConfHooksAnchor(`dummynet-anchor "${PF_ANCHOR}"\nanchor "${PF_ANCHOR}"\n`), {
    dummynetAnchor: true,
    anchor: true
  })
  assert.deepEqual(pfConfHooksAnchor(`# anchor "${PF_ANCHOR}"\ndummynet-anchor "${PF_ANCHOR}"\n`), {
    dummynetAnchor: true,
    anchor: false
  })
})

test('doctor: network faults check', () => {
  const hooked = `dummynet-anchor "${PF_ANCHOR}"\nanchor "${PF_ANCHOR}"\n`
  assert.equal(evaluateNetFaultsClean(null, null, { networkFaults: false }).status, SKIP)
  assert.equal(evaluateNetFaultsClean(null, null, { networkFaults: null }).status, SKIP)
  const refused = evaluateNetFaultsClean(null, null, { networkFaults: true })
  assert.equal(refused.status, FAIL)
  assert.match(refused.detail, /sudoers\.live-lab\.example/)

  const clean = evaluateNetFaultsClean('', '00001: 1 Mbit/s\n', {
    networkFaults: true,
    pfConf: hooked
  })
  assert.equal(clean.status, PASS)
  assert.match(
    clean.detail,
    /anchor com\.videorc\.live-lab empty, pipe 2178 absent, \/etc\/pf\.conf hooks the anchor/
  )
  assert.equal(evaluateNetFaultsClean('', '', { networkFaults: false }).status, PASS)

  const leftover = evaluateNetFaultsClean(
    `dummynet out proto tcp pipe ${DN_PIPE}\n`,
    `0${DN_PIPE}: x\n`,
    {
      networkFaults: true,
      pfConf: hooked
    }
  )
  assert.equal(leftover.status, FAIL)
  assert.match(
    leftover.detail,
    /1 rule\(s\) in anchor com\.videorc\.live-lab, pipe 2178 still configured/
  )
  for (const line of cleanupCommandLines()) assert.ok(leftover.detail.includes(line))

  const unhooked = evaluateNetFaultsClean('', '', { networkFaults: true, pfConf: '' })
  assert.equal(unhooked.status, FAIL)
  assert.match(
    unhooked.detail,
    /lacks dummynet-anchor "com\.videorc\.live-lab" and anchor "com\.videorc\.live-lab"/
  )
  // With faults off, pf.conf hooks are not required.
  assert.equal(evaluateNetFaultsClean('', '', { networkFaults: false, pfConf: '' }).status, PASS)

  const cleaned = evaluateNetFaultsClean('', '', {
    networkFaults: true,
    pfConf: hooked,
    cleaned: true
  })
  assert.equal(cleaned.status, WARN)
  assert.match(cleaned.detail, /previous run leaked/)
})
