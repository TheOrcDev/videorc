import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { FAIL, PASS, SKIP, WARN, evaluateLinuxNetFaultsClean } from './doctor-checks.mjs'
import {
  LINUX_ALLOWED_COMMANDS,
  LINUX_NETFAULT_HELPER,
  WATCHDOG_GRACE_S,
  applyNetFault,
  createNetFaultRegistry,
  linuxAllowedCommandLines,
  linuxCleanupCommandLines,
  linuxNetFaultResidue,
  linuxWatchdogScript,
  parseLinuxNetFaultStatus,
  parseSudoersCommandLines,
  removeNetFaults,
  residueIsClean
} from './net-fault.mjs'

// The live lab runs on macOS and Linux only (POSIX paths, modes and shells).
const posixOnly = {
  skip: process.platform === 'win32' && 'the live lab runs on macOS and Linux only'
}

// Plan 179: the Linux network fault backend. Same contract as the macOS
// pf/dnctl tests in net-fault.test.mjs: only allowlisted sudo lines, the
// watchdog before the fault, removal proven by a read-back, and the root
// helper script exercised against stand-in nft/tc/getent/ip.

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const LINUX_CONFIG = join(HERE, '..', '..', '..', 'config', 'live-lab', 'linux')
const SUDOERS_EXAMPLE = join(LINUX_CONFIG, 'sudoers.live-lab.example')
const HELPER_SCRIPT = join(LINUX_CONFIG, 'videorc-lab-netfault')
const LINUX = 'linux'
const ALLOWED = new Set(linuxAllowedCommandLines())

function lineOf({ command, args }) {
  return [command, ...args].join(' ')
}

function statusText({ table, qdiscs = [], ingest = [] }) {
  return [
    `table=${table ? 'present' : 'absent'}`,
    ...qdiscs.map(({ dev, mode }) => `qdisc=${dev} mode=${mode}`),
    ...ingest.map((address) => `ingest=${address}`)
  ].join('\n')
}

// The helper as the harness sees it through sudo: four verbs, a status line
// format, nothing else.
function fakeHelper({ refuse = false, failOn = null, stuck = false } = {}) {
  const state = { mode: null, calls: [] }
  const runner = async (entry) => {
    const line = lineOf(entry)
    assert.ok(ALLOWED.has(line), `runner got a command outside the allowlist: ${line}`)
    state.calls.push(entry.args[0])
    if (refuse) return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
    const verb = entry.args[0]
    if (failOn === verb) return { code: 1, stdout: '', stderr: 'error=tc refused the lab qdisc' }
    if (verb === 'loss' || verb === 'throttle') state.mode = verb
    if (verb === 'clear' && !stuck) state.mode = null
    const text = statusText({
      table: state.mode !== null,
      qdiscs: state.mode ? [{ dev: 'wlan0', mode: state.mode }] : [],
      ingest: state.mode ? ['142.250.1.1', '2a00:1450:4003::1'] : []
    })
    return { code: 0, stdout: `${text}\n`, stderr: '' }
  }
  return { state, runner }
}

function fakeClock() {
  const timers = []
  const killed = []
  const spawned = []
  return {
    now: () => 1_000_000,
    setTimer: (fn, ms) => {
      const handle = { fn, ms }
      timers.push(handle)
      return handle
    },
    clearTimer: () => {},
    kill: (pid, signal) => killed.push({ pid, signal }),
    spawnWatchdog: (script) => {
      spawned.push(script)
      return 4343
    },
    resolve: async () => ['142.250.1.1', '2a00:1450:4003::1'],
    timers,
    killed,
    spawned
  }
}

test('Linux sudoers example allows exactly the four helper verbs', posixOnly, async () => {
  const text = await readFile(SUDOERS_EXAMPLE, 'utf8')
  const inSudoers = parseSudoersCommandLines(text)
  assert.deepEqual([...inSudoers].sort(), [...ALLOWED].sort())
  assert.ok(!/\*/.test(inSudoers.join('\n')), 'no wildcard in any allowed command')
  assert.ok(!/\/(nft|tc)\b/.test(inSudoers.join('\n')), 'nft and tc are never allowed directly')
  assert.match(text, /^videorc-lab ALL=\(root\) NOPASSWD: LIVE_LAB_FAULTS$/m)
  assert.match(text, /^Defaults!LIVE_LAB_FAULTS env_reset$/m)
  assert.equal(LINUX_NETFAULT_HELPER, '/usr/local/sbin/videorc-lab-netfault')
  assert.deepEqual(Object.keys(LINUX_ALLOWED_COMMANDS).sort(), [
    'clear',
    'loss',
    'status',
    'throttle'
  ])
})

