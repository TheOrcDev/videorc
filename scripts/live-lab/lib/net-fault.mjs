import { execFile, spawn } from 'node:child_process'
import { resolve4 } from 'node:dns/promises'
import { promisify } from 'node:util'

// Plan 178 U13 (plan 166 S9 step 1). A network fault on the RTMP leg only:
// 100% loss or a 1 Mbit/s throttle on TCP 443/1935 to YouTube's ingest hosts,
// through one dummynet pipe and one pf anchor that are the lab's own.
//
// Safety shape (the STOP condition is "a rule outlives the harness"):
//   - Every command runs as `sudo -n <full path> <fixed args>`. The argument
//     lists live in ALLOWED_COMMANDS below, and a unit test checks that
//     config/live-lab/sudoers.live-lab.example allows exactly those lines
//     and nothing else. No wildcard reaches sudoers.
//   - pf rules are never written by the harness. `pfctl -a <anchor> -f` loads
//     a root-owned file the owner installed (PF_ANCHOR_FILE, template in
//     config/live-lab/pf.anchor.example); the file names the ingest hosts and
//     pf resolves them when the rules load.
//   - A fault has a hard deadline (MAX_FAULT_MS). Removal is scheduled three
//     ways: an in-process timer, a detached `sleep N; flush; delete` watchdog
//     that survives the harness dying, and removeNetFaults() in the caller's
//     finally / at teardown / from the doctor. Removal is idempotent and ends
//     with a read-back that proves the anchor and the pipe are gone.
//
// Nothing here is exercised against a real pf in tests: `runner`, `spawn`,
// `now`, timers and `resolve` are injected.

export const PF_ANCHOR = 'com.videorc.live-lab'
export const PF_ANCHOR_FILE = '/Library/Application Support/VideorcLab/pf.anchor'
export const PF_INGEST_TABLE = 'videorc_lab_ingest'
export const PF_CONF = '/etc/pf.conf'
// One pipe, in a range no other tool on the lab Mac uses (Network Link
// Conditioner takes low numbers). Reconfigured per fault, deleted after.
export const DN_PIPE = 2178
export const THROTTLE_KBPS = 1000
export const MAX_FAULT_MS = 60_000
export const WATCHDOG_GRACE_S = 5
// The hosts the rules file names; the app streams to one of them (RTMPS on
// 443 by default, RTMP on 1935 when the key says so).
export const INGEST_HOSTS = Object.freeze([
  'a.rtmps.youtube.com',
  'b.rtmps.youtube.com',
  'a.rtmp.youtube.com',
  'b.rtmp.youtube.com'
])

const PFCTL = '/sbin/pfctl'
const DNCTL = '/usr/sbin/dnctl'

// The complete set of command lines the harness may run with sudo. Every
// call site below picks one of these by name; the sudoers example is checked
// against `allowedCommandLines()` in net-fault.test.mjs.
export const ALLOWED_COMMANDS = Object.freeze({
  pfEnable: { command: PFCTL, args: ['-E'] },
  pfLoadAnchor: { command: PFCTL, args: ['-a', PF_ANCHOR, '-f', PF_ANCHOR_FILE] },
  pfFlushAnchor: { command: PFCTL, args: ['-a', PF_ANCHOR, '-F', 'all'] },
  pfShowAnchorRules: { command: PFCTL, args: ['-a', PF_ANCHOR, '-s', 'rules'] },
  pfShowIngestTable: {
    command: PFCTL,
    args: ['-a', PF_ANCHOR, '-t', PF_INGEST_TABLE, '-T', 'show']
  },
  pfShowInfo: { command: PFCTL, args: ['-s', 'info'] },
  dnPipeLoss: { command: DNCTL, args: ['pipe', String(DN_PIPE), 'config', 'plr', '1'] },
  dnPipeThrottle: {
    command: DNCTL,
    args: ['pipe', String(DN_PIPE), 'config', 'bw', `${THROTTLE_KBPS}Kbit/s`]
  },
  dnPipeDelete: { command: DNCTL, args: ['pipe', String(DN_PIPE), 'delete'] },
  dnList: { command: DNCTL, args: ['list'] }
})

