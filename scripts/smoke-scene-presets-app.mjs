#!/usr/bin/env node
// Named scenes must run through the production StudioProvider actions and survive
// a renderer restart. Media evidence stays in the isolated smoke directory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  evaluateVisibilityArtifacts,
  parseVisibilityFrames
} from './lib/scene-presets-visibility-artifact.mjs'
import { scenePresetStateReadCode } from './lib/scene-presets-smoke-state.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const outputDirectory =
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-scene-presets-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
  }
})
const smoke = launched.connections['preview-motion-ready']
let ws
const evaluate = async (code) => {
  const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
  return response?.result ?? response
}
const state = () => evaluate(scenePresetStateReadCode)
const waitFor = async (predicate, description) => {
  const until = Date.now() + timeoutMs
  console.log(`[scene-presets] Waiting for ${description}`)
  let lastState = null
  let lastError = null
  while (Date.now() < until) {
    try {
      lastState = await state()
      lastError = null
    } catch (error) {
      if (!/not ready|destroyed|navigation|context/i.test(String(error))) throw error
      lastError = String(error)
    }
    if (lastState && predicate(lastState)) return lastState
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out: ${description}; last error: ${lastError}; last state: ${JSON.stringify(lastState)}`
  )
}
const assertCameraOff = (current, description) => {
  assert.equal(current.visual.sources.cameraOff, true, `${description}: Camera Off intent missing`)
  assert.equal(current.visual.sources.cameraId, undefined, `${description}: camera reactivated`)
}
const chooseCameraOff = async () => {
  await evaluate(`
    const current = window.__videorcSmokeScenePresets.state();
    const stored = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}');
    window.__videorcSmokeScenePresets.configure({sources: {
      ...stored.sources, ...current.visual.sources,
      cameraId: undefined, cameraName: undefined, cameraOff: true
    }});
    return true;
  `)
  return waitFor(
    (current) =>
      current.canSave &&
      current.visual.sources.cameraOff === true &&
      !current.visual.sources.cameraId,
    'confirmed Camera Off'
  )
}
const refreshDevices = () =>
  evaluate(`
  await openTab('sources');
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Refresh');
  if (!button || button.disabled) throw new Error('Device refresh unavailable.');
  button.click();
  await new Promise(requestAnimationFrame);
  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    const refreshed = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Refresh');
    if (refreshed && !refreshed.disabled) return true;
    await sleep(25);
  }
  throw new Error('Device refresh did not finish.');