test('Linux watchdog only waits and runs the allowed clear', posixOnly, () => {
  assert.equal(
    linuxWatchdogScript(30_000),
    `sleep ${30 + WATCHDOG_GRACE_S}; sudo -n ${LINUX_NETFAULT_HELPER} clear; exit 0`
  )
  assert.deepEqual(linuxCleanupCommandLines(), [`sudo -n ${LINUX_NETFAULT_HELPER} clear`])
})

test(
  'status parsing: table, qdiscs with mode, ingest; unreadable output is residue',
  posixOnly,
  () => {
    const parsed = parseLinuxNetFaultStatus(
      'table=present\nqdisc=wlan0 mode=loss\nqdisc=eth0 mode=none\ningest=142.250.1.1\n'
    )
    assert.deepEqual(parsed, {
      table: true,
      qdiscs: [
        { dev: 'wlan0', mode: 'loss' },
        { dev: 'eth0', mode: 'none' }
      ],
      ingest: ['142.250.1.1']
    })
    assert.ok(residueIsClean(linuxNetFaultResidue('table=absent\n')))
    assert.ok(!residueIsClean(linuxNetFaultResidue('table=absent\nqdisc=wlan0 mode=none\n')))
    // Fail closed: no table line at all is not proof of a clean machine.
    assert.ok(!residueIsClean(linuxNetFaultResidue('')))
    assert.ok(!residueIsClean(linuxNetFaultResidue('sudo: something odd\n')))
  }
)

test(
  'Linux applyNetFault: clean slate, watchdog first, one verb, read-back, deadline',
  posixOnly,
  async () => {
    const sys = fakeHelper()
    const clock = fakeClock()
    const registry = createNetFaultRegistry()
    const watchdogs = []
    const handle = await applyNetFault({
      platform: LINUX,
      kind: 'loss',
      durationMs: 30_000,
      runner: sys.runner,
      registry,
      onWatchdog: (entry) => watchdogs.push(entry),
      ...clock
    })
    assert.deepEqual(sys.state.calls, ['clear', 'status', 'loss', 'status'])
    assert.deepEqual(clock.spawned, [linuxWatchdogScript(30_000)])
    assert.equal(watchdogs[0].pid, 4343)
    assert.equal(clock.timers[0].ms, 30_000)
    assert.equal(handle.deadlineAt, 1_030_000)
    assert.deepEqual(handle.ingest.missing, [])
    assert.equal(registry.active.kind, 'loss')

    await handle.remove()
    assert.deepEqual(sys.state.calls.slice(4), ['clear', 'status'])
    assert.deepEqual(clock.killed, [{ pid: -4343, signal: 'SIGTERM' }])
    assert.equal(registry.active, null)
  }
)