export const FAULT_KINDS = Object.freeze(['loss', 'throttle'])

function commandLine({ command, args }) {
  return [command, ...args].join(' ')
}

// `"/sbin/pfctl -a com.videorc.live-lab -F all"` and friends, one per allowed
// command, in the form a sudoers Cmnd_Alias lists them (before escaping).
export function allowedCommandLines() {
  return Object.values(ALLOWED_COMMANDS).map(commandLine)
}

// Parses a sudoers file's Cmnd_Alias entries into command lines. Handles the
// backslash line continuation and `\ ` escaped spaces; ignores comments.
export function parseSudoersCommandLines(text) {
  const joined = String(text ?? '').replace(/\\\r?\n/g, ' ')
  const lines = []
  for (const raw of joined.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^Cmnd_Alias\s+\w+\s*=\s*(.+)$/.exec(line)
    if (!match) continue
    for (const entry of match[1].split(/(?<!\\),/)) {
      const cleaned = entry.trim().replace(/\\ /g, ' ').replace(/\s+/g, ' ')
      if (cleaned) lines.push(cleaned)
    }
  }
  return lines
}

// The shell the detached watchdog runs: wait, then flush and delete with the
// same allowed commands. It never references anything else, so a harness
// that dies leaves at most WATCHDOG_GRACE_S seconds of fault behind.
export function watchdogScript(durationMs) {
  const seconds = Math.ceil(durationMs / 1000) + WATCHDOG_GRACE_S
  const flush = `sudo -n ${commandLine(ALLOWED_COMMANDS.pfFlushAnchor)}`
  const del = `sudo -n ${commandLine(ALLOWED_COMMANDS.dnPipeDelete)}`
  return `sleep ${seconds}; ${flush}; ${del}; exit 0`
}

const execFileAsync = promisify(execFile)

// Default runner: `sudo -n` so a missing sudoers entry fails at once instead
// of waiting for a password. Never throws on a non-zero exit; callers read
// `code` and `stderr`.
export async function sudoRunner({ command, args }, { exec = execFileAsync } = {}) {
  try {
    const { stdout, stderr } = await exec('sudo', ['-n', command, ...args], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024
    })
    return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? '')
    }
  }
}

export function sudoRefused(result) {
  return (
    result.code !== 0 &&
    /password is required|not allowed to execute|sudo: .*command not found|no tty present/i.test(
      result.stderr
    )
  )
}

