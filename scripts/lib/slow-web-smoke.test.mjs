import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const smoke = readFileSync(join(root, 'scripts', 'smoke-slow-web.mjs'), 'utf8')
const backend = readFileSync(join(root, 'crates', 'videorc-backend', 'src', 'main.rs'), 'utf8')
const api = readFileSync(join(root, 'crates', 'videorc-backend', 'src', 'videorc_api.rs'), 'utf8')

test('the slow-web proof stays in the maintained local gate', () => {
  assert.equal(packageJson.scripts['smoke:slow-web'], 'node scripts/smoke-slow-web.mjs')
  assert.match(packageJson.scripts['smoke:local-gates'], /pnpm smoke:slow-web/)
})

test('the slow-web smoke holds the web past the request timeout on one renderer socket', () => {
  assert.equal(
    [...smoke.matchAll(/connectBackend\(/g)].length,
    1,
    'the held commands and the local-control probes must share one WebSocket'
  )
  assert.doesNotMatch(
    smoke,
    /token:\s*ready\.adminToken/,
    'the proof must use the renderer credential, not an admin-role socket'
  )
  // The backend's cloud requests give up after 10 s, which was also the
  // focus check's whole mutation contract: the hold must outlast both.
  const requestTimeoutSeconds = Number(
    api.match(/const CLOUD_REQUEST_TIMEOUT[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/)?.[1]
  )
  const holdMs = Number(smoke.match(/const CURRENT_SHOW_HOLD_MS = ([\d_]+)/)?.[1].replaceAll('_', ''))
  assert.ok(Number.isFinite(requestTimeoutSeconds), 'CLOUD_REQUEST_TIMEOUT not found')
  assert.ok(
    holdMs > requestTimeoutSeconds * 1000,
    `the hold (${holdMs} ms) must outlast the ${requestTimeoutSeconds} s request timeout`
  )
  assert.match(smoke, /VIDEORC_API_BASE_URL: proxy\.origin/, 'the backend must talk to the proxy')
  assert.doesNotMatch(smoke, /videorc\.com\//, 'the smoke never names a real videorc.com URL')
})

test('the commands the smoke holds and probes sit where the proof assumes', () => {
  for (const method of ['cloud.allowance.refresh', 'cloud.show.check']) {
    assert.match(smoke, new RegExp(`'${method.replaceAll('.', '\\.')}'`))
    assert.match(backend, new RegExp(`"${method.replaceAll('.', '\\.')}"`))
  }
  // The probes are ordered-lane controls: none may have an isolated lane, or
  // the smoke would pass without proving anything about the ordered lane.
  const lanes = backend
    .split('fn websocket_isolated_command_lane(text: &str)')[1]
    .split('\n}\n')[0]
  for (const method of [
    'audio.processing.update',
    'replay.save',
    'session.marker.create',
    'scene.editor.draft.clear'
  ]) {
    assert.match(smoke, new RegExp(`'${method.replaceAll('.', '\\.')}'`))
    assert.doesNotMatch(
      lanes,
      new RegExp(`"${method.replaceAll('.', '\\.')}"`),
      `${method} must stay on the ordered lane`
    )
  }
  assert.match(lanes, /"cloud\.allowance\.refresh"/, 'the held command must be web-bound')
})
