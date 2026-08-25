import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const smoke = readFileSync(join(root, 'scripts', 'smoke-command-lanes.mjs'), 'utf8')
const backend = readFileSync(join(root, 'crates', 'videorc-backend', 'src', 'main.rs'), 'utf8')

test('command-lane failure injection stays in the maintained local gate', () => {
  assert.equal(packageJson.scripts['smoke:command-lanes'], 'node scripts/smoke-command-lanes.mjs')
  assert.match(packageJson.scripts['smoke:local-gates'], /pnpm smoke:command-lanes/)
})

test('command-lane smoke uses one explicitly enabled debug backend socket', () => {
  assert.match(smoke, /VIDEORC_ENABLE_SMOKE_RPC: '1'/)
  assert.equal(
    [...smoke.matchAll(/connectBackend\(/g)].length,
    1,
    'the blocker and all lane probes must share one WebSocket'
  )
  assert.doesNotMatch(
    smoke,
    /token:\s*ready\.adminToken/,
    'the proof must use the renderer credential, not an admin-role socket'
  )
  for (const method of [
    'diagnostics.stats',
    'screens.clear',
    'scene.layout.apply_preview',
    'captions.stop',
    'liveChat.send',
    'session.stop'
  ]) {
    assert.match(smoke, new RegExp(`['"]${method.replace('.', '\\.')}['"]`))
  }
})

test('readiness is an observable status RPC classified outside AccountMaintenance', () => {
  const methods = [
    'test.commandLanes.accountMaintenance.block',
    'test.commandLanes.accountMaintenance.status',
    'test.commandLanes.accountMaintenance.release'
  ]
  for (const method of methods) {
    assert.match(smoke, new RegExp(method.replaceAll('.', '\\.')))
    assert.match(backend, new RegExp(method.replaceAll('.', '\\.')))
  }
  assert.match(backend, /COMMAND_LANE_SMOKE_STATUS_METHOD[\s\S]*websocket_command_is_read_only/)
  assert.match(
    smoke,
    /waitForActiveGeneration\([\s\S]*client\.ok\(STATUS_METHOD/,
    'the blocker must be observed by status polling rather than a fixed delay'
  )
})
