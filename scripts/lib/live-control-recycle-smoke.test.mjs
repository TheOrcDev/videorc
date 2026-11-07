import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  lsofShowsOwnedTcpListener,
  netstatShowsOwnedTcpListener,
  ownedTcpListenerIsReady,
  procFdLinksHoldSocket,
  procTcpListenerInodes,
  waitForOwnedTcpListener
} from './live-control-recycle-smoke.mjs'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const smoke = readFileSync(join(root, 'scripts', 'smoke-live-control-recycle.mjs'), 'utf8')
const backend = readFileSync(join(root, 'crates', 'videorc-backend', 'src', 'main.rs'), 'utf8')
const authority = readFileSync(
  join(root, 'crates', 'videorc-backend', 'src', 'backend_authority.rs'),
  'utf8'
)

test('live-control recycle proof is a maintained local gate', () => {
  assert.equal(
    packageJson.scripts['smoke:live-control-recycle'],
    'node scripts/smoke-live-control-recycle.mjs'
  )
  assert.match(packageJson.scripts['smoke:local-gates'], /pnpm smoke:live-control-recycle/)
  assert.match(packageJson.scripts['smoke:local-gates'], /pnpm probe:comments-window/)
})

test('local gates fail fast before starting endurance decay runs', () => {
  const localGates = packageJson.scripts['smoke:local-gates']
  const lastFastGate = localGates.indexOf('pnpm smoke:process-memory:sentinel')
  assert.ok(lastFastGate >= 0)
  for (const enduranceGate of [
    'pnpm smoke:session-decay:gate',
    'pnpm smoke:capture-decay-soak:gate',
    'pnpm smoke:capture-decay-soak:long-recording'
  ]) {
    assert.ok(
      localGates.indexOf(enduranceGate) > lastFastGate,
      `${enduranceGate} must run after fast control and resilience gates`
    )
  }
})

