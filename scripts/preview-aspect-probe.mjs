// Preview-window aspect-lock probe.
//
// NSWindow's aspect-ratio constraint only applies to USER drag-resizes; macOS
// tiling, third-party window managers, and programmatic setBounds all bypass it
// and can squeeze the preview. This probe drives that exact hole through the
// smoke command channel and asserts the video region snaps back to the output
// ratio, so the lock is verified end-to-end without a human dragging windows.
//
// Usage: node scripts/preview-aspect-probe.mjs

import { request as httpRequest } from 'node:http'

import { launchDevApp } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 120000)
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
            if (payload.error) rejectCmd(new Error(`${command} -> ${payload.error}`))
            else resolveCmd(payload.result ?? payload)
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

// The video region (state.contentBounds) must match the output ratio; the
// baseline right after open is the reference since main conforms it on create.
function ratioOf(bounds) {
  return bounds.width / Math.max(1, bounds.height)
}

const failures = []
function check(name, state, expectedRatio) {
  const bounds = state.contentBounds
  const ratio = ratioOf(bounds)
  // ±2px of height at this width, expressed as a ratio tolerance.
  const tolerance = expectedRatio * (2 / Math.max(1, bounds.height))
  const ok = Math.abs(ratio - expectedRatio) <= tolerance
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}: video ${bounds.width}x${bounds.height} ratio=${ratio.toFixed(4)} expected=${expectedRatio.toFixed(4)}`
  )
  if (!ok) failures.push(name)
}

const launched = await launchDevApp({
  requiredMarkers: ['preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    // Keep probe churn out of the user's remembered preview frame/prefs.
    VIDEORC_DISABLE_AUTO_PREVIEW: '1'
  },
  onLine: (line) => {
    if (/error|panic/i.test(line)) console.log('APP>', line)
  }
})

const smoke = launched.connections['preview-motion-ready']
console.log('smoke server', JSON.stringify(smoke))

try {
  await smokeCommand(smoke, 'preview-window-open')
  // Let the renderer load and push the real output aspect ratio first.
  await sleep(4000)

  const baseline = await smokeCommand(smoke, 'preview-window-state')
  console.log('baseline', JSON.stringify(baseline.contentBounds))
  const expectedRatio = ratioOf(baseline.contentBounds)
  const base = { width: baseline.contentBounds.width, height: baseline.contentBounds.height + 28 }

  const squeezes = [
    ['height-squeeze', { width: base.width, height: base.height - 160 }],
    ['height-stretch', { width: base.width, height: base.height + 200 }],
    ['width-stretch', { width: base.width + 280, height: base.height }],
    ['tile-like-both-axes', { width: 860, height: 700 }]
  ]
  for (const [name, bounds] of squeezes) {
    await smokeCommand(smoke, 'preview-window-set-bounds', bounds)
    await sleep(600)
    const state = await smokeCommand(smoke, 'preview-window-state')
    check(name, state, expectedRatio)
  }

  await smokeCommand(smoke, 'preview-window-close')
} finally {
  await launched.stop()
}

if (failures.length > 0) {
  console.log(`\nprobe FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nprobe PASSED')
