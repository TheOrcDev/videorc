import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  lsofShowsOwnedTcpListener,
  netstatShowsOwnedTcpListener,
  ownedTcpListenerIsReady,
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
  assert.match(smoke, /'session\.start'/)
  assert.match(smoke, /appQuitRecordingSessionParams/)
  assert.match(smoke, /createFinalizationBarrierServer/)
  assert.match(smoke, /finalizationHoldMs <= minimumFinalizationHoldMs/)
  assert.match(smoke, /assertProcessesAliveWithoutReplacementFor/)
  assert.match(smoke, /readFinalizationRecoveryRecords/)
  assert.match(smoke, /heldDatabaseRow\.status, 'running'/)
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
  assert.match(
    backend,
    /let Some\(execution_deadline_completion\)[\s\S]*arm_runtime_independent_mutation_deadline[\s\S]*else \{[\s\S]*"command-not-applied"/
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

test('RTMP readiness waits for an owned listener without a fixed startup sleep', async () => {
  let probes = 0
  await waitForOwnedTcpListener({
    child: { pid: 421, exitCode: null },
    port: 19629,
    timeoutMs: 100,
    pollMs: 1,
    probe: () => ++probes === 2
  })
  assert.equal(probes, 2)
  assert.doesNotMatch(smoke, /await sleep\(750\)/)
  assert.match(smoke, /waitForOwnedTcpListener/)
})