test('smoke uses the debug renderer seam and proves exact generation replacement', () => {
  assert.match(smoke, /VIDEORC_ENABLE_SMOKE_RPC: '1'/)
  assert.match(smoke, /test\.commandLanes\.liveControl\.block/)
  assert.match(smoke, /replacement\.pid, oldBackendPid/)
  assert.match(smoke, /waitForPidExit\(oldBackendPid/)
  assert.match(smoke, /request\(newSocket, 2_000, 'health\.ping'/)
  assert.match(authority, /"test\.commandLanes\.liveControl\.block"/)
})

test('recycle proof runs during a recording and analyzes the safely finalized MP4', () => {
  // The start route comes from the shared helper: `session.start` on the
  // renderer socket, or `recording.start_test` through the admin bridge when
  // the session names the barrier shim.
  assert.match(smoke, /finalizationBarrierSessionStart\(sessionParams\)/)
  assert.match(smoke, /'backend-debug-rpc'/)
  assert.match(smoke, /request\(oldSocket, timeoutMs, sessionStart\.method, sessionParams\)/)
  assert.match(smoke, /microphoneAvailable: sessionSelectsMicrophone\(sessionParams\.sources\)/)
  assert.match(smoke, /appQuitRecordingSessionParams/)
  assert.match(smoke, /createFinalizationBarrierServer/)
  assert.match(smoke, /finalizationHoldMs <= minimumFinalizationHoldMs/)
  assert.match(smoke, /assertProcessesAliveWithoutReplacementFor/)
  assert.match(smoke, /readFinalizationRecoveryRecords/)
  assert.match(smoke, /heldDatabaseRow\.status, 'completed'/)
  assert.match(smoke, /heldDatabaseRow\.finalization_state, 'finalizing'/)
  assert.match(smoke, /heldDatabaseRow\.mp4_path, null/)
  assert.match(smoke, /barrier\.release\(\)/)
  assert.match(smoke, /analyzeRecording\(mp4Path/)
  assert.match(smoke, /quality\.verdict\.pass/)
  assert.match(smoke, /streamEnabled: true/)
  assert.match(smoke, /spawnRtmpListener/)
  assert.match(smoke, /The retired generation kept the live stream connection open/)
})

test('replacement proof requires a Studio-renderer scene commit with an exact ACK', () => {
  assert.match(smoke, /remote\.control\.enable/)
  assert.match(smoke, /'compositor\.status'/)
  assert.match(smoke, /source:test-pattern/)
  assert.doesNotMatch(smoke, /replacement Studio screen source readiness/)
  assert.ok(
    smoke.indexOf('await waitForRemoteDescribe(remote') <
      smoke.indexOf("await requestSmokeCommand(smoke, 'enable-synthetic-source'"),
    'Studio must publish idle replacement state before the smoke touches session-locked controls'
  )
  assert.match(smoke, /kind: 'sceneApply'/)
  assert.match(smoke, /sceneAck\?\.intentId/)
  assert.match(smoke, /sceneTicket\.payload\.intentId/)
  assert.match(smoke, /sceneAck\?\.ok, true/)
  assert.match(smoke, /sceneLayout\?\.layoutPreset === 'screen-only'/)
})

test('production lane cannot dispatch without an independent deadline', () => {
  const wrapper = backend.match(
    /\nfn spawn_websocket_mutation_execution<Retention>\([\s\S]*?\n\}/
  )?.[0]
  const helper = backend.match(
    /\nfn spawn_websocket_mutation_execution_with_deadline<Retention, Arm>\([\s\S]*?\n\}/
  )?.[0]
  const responseOwner = backend.match(
    /\nasync fn run_websocket_mutation_with_deadline\([\s\S]*?\n\}/
  )?.[0]
  assert.ok(wrapper, 'production mutation wrapper must exist')
  assert.ok(helper, 'production mutation execution helper must exist')
  assert.ok(responseOwner, 'production mutation response owner must exist')
  assert.match(
    wrapper,
    /spawn_websocket_mutation_execution_with_deadline\(\s*executor,\s*state,\s*text,\s*handler,\s*retention,\s*stateful_tracker,\s*move \|deadline_state\| \{\s*arm_runtime_independent_mutation_deadline\(deadline_state, max_execution_age\)\s*\},\s*\)/
  )
  const missingDeadline = helper.match(
    /let Some\(execution_deadline_completion\) = arm\(state\.clone\(\)\) else \{[\s\S]*?return Err\(WebSocketMutationStartFailure::DeadlineUnavailable\);\s*\};/
  )
  assert.ok(missingDeadline, 'missing completion must return DeadlineUnavailable')
  const dispatch = helper.indexOf('executor.spawn(')
  assert.ok(
    dispatch > missingDeadline.index + missingDeadline[0].length,
    'missing-deadline refusal must precede the first executor dispatch'
  )
  assert.match(
    responseOwner,
    /let mut execution = match spawn_websocket_mutation_execution\([\s\S]*?max_execution_age,\s*\) \{[\s\S]*?Err\(_failure\) => \{[\s\S]*?ServerResponse::error\(\s*command_id,\s*"command-not-applied",[\s\S]*?return WebSocketMutationDispatchResult \{\s*response_queued,\s*handler_terminal: true,\s*\};\s*\}\s*\};/
  )
  assert.match(backend, /worker_threads\(backend_runtime_worker_threads\(\)\)/)
  assert.match(backend, /\.unwrap_or\(2\)[\s\S]*\.max\(2\)/)
})

test('RTMP readiness requires the exact child PID to own the listening port', () => {
  assert.equal(lsofShowsOwnedTcpListener('p421\nn127.0.0.1:19629\n', 421, 19629), true)
  assert.equal(lsofShowsOwnedTcpListener('p422\nn127.0.0.1:19629\n', 421, 19629), false)
  assert.equal(
    netstatShowsOwnedTcpListener(
      '  TCP    127.0.0.1:19629    0.0.0.0:0    LISTENING    421\r\n',
      421,
      19629
    ),
    true
  )
  assert.equal(
    netstatShowsOwnedTcpListener(
      '  TCP    127.0.0.1:19629    0.0.0.0:0    LISTENING    422\r\n',
      421,
      19629
    ),
    false
  )
})

test('RTMP readiness treats an empty lsof query as not ready and rejects probe errors', () => {
  assert.equal(
    ownedTcpListenerIsReady({
      pid: 421,
      port: 19629,
      platform: 'darwin',
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' })
    }),
    false
  )
  assert.throws(
    () =>
      ownedTcpListenerIsReady({
        pid: 421,
        port: 19629,
        platform: 'darwin',
        spawnSyncImpl: () => ({ error: new Error('lsof missing') })
      }),
    /Could not inspect the local RTMP listener socket/
  )
})

const PROC_TCP_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
// 19629 is 0x4CAD.
const PROC_TCP = [
  PROC_TCP_HEADER,
  '   0: 0100007F:4CAD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0000 100 0 0 10 0',
  '   1: 0100007F:4CAD 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 5552 1 0000 20 4 30 10 -1',
  '   2: 0100007F:4CAE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5553 1 0000 100 0 0 10 0'
].join('\n')
const PROC_TCP6 = [
  PROC_TCP_HEADER,
  '   0: 00000000000000000000000000000000:4CAD 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6661 1 0000 100 0 0 10 0'
].join('\n')

function fakeProc({ tables = { tcp: PROC_TCP, tcp6: PROC_TCP6 }, fds = {} } = {}) {
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  return {
    readFile(path) {
      const table = tables[path.replace('/proc/net/', '')]
      if (table instanceof Error) throw table
      if (table === undefined) throw missing(path)
      return table
    },
    readdir(path) {
      const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1]
      if (!fds[pid]) throw missing(path)
      return Object.keys(fds[pid])
    },
    readlink(path) {
      const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)
      const link = fds[pid]?.[fd]
      if (link === undefined) throw missing(path)
      return link
    }
  }
}

test('Linux RTMP readiness reads the listening inodes from /proc/net', () => {
  assert.deepEqual([...procTcpListenerInodes([PROC_TCP, PROC_TCP6], 19629)], ['5551', '6661'])
  assert.deepEqual([...procTcpListenerInodes([PROC_TCP], 19631)], [])
  assert.equal(procFdLinksHoldSocket(['/dev/null', 'socket:[5551]'], new Set(['5551'])), true)
  assert.equal(procFdLinksHoldSocket(['socket:[5552]', 'pipe:[5551]'], new Set(['5551'])), false)
})

test('Linux RTMP readiness requires the exact child PID to hold the listening socket', () => {
  const proc = fakeProc({
    fds: {
      421: { 0: '/dev/null', 3: 'socket:[6661]' },
      422: { 3: 'socket:[5551]' },
      423: { 3: 'socket:[5552]' }
    }
  })
  const ready = (pid, extra = {}) =>
    ownedTcpListenerIsReady({
      pid,
      port: 19629,
      platform: 'linux',
      spawnSyncImpl: () => assert.fail('Linux must not run lsof'),
      procImpl: proc,
      ...extra
    })
  assert.equal(ready(421), true)
  assert.equal(ready(422), true)
  // An accepted connection on the port is not the listener.
  assert.equal(ready(423), false)
  // Gone, or not bound yet: not ready, and the caller reports the exit.
  assert.equal(ready(424), false)
  assert.equal(ready(421, { port: 19631 }), false)
})

test('Linux RTMP readiness tolerates a host without IPv6 and rejects unreadable tables', () => {
  const ipv4Only = fakeProc({ tables: { tcp: PROC_TCP }, fds: { 422: { 3: 'socket:[5551]' } } })
  assert.equal(
    ownedTcpListenerIsReady({ pid: 422, port: 19629, platform: 'linux', procImpl: ipv4Only }),
    true
  )
  const denied = fakeProc({
    tables: { tcp: Object.assign(new Error('EACCES: /proc/net/tcp'), { code: 'EACCES' }) }
  })
  assert.throws(
    () => ownedTcpListenerIsReady({ pid: 422, port: 19629, platform: 'linux', procImpl: denied }),
    /Could not inspect the local RTMP listener socket: EACCES/
  )
})

test('RTMP readiness waits for an owned listener without a fixed startup sleep', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let probes = 0
  const ready = waitForOwnedTcpListener({
    child: { pid: 421, exitCode: null },
    port: 19629,
    timeoutMs: 100,
    pollMs: 1,
    probe: () => ++probes === 2
  })
  t.mock.timers.tick(1)
  await ready
  assert.equal(probes, 2)
  assert.doesNotMatch(smoke, /await sleep\(750\)/)
  assert.match(smoke, /waitForOwnedTcpListener/)
})

test('RTMP readiness still refuses a listener absent at its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const ready = waitForOwnedTcpListener({
    child: { pid: 421, exitCode: null },
    port: 19629,
    timeoutMs: 100,
    probe: () => false
  })
  const rejected = assert.rejects(ready, /did not bind port 19629 within 100ms/)
  t.mock.timers.tick(100)
  await rejected
})