`)
try {
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  await waitFor(() => true, 'renderer scene-preset actions ready')
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await requestSmokeCommand(smoke, 'select-camera-device', { settleMs: 500 }, { timeoutMs })
  await evaluate(
    `window.__videorcSmokeScenePresets.configure({video: {preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000}}); window.__videorcSmokeScenePresets.layout({layoutPreset: 'screen-only', cameraZoom: 125}); return true`
  )
  await waitFor(
    (current) => current.canSave && current.visual.layout.layoutPreset === 'screen-only',
    'initial scene'
  )
  await evaluate(`window.__videorcSmokeScenePresets.background('bg-01'); return true`)
  await waitFor(
    (current) => current.canSave && current.visual.background?.assetId === 'builtin-bg-01',
    'first background'
  )
  assertCameraOff(await chooseCameraOff(), 'before saving A')
  assert.equal(await evaluate(`return window.__videorcSmokeScenePresets.save('Smoke A')`), true)
  const first = (await state()).scenes.find((scene) => scene.name === 'Smoke A')
  assert.equal(first.visual.sources.cameraOff, true)
  await requestSmokeCommand(smoke, 'select-camera-device', { settleMs: 500 }, { timeoutMs })
  await waitFor(
    (current) =>
      current.canSave &&
      current.visual.sources.cameraOff === false &&
      Boolean(current.visual.sources.cameraId),
    'Camera On before saving B'
  )
  await evaluate(
    `window.__videorcSmokeScenePresets.background('bg-02'); window.__videorcSmokeScenePresets.layout({cameraZoom: 175}); return true`
  )
  // Apply the background after the layout settles to exercise independent user edits.
  await waitFor(
    (current) => current.canSave && current.visual.layout.cameraZoom === 175,
    'second framing'
  )
  await evaluate(`window.__videorcSmokeScenePresets.background('bg-02'); return true`)
  await waitFor(
    (current) => current.canSave && current.visual.background?.assetId === 'builtin-bg-02',
    'second background'
  )
  assert.equal(await evaluate(`return window.__videorcSmokeScenePresets.save('Smoke B')`), true)
  let second = (await state()).scenes.find((scene) => scene.name === 'Smoke B')
  assert.equal(second.visual.sources.cameraOff, false)
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(first.id)})`
    ),
    true
  )
  await waitFor((current) => current.canSave && current.activeId === first.id, 'saved Off after On')
  await refreshDevices()
  assertCameraOff(await state(), 'saved A after device refresh')
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(second.id)})`
    ),
    true
  )
  const restoredOn = await waitFor(
    (current) => current.canSave && current.activeId === second.id,
    'saved On after Off'
  )
  assert.equal(restoredOn.visual.sources.cameraOff, false)
  assert.equal(restoredOn.visual.sources.cameraId, second.visual.sources.cameraId)
  assert.equal(restoredOn.modified, false)
  // Update B with explicit Off so both encoded backgrounds also exercise Off
  // through the live apply and final stop, without changing audio ownership.
  assertCameraOff(await chooseCameraOff(), 'before updating B')
  assert.equal(
    await evaluate(
      `return window.__videorcSmokeScenePresets.save('Smoke B', ${JSON.stringify(second.id)})`
    ),
    true
  )
  second = (await state()).scenes.find((scene) => scene.id === second.id)
  assert.equal(second.visual.sources.cameraOff, true)
  try {
    await requestSmokeCommand(
      smoke,
      'open-tab',
      { tab: 'studio', waitFor: '[data-videorc-preview-card]' },
      { timeoutMs }
    )
    for (let pass = 0; pass < 2; pass++) {
      const theme = await evaluate(
        `await waitFor('button[aria-label="Actions for Smoke A"]'); const card = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes('Smoke A')); card?.scrollIntoView({block: 'center'}); await new Promise(requestAnimationFrame); return document.documentElement.classList.contains('dark') ? 'dark' : 'light'`
      )
      const capture = await requestSmokeCommand(
        smoke,
        'capture-page',
        { name: `scene-presets-${theme}` },
        { timeoutMs }
      )
      console.log(`Scene library UI evidence: ${capture.file}`)
      await evaluate(
        `document.querySelector('button[aria-label="Toggle color theme"]')?.click(); await sleep(200); return true`
      )
    }
  } catch (error) {
    console.warn(`UI capture unavailable: ${error.message}`)
  }

  assert.equal(first.visual.layout.layoutPreset, second.visual.layout.layoutPreset)
  await evaluate(
    `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(first.id)})`
  )
  await waitFor(
    (current) => current.canSave && current.activeId === first.id,
    'apply first saved scene'
  )
  assert.deepEqual((await state()).visual, first.visual)
  const bad = {
    ...second.visual,
    sources: {
      ...second.visual.sources,
      testPattern: false,
      screenId: undefined,
      windowId: 'window-that-does-not-exist'
    }
  }
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(second.id)}, ${JSON.stringify(bad)})`
    ),
    false
  )
  assert.equal((await state()).activeId, first.id)
  await evaluate(`window.__videorcSmokeScenePresets.layout({cameraZoom: 145}); return true`)
  await waitFor(
    (current) => current.canSave && current.modified && current.visual.layout.cameraZoom === 145,
    'modified working checkpoint'
  )
  await evaluate(`window.__videorcSmokeScenePresets.removeBackground('bg-03'); return true`)
  await waitFor(
    (current) =>
      current.backgroundSlots.some((slot) => slot.id === 'bg-03' && slot.assetId === null),
    'background removal'
  )
  await evaluate(`window.location.reload(); return true`).catch(() => {})
  await waitFor(
    (current) =>
      current.canSave && current.activeId === first.id && current.visual.layout.cameraZoom === 145,
    'renderer restart checkpoint'
  )
  const beforeRecording = await state()
  assertCameraOff(beforeRecording, 'working checkpoint after renderer restart')
  assert.equal(beforeRecording.backgroundSlots.find((slot) => slot.id === 'bg-03').assetId, null)
  const directory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  const started = await request(ws, timeoutMs, 'session.start', {
    sources: beforeRecording.visual.sources,
    layout: beforeRecording.visual.layout,
    background: {
      ...beforeRecording.visual.background,
      managedAssetPath: 'videorc-asset://background/code-demo.webp'
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: directory.capabilityId,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  await waitFor(
    (current) => ['recording', 'streaming'].includes(current.recording),
    'live provider state'
  )
  await evaluate(
    `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(first.id)})`
  )
  await waitFor((current) => current.activeId === first.id && !current.pendingId, 'live A')
  await new Promise((resolve) => setTimeout(resolve, 1700))
  await evaluate(
    `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(second.id)})`
  )
  await waitFor((current) => current.activeId === second.id && !current.pendingId, 'live B')
  assertCameraOff(await state(), 'live saved B')
  assert.equal((await request(ws, timeoutMs, 'recording.status')).sessionId, started.sessionId)
  await new Promise((resolve) => setTimeout(resolve, 1700))
  const stopped = await request(ws, timeoutMs, 'session.stop')
  await waitFor((current) => current.recording === 'idle', 'finished session')
  await refreshDevices()
  assertCameraOff(await state(), 'finished session after device refresh')
  const path = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
  const quality = await analyzeRecording(path, {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    intendedFps: 30,
    expectAudio: false,
    gates: { requireMotion: false, avSyncTargetMs: Infinity, avSyncHardFailMs: Infinity }
  })
  const reports = writeReports(quality)
  assert.equal(quality.verdict.pass, true, JSON.stringify(quality.verdict.failures))
  // Sample the background ring, outside the inset synthetic source. Its pixels
  // must change with the two saved assets in the finished encoded artifact.
  const frame = (at) =>
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(at),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'crop=32:32:0:0,scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
  const a = frame(0.8),
    b = frame(quality.metrics.durationSeconds - 0.6)
  assert.ok(
    a.reduce((sum, channel, index) => sum + Math.abs(channel - b[index]), 0) > 8,
    `Saved background pixels did not change: ${a} / ${b}`
  )
  // The camera control uses the existing real-device selection contract, not
  // a synthetic source relabeled as camera. A denied/unavailable/dark camera
  // must block acceptance; the visible artifact proves foreground pixels exist.
  await requestSmokeCommand(smoke, 'select-camera-device', { settleMs: 500 }, { timeoutMs })
  await evaluate(
    `window.__videorcSmokeScenePresets.layout({layoutPreset: 'camera-only', cameraZoom: 100, sourceVisibility: {camera: true, capture: true}}); return true`
  )
  await waitFor(
    (current) =>
      current.canSave &&
      current.visual.layout.layoutPreset === 'camera-only' &&
      current.visual.sources.cameraId &&
      current.visual.layout.sourceVisibility.camera,
    'visible camera-only control'
  )
  await evaluate(`window.__videorcSmokeScenePresets.background(null); return true`)
  await waitFor(
    (current) => current.canSave && current.visual.background === null,
    'camera-only without background asset'
  )
  const selectedCameraId = (await state()).visual.sources.cameraId
  assert.equal(
    await evaluate(`return window.__videorcSmokeScenePresets.save('Visible camera control')`),
    true
  )
  const visibleCamera = (await state()).scenes.find(
    (scene) => scene.name === 'Visible camera control'
  )
  const setCameraVisible = async (visible) => {
    const scene = await request(ws, timeoutMs, 'scene.get')
    const camera = scene.sources.find((source) => source.kind === 'camera')
    assert.ok(camera, 'Camera source is unavailable for the visibility control')
    await requestSmokeCommand(smoke, 'open-layout-tab', {}, { timeoutMs })
    await evaluate(`
      const select = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === ${JSON.stringify('Select ')} + ${JSON.stringify(camera.name)});
      if (!select || select.disabled) throw new Error('Camera inspector selection unavailable');
      select.click();
      const toggle = await waitFor(${JSON.stringify('[id="source-visible-' + camera.id + '"]')});
      if (toggle.disabled) throw new Error('Camera visibility control unavailable');
      if ((toggle.getAttribute('aria-checked') === 'true') !== ${visible}) toggle.click();
      return true;
    `)
    const confirmed = await waitFor(
      (current) => current.canSave && current.visual.layout.sourceVisibility.camera === visible,
      `camera visibility ${visible}`
    )
    assert.equal(
      confirmed.visual.sources.cameraId,
      selectedCameraId,
      'Visibility cleared selected camera identity'
    )
    assert.equal(confirmed.visual.sources.cameraOff, false, 'Visibility became Camera Off')
    return confirmed
  }
  assert.equal((await setCameraVisible(false)).modified, true)
  assert.equal(
    await evaluate(
      `return window.__videorcSmokeScenePresets.save('Hidden camera', ${JSON.stringify(visibleCamera.id)})`
    ),
    true
  )
  const hiddenCamera = (await state()).scenes.find((scene) => scene.id === visibleCamera.id)
  assert.equal(hiddenCamera.visual.layout.sourceVisibility.camera, false)
  await evaluate(`window.__videorcSmokeScenePresets.layout({cameraZoom: 110}); return true`)
  await waitFor(
    (current) =>
      current.canSave &&
      current.modified &&
      current.visual.layout.cameraZoom === 110 &&
      !current.visual.layout.sourceVisibility.camera,
    'hidden camera Save-as framing'
  )
  assert.equal(
    await evaluate(`return window.__videorcSmokeScenePresets.save('Hidden camera copy')`),
    true
  )
  const hiddenCopy = (await state()).scenes.find((scene) => scene.name === 'Hidden camera copy')
  assert.equal((await setCameraVisible(true)).modified, true)
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(hiddenCamera.id)})`
    ),
    true
  )
  await waitFor(
    (current) =>
      current.canSave &&
      !current.modified &&
      current.activeId === hiddenCamera.id &&
      !current.visual.layout.sourceVisibility.camera,
    'saved hidden camera after show'
  )
  await evaluate(`window.location.reload(); return true`).catch(() => {})
  const hiddenRestart = await waitFor(
    (current) =>
      current.canSave &&
      !current.modified &&
      current.activeId === hiddenCamera.id &&
      !current.visual.layout.sourceVisibility.camera,
    'hidden camera checkpoint after renderer restart'
  )
  assert.equal(hiddenRestart.visual.sources.cameraId, selectedCameraId)
  assert.equal(hiddenRestart.visual.sources.cameraOff, false)

  const recordCameraVisibility = async (visual, liveTargetId) => {
    const recording = await request(ws, timeoutMs, 'session.start', {
      sources: visual.sources,
      layout: visual.layout,
      background: null,
      output: {
        recordEnabled: true,
        streamEnabled: false,
        outputDirectoryCapability: directory.capabilityId,
        video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
        rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
      }
    })
    let finished
    try {
      await waitFor(
        (current) => current.recording === 'recording',
        'confirmed visibility recording start'
      )
      const scene = await request(ws, timeoutMs, 'scene.get')
      assert.equal(scene.background ?? null, null)
      assert.equal(scene.sources.length, 1, 'Camera-only artifact has another foreground source')
      assert.equal(scene.sources[0].kind, 'camera')
      assert.equal(scene.sources[0].visible, visual.layout.sourceVisibility.camera)
      // This duration is the encoded workload after confirmed start, not a
      // readiness delay. Hidden analysis includes every frame from file start.
      await new Promise((resolve) => setTimeout(resolve, 1700))
      if (liveTargetId) {
        assert.equal(
          await evaluate(
            `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(liveTargetId)})`
          ),
          true
        )
        await waitFor(
          (current) =>
            current.recording === 'recording' &&
            current.activeId === liveTargetId &&
            !current.pendingId &&
            !current.pendingLayout &&
            !current.visual.layout.sourceVisibility.camera,
          'confirmed atomic hidden live apply'
        )
        const rebuilt = await request(ws, timeoutMs, 'scene.get')
        assert.ok(
          rebuilt.sources.every((source) => !source.visible),
          'Live rebuild revealed hidden camera'
        )
        await new Promise((resolve) => setTimeout(resolve, 1700))
      }
    } finally {
      finished = await request(ws, timeoutMs, 'session.stop')
      await waitFor((current) => current.recording === 'idle', 'finished visibility recording')
    }
    const file = await resolveFinalRecordingPath({
      started: recording,
      stopped: finished,
      timeoutMs
    })
    const analysis = await analyzeRecording(file, {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      intendedFps: 30,
      expectAudio: false,
      gates: { requireMotion: false, avSyncTargetMs: Infinity, avSyncHardFailMs: Infinity }
    })
    writeReports(analysis)
    assert.equal(analysis.verdict.pass, true, JSON.stringify(analysis.verdict.failures))
    const metadata = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-an',
        '-vf',
        'signalstats,metadata=mode=print:file=-',
        '-f',
        'null',
        '-'
      ],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
    )
    return { frames: parseVisibilityFrames(metadata), count: analysis.metrics.observedFrames }
  }
  // The original visible snapshot was updated to Hidden. Restore its captured
  // visual as an explicit apply target for the independent positive control.
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(hiddenCamera.id)}, ${JSON.stringify(visibleCamera.visual)})`
    ),
    true
  )
  await waitFor(
    (current) => current.canSave && current.visual.layout.sourceVisibility.camera,
    'visible artifact control apply'
  )
  const visibleArtifact = await recordCameraVisibility(visibleCamera.visual)
  assert.equal(
    await evaluate(
      `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(hiddenCamera.id)})`
    ),
    true
  )
  await waitFor(
    (current) => current.canSave && !current.visual.layout.sourceVisibility.camera,
    'hidden artifact start intent'
  )
  const hiddenArtifact = await recordCameraVisibility(hiddenCamera.visual, hiddenCopy.id)
  const visibility = evaluateVisibilityArtifacts({
    visibleFrames: visibleArtifact.frames,
    visibleCount: visibleArtifact.count,
    hiddenFrames: hiddenArtifact.frames,
    hiddenCount: hiddenArtifact.count
  })
  writeFileSync(
    join(outputDirectory, 'scene-visibility-artifact.json'),
    JSON.stringify(
      {
        fixture: 'selected real camera; camera-only; no background asset',
        hiddenBoundary:
          'atomic hidden session.start and confirmed hidden live apply; all decoded frames',
        ...visibility
      },
      null,
      2
    )
  )
  assert.equal(visibility.pass, true, visibility.failures.join('; '))
  console.log(
    `Scene presets smoke PASS: atomic apply, Camera Off/On round trips, exact source refusal, working restart, live switching, encoded background pixels and every-frame hidden-camera artifacts. ${reports.mdPath}`
  )
} finally {
  ws?.close()
  await launched.stop()
}
