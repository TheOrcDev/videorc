// Autonomous preview/recording diagnostics probe.
//
// Launches the real dev app (NO native-preview env override by default, so it
// reproduces exactly what the user gets), opens the Studio layout tab via the
// smoke command channel, then dumps the live compositor/preview diagnostics so
// we can see the actual preview transport and WHY it falls back — without
// needing UI Accessibility permission or the backend token by hand.
//
// Usage: node scripts/diag-probe.mjs
// Env knobs (all optional):
//   VIDEORC_PROBE_RECORD=1   also start a short recording and sample during it
//   VIDEORC_PROBE_SAMPLES=10 number of idle diagnostics samples
//   plus any VIDEORC_* the app honors (pass-through), e.g.
//   VIDEORC_NATIVE_PREVIEW_SURFACE / VIDEORC_EXPECT_NATIVE_METAL_PREVIEW

import { request as httpRequest } from 'node:http'
import { createWriteStream } from 'node:fs'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 120000)
const idleSamples = Number(process.env.VIDEORC_PROBE_SAMPLES ?? 10)
const doRecord = process.env.VIDEORC_PROBE_RECORD === '1'

const KEYS = [
  'previewTransport',
  'previewSurfaceBacking',
  'compositorBackend',
  'compositorFallbackReason',
  'compositorCpuFallbackFrames',
  'compositorFrames',
  'metalTargetIosurfaceId',
  'metalTargetIosurfaceWidth',
  'previewPresentFps',
  'previewInputToPresentLatencyMs',
  'previewInputToPresentLatencyP95Ms',
  'previewCompositorFrameLag',
  'previewSourcePixelsPresent',
  'previewSourceFps',
  'previewCameraSourceFps',
  'previewCameraFrameAgeMs',
  'activeSceneRevision',
  'captureFps',
  'renderFps'
]

function fetchToFile(host, port, path, token, outPath) {
  return new Promise((resolveFetch) => {
    const sep = path.includes('?') ? '&' : '?'
    const req = httpRequest(
      { hostname: host, port, path: `${path}${sep}token=${encodeURIComponent(token)}`, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          let t = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (t += c))
          res.on('end', () => resolveFetch({ ok: false, status: res.statusCode, body: t.slice(0, 120) }))
          return
        }
        const ct = res.headers['content-type']
        const ws = createWriteStream(outPath)
        let bytes = 0
        res.on('data', (c) => (bytes += c.length))
        res.pipe(ws)
        ws.on('finish', () => resolveFetch({ ok: true, status: 200, bytes, contentType: ct, outPath }))
      }
    )
    req.on('error', (e) => resolveFetch({ ok: false, error: String(e?.message ?? e) }))
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCmd, rejectCmd) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${smoke.capability}` }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            resolveCmd(payload.result ?? payload)
          } catch {
            rejectCmd(new Error(`${command} -> invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', rejectCmd)
    req.write(body)
    req.end()
  })
}

async function smokeCommandRetry(smoke, command, params = {}) {
  const deadline = Date.now() + 20000
  let last
  while (Date.now() < deadline) {
    try {
      return await smokeCommand(smoke, command, params)
    } catch (e) {
      last = e
      const m = String(e?.message ?? e)
      if (!m.includes('Main window is not ready') && !m.includes('Could not find tab')) throw e
      await sleep(200)
    }
  }
  throw last
}

function pick(d) {
  const out = {}
  for (const k of KEYS) if (d[k] !== undefined) out[k] = d[k]
  if (d.previewImagePollCounts) out.previewImagePollCounts = d.previewImagePollCounts
  return out
}

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    // Command server WITHOUT the synthetic motion stimulus, so the renderer uses
    // the real saved camera instead of an injected synthetic-compositor source.
    VIDEORC_SMOKE_COMMAND_SERVER: '1'
  },
  onLine: (line) => {
    if (/error|fallback|panic|warn|native preview|handoff|iosurface|compositor/i.test(line)) {
      console.log('APP>', line)
    }
  }
})

const backend = launched.connections['backend-ready']
const smoke = launched.connections['preview-motion-ready']
console.log('\n=== CONNECTIONS ===')
console.log('backend', JSON.stringify({ host: backend.host, port: backend.port }))
console.log('smoke  ', JSON.stringify(smoke))

let ws
try {
  ws = await connectBackend(backend, timeoutMs)

  console.log('\n=== open Studio tab ===')
  for (const attempt of [
    ['open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-stage]' }],
    ['open-layout-tab', {}]
  ]) {
    try {
      const opened = await smokeCommandRetry(smoke, attempt[0], attempt[1])
      console.log(attempt[0], '->', JSON.stringify(opened))
      break
    } catch (e) {
      console.log(attempt[0], 'FAILED:', String(e?.message ?? e))
    }
  }

  // Let the surface driver + scene push settle.
  await sleep(5000)

  console.log('\n=== IDLE diagnostics samples ===')
  let full
  for (let i = 0; i < idleSamples; i += 1) {
    full = await request(ws, timeoutMs, 'diagnostics.stats')
    console.log(`idle[${i}]`, JSON.stringify(pick(full)))
    await sleep(1000)
  }

  if (full) {
    console.log('\n=== ALL diagnostics keys ===')
    console.log(Object.keys(full).sort().join(', '))
  }

  // Renderer-side view of the preview stage.
  console.log('\n=== renderer bootstrap / badges / runtime ===')
  for (const cmd of [
    'inspect-native-preview-bootstrap',
    'inspect-preview-stage-badges',
    'inspect-native-preview-runtime'
  ]) {
    try {
      const r = await smokeCommandRetry(smoke, cmd)
      console.log(cmd, '->', JSON.stringify(r))
    } catch (e) {
      console.log(cmd, 'FAILED:', String(e?.message ?? e))
    }
  }

  console.log('\n=== fetch composited preview frames to disk (for visual check) ===')
  for (const [path, out] of [
    ['/preview/live.jpg', '/tmp/vrc_live.jpg'],
    ['/preview/camera/live.png', '/tmp/vrc_camera.png']
  ]) {
    const r = await fetchToFile(backend.host, backend.port, path, backend.token, out)
    console.log(path, '->', JSON.stringify(r))
  }

  if (doRecord) {
    console.log('\n=== start recording, sample during record ===')
    try {
      const started = await request(ws, timeoutMs, 'recording.start', {})
      console.log('recording.start ->', JSON.stringify(started))
    } catch (e) {
      console.log('recording.start FAILED:', String(e?.message ?? e))
    }
    for (let i = 0; i < 6; i += 1) {
      await sleep(1000)
      const d = await request(ws, timeoutMs, 'diagnostics.stats')
      console.log(`rec[${i}]`, JSON.stringify(pick(d)))
    }
    try {
      const stopped = await request(ws, timeoutMs, 'recording.stop', {})
      console.log('recording.stop ->', JSON.stringify(stopped))
    } catch (e) {
      console.log('recording.stop FAILED:', String(e?.message ?? e))
    }
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  await launched.stop()
  console.log('\n=== probe done ===')
}
