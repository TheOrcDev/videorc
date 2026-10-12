import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createQuotaLedger } from './quota-ledger.mjs'
import {
  AGENT_LABEL,
  AgentRefusal,
  TEMPLATE_PATH,
  agentLogsDir,
  agentPlistPath,
  installAgent,
  renderAgentPlist,
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
    installAgent({ home, uid: 501, username: 'orcdev', runner, nodePath: '/n' }),
    (error) => error instanceof AgentRefusal && /videorc-lab only/.test(error.message)
  )
  await assert.rejects(uninstallAgent({ home, uid: 501, username: 'orcdev', runner }), AgentRefusal)
  assert.deepEqual(calls, [])
})

test('install-agent refuses while a run holds the lock unless --force', async () => {
  const home = await freshDir()
  const { calls, runner } = fakeRunner()
  await assert.rejects(
    installAgent({
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
    installAgent({ home, uid: 501, username: 'videorc-lab', runner: lint.runner, nodePath: '/n' }),
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
    installAgent({ home, uid: 501, username: 'videorc-lab', runner: boot.runner, nodePath: '/n' }),
    /launchctl bootstrap gui\/501 failed: Bootstrap failed/
  )
})

test('uninstall-agent boots out and removes the plist', async () => {
  const home = await freshDir()
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(agentPlistPath(home), 'x')
  const { calls, runner } = fakeRunner()
  const result = await uninstallAgent({ home, uid: 501, username: 'videorc-lab', runner })
  assert.equal(result.wasLoaded, true)
  assert.deepEqual(calls, [['/bin/launchctl', 'bootout', `gui/501/${AGENT_LABEL}`]])
  await assert.rejects(access(agentPlistPath(home)), { code: 'ENOENT' })
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
