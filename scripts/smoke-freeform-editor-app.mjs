#!/usr/bin/env node
// Trusted Chromium input exercises the mounted SceneStage, pointer capture,
// real renderer/backend RPC and delayed commit handoff in an isolated profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  evaluateFreeformArtifact,
  evaluateFreeformChrome,
  evaluateFreeformGesture,
  summarizeFreeformTiming
} from './lib/freeform-editor-gate.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.serial = 0
    this.pending = new Map()
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP connection failed')), {
        once: true
      })
    })
  }
  send(method, params = {}) {
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timeout`))
      }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    return result.result.value
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.socket.close()
  }
}

const baseSourceId = 'source:test-pattern'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-freeform-editor-'))
const report = {
  timingDefinition:
    'Pointer event delivery to first changed DOM rectangle at the animation-frame paint boundary; physical display scan-out is not measured.',
  refreshRateMethod: 'Mean of 30 requestAnimationFrame intervals in the foreground renderer.',
  machine: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    platform: platform(),
    release: release(),
    loadAtStart: loadavg()
  },
  gestures: [],
  screenshots: [],
  failures: []
}
let devtoolsUrl
let cdp
let backend
const launched = await launchDevApp({
  timeoutMs,
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_REMOTE_DEBUG_PORT: '0'
  },
  onLine(line) {
    appendFileSync(join(outputDirectory, 'launch.log'), line + '\n')
    const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (endpoint) devtoolsUrl = endpoint[1]
  }
})
const smoke = launched.connections['preview-motion-ready']
const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })
try {
  assert.ok(devtoolsUrl, 'Electron did not expose its development CDP endpoint')
  const targets = await (await fetch(`http://${new URL(devtoolsUrl).host}/json/list`)).json()
  const target = targets.find(
    (entry) => entry.type === 'page' && /^https?:\/\/localhost/.test(entry.url)
  )
  assert.ok(target, 'main renderer CDP target missing')
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.bringToFront')
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  await cdp.eval(`localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1')`)
  await command('enable-synthetic-source', { settleMs: 100 })
  await command('select-camera-device', { settleMs: 100 })
  await cdp.eval(
    `(async () => {const deadline=performance.now()+5000;while(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')){document.querySelectorAll('[data-slot="dialog-close"]').forEach(button=>button.click());document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(performance.now()>deadline)throw Error('Could not dismiss launch dialog');await new Promise(resolve=>setTimeout(resolve,100))}})()`
  )
  await cdp.eval(`(${installObserver.toString()})()`)
  report.display = await cdp.eval(
    `({width:screen.width,height:screen.height,dpr:devicePixelRatio,userAgent:navigator.userAgent})`
  )
  report.refreshIntervalMs = await cdp.eval(
    `new Promise(resolve => {const times=[];const tick=t=>{times.push(t);if(times.length===31)resolve((times.at(-1)-times[0])/30);else requestAnimationFrame(tick)};requestAnimationFrame(tick)})`
  )

  for (const orientation of ['landscape', 'portrait']) {
    console.log(`Freeform: ${orientation} pointer matrix`)
    await command('select-layout-preset', {
      preset: orientation === 'landscape' ? 'screen-only' : 'vertical-screen-only',
      settleMs: 100
    })
    await clickText('Freeform')
    await selectSource(baseSourceId)
    await cdp.eval(`document.querySelector('button[aria-label="Unlock aspect ratio"]')?.click()`)
    await setRect({ width: 30, height: 30, x: 30, y: 30 })
    assert.equal(
      await cdp.eval(`document.querySelector('[aria-label="Snap"]')?.getAttribute('aria-pressed')`),
      'false',
      'Freeform must default to Snap off'
    )
    for (let index = 0; index < 20; index++) {
      await gesture({ orientation, kind: 'move', index, delayMs: index % 2 ? 50 : 250 })
      await gesture({ orientation, kind: 'resize', index, delayMs: index % 2 ? 250 : 50 })
    }
    for (const cancellation of ['escape', 'pointercancel', 'leave']) {
      await gesture({ orientation, kind: 'move', index: 0, delayMs: 250, cancellation })
    }
    await gesture({ orientation, kind: 'move', index: 1, delayMs: 250, noop: true })
    await gesture({ orientation, kind: 'move', index: 1, delayMs: 250, modifiers: 8 })
    await cdp.eval(`document.querySelector('[aria-label="Snap"]').click()`)
    await gesture({ orientation, kind: 'move', index: 0, delayMs: 250, modifiers: 1 })
    await cdp.eval(`document.querySelector('[aria-label="Snap"]').click()`)
    await gesture({ orientation, kind: 'move', index: 1, delayMs: 250, quickEdits: true })
    await cdp.eval(`document.querySelector('[aria-label="Lock aspect ratio"]')?.click()`)
    await frames(2)
    await gesture({ orientation, kind: 'resize', index: 1, delayMs: 250, aspectLocked: true })
    await cdp.eval(`document.querySelector('[aria-label="Unlock aspect ratio"]')?.click()`)
    await setRect({ width: 30, height: 30, x: 3, y: 30 })
    await cdp.eval(`document.querySelector('[aria-label="Snap"]').click()`)
    await gesture({ orientation, kind: 'move', index: 1, delayMs: 250, snapCase: true })
    await cdp.eval(`document.querySelector('[aria-label="Snap"]').click()`)
    await visualMatrix(orientation)
  }
  await recordCommittedComposition()
  if (report.failures.length) throw new Error(report.failures.join('\n'))
  console.log(
    `Freeform editor smoke OK: ${report.gestures.length} trusted gestures; evidence ${outputDirectory}`
  )
} catch (error) {
  const failureShot = await cdp?.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (failureShot) {
    report.failureScreenshot = join(outputDirectory, 'failure.png')
    writeFileSync(report.failureScreenshot, Buffer.from(failureShot.data, 'base64'))
  }
  report.failures.push(error?.stack ?? String(error))
  console.error(`Freeform editor evidence: ${outputDirectory}`)
  throw error
} finally {
  report.timing = summarizeFreeformTiming(report.gestures)
  report.machine.loadAtEnd = loadavg()
  writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
  cdp?.close()
  backend?.close()
  await launched.stop()
}

