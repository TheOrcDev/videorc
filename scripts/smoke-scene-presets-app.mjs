#!/usr/bin/env node
// Named scenes must run through the production StudioProvider actions and survive
// a renderer restart. Media evidence stays in the isolated smoke directory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
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
const state = () => evaluate('return window.__videorcSmokeScenePresets?.state()')
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
  assert.equal(await evaluate(`return window.__videorcSmokeScenePresets.save('Smoke A')`), true)
  const first = (await state()).scenes.find((scene) => scene.name === 'Smoke A')
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
  const second = (await state()).scenes.find((scene) => scene.name === 'Smoke B')
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
  assert.equal((await request(ws, timeoutMs, 'recording.status')).sessionId, started.sessionId)
  await new Promise((resolve) => setTimeout(resolve, 1700))
  const stopped = await request(ws, timeoutMs, 'session.stop')
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
  console.log(
    `Scene presets smoke PASS: atomic apply, exact source refusal, working restart, live switching and encoded background pixels. ${reports.mdPath}`
  )
} finally {
  ws?.close()
  await launched.stop()
}
