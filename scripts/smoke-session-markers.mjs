// Named markers through the real detached composer, provider callbacks and finished video.
// Isolated profile, local caption fake, synthetic video, no production credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { streamSessionParams } from './lib/cohost-caption-audio.mjs'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { connectBackend, loadSessionListItem, request } from './smoke-recording-session.mjs'

const timeoutMs = 120_000
const root = mkdtempSync(join(tmpdir(), 'videorc-session-markers-'))
const appDataDir = join(root, 'app-data')
const output = join(root, 'recordings')
mkdirSync(appDataDir, { recursive: true })
mkdirSync(output)
const smokeSessionToken = `marker-smoke-${randomUUID()}`
const secrets = join(appDataDir, 'videorc-secrets.json')
writeFileSync(secrets, JSON.stringify({ 'account:videorc:session': smokeSessionToken }))
chmodSync(secrets, 0o600)
const fake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken: `marker-realtime-${randomUUID()}`,
  autoTranscript: false,
  chunkText: ''
})
fake.state.realtimeAvailable = false
let launched, ws, audioPump, listener
let captureSessionId
const markerEvents = []
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function waitFor(read, predicate, message, budget = 15_000) {
  const deadline = Date.now() + budget
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await pause(100)
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`)
}
try {
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (line.includes('Marker chunk admission')) console.log(line)
    },
    env: {
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_SMOKE_STATE_DIR: root,
      VIDEORC_SMOKE_OUTPUT_DIR: root,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_ENABLE_SMOKE_RPC: '1',
      VIDEORC_PREMIUM_FEATURES: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_API_BASE_URL: fake.httpOrigin,
      VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE: '1',
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_RECORDINGS_DIR: output,
      VIDEORC_COMMENTS_WINDOW: '1',
      RUST_LOG: 'videorc_backend::captions=debug'
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  const ready = launched.connections['backend-ready']
  ws = await connectBackend({ ...ready, token: ready.adminToken ?? ready.token }, timeoutMs)
  ws.addEventListener('message', (event) => {
    const value = JSON.parse(event.data)
    if (value.event?.startsWith('session.marker.')) markerEvents.push(value)
  })
  const command = (name, params) => requestSmokeCommand(smoke, name, params, { timeoutMs: 15_000 })
  const ask = async (method, params) => {
    try {
      return method === 'captions.test.inject-audio'
        ? await command('backend-debug-rpc', {
            method: 'audio.test.inject-pcm',
            params: {
              sessionId: captureSessionId,
              durationMs: params.durationMs,
              rawPeak: params.quiet ? 0.001 : 0.12
            },
            timeoutMs: 30_000
          })
        : await request(ws, 30_000, method, params)
    } catch (error) {
      throw new Error(`${method}: ${error.message}`, { cause: error })
    }
  }
  console.log('session markers: detached composer and active recording')
  await command('eval-js', { code: "localStorage.setItem('videorc.aiConsent','1'); return true" })
  await ask('cohost.settings.set', { enabled: true, listen: true })
  // Consent is React state read at mount; reload the isolated profile so the
  // real capture effect owns the same grant as this test's voice configuration.
  await command('eval-js', { code: 'setTimeout(() => location.reload(), 0); return true' })
  await waitFor(
    () =>
      command('eval-js', { code: 'return window.videorc.getCohostWindowState()' }).catch(
        () => null
      ),
    (view) =>
      view?.result?.consented === true &&
      view.result.enabled === true &&
      view.result.listen === true,
    'Renderer did not load the voice marker consent and Listen settings'
  )
  const capability = (
    await command('authorize-smoke-resource', { kind: 'output-directory', path: output })
  ).capabilityId
  const started = await ask('session.start', {
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: capability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  const sessionId = started.sessionId
  captureSessionId = sessionId
  assert.ok(sessionId)
  await command('comments-window-open')
  await waitFor(
    () => command('eval-js', { code: 'return window.videorc.getMarkerContext()' }),
    (view) => view?.result?.available && view.result.sessionId === sessionId,
    'Recording marker context did not become available'
  )
  await waitFor(
    () => command('comments-window-reader-state'),
    (view) => view.composerCount === 1,
    'Record-only composer did not become available'
  )
  const before = await ask('session.markers.list', { sessionId })
  assert.equal(before.markers.length, 0)
  assert.equal(
    (await command('comments-window-submit-message', { text: '/marker Shadcn New Library' }))
      .submitted,
    true
  )
  const typed = await waitFor(
    () => ask('session.markers.list', { sessionId }),
    (page) => page.markers.some((m) => m.label === 'Shadcn New Library'),
    'Real composer did not save marker'
  )
  assert.equal(typed.markers.length, 1)
  const manual = typed.markers[0]
  assert.equal(manual.source, 'manual')
  assert.ok(manual.atSeconds >= 0)
  const capture = await command('comments-window-capture-page', {
    name: 'marker-created-320',
    width: 320,
    height: 640
  })
  assert.equal(capture.size.width, 320)
  console.log(`session markers: composer capture ${capture.file}`)
  await command('eval-js', { code: "await window.videorc.setNativeTheme('light'); return true" })
  const lightCapture = await command('comments-window-capture-page', {
    name: 'marker-created-light-320',
    width: 320,
    height: 640
  })
  console.log(`session markers: light composer capture ${lightCapture.file}`)
  await command('eval-js', { code: "await window.videorc.setNativeTheme('dark'); return true" })
  await command('comments-window-submit-message', { text: '/unknown' })
  await command('comments-window-submit-message', { text: '/help' })
  assert.equal((await ask('session.markers.list', { sessionId })).markers.length, 1)
  const listening = await ask('session.marker.voice.configure', { sessionId, consent: true })
  console.log('session markers: chunked recording-only voice')
  assert.notEqual(listening.state, 'blocked')
  // Flush the startup chunk that may cross the listen grant. Every scripted
  // voiced chunk must be fully admitted under the stable current scope.
  await ask('captions.test.inject-audio', { durationMs: 3000, quiet: true })
  const requestsBeforeCommand = fake.state.chunkRequests
  fake.state.chunkFinals.push(
    {
      text: 'Golem make a marker here for Voice Shadcn',
      delayMs: 3500,
      segments: [{ text: 'make', startSecond: 0.2, endSecond: 0.4 }]
    },
    { text: 'New Library', segments: [{ text: 'New Library', startSecond: 0, endSecond: 1 }] }
  )
  // The real microphone bus stays continuous across the two provider finals.
  await Promise.all([
    ask('captions.test.inject-audio', { durationMs: 5000 }),
    (async () => {
      await waitFor(
        () => Promise.resolve(fake.state.chunkRequests),
        (count) => count > requestsBeforeCommand,
        'Chunked provider received no voiced audio'
      )
      assert.equal(
        (await ask('session.markers.list', { sessionId })).markers.length,
        1,
        'A chunk final saved a partial title'
      )
    })()
  ])
  await ask('captions.test.inject-audio', { durationMs: 2000, quiet: true })
  const chunked = await waitFor(
    () => ask('session.markers.list', { sessionId }),
    (page) => page.markers.some((m) => m.label === 'Voice Shadcn New Library'),
    'Actual chunked callback did not save its complete title'
  )
  assert.equal(chunked.markers.length, 2)
  // Explicit captions exercise the other actual provider callback.
  await ask('session.marker.voice.configure', { sessionId, consent: false })
  fake.state.realtimeAvailable = true
  await ask('captions.start', {})
  await ask('session.marker.voice.configure', { sessionId, consent: true })
  console.log('session markers: realtime voice and consent cancellation')
  fake.state.realtimePartialProgress = true
  audioPump = setInterval(
    () => ask('captions.test.inject-audio', { durationMs: 200 }).catch(() => {}),
    500
  )
  await waitFor(
    () => Promise.resolve(fake.state.realtimeConnections),
    (count) => count > 0,
    'Realtime caption provider did not connect'
  )
  await ask('captions.test.inject-audio', { durationMs: 1000 })
  const timingHold = fake.holdNextRealtimeFinal()
  const timedFinal = fake.emitRealtimeFinal('Golem make a marker here for Realtime topic')
  await timingHold.arrived
  // Deliberate transcription latency, after the provider stamped speech time.
  await pause(3500)
  timingHold.release()
  await timedFinal
  const spoken = await waitFor(
    () => ask('session.markers.list', { sessionId }),
    (page) => page.markers.some((m) => m.label === 'Realtime topic'),
    'Actual realtime callback did not save marker'
  )
  assert.equal(spoken.markers.length, 3)
  assert.equal(spoken.markers.find((m) => m.source === 'voice').sessionId, sessionId)
  assert.equal((await ask('clip.marks.list', { sessionId })).length, 0)
  // Consent retirement cancels an admitted, delayed provider completion.
  const hold = fake.holdNextRealtimeFinal()
  const late = fake.emitRealtimeFinal('Golem make a marker here for Cancelled title')
  await hold.arrived
  await ask('session.marker.voice.configure', { sessionId, consent: false })
  hold.release()
  await late
  await pause(200)
  assert.equal((await ask('session.markers.list', { sessionId })).markers.length, 3)
  clearInterval(audioPump)
  audioPump = null
  await ask('session.stop')
  console.log('session markers: finished video and durable marker mutations')
  const completed = await waitFor(
    () => loadSessionListItem(ws, 30_000, sessionId),
    (row) => Boolean(row?.mp4Path),
    'Recording did not finalize',
    60_000
  )
  const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const analysis = await analyzeRecording(completed.mp4Path, {
    ffmpegPath,
    ffprobePath: siblingFfprobePath(ffmpegPath) ?? 'ffprobe',
    intendedFps: 30,
    expectAudio: false,
    gates: { requireMotion: false }
  })
  assert.equal(analysis.verdict.pass, true, analysis.verdict.failures.join('; '))
  const srt = readFileSync(completed.mp4Path.replace(/\.[^.]+$/, '.srt'), 'utf8')
  for (const [label, transcript] of [
    ['Voice Shadcn New Library', 'Golem make a marker here for Voice Shadcn'],
    ['Realtime topic', 'Golem make a marker here for Realtime topic']
  ]) {
    // The caption artifact independently retains the seeded audio window
    // and verb segment offset, even when transcription arrives seconds later.
    const cue = srt.split(/\r?\n\r?\n/).find((block) => block.includes(transcript))
    assert.ok(cue, `Missing timed speech evidence for ${label}`)
    const stamp = cue.match(/(\d+):(\d+):(\d+),(\d+) -->/)
    assert.ok(stamp, `Missing audio timestamp for ${label}`)
    const expected =
      Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]) + Number(stamp[4]) / 1000
    const marker = spoken.markers.find((entry) => entry.label === label)
    assert.ok(
      marker && Math.abs(marker.atSeconds - expected) <= 0.002,
      `${label} must use speech time ${expected}, got ${marker?.atSeconds}`
    )
    console.log(`session markers: delayed ${label} matches audio offset ${expected}`)
  }
  for (const marker of spoken.markers)
    assert.ok(
      marker.atSeconds <= analysis.metrics.durationSeconds + 0.1,
      'Marker lies beyond finished video'
    )
  await ask('session.marker.rename', { sessionId, markerId: manual.id, label: 'Renamed title' })
  await ask('session.marker.delete', { sessionId, markerId: manual.id })
  assert.equal(
    (await ask('session.marker.get', { sessionId, markerId: manual.id })).status,
    'deleted'
  )
  await assert.rejects(() =>
    ask('session.marker.create', { operationId: manual.id, sessionId, label: 'Shadcn New Library' })
  )
  assert.equal((await ask('session.markers.list', { sessionId })).markers.length, 2)
  const selected = spoken.markers.find((marker) => marker.label === 'Voice Shadcn New Library')
  assert.ok(selected)
  await command('eval-js', {
    code: `
      const until = async (read) => { const deadline = Date.now() + 8000; while (Date.now() < deadline) { const value = read(); if (value) return value; await sleep(50); } throw new Error('Marker viewer did not reach the expected state'); };
      await openTab('library');
      const row = await until(() => document.querySelector('[data-videorc-library-row="${sessionId}"]'));
      row.querySelector('button[aria-label="Session actions"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const action = await until(() => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === 'Markers'));
      action.click();
      const dialog = await until(() => document.querySelector('[data-testid="session-markers-dialog"]'));
      const video = await until(() => { const value = dialog.querySelector('video'); return value?.readyState > 0 ? value : null; });
      const marker = await until(() => [...dialog.querySelectorAll('[aria-label="Saved markers"] button')].find((item) => item.textContent.includes('Voice Shadcn New Library')));
      marker.click();
      await until(() => Math.abs(video.currentTime - ${selected.atSeconds}) < 0.2);
      video.currentTime = 0;
      marker.click();
      await until(() => Math.abs(video.currentTime - ${selected.atSeconds}) < 0.2);
      dialog.querySelector('button[aria-label="Rename Voice Shadcn New Library"]').click();
      const title = await until(() => dialog.querySelector('input[aria-label="Marker title"]'));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, 'Edited in Library');
      title.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      title.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !dialog.querySelector('input[aria-label="Marker title"]') && [...dialog.querySelectorAll('[aria-label="Saved markers"] button')].some(item => item.textContent.includes('Edited in Library')));
      dialog.querySelector('[data-slot="dialog-close"]')?.click();
      return { repeatedSeek: video.currentTime };
    `
  })
  const edited = await ask('session.marker.get', { sessionId, markerId: selected.id })
  assert.equal(edited.marker.label, 'Edited in Library')
  assert.equal(edited.marker.atSeconds, selected.atSeconds)
  assert.equal(edited.marker.revision, 2)
  console.log('session markers: real Library viewer repeated original-video seek and rename')
  await ask('captions.stop')
  // Livestream with Record off: same local command and durable metadata, no media file.
  const port = Number(process.env.VIDEORC_MARKERS_RTMP_PORT ?? 19889)
  console.log('session markers: livestream with Record off')
  listener = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${port}/live`,
      '-f',
      'null',
      '-'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let listenerError = ''
  listener.stderr.on('data', (chunk) => {
    listenerError += chunk.toString()
  })
  await waitForOwnedTcpListener({
    child: listener,
    port,
    timeoutMs: 10_000,
    diagnostics: () => listenerError
  })
  const streamCapability = (
    await command('authorize-smoke-resource', { kind: 'output-directory', path: output })
  ).capabilityId
  const streaming = await ask('session.start', streamSessionParams(streamCapability, port))
  const streamId = streaming.sessionId
  captureSessionId = streamId
  assert.ok(streamId)
  assert.equal(streaming.outputPath, undefined)
  await waitFor(
    () => command('eval-js', { code: 'return window.videorc.getMarkerContext()' }),
    (view) => view?.result?.available && view.result.sessionId === streamId,
    'Stream-only marker context did not become available'
  )
  await waitFor(
    () => command('comments-window-reader-state'),
    (view) => view.composerCount === 1,
    'Stream-only composer unavailable'
  )
  assert.equal(
    (await command('comments-window-submit-message', { text: '/marker Live topic' })).submitted,
    true
  )
  await waitFor(
    () => ask('session.markers.list', { sessionId: streamId }),
    (page) => page.markers.length === 1,
    'Stream-only marker not saved'
  )
  await ask('session.marker.voice.configure', { sessionId: streamId, consent: true })
  await ask('captions.test.inject-audio', { durationMs: 3000, quiet: true })
  fake.state.chunkFinals.push({
    text: 'Golem make a marker here for Live voice topic',
    segments: [{ text: 'make', startSecond: 0.2, endSecond: 0.4 }]
  })
  await ask('captions.test.inject-audio', { durationMs: 3000 })
  await ask('captions.test.inject-audio', { durationMs: 2000, quiet: true })
  await waitFor(
    () => ask('session.markers.list', { sessionId: streamId }),
    (page) =>
      page.markers.some(
        (marker) => marker.label === 'Live voice topic' && marker.source === 'voice'
      ),
    'Stream-only voice marker not saved'
  )
  await ask('session.stop')
  const streamMarkers = (await ask('session.markers.list', { sessionId: streamId })).markers
  assert.deepEqual(
    streamMarkers.map((marker) => marker.label),
    ['Live topic', 'Live voice topic']
  )
  assert.equal((await ask('clip.marks.list', { sessionId: streamId })).length, 0)
  assert.equal(fake.state.commandRequests, 0, 'Named markers invoked a cloud command parser')
  console.log(
    'session markers PASS: real composer, chunked/realtime voice, stream-only typed/voice markers, consent cancellation, clip isolation, rename/delete receipts and analyzed video timeline'
  )
} finally {
  console.log(
    'session marker diagnostics:',
    JSON.stringify({
      chunkRequests: fake.state.chunkRequests,
      remainingChunkFinals: fake.state.chunkFinals.length,
      realtimeConnections: fake.state.realtimeConnections,
      markerEvents
    })
  )
  if (audioPump) clearInterval(audioPump)
  ws?.close()
  if (launched) await stopProcess(launched.process)
  if (listener) await stopProcess(listener)
  await fake.close()
}
