/** S15 maintained real acquisition. Import is inert; no provider calls. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { captionPixels, assessCaptionEvidence } from './cloud-parity-captions-contract.mjs'
export async function exerciseCaptions({ h, clients, newPage, programUrl, output }) {
  assert.ok(h.speech, 'Inject the real fake speech gateway before launching the app')
  const report = {
    status: 'running',
    productionQualified: false,
    managed: 'not-run',
    devices: 'not-run',
    showClockUncertaintyMs: null,
    steps: [],
    artifacts: []
  }
  const program = clients.find((c) => c.name === 'program').page
  const recording = await newPage('captions-recording')
  const url = new URL(programUrl)
  url.searchParams.set('rec', '1')
  url.searchParams.set('token', h.web.tokenFor(h.showId, 'EG_parity_avatar_recording', 'recorder'))
  await recording.goto(url.toString())
  const configure = async (patch) => {
    if (patch.burnTarget) {
      const layout = await h.rpc('overlays.layout.get')
      await h.rpc('overlays.layout.set', {
        ...layout,
        captions: {
          ...layout.captions,
          showOnStream: ['stream', 'both'].includes(patch.burnTarget),
          showInRecording: ['recording', 'both'].includes(patch.burnTarget)
        }
      })
    }
    await h.eval(
      `const s=window.__videorcSmokeScenePresets,c=s.streamingState().captureConfig;s.configure({captions:{...c.captions,...${JSON.stringify(patch)}}});return true`
    )
    await waitFor(
      () =>
        h.eval(
          `const c=window.__videorcSmokeScenePresets.streamingState().captureConfig.captions;return Object.entries(${JSON.stringify(patch)}).every(([k,v])=>c[k]===v)`
        ),
      'Caption consent/output configuration applied'
    )
  }
  const mic = (mode) =>
    h.eval(`return window.__videorcSmokeScenePresets.microphone(${JSON.stringify(mode)})`)
  const counters = () => ({
    bytes: h.speech.state.audioBytes,
    chunks: h.speech.state.chunkRequests,
    commands: h.speech.state.commandRequests
  })
  const silent = async (label) => {
    const before = counters()
    await delay(1000)
    assert.deepEqual(counters(), before, `${label}: zero uploads and guest commands`)
    report.steps.push({ name: label, zeroUpload: true, zeroGuestCommands: true })
  }
  const layer = (page) => page.locator('img[data-graphics-layer="caption"]')
  const pixels = async (label, page) => {
    await waitFor(async () => (await layer(page).count()) === 1, `${label}: caption displayed`)
    const path = join(output, `${label}.png`)
    await page.screenshot({ path })
    const box = await layer(page).boundingBox()
    assert.ok(box && box.width > 0 && box.height > 0)
    // Inspect decoded picture pixels from the actual program page, not a receipt.
    const crop = `crop=${Math.floor(box.width)}:${Math.floor(box.height)}:${Math.floor(box.x)}:${Math.floor(box.y)}`
    const raw = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      crop,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    const measured = captionPixels(raw)
    assert.ok(measured.ink > 30, `${label}: no caption glyph pixels`)
    report.artifacts.push({ file: path, kind: 'actual-program-caption-pixels', ...measured })
    return measured
  }
  await configure({ enabled: false, burnTarget: 'both' })
  await h.rpc('captions.stop')
  await h.rpc('cohost.stop')
  await silent('off-with-live-guest-audio')
  const nativeBefore = await h.eval('return window.videorc.getRoomNativeMicrophoneResources()')
  assert.equal(nativeBefore.nativeSources, 0, 'Browser-AEC must not open native capture')
  await configure({ enabled: true, burnTarget: 'both' })
  await waitFor(
    () => h.speech.state.audioBytes > 0,
    'Actual processed host PCM reached fake gateway'
  )
  const previousPicture = await layer(program)
    .getAttribute('src')
    .catch(() => null)
  const partialSentAt = performance.now()
  const hold = h.speech.holdNextRealtimeFinal()
  const final = h.speech.emitRealtimeFinal('HOST FINAL REPLACES PARTIAL', {
    partialText: 'HOST PARTIAL'
  })
  await hold.arrived
  await waitFor(
    async () =>
      (await layer(program).count()) === 1 &&
      (await layer(program).getAttribute('src')) !== previousPicture,
    'Manual partial replaced prior picture'
  )
  const partial = await pixels('host-partial-program', program)
  const partialToPaintMs = performance.now() - partialSentAt
  const partialPicture = await layer(program).getAttribute('src')
  const finalSentAt = performance.now()
  hold.release()
  await final
  await waitFor(
    async () =>
      (await h.rpc('cloud.speech.transcript', { showId: h.showId })).some(
        (c) => c.text === 'HOST FINAL REPLACES PARTIAL'
      ),
    'Durable canonical final'
  )
  await waitFor(
    async () =>
      (await layer(program).count()) === 1 &&
      (await layer(program).getAttribute('src')) !== partialPicture,
    'Final replaced partial picture'
  )
  const settled = await pixels('host-final-program', program)
  const finalToPaintMs = performance.now() - finalSentAt
  assert.ok(
    partialToPaintMs < 5000 && finalToPaintMs < 5000,
    'Local fake-gateway caption picture exceeded five seconds'
  )
  report.steps.push({
    name: 'local-cue-timing',
    partialToPaintMs,
    finalToPaintMs,
    clockBasis: 'processed-host-source'
  })
  assert.notEqual(settled.sha256, partial.sha256, 'Partial must be replaced by final picture')
  await pixels('host-final-recording', recording)
  const cues = await h.rpc('cloud.speech.transcript', { showId: h.showId })
  assert.equal(cues.filter((c) => c.text === 'HOST FINAL REPLACES PARTIAL').length, 1)
  assert.ok(
    cues.every((c) => c.clockBasis === 'processed-host-source' && c.clock.uncertaintyMs === null)
  )
  report.steps.push({ name: 'partial-final-and-transcript', canonicalFinals: 1 })
  const bothPicture = await layer(program).getAttribute('src')
  await configure({ burnTarget: 'stream' })
  await h.speech.emitRealtimeFinal('STREAM ONLY HOST')
  await waitFor(
    async () =>
      (await layer(program).count()) === 1 &&
      (await layer(program).getAttribute('src')) !== bothPicture,
    'Stream-only utterance picture'
  )
  await pixels('stream-only-program', program)
  await waitFor(
    async () => (await layer(recording).count()) === 0,
    'Recording caption cleared independently'
  )
  await configure({ burnTarget: 'recording' })
  await h.speech.emitRealtimeFinal('RECORD ONLY HOST')
  await pixels('record-only-program', recording)
  await waitFor(
    async () => (await layer(program).count()) === 0,
    'Stream caption cleared independently'
  )
  report.steps.push({ name: 'independent-output-pixels', streamOnly: true, recordingOnly: true })
  await mic('mute')
  await waitFor(
    async () => (await layer(recording).count()) === 0,
    'Mute clears room caption picture'
  )
  await silent('muted-host-guests-still-publishing')
  await mic('unmute')
  const resumed = counters().bytes
  await waitFor(() => counters().bytes > resumed, 'Host upload resumed on same publication')
  await configure({ enabled: false })
  await h.rpc('captions.stop')
  await silent('consent-withdrawn')
  // Listen-only uses the same actual host publication and metered chunk path.
  await h.rpc('liveChat.start', {
    sessionId: h.showId,
    destinations: [
      { platform: 'twitch', targetId: 'host-listen-fixture', read: 'ready', write: 'ready' }
    ],
    fakes: [{ platform: 'twitch', targetId: 'host-listen-fixture', count: 0, send: 'sent' }]
  })
  await h.rpc('cohost.settings.set', { enabled: true, listen: true })
  const beforeListen = counters().chunks
  await h.rpc('cohost.start', { sessionId: h.showId, consentToProcessChat: true })
  await waitFor(() => counters().chunks > beforeListen, 'Listen-only actual host PCM chunk')
  assert.ok(h.speech.state.chunkPurposes.includes('listen'))
  report.steps.push({ name: 'listen-only-host', uploaded: true })
  await mic('mute')
  await silent('listen-only-muted')
  await h.rpc('cohost.stop')
  await mic('unmute')
  await silent('listen-consent-withdrawn')
  const beforeReconsent = counters().bytes
  await configure({ enabled: true })
  await waitFor(() => counters().bytes > beforeReconsent, 'Host reconsent')
  await h.rpc('cloud.room.close')
  await silent('room-closed')
  await assert.rejects(h.rpc('cloud.speech.transcript', { showId: 'other-show' }))
  assert.equal(
    (await h.eval('return window.videorc.getRoomNativeMicrophoneResources()')).nativeSources,
    0
  )
  await h.kill()
  const readDurable = () => {
    const db = new DatabaseSync(join(h.appData, 'videorc.sqlite3'), { readOnly: true })
    try {
      return db
        .prepare(
          'SELECT text,offset_seconds,source_id FROM cloud_host_transcript WHERE show_id=? ORDER BY rowid'
        )
        .all(h.showId)
    } finally {
      db.close()
    }
  }
  const beforeRestart = readDurable()
  assert.ok(beforeRestart.some((c) => c.text === 'HOST FINAL REPLACES PARTIAL'))
  await h.launch()
  assert.deepEqual(
    readDurable(),
    beforeRestart,
    'Backend relaunch must preserve settled host transcript without reupload'
  )
  await silent('restart-with-room-closed')
  report.steps.push({ name: 'durable-restart', cues: beforeRestart.length })
  Object.assign(report, assessCaptionEvidence(report))
  assert.equal(report.status, 'passed')
  writeFileSync(join(output, 'captions-acquisition.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