test('Linux throttle runs the throttle verb and checks the reported mode', posixOnly, async () => {
  const sys = fakeHelper()
  const clock = fakeClock()
  await applyNetFault({
    platform: LINUX,
    kind: 'throttle',
    durationMs: 30_000,
    runner: sys.runner,
    registry: createNetFaultRegistry(),
    ...clock
  })
  assert.ok(sys.state.calls.includes('throttle'))
  assert.ok(!sys.state.calls.includes('loss'))
  await assert.rejects(
    applyNetFault({
      platform: LINUX,
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

test('Linux: sudo refused stops at the first command, nothing spawned', posixOnly, async () => {
  const sys = fakeHelper({ refuse: true })
  const clock = fakeClock()
  await assert.rejects(
    applyNetFault({
      platform: LINUX,
      kind: 'loss',
      durationMs: 5_000,
      runner: sys.runner,
      registry: createNetFaultRegistry(),
      ...clock
    }),
    (error) => error.code === 'SUDO_REFUSED' && /sudoers\.live-lab\.example/.test(error.message)
  )
  assert.deepEqual(sys.state.calls, ['clear'])
  assert.deepEqual(clock.spawned, [])
})

test('Linux: a failed apply clears and kills the watchdog', posixOnly, async () => {
  const sys = fakeHelper({ failOn: 'loss' })
  const clock = fakeClock()
  const registry = createNetFaultRegistry()
  await assert.rejects(
    applyNetFault({
      platform: LINUX,
      kind: 'loss',
      durationMs: 5_000,
      runner: sys.runner,
      registry,
      ...clock
    }),
    /loss exit 1: error=tc refused/
  )
  assert.deepEqual(sys.state.calls.slice(-2), ['clear', 'status'])
  assert.deepEqual(clock.killed, [{ pid: -4343, signal: 'SIGTERM' }])
  assert.equal(registry.active, null)
  assert.equal(registry.watchdogs.size, 0)
})

test(
  'Linux removeNetFaults throws with the cleanup command when the read-back shows residue',
  posixOnly,
  async () => {
    const sys = fakeHelper({ stuck: true })
    sys.state.mode = 'loss'
    await assert.rejects(
      removeNetFaults({
        platform: LINUX,
        runner: sys.runner,
        registry: createNetFaultRegistry(),
        kill: () => {}
      }),
      (error) =>
        error.code === 'NET_FAULT_RESIDUE' &&
        error.message.includes(linuxCleanupCommandLines()[0]) &&
        error.residue.pipes.length === 1
    )
  }
)

test('doctor: Linux network faults check', posixOnly, () => {
  const clean = statusText({ table: false })
  assert.equal(evaluateLinuxNetFaultsClean(null, { networkFaults: false }).status, SKIP)
  assert.equal(evaluateLinuxNetFaultsClean(null, { networkFaults: true }).status, FAIL)
  assert.match(
    evaluateLinuxNetFaultsClean(null, {
      networkFaults: true,
      helper: { present: false, rootOwned: false, writable: false }
    }).detail,
    /videorc-lab-netfault is missing/
  )
  assert.equal(evaluateLinuxNetFaultsClean(clean, { networkFaults: true }).status, PASS)
  const leftover = evaluateLinuxNetFaultsClean(
    statusText({ table: true, qdiscs: [{ dev: 'wlan0', mode: 'loss' }] }),
    { networkFaults: true }
  )
  assert.equal(leftover.status, FAIL)
  assert.ok(leftover.detail.includes(linuxCleanupCommandLines()[0]))
  assert.equal(evaluateLinuxNetFaultsClean(clean, { cleaned: true }).status, WARN)
  for (const helper of [
    { present: true, rootOwned: false, writable: false },
    { present: true, rootOwned: true, writable: true }
  ]) {
    const verdict = evaluateLinuxNetFaultsClean(clean, { networkFaults: false, helper })
    assert.equal(verdict.status, FAIL, JSON.stringify(helper))
    assert.match(verdict.detail, /reinstall it: sudo install -o root -g root -m 0755/)
  }
})

// ---------------------------------------------------------------------------
// The root helper itself, run as a copy whose PATH points at stand-ins for
// id, getent, ip, nft and tc. The stand-ins keep their state in files and
// print what the real tools print, including qdiscs that are not the lab's
// (they must survive `clear`).

const STUBS = {
  id: `#!/bin/sh
[ "$1" = "-u" ] && echo 0`,
  getent: `#!/bin/sh
echo "getent $*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "ahostsv4 a.rtmps.youtube.com") printf '142.250.1.1     STREAM a.rtmps.youtube.com\\n142.250.1.1     DGRAM\\n' ;;
  "ahostsv4 b.rtmps.youtube.com") printf '142.250.1.2     STREAM b.rtmps.youtube.com\\n' ;;
  "ahostsv4 a.rtmp.youtube.com") printf '142.250.1.1     STREAM a.rtmp.youtube.com\\n' ;;
  "ahostsv4 b.rtmp.youtube.com") exit 2 ;;
  "ahostsv6 a.rtmps.youtube.com") printf '2a00:1450:4003::1 STREAM a.rtmps.youtube.com\\n' ;;
  ahostsv6*) printf '::ffff:142.250.1.2 STREAM x\\n' ;;
esac`,
  ip: `#!/bin/sh
echo "ip $*" >> "$STUB_DIR/calls.log"
echo "$4 via 192.168.1.1 dev wlan0 src 192.168.1.138 uid 1000"`,
  nft: `#!/bin/sh
echo "nft $*" >> "$STUB_DIR/calls.log"
T="$STUB_DIR/nft.table"
case "$*" in
  "-f -") cat > "$T" ;;
  "list table inet videorc_lab") [ -f "$T" ] ;;
  "delete table inet videorc_lab") rm "$T" ;;
  "list set inet videorc_lab ingest4") [ -f "$T" ] && grep 'set ingest4' "$T" ;;
  "list set inet videorc_lab ingest6") [ -f "$T" ] && grep 'set ingest6' "$T" ;;
  *) exit 1 ;;
esac`,
  tc: `#!/bin/sh
echo "tc $*" >> "$STUB_DIR/calls.log"
Q="$STUB_DIR/qdiscs"
touch "$Q"
case "$1 $2 $3" in
  "qdisc show ")
    cat "$Q" ;;
  "qdisc show dev")
    grep " dev $4 " "$Q" | sed "s/ dev $4//" ;;
  "qdisc replace dev")
    grep -v " dev $4 root" "$Q" > "$Q.new"; mv "$Q.new" "$Q"
    echo "qdisc prio 2178: dev $4 root refcnt 2 bands 4 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1" >> "$Q" ;;
  "qdisc add dev")
    dev=$4; shift 9; echo "qdisc netem 2179: dev $dev parent 2178:4 limit 1000 $*" >> "$Q" ;;
  "qdisc del dev")
    grep -v " dev $4 " "$Q" > "$Q.new"; mv "$Q.new" "$Q" ;;
  "filter add dev") ;;
  *) exit 1 ;;
esac`
}

const FOREIGN_QDISCS = [
  'qdisc fq_codel 0: dev eth1 root refcnt 2 limit 10240p',
  'qdisc prio 1: dev eth2 root refcnt 2 bands 3 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1'
]

async function withHelper(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-netfault-'))
  try {
    for (const [name, body] of Object.entries(STUBS)) {
      await writeFile(join(dir, name), `${body}\n`)
      await chmod(join(dir, name), 0o755)
    }
    await writeFile(join(dir, 'qdiscs'), `${FOREIGN_QDISCS.join('\n')}\n`)
    const source = await readFile(HELPER_SCRIPT, 'utf8')
    const line = 'PATH=/usr/sbin:/usr/bin:/sbin:/bin'
    assert.ok(source.includes(`\n${line}\n`), 'the helper sets its own PATH')
    await writeFile(join(dir, 'helper'), source.replace(line, `PATH=${dir}:/usr/bin:/bin`))
    const run = async (verb) => {
      try {
        const { stdout } = await execFileAsync('/bin/sh', [join(dir, 'helper'), verb], {
          env: { STUB_DIR: dir }
        })
        return { code: 0, stdout }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    }
    const read = async (name) => readFile(join(dir, name), 'utf8').catch(() => '')
    await fn({ run, read })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test(
  'helper script: loss marks only ingest traffic and shapes only band 3',
  posixOnly,
  async () => {
    await withHelper(async ({ run, read }) => {
      const applied = await run('loss')
      assert.equal(applied.code, 0, applied.stderr)
      const status = parseLinuxNetFaultStatus(applied.stdout)
      assert.equal(status.table, true)
      assert.deepEqual(status.qdiscs, [{ dev: 'wlan0', mode: 'loss' }])
      assert.deepEqual(status.ingest.sort(), ['142.250.1.1', '142.250.1.2', '2a00:1450:4003::1'])

      const table = await read('nft.table')
      assert.match(table, /^table inet videorc_lab \{/)
      assert.match(
        table,
        /set ingest4 \{ type ipv4_addr; elements = \{ 142\.250\.1\.1, 142\.250\.1\.2 \} \}/
      )
      // v4-mapped answers from ahostsv6 are dropped.
      assert.match(table, /set ingest6 \{ type ipv6_addr; elements = \{ 2a00:1450:4003::1 \} \}/)
      assert.ok(!table.includes('::ffff:'))
      assert.match(table, /type filter hook output priority mangle; policy accept;/)
      assert.match(
        table,
        /ip daddr @ingest4 tcp dport \{ 443, 1935 \} meta mark set meta mark \| 0x2178/
      )
      assert.ok(!/\bdrop\b|\breject\b/.test(table), 'nft only marks; tc does the damage')

      const calls = await read('calls.log')
      assert.match(
        calls,
        /tc qdisc replace dev wlan0 root handle 2178: prio bands 4 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1/
      )
      assert.match(calls, /tc qdisc add dev wlan0 parent 2178:4 handle 2179: netem loss 100%/)
      assert.match(
        calls,
        /tc filter add dev wlan0 parent 2178: protocol all prio 1 handle 0x2178\/0xffff fw flowid 2178:4/
      )
      // The priomap never names band 3, so unmarked traffic never meets netem.
      const priomap = /priomap ((?:\d )+\d)/.exec(calls)[1].split(' ').map(Number)
      assert.ok(priomap.every((band) => band <= 2))
    })
  }
)

test(
  'helper script: throttle, then clear removes only the lab table and qdisc',
  posixOnly,
  async () => {
    await withHelper(async ({ run, read }) => {
      const applied = await run('throttle')
      assert.equal(applied.code, 0, applied.stderr)
      assert.deepEqual(parseLinuxNetFaultStatus(applied.stdout).qdiscs, [
        { dev: 'wlan0', mode: 'throttle' }
      ])
      assert.match(await read('calls.log'), /netem rate 1000kbit/)

      const cleared = await run('clear')
      assert.equal(cleared.code, 0, cleared.stderr)
      assert.ok(residueIsClean(linuxNetFaultResidue(cleared.stdout)))
      assert.equal(await read('nft.table'), '')
      const left = (await read('qdiscs')).trim().split('\n')
      assert.deepEqual(left, FOREIGN_QDISCS)

      // Idempotent, and status on a clean machine is clean.
      assert.equal((await run('clear')).code, 0)
      assert.ok(residueIsClean(linuxNetFaultResidue((await run('status')).stdout)))
    })
  }
)

test('helper script: refuses anything but one known verb', posixOnly, async () => {
  await withHelper(async ({ run }) => {
    for (const verb of ['', 'flush', 'loss; id']) {
      const result = await run(verb)
      assert.notEqual(result.code, 0, verb)
    }
  })
})
