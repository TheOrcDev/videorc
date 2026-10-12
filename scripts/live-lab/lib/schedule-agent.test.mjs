import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createQuotaLedger } from './quota-ledger.mjs'
import {
  AGENT_LABEL,
  AgentRefusal,
  SERVICE_TEMPLATE_PATH,
  TEMPLATE_PATH,
  TIMER_TEMPLATE_PATH,
  agentLogsDir,
  agentPlistPath,
  installAgent,
  renderAgentPlist,
  renderSystemdUnit,
  systemdUserDir,
  uninstallAgent
} from './schedule-agent.mjs'
import { writeState } from './schedule-state.mjs'
import { formatStatus, gatherStatus } from './schedule-status.mjs'
import { validateScheduleTable } from './schedule-table.mjs'

const execFileAsync = promisify(execFile)

async function freshDir(prefix = 'live-lab-agent-') {
  return mkdtemp(join(tmpdir(), prefix))
}

function fakeRunner(results = {}) {
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    const key = `${command.split('/').pop()} ${args[0]}`
    return results[key] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

test('renderAgentPlist swaps in home, repo and node, and keeps the schedule shape', async () => {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const rendered = renderAgentPlist(template, {
    home: '/Users/tester',
    repoRoot: '/opt/lab/videorc',
    nodePath: '/usr/local/bin/node'
  })
  assert.ok(!rendered.includes('/Users/videorc-lab'))
  assert.match(rendered, /<string>\/usr\/local\/bin\/node<\/string>/)
  assert.match(
    rendered,
    /<string>\/opt\/lab\/videorc\/scripts\/live-lab\/schedule\.mjs<\/string>\s*<string>tick<\/string>/
  )
  assert.match(rendered, /<key>WorkingDirectory<\/key>\s*<string>\/opt\/lab\/videorc<\/string>/)
  assert.match(rendered, /<key>HOME<\/key>\s*<string>\/Users\/tester<\/string>/)
  assert.match(
    rendered,
    /<key>StandardOutPath<\/key>\s*<string>\/Users\/tester\/videorc-live-lab\/logs\/schedule\.log<\/string>/
  )
  assert.match(rendered, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
  assert.match(rendered, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/)
  assert.match(rendered, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(rendered, /<key>ExitTimeOut<\/key>\s*<integer>90<\/integer>/)
  assert.throws(
    () => renderAgentPlist(template, { home: 'relative', nodePath: '/n' }),
    /absolute home/
  )
  assert.throws(() => renderAgentPlist('<plist/>', { home: '/h', nodePath: '/n' }), /label/)
  const escaped = renderAgentPlist(template, { home: '/Users/a&b', repoRoot: '/r', nodePath: '/n' })
  assert.match(escaped, /\/Users\/a&amp;b\/videorc-live-lab/)

  if (process.platform === 'darwin') {
    const dir = await freshDir()
    const file = join(dir, 'agent.plist')
    await writeFile(file, rendered)
    await execFileAsync('/usr/bin/plutil', ['-lint', file])
  }
})

test('install-agent refuses any user but the lab user unless --force-user', async () => {
  const home = await freshDir()
  const { calls, runner } = fakeRunner()
  await assert.rejects(
    installAgent({
      platform: 'darwin',
      home,
      uid: 501,
      username: 'orcdev',
      runner,
      nodePath: '/n'
    }),
    (error) => error instanceof AgentRefusal && /videorc-lab only/.test(error.message)
  )
  await assert.rejects(
    uninstallAgent({ platform: 'darwin', home, uid: 501, username: 'orcdev', runner }),
    AgentRefusal
  )
  assert.deepEqual(calls, [])
})

test('install-agent refuses while a run holds the lock unless --force', async () => {
  const home = await freshDir()
  const { calls, runner } = fakeRunner()
  await assert.rejects(
    installAgent({
      platform: 'darwin',
      home,
      uid: 501,
      username: 'videorc-lab',
      lockHolder: 'od-1, pid 7',
      runner,
      nodePath: '/n'
    }),
    /would kill it/
  )
  assert.deepEqual(calls, [])
})

test('install-agent writes the plist and logs dir, lints, boots out the old one and bootstraps', async () => {
  const home = await freshDir()
  const { calls, runner } = fakeRunner({
    'launchctl bootout': { code: 3, stdout: '', stderr: 'No such process' }
  })
  const result = await installAgent({
    platform: 'darwin',
    home,
    uid: 501,
    username: 'tester',
    forceUser: true,
    runner,
    nodePath: '/opt/homebrew/bin/node'
  })
  const target = agentPlistPath(home)
  assert.equal(result.path, target)
  assert.equal(result.domain, 'gui/501')
  assert.equal((await stat(target)).mode & 0o777, 0o644)
  assert.ok((await readFile(target, 'utf8')).includes(`${home}/videorc-live-lab/logs/schedule.log`))
  await access(agentLogsDir(home))
  assert.deepEqual(
    calls.map((call) =>
      call.slice(0, 2).concat(call.slice(2).map((arg) => arg.replace(home, '~')))
    ),
    [
      ['/usr/bin/plutil', '-lint', calls[0][2].replace(home, '~')],
      ['/bin/launchctl', 'bootout', `gui/501/${AGENT_LABEL}`],
      ['/bin/launchctl', 'bootstrap', 'gui/501', `~/Library/LaunchAgents/${AGENT_LABEL}.plist`]
    ]
  )
})

test('install-agent fails loudly when plutil or bootstrap fails', async () => {
  const home = await freshDir()
  const lint = fakeRunner({ 'plutil -lint': { code: 1, stdout: 'bad plist', stderr: '' } })
  await assert.rejects(
    installAgent({
      platform: 'darwin',
      home,
      uid: 501,
      username: 'videorc-lab',
      runner: lint.runner,
      nodePath: '/n'
    }),
    /plutil rejected the rendered plist: bad plist/
  )
  await assert.rejects(access(agentPlistPath(home)), { code: 'ENOENT' })

  const boot = fakeRunner({
    'launchctl bootstrap': {
      code: 5,
      stdout: '',
      stderr: 'Bootstrap failed: 5: Input/output error'
    }
  })
  await assert.rejects(
    installAgent({
      platform: 'darwin',
      home,
      uid: 501,
      username: 'videorc-lab',
      runner: boot.runner,
      nodePath: '/n'
    }),
    /launchctl bootstrap gui\/501 failed: Bootstrap failed/
  )
})

test('uninstall-agent boots out and removes the plist', async () => {
  const home = await freshDir()
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(agentPlistPath(home), 'x')
  const { calls, runner } = fakeRunner()
  const result = await uninstallAgent({
    platform: 'darwin',
    home,
    uid: 501,
    username: 'videorc-lab',
    runner
  })
  assert.equal(result.wasLoaded, true)
  assert.deepEqual(calls, [['/bin/launchctl', 'bootout', `gui/501/${AGENT_LABEL}`]])
  await assert.rejects(access(agentPlistPath(home)), { code: 'ENOENT' })
})

// Plan 179: the Linux scheduler is a systemd user timer. Every call pins
// platform: 'linux' (and the macOS tests above pin 'darwin'), so the tests
// never depend on the host; CI runs them on Linux.

const SERVICE = 'videorc-live-lab.service'
const TIMER = 'videorc-live-lab.timer'
const SYSTEMCTL = '/usr/bin/systemctl'

/** Results keyed by `<binary> <first non-flag argument>`, e.g. `systemctl enable`. */
function systemdRunner(results = {}) {
  const calls = []
  const options = []
  const runner = async (command, args, opts) => {
    calls.push([command, ...args])
    options.push(opts ?? null)
    const key = `${command.split('/').pop()} ${args.find((arg) => !arg.startsWith('-'))}`
    const result = results[key]
    if (typeof result === 'function') return result(args)
    return result ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, options, runner }
}

const HEALTHY = Object.freeze({
  'systemctl is-enabled': { code: 0, stdout: 'enabled\n', stderr: '' },
  'systemctl is-active': { code: 0, stdout: 'active\n', stderr: '' },
  'loginctl show-user': { code: 0, stdout: 'Linger=yes\n', stderr: '' }
})

function settings(unit) {
  return unit.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'))
}

test('renderSystemdUnit swaps home, repo and node into the service and puts node first in PATH', async () => {
  const template = await readFile(SERVICE_TEMPLATE_PATH, 'utf8')
  const service = renderSystemdUnit(template, {
    home: '/home/tester',
    repoRoot: '/srv/lab/videorc',
    nodePath: '/opt/node/bin/node'
  })
  assert.ok(!service.includes('/home/videorc-lab'), 'nothing of the template home is left')
  assert.ok(!service.includes('/usr/bin/node'))
  assert.deepEqual(settings(service), [
    '[Unit]',
    'Description=Videorc live lab schedule tick (plan 179)',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/opt/node/bin/node /srv/lab/videorc/scripts/live-lab/schedule.mjs tick',
    'WorkingDirectory=/srv/lab/videorc',
    'Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    'Environment=HOME=/home/tester',
    'TimeoutStartSec=infinity',
    'KillMode=mixed',
    'TimeoutStopSec=90',
    'StandardOutput=append:/home/tester/videorc-live-lab/logs/schedule.log',
    'StandardError=append:/home/tester/videorc-live-lab/logs/schedule.log'
  ])
  for (const line of settings(service)) {
    assert.doesNotMatch(line, /key|token|secret|password/i, `no secret in ${line}`)
  }

  // node already on PATH moves to the front instead of appearing twice.
  const distro = renderSystemdUnit(template, {
    home: '/home/tester',
    repoRoot: '/home/tester/videorc',
    nodePath: '/usr/bin/node'
  })
  assert.match(distro, /^Environment=PATH=\/usr\/bin:\/usr\/local\/bin:\/bin:\/usr\/sbin:\/sbin$/m)
  assert.match(
    distro,
    /^ExecStart=\/usr\/bin\/node \/home\/tester\/videorc\/scripts\/live-lab\/schedule\.mjs tick$/m
  )

  // Rendering for the template's own lab user changes nothing but PATH: the
  // work dir is never mistaken for the repo it starts with.
  const identity = renderSystemdUnit(template, {
    home: '/home/videorc-lab',
    repoRoot: '/home/videorc-lab/videorc',
    nodePath: '/usr/bin/node'
  })
  assert.equal(
    identity,
    template.replace(
      'Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      'Environment=PATH=/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin'
    )
  )
})

test('renderSystemdUnit keeps the timer shape and refuses paths systemd would parse', async () => {
  const template = await readFile(TIMER_TEMPLATE_PATH, 'utf8')
  const timer = renderSystemdUnit(template, {
    home: '/home/tester',
    repoRoot: '/srv/lab/videorc',
    nodePath: '/opt/node/bin/node'
  })
  assert.equal(timer, template, 'the timer holds no path')
  assert.deepEqual(settings(timer), [
    '[Unit]',
    'Description=Videorc live lab schedule tick every 300 s (plan 179)',
    '[Timer]',
    'OnStartupSec=60',
    'OnUnitActiveSec=300',
    'AccuracySec=10s',
    'Unit=videorc-live-lab.service',
    '[Install]',
    'WantedBy=timers.target'
  ])

  const good = { home: '/home/tester', repoRoot: '/srv/lab/videorc', nodePath: '/usr/bin/node' }
  for (const bad of [
    '/home/a b',
    '/home/a%h',
    '/home/a\nb',
    '/home/a"b',
    "/home/a'b",
    '/home/$USER',
    '/home/a\\b',
    '/home/a\tb'
  ]) {
    assert.throws(
      () => renderSystemdUnit(template, { ...good, home: bad }),
      /renderSystemdUnit refuses home .*systemd reads whitespace, quotes, %, \$ and backslashes/,
      JSON.stringify(bad)
    )
  }
  assert.throws(
    () => renderSystemdUnit(template, { ...good, repoRoot: '/srv/my lab' }),
    /refuses repoRoot/
  )
  assert.throws(
    () => renderSystemdUnit(template, { ...good, nodePath: '/opt/%n/node' }),
    /refuses nodePath/
  )
  assert.throws(
    () => renderSystemdUnit(template, { ...good, home: 'home/tester' }),
    /absolute home/
  )
  assert.throws(() => renderSystemdUnit('<plist/>', good), /not a videorc-live-lab systemd unit/)
  assert.throws(
    () => renderSystemdUnit('[Unit]\nDescription=videorc-live-lab\nX=/home/videorc-lab2/x\n', good),
    /left a template path behind/
  )
})

test('Linux install-agent stages, verifies, moves both units in, reloads and enables the timer', async () => {
  const home = await freshDir()
  const unitDir = systemdUserDir(home)
  const staging = join(unitDir, `.videorc-live-lab.${process.pid}.tmp`)
  const stagedAtVerify = []
  const { calls, runner } = systemdRunner({
    ...HEALTHY,
    'systemd-analyze verify': async (args) => {
      for (const file of args.slice(2)) {
        stagedAtVerify.push([file, (await stat(file)).mode & 0o777])
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const lines = []
  const result = await installAgent({
    platform: 'linux',
    home,
    uid: 1001,
    username: 'videorc-lab',
    runner,
    nodePath: '/usr/bin/node',
    repoRoot: '/home/videorc-lab/videorc',
    log: (line) => lines.push(line)
  })
  assert.deepEqual(calls, [
    ['/usr/bin/systemd-analyze', '--user', 'verify', join(staging, SERVICE), join(staging, TIMER)],
    [SYSTEMCTL, '--user', 'daemon-reload'],
    [SYSTEMCTL, '--user', 'enable', '--now', TIMER],
    [SYSTEMCTL, '--user', 'is-enabled', TIMER],
    [SYSTEMCTL, '--user', 'is-active', TIMER],
    ['/usr/bin/loginctl', 'show-user', 'videorc-lab', '-p', 'Linger']
  ])
  assert.deepEqual(stagedAtVerify, [
    [join(staging, SERVICE), 0o644],
    [join(staging, TIMER), 0o644]
  ])
  assert.deepEqual((await readdir(unitDir)).sort(), [SERVICE, TIMER], 'no staging copy is left')
  for (const name of [SERVICE, TIMER]) {
    assert.equal((await stat(join(unitDir, name))).mode & 0o777, 0o644)
  }
  const service = await readFile(join(unitDir, SERVICE), 'utf8')
  assert.equal(service, result.rendered.service)
  assert.ok(
    settings(service).includes(`StandardOutput=append:${home}/videorc-live-lab/logs/schedule.log`)
  )
  assert.ok(settings(service).includes(`Environment=HOME=${home}`))
  await access(agentLogsDir(home))
  assert.deepEqual(result.paths, { service: join(unitDir, SERVICE), timer: join(unitDir, TIMER) })
  assert.equal(result.enabled, 'enabled')
  assert.equal(result.active, 'active')
  assert.equal(result.linger, 'yes')
  assert.ok(lines.some((line) => line.includes(`${TIMER}: is-enabled enabled, is-active active`)))
  assert.ok(lines.some((line) => /Linger is on for videorc-lab/.test(line)))
  assert.ok(!lines.some((line) => line.startsWith('WARNING')), lines.join('\n'))
})

test('Linux install-agent: a unit systemd-analyze rejects never lands, and the old units stay', async () => {
  const fresh = await freshDir()
  const rejected = {
    'systemd-analyze verify': {
      code: 1,
      stdout: '',
      stderr: 'videorc-live-lab.service:31: Unknown key name ExecStrat in section Service'
    }
  }
  const first = systemdRunner(rejected)
  await assert.rejects(
    installAgent({
      platform: 'linux',
      home: fresh,
      username: 'videorc-lab',
      runner: first.runner,
      nodePath: '/usr/bin/node'
    }),
    /systemd-analyze --user verify of the rendered units failed: .*Unknown key name ExecStrat/
  )
  assert.deepEqual(await readdir(systemdUserDir(fresh)), [], 'no unit and no staging copy')
  assert.equal(first.calls.length, 1, 'nothing is reloaded or enabled')

  const reinstall = await freshDir()
  const unitDir = systemdUserDir(reinstall)
  await mkdir(unitDir, { recursive: true })
  await writeFile(join(unitDir, SERVICE), 'old service')
  await writeFile(join(unitDir, TIMER), 'old timer')
  const second = systemdRunner(rejected)
  await assert.rejects(
    installAgent({
      platform: 'linux',
      home: reinstall,
      username: 'videorc-lab',
      runner: second.runner,
      nodePath: '/usr/bin/node'
    }),
    /rejected|failed/
  )
  assert.deepEqual((await readdir(unitDir)).sort(), [SERVICE, TIMER])
  assert.equal(await readFile(join(unitDir, SERVICE), 'utf8'), 'old service')
  assert.equal(await readFile(join(unitDir, TIMER), 'utf8'), 'old timer')
})

test('Linux install-agent refuses another user, naming the policy labUser, and a held run lock', async () => {
  const home = await freshDir()
  const { calls, runner } = systemdRunner()
  const base = { platform: 'linux', home, runner, nodePath: '/usr/bin/node' }
  await assert.rejects(
    installAgent({ ...base, username: 'orcdev' }),
    (error) =>
      error instanceof AgentRefusal &&
      /lab user videorc-lab only \(you are orcdev; labUser in the policy/.test(error.message)
  )
  await assert.rejects(
    installAgent({ ...base, username: 'videorc-lab', labUser: 'ogre-lab' }),
    (error) =>
      error instanceof AgentRefusal &&
      /lab user ogre-lab only \(you are videorc-lab;/.test(error.message)
  )
  await assert.rejects(uninstallAgent({ ...base, username: 'orcdev' }), AgentRefusal)
  await assert.rejects(
    installAgent({ ...base, username: 'videorc-lab', lockHolder: 'od-1, pid 7' }),
    (error) => error instanceof AgentRefusal && /would kill it/.test(error.message)
  )
  await assert.rejects(
    uninstallAgent({ ...base, username: 'videorc-lab', lockHolder: 'od-1, pid 7' }),
    /would kill it/
  )
  assert.deepEqual(calls, [], 'a refusal runs nothing')
  await assert.rejects(access(systemdUserDir(home)), { code: 'ENOENT' })
  await assert.rejects(
    installAgent({ ...base, platform: 'win32', username: 'videorc-lab' }),
    /The schedule agent runs on macOS or Linux only \(this is win32\)/
  )
})

test('Linux install-agent warns, without refusing, when linger is off or unreadable', async () => {
  const home = await freshDir()
  const off = systemdRunner({
    ...HEALTHY,
    'loginctl show-user': { code: 0, stdout: 'Linger=no\n', stderr: '' }
  })
  const lines = []
  const result = await installAgent({
    platform: 'linux',
    labUser: 'ogre-lab',
    home,
    username: 'ogre-lab',
    runner: off.runner,
    nodePath: '/usr/bin/node',
    log: (line) => lines.push(line)
  })
  assert.equal(result.linger, 'no')
  assert.deepEqual(off.calls.at(-1), ['/usr/bin/loginctl', 'show-user', 'ogre-lab', '-p', 'Linger'])
  const warning = lines.find((line) => line.startsWith('WARNING'))
  assert.match(
    warning,
    /linger is off for ogre-lab, so videorc-live-lab\.timer runs only while ogre-lab is logged in/
  )
  assert.match(warning, /sudo loginctl enable-linger ogre-lab$/)

  const unknown = systemdRunner({
    ...HEALTHY,
    'loginctl show-user': {
      code: 1,
      stdout: '',
      stderr: 'Failed to get user: User ID 1001 is not logged in or lingering'
    }
  })
  const more = []
  const unread = await installAgent({
    platform: 'linux',
    home,
    username: 'videorc-lab',
    runner: unknown.runner,
    nodePath: '/usr/bin/node',
    log: (line) => more.push(line)
  })
  assert.equal(unread.linger, null)
  assert.match(
    more.join('\n'),
    /WARNING: could not read linger for videorc-lab \(Failed to get user/
  )
})

test('Linux install-agent fails loudly when enabling fails, and says how to reach the user bus', async () => {
  const home = await freshDir()
  const enable = systemdRunner({
    'systemctl enable': {
      code: 1,
      stdout: '',
      stderr: 'Failed to enable unit: Unit file videorc-live-lab.timer is masked.'
    }
  })
  await assert.rejects(
    installAgent({
      platform: 'linux',
      home,
      username: 'videorc-lab',
      runner: enable.runner,
      nodePath: '/usr/bin/node'
    }),
    /systemctl --user enable --now videorc-live-lab\.timer failed: Failed to enable unit: .*masked\.$/
  )

  const noBus = systemdRunner({
    'systemctl daemon-reload': {
      code: 1,
      stdout: '',
      stderr: 'Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined'
    }
  })
  await assert.rejects(
    installAgent({
      platform: 'linux',
      home,
      username: 'videorc-lab',
      runner: noBus.runner,
      nodePath: '/usr/bin/node'
    }),
    /daemon-reload failed: Failed to connect to bus.*SSH in as videorc-lab, or use `sudo machinectl shell videorc-lab@`/
  )
})

test('Linux uninstall-agent disables the timer, stops the tick, removes both units and reloads', async () => {
  const home = await freshDir()
  const unitDir = systemdUserDir(home)
  await mkdir(unitDir, { recursive: true })
  await writeFile(join(unitDir, SERVICE), 'x')
  await writeFile(join(unitDir, TIMER), 'x')
  const { calls, options, runner } = systemdRunner()
  const lines = []
  const result = await uninstallAgent({
    platform: 'linux',
    home,
    uid: 1001,
    username: 'videorc-lab',
    lockHolder: 'od-1, pid 7',
    force: true,
    runner,
    log: (line) => lines.push(line)
  })
  assert.deepEqual(calls, [
    [SYSTEMCTL, '--user', 'disable', '--now', TIMER],
    [SYSTEMCTL, '--user', 'stop', SERVICE],
    [SYSTEMCTL, '--user', 'daemon-reload']
  ])
  assert.equal(options[1].timeout, 120_000, 'stopping a tick mid-run may take its 90 s')
  assert.equal(result.wasLoaded, true)
  assert.deepEqual(await readdir(unitDir), [])
  assert.match(lines.join('\n'), /Disabled and stopped videorc-live-lab\.timer/)

  const gone = systemdRunner({
    'systemctl disable': {
      code: 1,
      stdout: '',
      stderr: 'Failed to disable unit: Unit file videorc-live-lab.timer does not exist.'
    },
    'systemctl stop': {
      code: 5,
      stdout: '',
      stderr: 'Failed to stop videorc-live-lab.service: Unit videorc-live-lab.service not loaded.'
    }
  })
  const quiet = []
  const again = await uninstallAgent({
    platform: 'linux',
    home,
    username: 'videorc-lab',
    runner: gone.runner,
    log: (line) => quiet.push(line)
  })
  assert.equal(again.wasLoaded, false)
  assert.equal(gone.calls.length, 3)
  assert.match(
    quiet.join('\n'),
    /videorc-live-lab\.timer was not installed \(Failed to disable unit/
  )
})

test('status shows slots, the last 7 runs with verdicts, quota, lock and kill switch', async () => {
  const work = await freshDir('live-lab-work-')
  const lab = await freshDir('live-lab-lab-')
  const now = new Date('2026-10-12T02:35:00Z')
  const runs = join(work, 'runs')
  for (let index = 1; index <= 9; index += 1) {
    const name = `2026-10-0${index}-churn-r${index}`
    await mkdir(join(runs, name), { recursive: true })
    await writeFile(
      join(runs, name, 'manifest.json'),
      JSON.stringify({
        scenario: 'churn',
        trigger: 'schedule',
        build: { kind: 'release', version: '0.9.141' }
      })
    )
    if (index === 9)
      await writeFile(join(runs, name, 'verdict.json'), JSON.stringify({ verdict: 'pass' }))
  }
  await writeState(work, {
    version: 1,
    since: '2026-10-01T00:00:00.000Z',
    days: { '2026-10-12': { 'update-check': { status: 'passed' } } },
    history: [{ slotId: 'churn', status: 'failed', runDir: join(runs, '2026-10-08-churn-r8') }],
    lastBootDoctor: null,
    lastTick: { at: '2026-10-12T02:30:00.000Z', outcome: 'acted' }
  })
  createQuotaLedger({ dir: lab, maxUnitsPerDay: 8000, now: () => now }).charge(
    'liveBroadcasts.list',
    3
  )
  await writeFile(
    join(work, 'run.lock'),
    JSON.stringify({ pid: 31337, runId: 'od-4', startedAt: '2026-10-12T02:00:00Z' })
  )

  const policy = {
    enabled: true,
    schedule: { enabled: true, timezone: 'Europe/Madrid' },
    quota: { labProjectMaxUnitsPerDay: 8000 },
    killSwitchUrl: 'https://raw.githubusercontent.com/o/r/main/control.json'
  }
  const table = validateScheduleTable({
    version: 1,
    slots: [
      { id: 'update-check', at: '04:00', action: 'update-check' },
      { id: 'churn', at: '04:30', action: 'run', scenario: 'churn' }
    ]
  }).table
  const status = await gatherStatus({
    now,
    workDir: work,
    labDir: lab,
    loadPolicyFn: async () => ({ policy, problems: [], path: '/p' }),
    loadTableFn: async () => ({ table, problems: [] }),
    fetchControl: async () => ({ enabled: true }),
    isAlive: () => true
  })
  assert.equal(status.runs.length, 7)
  assert.equal(status.runs[0].name, '2026-10-09-churn-r9')
  assert.equal(status.runs[0].verdict, 'pass')
  assert.equal(status.runs[1].verdict, 'exit: failed')
  assert.equal(status.runs[2].verdict, null)
  assert.equal(status.runs[0].build, 'release 0.9.141')
  assert.equal(status.quota.units, 3)
  assert.equal(status.lock.alive, true)
  assert.deepEqual(status.control, { enabled: true, error: null })
  assert.equal(status.slots.length, 4)
  assert.deepEqual(
    status.slots.slice(0, 2).map((slot) => [slot.id, slot.local, slot.status ?? slot.when]),
    [
      ['update-check', 'Mon 2026-10-12 04:00', 'passed'],
      ['churn', 'Mon 2026-10-12 04:30', 'open']
    ]
  )
  const text = formatStatus(status).join('\n')
  assert.match(text, /policy +enabled yes, schedule yes/)
  assert.match(text, /run lock +held by od-4 \(pid 31337/)
  assert.match(text, /quota +3 of 8000 lab units/)
  assert.match(text, /control\.json +enabled yes/)
  assert.match(text, /2026-10-12 04:30 +churn +run churn +due now/)
  assert.match(text, /2026-10-09-churn-r9 +churn, schedule, release 0\.9\.141 +pass/)
  assert.match(text, /last tick +2026-10-12T02:30:00\.000Z: acted/)
})

test('status tolerates a missing policy, state, runs and an unreachable control file', async () => {
  const work = await freshDir('live-lab-work-')
  const status = await gatherStatus({
    now: new Date('2026-10-12T02:35:00Z'),
    workDir: work,
    labDir: work,
    loadPolicyFn: async () => ({ policy: null, problems: ['/p is missing'], path: '/p' }),
    loadTableFn: async () => ({ table: null, problems: ['bad table'] }),
    fetchControl: async () => {
      throw new Error('should not be called without a policy')
    }
  })
  assert.equal(status.policy.ok, false)
  assert.equal(status.control, null)
  assert.deepEqual(status.runs, [])
  const text = formatStatus(status).join('\n')
  assert.match(text, /policy +INVALID: \/p is missing/)
  assert.match(text, /schedule table INVALID: bad table/)
  assert.match(text, /none yet/)
  assert.match(text, /last tick +never/)
})