function defaultSpawnWatchdog(script) {
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

// The anchor's rules as `pfctl -a <anchor> -s rules` prints them: one rule
// per non-empty, non-comment line. An empty anchor prints nothing.
export function anchorRuleLines(pfRulesOutput) {
  return String(pfRulesOutput ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

// `dnctl list` prints `02178:  1.000 Mbit/s    0 ms   50 sl.plr 1.000000 ...`
// for a configured pipe. Only the lab's own number counts.
export function labPipeLines(dnctlListOutput, pipe = DN_PIPE) {
  const prefix = new RegExp(`^0*${pipe}:`)
  return String(dnctlListOutput ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => prefix.test(line))
}

// What is still installed, from the two read-only commands. Pure.
export function netFaultResidue({ pfRules, dnctlList }) {
  return {
    rules: anchorRuleLines(pfRules),
    pipes: labPipeLines(dnctlList)
  }
}

export function residueIsClean(residue) {
  return residue.rules.length === 0 && residue.pipes.length === 0
}

// The two cleanup commands, for a doctor FAIL line or a runbook.
export function cleanupCommandLines() {
  return [ALLOWED_COMMANDS.pfFlushAnchor, ALLOWED_COMMANDS.dnPipeDelete].map(
    (entry) => `sudo -n ${commandLine(entry)}`
  )
}

// /etc/pf.conf must hand the anchor to pf: both a dummynet-anchor (the pipe
// rule) and a plain anchor line. Pure, over the file's text.
export function pfConfHooksAnchor(pfConfText) {
  const text = String(pfConfText ?? '')
  const quoted = `"${PF_ANCHOR}"`
  return {
    dummynetAnchor: new RegExp(`^\\s*dummynet-anchor\\s+${quoted}`, 'm').test(text),
    anchor: new RegExp(`^\\s*anchor\\s+${quoted}`, 'm').test(text)
  }
}

export function createNetFaultRegistry() {
  return { active: null, watchdogs: new Map(), timers: new Set() }
}

const defaultRegistry = createNetFaultRegistry()

function describe(result) {
  const text = `${result.stderr}`.trim() || `${result.stdout}`.trim()
  return text ? `exit ${result.code}: ${text.split('\n')[0]}` : `exit ${result.code}`
}

async function runAllowed(runner, name) {
  const entry = ALLOWED_COMMANDS[name]
  if (!entry) throw new Error(`net-fault: no allowed command named ${name}`)
  const result = await runner(entry)
  if (sudoRefused(result)) {
    const error = new Error(
      `sudo refused "${commandLine(entry)}": ${describe(result)}. Install config/live-lab/sudoers.live-lab.example (owner step) or set faults.network to false.`
    )
    error.code = 'SUDO_REFUSED'
    throw error
  }
  return result
}

function killGroup(kill, pid) {
  try {
    kill(-pid, 'SIGTERM')
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

// Removes every lab rule and the pipe, kills the watchdogs this process
// spawned, clears timers, then reads back. Idempotent: safe with nothing
// installed, safe twice. Throws only when the read-back still shows residue
// or sudo refuses, so the caller's finally can surface a real leak.
export async function removeNetFaults({
  runner = sudoRunner,
  registry = defaultRegistry,
  kill = process.kill.bind(process),
  clearTimer = clearTimeout,
  log = () => {}
} = {}) {
  for (const timer of registry.timers) clearTimer(timer)
  registry.timers.clear()
  const flushed = await runAllowed(runner, 'pfFlushAnchor')
  if (flushed.code !== 0) log(`net-fault: anchor flush ${describe(flushed)}`)
  const deleted = await runAllowed(runner, 'dnPipeDelete')
  // A pipe that was never configured makes `dnctl pipe delete` fail; the
  // read-back below is the truth, not this exit code.
  if (deleted.code !== 0) log(`net-fault: pipe delete ${describe(deleted)}`)
  const killed = []
  for (const [pid] of registry.watchdogs) {
    if (killGroup(kill, pid)) killed.push(pid)
    registry.watchdogs.delete(pid)
  }
  registry.active = null
  const [rules, list] = await Promise.all([
    runAllowed(runner, 'pfShowAnchorRules'),
    runAllowed(runner, 'dnList')
  ])
  const residue = netFaultResidue({ pfRules: rules.stdout, dnctlList: list.stdout })
  if (!residueIsClean(residue)) {
    const error = new Error(
      `net-fault: residue after removal (${residue.rules.length} rule(s), ${residue.pipes.length} pipe(s)). Run: ${cleanupCommandLines().join(' && ')}`
    )
    error.code = 'NET_FAULT_RESIDUE'
    error.residue = residue
    throw error
  }
  return { residue, killedWatchdogs: killed }
}

function validateRequest({ kind, durationMs, kbps }) {
  if (!FAULT_KINDS.includes(kind)) {
    throw new Error(`net-fault: kind must be one of ${FAULT_KINDS.join(', ')} (got ${kind})`)
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_FAULT_MS) {
    throw new Error(`net-fault: durationMs must be 1..${MAX_FAULT_MS} (got ${durationMs})`)
  }
  if (kind === 'throttle' && kbps !== undefined && kbps !== THROTTLE_KBPS) {
    throw new Error(
      `net-fault: only ${THROTTLE_KBPS} kbps is in the sudoers allowlist (got ${kbps})`
    )
  }
}

async function resolveIngest(resolve) {
  const resolved = new Set()
  for (const host of INGEST_HOSTS) {
    try {
      for (const address of await resolve(host)) resolved.add(address)
    } catch {
      // A host that does not resolve here is also not one pf could add.
    }
  }
  return [...resolved]
}

// Installs one fault with a hard deadline. Returns a handle; `remove()` is
// removeNetFaults() bound to the same runner and registry. The caller still
// calls remove() in its finally: the timer and the watchdog are the backstops,
// not the plan.
export async function applyNetFault({
  kind,
  durationMs,
  kbps,
  runner = sudoRunner,
  now = Date.now,
  registry = defaultRegistry,
  spawnWatchdog = defaultSpawnWatchdog,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  kill = process.kill.bind(process),
  resolve = resolve4,
  onWatchdog = () => {},
  log = () => {}
}) {
  validateRequest({ kind, durationMs, kbps })
  if (registry.active) {
    throw new Error(
      `net-fault: a ${registry.active.kind} fault is already installed (deadline ${new Date(registry.active.deadlineAt).toISOString()}); remove it first`
    )
  }
  const remove = () => removeNetFaults({ runner, registry, kill, clearTimer, log })
  // Clean slate, and the first sudo call tells us at once if sudoers is
  // missing, before anything is half installed.
  await remove()

  const startedAt = now()
  const deadlineAt = startedAt + durationMs
  // The watchdog goes first: from here on a dead harness still cleans up.
  const watchdogPid = spawnWatchdog(watchdogScript(durationMs))
  if (!Number.isInteger(watchdogPid) || watchdogPid <= 1) {
    throw new Error('net-fault: could not spawn the removal watchdog; fault not installed')
  }
  registry.watchdogs.set(watchdogPid, { kind, deadlineAt })
  onWatchdog({ pid: watchdogPid, label: 'live-lab-net-fault-watchdog', deadlineAt })
  try {
    const enabled = await runAllowed(runner, 'pfEnable')
    if (enabled.code !== 0) throw new Error(`net-fault: pfctl -E ${describe(enabled)}`)
    const pipe = await runAllowed(runner, kind === 'loss' ? 'dnPipeLoss' : 'dnPipeThrottle')
    if (pipe.code !== 0) throw new Error(`net-fault: pipe config ${describe(pipe)}`)
    const loaded = await runAllowed(runner, 'pfLoadAnchor')
    if (loaded.code !== 0) throw new Error(`net-fault: anchor load ${describe(loaded)}`)
    const rules = anchorRuleLines((await runAllowed(runner, 'pfShowAnchorRules')).stdout)
    if (!rules.some((line) => line.includes(`pipe ${DN_PIPE}`))) {
      throw new Error(
        `net-fault: the anchor holds no rule for pipe ${DN_PIPE} after loading ${PF_ANCHOR_FILE} (${rules.length} rule(s))`
      )
    }
    const table = (await runAllowed(runner, 'pfShowIngestTable')).stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const resolved = await resolveIngest(resolve)
    const missing = resolved.filter((address) => !table.includes(address))
    if (missing.length) {
      log(
        `net-fault: ${missing.length} ingest address(es) resolved here are not in the pf table (${table.length} in table); the leg may dodge the fault`
      )
    }
    const timer = setTimer(() => {
      registry.timers.delete(timer)
      remove().catch((error) => log(`net-fault: deadline removal failed: ${error.message}`))
    }, durationMs)
    registry.timers.add(timer)
    registry.active = { kind, startedAt, deadlineAt, watchdogPid }
    log(`net-fault: ${kind} installed for ${durationMs} ms (watchdog pid ${watchdogPid})`)
    return {
      kind,
      startedAt,
      deadlineAt,
      watchdogPid,
      rules,
      ingest: { resolved, inTable: table, missing },
      remove
    }
  } catch (error) {
    try {
      await remove()
    } catch (removeError) {
      error.removeError = removeError
    }
    throw error
  }
}
