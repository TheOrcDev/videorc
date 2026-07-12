// OBS import smoke (plan O6): boot the dev app against a FIXTURE OBS root and
// prove the import surface end-to-end over the real IPC — discovery finds the
// fixture, the setup payload carries the collection WITHOUT the stream key,
// and the key arrives only through the dedicated apply-time channel.
//
// Run: pnpm smoke:obs-import

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const fixtures = join(repoRoot, 'apps/desktop/src/main/obs-fixtures')

// Assemble a fake OBS root from the scrubbed fixtures.
const obsRoot = mkdtempSync(join(tmpdir(), 'videorc-obs-smoke-'))
mkdirSync(join(obsRoot, 'basic', 'scenes'), { recursive: true })
mkdirSync(join(obsRoot, 'basic', 'profiles', 'Fixture Profile'), { recursive: true })
writeFileSync(
  join(obsRoot, 'basic', 'scenes', 'Fixture Collection.json'),
  readFileSync(join(fixtures, 'collection.json'))
)
writeFileSync(
  join(obsRoot, 'basic', 'profiles', 'Fixture Profile', 'basic.ini'),
  readFileSync(join(fixtures, 'basic.ini'))
)
writeFileSync(
  join(obsRoot, 'basic', 'profiles', 'Fixture Profile', 'service.json'),
  readFileSync(join(fixtures, 'service.json'))
)
writeFileSync(
  join(obsRoot, 'global.ini'),
  '[Basic]\nSceneCollection=Fixture Collection\nProfile=Fixture Profile\n'
)

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_OBS_ROOT: obsRoot
  }
})

try {
  const smoke = launched.connections['preview-motion-ready']

  const discovery = await evalJs(smoke, 'return await window.videorc.obsDiscover()')
  assertLike(discovery, 'discovery', (value) => value?.available === true)
  assertLike(
    discovery,
    'current collection',
    (value) => value?.currentCollection === 'Fixture Collection'
  )

  const setup = await evalJs(
    smoke,
    "return await window.videorc.obsRead('Fixture Collection', 'Fixture Profile')"
  )
  assertLike(setup, 'canvas', (value) => value?.canvasWidth === 3840 && value?.fps === 24)
  assertLike(setup, 'scenes', (value) => Array.isArray(value?.scenes) && value.scenes.length > 1)
  assertLike(setup, 'service without key', (value) => value?.service?.hasKey === true)
  if (JSON.stringify(setup).includes('fixture-not-a-real-key')) {
    throw new Error('obs:read leaked the stream key into the discovery payload.')
  }

  const key = await evalJs(smoke, "return await window.videorc.obsReadStreamKey('Fixture Profile')")
  if (key !== 'fixture-not-a-real-key') {
    throw new Error('obs:read-stream-key did not return the fixture key at apply time.')
  }

  console.log(
    'OBS import smoke OK — fixture root discovered, setup read (key stripped), apply-time key channel verified.'
  )
} finally {
  await stopProcess(launched.child, { timeoutMs: 15000 })
}

process.exit(0)

function assertLike(value, label, predicate) {
  if (!predicate(value)) {
    throw new Error(
      `OBS import smoke: unexpected ${label}: ${JSON.stringify(value)?.slice(0, 400)}`
    )
  }
}

async function evalJs(smoke, code) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await sendSmokeCommand(smoke, 'eval-js', { code })
      return result?.result ?? result
    } catch (error) {
      lastError = error
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 300))
    }
  }
  throw lastError ?? new Error('Timed out waiting for eval-js.')
}

function sendSmokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${smoke.capability}`
        }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (res.statusCode !== 200) {
              rejectPromise(new Error(payload.error ?? `HTTP ${res.statusCode}`))
            } else {
              resolvePromise(payload.result ?? payload)
            }
          } catch {
            rejectPromise(
              new Error(`Bad smoke response (${res.statusCode}): ${text.slice(0, 300)}`)
            )
          }
        })
      }
    )
    req.on('error', rejectPromise)
    req.setTimeout(15000, () => req.destroy(new Error('smoke command timeout')))
    req.end(body)
  })
}