async function recordCommittedComposition() {
  console.log('Freeform: final-artifact composition proof')
  await command('select-layout-preset', { preset: 'screen-camera', settleMs: 100 })
  await clickText('Freeform')
  await selectSource('source:camera')
  await command('select-camera-shape', { shape: 'rectangle', settleMs: 100 })
  await cdp.eval(`document.querySelector('[data-videorc-camera-aspect="source"]').click()`)
  await frames(3)
  await cdp.eval(`document.querySelector('[aria-label="Unlock aspect ratio"]')?.click()`)
  await setRect({ width: 21.3, height: 28.7, x: 60.7, y: 50.3 })
  await selectSource(baseSourceId)
  await cdp.eval(`document.querySelector('[aria-label="Unlock aspect ratio"]')?.click()`)
  await setRect({ width: 37.3, height: 43.7, x: 1.1, y: 2.3 })
  const committed = await request(backend, timeoutMs, 'scene.get')
  const sourceIds = [baseSourceId, 'source:camera']
  const transforms = Object.fromEntries(
    sourceIds.map((id) => [id, committed.sources.find((source) => source.id === id)?.transform])
  )
  assert.ok(Object.values(transforms).every(Boolean), 'both committed source transforms required')
  const fields = ['x', 'y', 'width', 'height']
  await waitUntil(
    `(() => {const layout=JSON.parse(localStorage.getItem('videorc.captureConfig')).layout;return layout.arrangementMode==='freeform' && Object.entries(${JSON.stringify(transforms)}).every(([id,rect])=>${JSON.stringify(fields)}.every(field=>Math.abs(layout.sourceTransformOverrides?.[id]?.[field]-rect[field])<0.000001))})()`
  )
  const saved = await cdp.eval(`JSON.parse(localStorage.getItem('videorc.captureConfig'))`)
  const width = 640,
    height = 360,
    fps = 30
  const scene = {
    ...committed,
    background: null,
    sources: committed.sources
      .filter((source) => sourceIds.includes(source.id))
      .map((source) => ({ ...source, kind: 'test-pattern', deviceId: null })),
    outputs: committed.outputs.map((output) => ({ ...output, width, height, fps }))
  }
  const resource = await command('authorize-smoke-resource', {
    path: outputDirectory,
    kind: 'output-directory'
  })
  const started = await request(backend, timeoutMs, 'session.start', {
    sources: { testPattern: true },
    scene,
    layout: saved.layout,
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: resource.capabilityId,
      video: { preset: 'custom', width, height, fps, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  assert.equal(started.state, 'recording')
  const during = await request(backend, timeoutMs, 'scene.get')
  assertSceneTransforms(during, transforms)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const stopped = await request(backend, timeoutMs, 'session.stop')
  const path = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
  assert.ok(path?.endsWith('.mp4'), 'finalized MP4 required')
  const after = await request(backend, timeoutMs, 'scene.get')
  assertSceneTransforms(after, transforms)
  const persistedAfter = await cdp.eval(
    `JSON.parse(localStorage.getItem('videorc.captureConfig')).layout.sourceTransformOverrides`
  )
  for (const id of sourceIds)
    for (const field of fields)
      assert.ok(
        Math.abs(persistedAfter[id][field] - transforms[id][field]) < 0.000001,
        `stored ${id}.${field} changed during recording`
      )
  const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
  const quality = await analyzeRecording(path, {
    ffmpegPath,
    ffprobePath,
    intendedFps: fps,
    expectAudio: false,
    gates: { requireMotion: false }
  })
  const qualityPaths = writeReports(quality, { outDir: join(outputDirectory, 'artifact-reports') })
  assert.equal(quality.verdict.pass, true, JSON.stringify(quality.verdict.failures))
  assert.equal(quality.metrics.width, width)
  assert.equal(quality.metrics.height, height)
  const pixels = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-ss',
      '1',
      '-i',
      path,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
    { timeout: 30000, maxBuffer: width * height * 4 }
  )
  const placement = evaluateFreeformArtifact({
    pixels,
    width,
    height,
    rects: sourceIds.map((id) => transforms[id])
  })
  const framePath = join(outputDirectory, 'freeform-recorded-composition.png')
  execFileSync(ffmpegPath, ['-v', 'error', '-ss', '1', '-i', path, '-frames:v', '1', framePath], {
    timeout: 30000
  })
  report.artifact = {
    path,
    framePath,
    sourceSubstitution:
      'Committed source IDs, transforms and crops retained; capture kinds replaced by deterministic test-pattern sources to avoid dev camera TCC. Explicit scene exercises compositor/encoder; persisted overrides asserted separately.',
    transforms,
    persistedAfter,
    qualityPaths,
    placement
  }
  assert.equal(placement.ok, true, placement.failures.join('; '))
}
function assertSceneTransforms(scene, transforms) {
  for (const [id, rect] of Object.entries(transforms))
    for (const field of ['x', 'y', 'width', 'height']) {
      const source = scene.sources.find((candidate) => candidate.id === id)
      assert.ok(
        source && Math.abs(source.transform[field] - rect[field]) < 0.000001,
        `${id}.${field} changed across recording boundary`
      )
    }
}

async function gesture({
  orientation,
  kind,
  index,
  delayMs,
  cancellation,
  modifiers = 0,
  noop = false,
  quickEdits = false,
  aspectLocked = false,
  snapCase = false
}) {
  const sourceId = baseSourceId
  const start = await cdp.eval(
    `window.__freeformSmoke.box('[data-videorc-stage-source="${sourceId}"]')`
  )
  const canvas = await cdp.eval(`window.__freeformSmoke.box('[data-videorc-stage-canvas]')`)
  const handle =
    kind === 'resize'
      ? await cdp.eval(`window.__freeformSmoke.box('[data-videorc-stage-handle="se"]')`)
      : null
  const origin = handle
    ? { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
    : { x: start.x + start.width / 2, y: start.y + start.height / 2 }
  const before = await request(backend, timeoutMs, 'compositor.status')
  await cdp.eval(
    `window.__freeformSmoke.begin(${JSON.stringify({ start, kind, origin, delayMs, sourceId, canvas, aspectLocked, snapCase })})`
  )
  await mouse('mouseMoved', origin, modifiers)
  await mouse('mousePressed', origin, modifiers)
  await waitForPointerDown(1)
  await frames(2)
  const captured = await cdp.eval('window.__freeformSmoke.checkCapture()')
  // Alternating direction leaves room for the entire 40-gesture matrix. The
  // reversal inside each path exercises direction changes; the locked case
  // separately crosses the historical dominant-axis resize discontinuity.
  const sign = index % 2 ? -1 : 1
  const points = snapCase
    ? [4.9, 5.1, 4.9, 8.9, 9.1, 11.1].map((raw) => ({
        x: origin.x + raw - (start.x - canvas.x),
        y: origin.y
      }))
    : aspectLocked
      ? [
          [-12, 11.8],
          [-12, 12.2],
          [-8, 8],
          [-12, 12],
          [-10, 10]
        ].map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      : (noop ? [0] : [2, 4, 3, 6, 8]).map((amount) => ({
          x: origin.x + sign * amount,
          y: origin.y + (sign * amount) / 2
        }))
  const snapSamples = []
  for (const [pointIndex, point] of points.entries()) {
    await mouse('mouseMoved', point, modifiers)
    if (snapCase || aspectLocked || index % 3 !== 0)
      await frames(snapCase || aspectLocked ? 2 : index % 3 === 1 ? 1 : 3)
    if (snapCase) {
      const sample = await cdp.eval(
        `({rect:window.__freeformSmoke.box('[data-videorc-stage-source="${sourceId}"]'), guide:document.querySelector('[data-videorc-stage-guide="x"]')?.getAttribute('x1') ?? null})`
      )
      snapSamples.push(sample)
      assert.equal(
        sample.guide !== null,
        pointIndex < 4,
        `snap guide ownership at point ${pointIndex}`
      )
      assert.ok(
        Math.abs(sample.rect.x - canvas.x - (pointIndex === 5 ? 2 : 0)) <= 1,
        `snap acquisition/noise/release must preserve displayed continuity at point ${pointIndex}`
      )
    }
  }
  if (cancellation === 'leave') {
    // Trusted pointer input beyond the SVG confirms capture retains ownership;
    // Escape then cancels the resulting clamped draft without a backend write.
    await mouse('mouseMoved', { x: Math.max(1, canvas.x - 18), y: canvas.y + canvas.height / 2 })
  }
  if (cancellation === 'pointercancel') {
    // CDP mouse has no cancel verb. Dispatch on the actual stable capture
    // owner with the trusted down's recorded pointerId (never stub capture).
    await cdp.eval(`window.__freeformSmoke.cancelPointer()`)
  } else if (cancellation) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
  }
  await mouse('mouseReleased', points.at(-1), modifiers)
  if (quickEdits) {
    await frames(1)
    assert.equal(
      await cdp.eval(
        `document.querySelector('[data-videorc-stage-phase]').dataset.videorcStagePhase`
      ),
      'pending',
      'second drag must begin during actual pending ownership'
    )
    const nextOrigin = await cdp.eval('window.__freeformSmoke.rebase()')
    await mouse('mouseMoved', nextOrigin)
    await mouse('mousePressed', nextOrigin)
    await waitForPointerDown(2)
    await frames(2)
    assert.equal(
      await cdp.eval('window.__freeformSmoke.checkCapture()'),
      true,
      'second pointer capture'
    )
    const nextPoint = { x: nextOrigin.x + 8, y: nextOrigin.y + 4 }
    await mouse('mouseMoved', nextPoint)
    await frames(2)
    await mouse('mouseReleased', nextPoint)
  }
  await frames(2)
  await cdp.eval(`new Promise(resolve => setTimeout(resolve, ${delayMs + 100}))`)
  await waitUntil(
    `document.querySelector('[data-videorc-stage-phase]')?.dataset.videorcStagePhase === 'idle'`
  )
  const observation = await cdp.eval('window.__freeformSmoke.finish()')
  const accepted = await request(backend, timeoutMs, 'scene.get')
  const status = await request(backend, timeoutMs, 'compositor.status')
  const transform = accepted.sources.find((source) => source.id === sourceId)?.transform
  const acceptedRect = transform && {
    x: canvas.x + transform.x * canvas.width,
    y: canvas.y + transform.y * canvas.height,
    width: transform.width * canvas.width,
    height: transform.height * canvas.height
  }
  const data = {
    ...observation,
    captured,
    sourceId,
    orientation,
    kind,
    index,
    delayMs,
    cancelled: Boolean(cancellation),
    noop,
    modifiers,
    quickEdits,
    aspectLocked,
    snapCase,
    snapSamples,
    cancellation,
    acceptedRect,
    revisionAdvanced: status.sceneRevision > before.sceneRevision,
    revisionBefore: before.sceneRevision,
    revisionAfter: status.sceneRevision,
    canvas
  }
  const gate = evaluateFreeformGesture(data)
  report.gestures.push({ ...data, gate })
  if (!gate.ok && process.env.VIDEORC_FREEFORM_FAIL_FAST === '1')
    throw new Error(JSON.stringify(gate))
  if (!gate.ok)
    report.failures.push(
      `${orientation} ${kind} ${index} ${cancellation ?? ''}: ${gate.failures.join('; ')}`
    )
}

async function visualMatrix(orientation) {
  await command('select-layout-preset', {
    preset: orientation === 'landscape' ? 'screen-camera' : 'vertical-screen-camera',
    settleMs: 100
  })
  await clickText('Freeform')
  // Pairwise matrix: every requested theme/viewport/shape and geometry extreme
  // is represented, while the pointer matrix above stays at a fixed viewport.
  for (const [index, variant] of [
    {
      width: 1440,
      theme: 'dark',
      shape: 'rectangle',
      rect: { width: 100, height: 100, x: 0, y: 0 }
    },
    { width: 980, theme: 'light', shape: 'circle', rect: { width: 5, height: 5, x: 0, y: 0 } },
    { width: 1440, theme: 'light', shape: 'rounded', rect: { width: 30, height: 30, x: 70, y: 0 } },
    { width: 980, theme: 'dark', shape: 'rectangle', rect: { width: 30, height: 30, x: 0, y: 70 } },
    { width: 1440, theme: 'dark', shape: 'circle', rect: { width: 30, height: 30, x: 70, y: 70 } }
  ].entries()) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: variant.width,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false
    })
    await cdp.eval(
      `document.documentElement.classList.toggle('dark', ${variant.theme === 'dark'}); document.documentElement.classList.toggle('light', ${variant.theme === 'light'}); document.documentElement.style.colorScheme=${JSON.stringify(variant.theme)}`
    )
    await selectSource('source:camera')
    await command('select-camera-shape', { shape: variant.shape, settleMs: 100 })
    await selectSource(baseSourceId)
    await setRect(variant.rect)
    await frames(3)
    if (variant.width === 980)
      await cdp.eval(
        `(() => {const label=document.querySelector('[data-videorc-stage-toolbar] button[aria-label^="Select"] span');window.__freeformSmoke.originalSourceLabel=label.textContent;label.textContent='An intentionally long source name to verify truncation at narrow widths'})()`
      )
    const chrome = await cdp.eval(`window.__freeformSmoke.chrome(${JSON.stringify(variant.shape)})`)
    const gate = evaluateFreeformChrome(chrome)
    const path = join(
      outputDirectory,
      `${orientation}-${variant.width}-${variant.theme}-${index}.png`
    )
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    report.screenshots.push({
      ...variant,
      orientation,
      path,
      chrome,
      gate,
      simulatedLongSourceName: variant.width === 980
    })
    if (!gate.ok)
      report.failures.push(`Visual ${orientation}/${index}: ${gate.failures.join('; ')}`)
    await selectSource('source:camera')
    await frames(2)
    const cameraChrome = await cdp.eval(
      `window.__freeformSmoke.chrome(${JSON.stringify(variant.shape)})`
    )
    const cameraGate = evaluateFreeformChrome(cameraChrome)
    const cameraPath = join(
      outputDirectory,
      `${orientation}-${variant.width}-${variant.theme}-${variant.shape}-camera.png`
    )
    const cameraShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(cameraPath, Buffer.from(cameraShot.data, 'base64'))
    report.screenshots.push({
      ...variant,
      orientation,
      path: cameraPath,
      chrome: cameraChrome,
      gate: cameraGate,
      selectedSource: 'source:camera',
      simulatedLongSourceName: variant.width === 980
    })
    if (variant.width === 980)
      await cdp.eval(
        `document.querySelector('[data-videorc-stage-toolbar] button[aria-label^="Select"] span').textContent=window.__freeformSmoke.originalSourceLabel`
      )
    if (!cameraGate.ok)
      report.failures.push(
        `Camera visual ${orientation}/${index}: ${cameraGate.failures.join('; ')}`
      )
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
}
async function setRect(rect) {
  for (const [field, value] of Object.entries(rect)) {
    await cdp.eval(
      `(() => {const input=document.querySelector('[data-videorc-transform-field="${field}"]');if(!input||input.disabled)throw Error('Missing editable ${field}');input.focus();input.select()})()`
    )
    await cdp.send('Input.insertText', { text: String(value) })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
    await frames(3)
    await waitUntil(
      `document.querySelector('[data-videorc-transform-field="${field}"]')?.value === '${value}'`
    )
  }
  await cdp.eval(
    `document.activeElement?.blur(); document.querySelector('[data-videorc-stage-phase]').scrollIntoView({block:'center',behavior:'instant'})`
  )
  await frames(2)
}
async function clickText(text) {
  await cdp.eval(
    `(() => {const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw Error('Missing ${text} button');button.click()})()`
  )
  await frames(3)
}
async function selectSource(sourceId) {
  const scene = await request(backend, timeoutMs, 'scene.get')
  const source = scene.sources.find((candidate) => candidate.id === sourceId)
  assert.ok(source, `Missing ${sourceId}`)
  await cdp.eval(
    `document.querySelector('button[aria-label='+CSS.escape(${JSON.stringify('Select ')}+${JSON.stringify(source.name)})+']').click()`
  )
  await frames(2)
}

