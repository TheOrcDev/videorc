// Attach to an ALREADY-RUNNING camera-permitted app (do not launch one).
// Args via env: H=backendHost P=backendPort T=token  CH=cmdHost CP=cmdPort C=cmdCapability
import { request as httpRequest } from 'node:http'
import { createWriteStream } from 'node:fs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const H = process.env.H, P = Number(process.env.P), T = process.env.T
const CH = process.env.CH, CP = Number(process.env.CP), C = process.env.C
const timeoutMs = 30000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cmd(command, params = {}) {
  if (!C) throw new Error('C=cmdCapability is required when using the smoke command server.')
  const body = JSON.stringify({ command, params })
  return new Promise((res) => {
    const req = httpRequest(
      { hostname: CH, port: CP, path: '/command', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${C}` } },
      (r) => { r.setEncoding('utf8'); let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => { try { res(JSON.parse(t).result ?? JSON.parse(t)) } catch { res({ raw: t.slice(0, 150) }) } }) }
    )
    req.on('error', (e) => res({ err: String(e?.message ?? e) })); req.write(body); req.end()
  })
}
function fetchToFile(path, out) {
  return new Promise((res) => {
    const sep = path.includes('?') ? '&' : '?'
    const req = httpRequest({ hostname: H, port: P, path: `${path}${sep}token=${encodeURIComponent(T)}`, method: 'GET' }, (r) => {
      if (r.statusCode !== 200) { let t = ''; r.setEncoding('utf8'); r.on('data', (c) => (t += c)); r.on('end', () => res({ ok: false, status: r.statusCode, body: t.slice(0, 80) })); return }
      const ws = createWriteStream(out); let b = 0; r.on('data', (c) => (b += c.length)); r.pipe(ws); ws.on('finish', () => res({ ok: true, bytes: b, out }))
    })
    req.on('error', (e) => res({ err: String(e?.message ?? e) })); req.end()
  })
}

const pick = (d) => ({
  camFps: d.previewCameraSourceFps, camFrameAgeMs: d.previewCameraFrameAgeMs,
  camCaptureGapP95: d.previewCameraCaptureGapP95Ms, camCaptureGapMax: d.previewCameraCaptureGapMaxMs,
  camSourceFrameBufferCount: d.previewSourceFrameBufferCount, camDropped: d.previewCameraDroppedFrames,
  presentFps: d.previewPresentFps, presentLatencyMs: d.previewInputToPresentLatencyMs,
  presentLatencyP95: d.previewInputToPresentLatencyP95Ms, compFrameLag: d.previewCompositorFrameLag,
  compRenderFps: d.renderFps, compTickGapP95: d.compositorTickGapP95Ms, compFetchP95: d.compositorCameraFrameFetchP95Ms,
  previewFrameAgeMs: d.previewFrameAgeMs, previewLatencyMs: d.previewLatencyMs
})

const ws = await connectBackend({ host: H, port: P, token: T }, timeoutMs)
try {
  const devs = await request(ws, timeoutMs, 'devices.list', { ffmpegPath: '/opt/homebrew/bin/ffmpeg' })
  const cams = (devs.devices ?? []).filter((d) => d.kind === 'camera')
  console.log('CAMERAS ->', JSON.stringify(cams.map((c) => ({ name: c.name, status: c.status, id: c.id.slice(0, 40) }))))
  if (CH && CP) {
    console.log('open-tab studio ->', JSON.stringify(await cmd('open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-stage]' })))
    await sleep(2500)
  }
  for (let i = 0; i < 6; i += 1) {
    const d = await request(ws, timeoutMs, 'diagnostics.stats')
    console.log(`diag[${i}]`, JSON.stringify(pick(d)))
    await sleep(1500)
  }
  console.log('\ncamera.status ->', JSON.stringify(await request(ws, timeoutMs, 'preview.camera.status')))
  console.log('compositor.status ->', JSON.stringify(await request(ws, timeoutMs, 'compositor.status')))
  if (CH && CP) {
    console.log('\nbootstrap ->', JSON.stringify(await cmd('inspect-native-preview-bootstrap')))
    console.log('badges ->', JSON.stringify(await cmd('inspect-preview-stage-badges')))
    console.log('measure ->', JSON.stringify(await cmd('measure-native-preview-surface', { durationMs: 2000 })))
  }
  console.log('\n--- fetch frames ---')
  console.log('camera.png ->', JSON.stringify(await fetchToFile('/preview/camera/live.png', '/tmp/vrc_real_camera.png')))
  console.log('live.jpg ->', JSON.stringify(await fetchToFile('/preview/live.jpg', '/tmp/vrc_real_live.jpg')))
} finally {
  try { ws.close() } catch { /* ignore */ }
  console.log('=== attach done ===')
}