function mouse(type, point, modifiers = 0) {
  return cdp.send('Input.dispatchMouseEvent', {
    type,
    ...point,
    modifiers,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1
  })
}
function frames(count) {
  return cdp.eval(
    `new Promise(resolve=>{let n=${count};const tick=()=>--n<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick)})`
  )
}
async function waitForPointerDown(count) {
  // CDP acknowledgement is not renderer event delivery. Wait for the trusted
  // down itself before checking its pointer ID, then let React's handler finish.
  await cdp.eval(
    `new Promise((resolve,reject)=>{const end=performance.now()+1000;const tick=()=>{if(window.__freeformSmoke.pointerDowns.filter(event=>event.trusted).length===${count})resolve();else if(performance.now()>end)reject(Error('Trusted pointerdown was not delivered'));else requestAnimationFrame(tick)};tick()})`
  )
}
async function waitUntil(expression) {
  await cdp.eval(
    `new Promise((resolve,reject)=>{const end=performance.now()+10000;const tick=()=>{if(${expression})resolve();else if(performance.now()>end)reject(Error('Timed out: '+${JSON.stringify(expression)}));else requestAnimationFrame(tick)};tick()})`
  )
}

function installObserver() {
  const box = (selector) => {
    const element = typeof selector === 'string' ? document.querySelector(selector) : selector
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  const difference = (a, b) =>
    Math.max(...['x', 'y', 'width', 'height'].map((key) => Math.abs(a[key] - b[key])))
  const state = { box, active: false, delayMs: 0, captured: false }
  for (const name of ['lostpointercapture', 'pointercancel', 'blur', 'scroll', 'resize'])
    window.addEventListener(
      name,
      (event) => {
        if (state.active)
          state.events.push({
            name,
            at: performance.now(),
            target: event.target?.tagName ?? 'window',
            pointerId: event.pointerId
          })
      },
      true
    )
  const nativeSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    const command = typeof data === 'string' ? JSON.parse(data) : null
    if (command?.method === 'scene.source.transform.update' && state.active) {
      state.commits.push({
        id: command.id,
        sourceId: command.params.sourceId,
        transform: command.params.transform,
        sentAt: performance.now()
      })
      setTimeout(() => nativeSend.call(this, data), state.delayMs)
      return
    }
    return nativeSend.call(this, data)
  }
  const expected = (event) => {
    const dx = event.clientX - state.origin.x
    const dy = event.shiftKey && state.kind === 'move' ? 0 : event.clientY - state.origin.y
    if (state.snapCase) {
      const raw = state.start.x - state.canvas.x + dx
      const x =
        Math.abs(raw - 11.1) < 0.15
          ? state.canvas.x + raw - 9.1
          : [4.9, 5.1, 8.9, 9.1].some((value) => Math.abs(raw - value) < 0.15)
            ? state.canvas.x
            : state.start.x + dx
      return { ...state.start, x }
    }
    if (state.aspectLocked && state.kind === 'resize') {
      const w = state.start.width,
        h = state.start.height
      const scale = (w * (w + dx) + h * (h + dy)) / (w * w + h * h)
      return { ...state.start, width: w * scale, height: h * scale }
    }
    return state.kind === 'move'
      ? {
          ...state.start,
          x: Math.max(
            state.canvas.x,
            Math.min(state.canvas.x + state.canvas.width - state.start.width, state.start.x + dx)
          ),
          y: Math.max(
            state.canvas.y,
            Math.min(state.canvas.y + state.canvas.height - state.start.height, state.start.y + dy)
          )
        }
      : { ...state.start, width: state.start.width + dx, height: state.start.height + dy }
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (state.active) {
        state.pointerId = event.pointerId
        state.pointerDowns.push({
          at: performance.now(),
          pointerId: event.pointerId,
          trusted: event.isTrusted,
          target: event.target?.tagName,
          focused: document.hasFocus()
        })
      }
    },
    true
  )
  document.addEventListener(
    'gotpointercapture',
    (event) => {
      if (!state.active) return
      state.captured = true
      state.captureEvents++
      state.owner = event.target
    },
    true
  )
  document.addEventListener(
    'pointermove',
    (event) => {
      if (state.active && event.buttons === 1) {
        const rect = expected(event)
        const at = performance.now()
        state.inputs.push({ at, rect })
        if (difference(rect, state.lastPaintRect) > 1 && state.pendingSince === null)
          state.pendingSince = at
        if (difference(rect, state.lastPaintRect) <= 1) state.pendingSince = null
      }
    },
    true
  )
  document.addEventListener(
    'pointerup',
    () => {
      if (state.active) {
        state.releasedAt = performance.now()
        state.finalRect = state.inputs.at(-1)?.rect ?? state.start
      }
    },
    true
  )
  const observer = new PerformanceObserver((list) => {
    if (state.active)
      state.longTasks.push(
        ...list
          .getEntries()
          .filter((entry) => entry.startTime >= state.beganAt)
          .map((entry) => ({ startTime: entry.startTime, duration: entry.duration }))
      )
  })
  observer.observe({ type: 'longtask' })
  state.begin = (options) => {
    Object.assign(state, options, {
      active: true,
      beganAt: performance.now(),
      frames: [],
      events: [],
      commits: [],
      inputs: [],
      longTasks: [],
      captured: false,
      captureCount: 0,
      captureEvents: 0,
      pointerId: null,
      pointerDowns: [],
      captureChecks: [],
      sampled: new Set(),
      lastPaintInputIndex: -1,
      releasedAt: null,
      lastPaintRect: options.start,
      pendingSince: null,
      finalRect: options.start
    })
    const sample = () => {
      if (!state.active) return
      // setTimeout after the rAF lets React's gesture rAF update the DOM first.
      setTimeout(() => {
        if (!state.active) return
        const rect = box(`[data-videorc-stage-source="${state.sourceId}"]`)
        const phase = document.querySelector('[data-videorc-stage-phase]')?.dataset
          .videorcStagePhase
        const matches = state.inputs.findLastIndex((input) =>
          ['x', 'y', 'width', 'height'].every((key) => Math.abs(rect[key] - input.rect[key]) < 0.25)
        )
        const input = state.inputs[matches]
        const pointerToPaintMs =
          input && difference(rect, state.lastPaintRect) > 0.01 && !state.sampled.has(matches)
            ? performance.now() - input.at
            : undefined
        const pendingAgeMs =
          state.pendingSince === null ? 0 : performance.now() - state.pendingSince
        if (input) state.sampled.add(matches)
        if (phase === 'dragging' && state.releasedAt === null) state.finalRect = rect
        state.frames.push({
          at: performance.now(),
          rect,
          phase,
          snapTargets: [...document.querySelectorAll('[data-videorc-stage-guide]')].map(
            (guide) => ({
              axis: guide.dataset.videorcStageGuide,
              x: guide.getAttribute('x1'),
              y: guide.getAttribute('y1')
            })
          ),
          afterRelease: state.releasedAt !== null,
          releaseRect: state.releasedAt !== null ? state.finalRect : null,
          commandedRects: [
            state.inputs.at(-1)?.rect ?? state.start,
            ...state.inputs
              .slice(state.lastPaintInputIndex + 1)
              .filter((entry) => performance.now() - entry.at <= 33)
              .map((entry) => entry.rect)
          ],
          previousInputIndex: state.lastPaintInputIndex,
          matchedInputIndex: matches,
          previousRect: state.lastPaintRect,
          pendingAgeMs,
          pointerToPaintMs
        })
        state.lastPaintRect = rect
        state.lastPaintInputIndex = Math.max(state.lastPaintInputIndex, matches)
        if (matches >= 0)
          state.pendingSince =
            state.inputs.slice(matches + 1).find((entry) => difference(entry.rect, rect) > 1)?.at ??
            null
      }, 0)
      state.raf = requestAnimationFrame(sample)
    }
    state.raf = requestAnimationFrame(sample)
  }
  state.rebase = () => {
    state.start = box(`[data-videorc-stage-source="${state.sourceId}"]`)
    state.origin = {
      x: state.start.x + state.start.width / 2,
      y: state.start.y + state.start.height / 2
    }
    state.inputs = []
    state.sampled = new Set()
    state.lastPaintInputIndex = -1
    state.releasedAt = null
    state.finalRect = state.start
    state.lastPaintRect = state.start
    state.pendingSince = null
    return state.origin
  }
  state.finish = () => {
    state.longTasks.push(
      ...observer
        .takeRecords()
        .filter((entry) => entry.startTime >= state.beganAt)
        .map((entry) => ({ startTime: entry.startTime, duration: entry.duration }))
    )
    state.active = false
    cancelAnimationFrame(state.raf)
    return {
      frames: state.frames,
      events: state.events,
      captureCount: state.captureCount,
      pointerDowns: state.pointerDowns,
      captureChecks: state.captureChecks,
      commits: state.commits,
      longTasks: state.longTasks,
      finalRect: state.finalRect,
      inputs: state.inputs
    }
  }
  state.checkCapture = () => {
    const owner = document.querySelector('[data-videorc-stage-canvas]')?.ownerSVGElement
    const captured = Boolean(owner?.hasPointerCapture(state.pointerId))
    state.captureChecks.push({
      at: performance.now(),
      pointerId: state.pointerId,
      captured,
      focused: document.hasFocus(),
      phase: document.querySelector('[data-videorc-stage-phase]')?.dataset.videorcStagePhase
    })
    if (captured) {
      state.owner = owner
      state.captureCount++
      state.captured = true
    }
    return captured
  }
  state.cancelPointer = () =>
    state.owner.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: state.pointerId, bubbles: true })
    )
  state.chrome = (expectedCameraShape) => {
    const camera = document.querySelector('[data-videorc-stage-source="source:camera"]')
    const circle = camera?.querySelector('[data-videorc-stage-painted-shape="circle"]')
    const paintedCircle =
      expectedCameraShape === 'circle'
        ? { tag: circle?.tagName, bounds: box(circle), sourceBounds: box(camera) }
        : null
    const sourceId = document.querySelector('[data-videorc-transform-fields]')?.dataset
      .videorcTransformFields
    const source = document.querySelector(`[data-videorc-stage-source="${sourceId}"]`)
    const sourceBox = box(source)
    const hit =
      sourceBox &&
      document.elementFromPoint(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2
      )
    const tinySourceBody =
      sourceBox && (sourceBox.width < 24 || sourceBox.height < 24)
        ? { box: sourceBox, hitMatches: hit === source || source.contains(hit) }
        : null
    return {
      tinySourceBody,
      paintedCircle,
      canvas: box('[data-videorc-stage-canvas]'),
      toolbar: box('[data-videorc-stage-toolbar]'),
      footer: box('[data-videorc-stage-footer]'),
      handles: [...document.querySelectorAll('[data-videorc-stage-handle]')].map((element) => {
        const bounds = box(element)
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2
        )
        return {
          id: element.dataset.videorcStageHandle,
          box: bounds,
          hitMatches: hit === element || element.contains(hit)
        }
      })
    }
  }
  window.__freeformSmoke = state
}
