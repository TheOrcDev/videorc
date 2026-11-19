/** Maintained real-page privacy acceptance. NEVER imported by focused tests.
 * Fake capture input and fixture API transport; actual desktop publication,
 * LiveKit codecs, program page, guest component and decoded recording pixels.
 * Managed egress/physical capture qualification is separate and remains not-run. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import {
  assertFrostPixels,
  assertPrivacyDrain,
  assertNoSecretPixels,
  hasSecretMarker
} from './cloud-parity-privacy-contract.mjs'

export async function exercisePrivacy({ h, clients, pages, report, output, newPage, programUrl }) {
  const recording = await newPage('privacy-recording')
  const recordingUrl = new URL(programUrl)
  recordingUrl.searchParams.set('rec', '1')
  recordingUrl.searchParams.set(
    'token',
    h.web.tokenFor(h.showId, 'EG_parity_privacy_recording', 'recorder')
  )
  await recording.goto(recordingUrl.toString())
  const consumers = [...clients, { name: 'privacy-recording', page: recording }]
  const watchFrames = () => {
    const trace = { frames: [] }
    window.__privacyTrace = trace
    const seen = new WeakMap()
    setInterval(() => {
      for (const video of document.querySelectorAll('video')) {
        if (video.videoWidth !== 640 || video.videoHeight !== 360 || video.readyState < 2) continue
        const decoded = video.getVideoPlaybackQuality().totalVideoFrames
        if (seen.get(video) === decoded) continue
        seen.set(video, decoded)
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(video, 0, 0, 32, 32)
        const data = context.getImageData(0, 0, 32, 32).data
        let raw = false
        for (let i = 0; i < data.length; i += 4)
          raw ||= [0, 1, 2].some((offset) => Math.abs(data[i + offset] - 128) > 5)
        trace.frames.push({ at: Date.now(), raw, decoded })
        if (trace.frames.length > 10000)
          throw new Error('Privacy trace exceeded bounded frame budget')
      }
    }, 16)
  }
  for (const { page } of consumers) {
    await page.addInitScript(watchFrames)
    await page.evaluate(watchFrames)
  }
  const result = {
    status: 'running',
    cases: [],
    managedEgress: 'not-run',
    physicalCapture: 'not-run',
    ackAuthority:
      'Fixture transport receipts; real HTTP authorization tested separately. No forged host confirmations.'
  }
  report.privacy = result
  // Secret marker is readable magenta text on the wire's neutral grey. Any
  // decoded raw frame carries text pixels off the grey, so downsampled
  // inspection stays decisive. A receiver's Hide frost (plan 210 D8: the
  // frame it last showed, blurred, as in the Studio) keeps the page's
  // colour as a soft pink band but never a pure magenta stroke, so a pure
  // magenta pixel in a composed output is a raw frame.
  await h.eval(`
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d');
      const draw = () => { context.fillStyle = '#808080'; context.fillRect(0,0,640,360);
        context.fillStyle = '#ff00ff'; context.font = 'bold 72px sans-serif'; context.fillText('SECRET 249',40,200); };
      draw(); const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
    await window.__videorcSmokeScenePresets.screenPrivacyCommand('show');
    await window.__videorcSmokeScenePresets.roomScreenShare();
  `)
  await h.rpc('cloud.stage.set', {
    layout: 'screen-people',
    screen: `host:${h.showId}`,
    onStage: [
      `host:${h.showId}`,
      ...clients.filter((c) => c.name !== 'program').map((_, i) => `g_${String(i + 1).repeat(22)}`)
    ]
  })
  const sample = async (page) =>
    page.evaluate(() => {
      const video = [...document.querySelectorAll('video')].find(
        (v) => v.videoWidth === 640 && v.videoHeight === 360
      )
      if (!video || video.readyState < 2) return null
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(video, 0, 0, 32, 32)
      return { at: Date.now(), pixels: [...context.getImageData(0, 0, 32, 32).data] }
    })
  for (const consumer of consumers)
    await waitFor(
      async () => hasSecretMarker((await sample(consumer.page))?.pixels),
      `${consumer.name} sees real secret before Hide`
    )
  for (const scenario of [
    'hide',
    'automatic',
    'source-switch',
    'rapid-show-hide',
    'receiver-reconnect'
  ]) {
    if (scenario === 'automatic')
      await h.eval(`await window.__videorcSmokeScenePresets.screenPrivacyCommand('show');`)
    const blocked = await h.eval(`
      await window.__videorcSmokeScenePresets.screenPrivacyCommand('hide', 'you', '${scenario === 'automatic' ? 'password-manager' : 'you'}');
      return window.__videorcSmokeScenePresets.roomPrivacy();
    `)
    assert.ok(blocked?.hidden && blocked.sourceBlockedAt)
    if (scenario === 'source-switch')
      await h.eval('await window.__videorcSmokeScenePresets.roomScreenShare();')
    if (scenario === 'rapid-show-hide')
      await h.eval(`
      const show = window.__videorcSmokeScenePresets.screenPrivacyCommand('show');
      const hide = window.__videorcSmokeScenePresets.screenPrivacyCommand('hide');
      await Promise.all([show, hide]);
    `)
    if (scenario === 'receiver-reconnect')
      await Promise.all(consumers.map(({ page }) => page.reload()))
    await waitFor(
      () => h.eval('return !!window.__videorcSmokeScenePresets.roomPrivacyPixels()'),
      'guarded source ready'
    )
    for (let i = 0; i < 30; i++)
      assertFrostPixels(
        await h.eval('return window.__videorcSmokeScenePresets.roomPrivacyPixels()'),
        'publication boundary'
      )
    const epoch = await h.eval('return window.__videorcSmokeScenePresets.roomPrivacy();')
    const checks = await Promise.all(
      consumers.map(async ({ name, page }) => {
        let lastRawAt = null,
          firstFrostAt,
          appliedAt
        await waitFor(async () => {
          const frame = await sample(page)
          if (!frame) return false
          try {
            assertFrostPixels(frame.pixels, name)
            firstFrostAt = frame.at
            return true
          } catch {
            lastRawAt = frame.at
            return false
          }
        }, `${name} receives frost`)
        await waitFor(() => {
          const observations =
            name.startsWith('privacy-recording') || name === 'program'
              ? pages.programBeacons
                  .filter((b) => (b.body?.rec === true) === (name === 'privacy-recording'))
                  .map((b) => b.body?.privacy)
                  .filter(Boolean)
              : pages.privacyObservations.filter((b) => b.receiver === name)
          const matching = observations.find(
            (b) => b.epoch === epoch.epoch && b.generation === epoch.generation
          )
          appliedAt = matching?.appliedAt
          return !!matching
        }, `${name} applied-frost observation`)
        await waitFor(
          async () =>
            page.evaluate(
              (at) => window.__privacyTrace.frames.some((frame) => !frame.raw && frame.at >= at),
              appliedAt
            ),
          `${name} decoded pixel after ack`
        )
        const trace = await page.evaluate(() => window.__privacyTrace.frames)
        const rawFrames = trace.filter((frame) => frame.raw)
        lastRawAt = rawFrames.at(-1)?.at ?? null
        assertPrivacyDrain({ blockedAt: blocked.sourceBlockedAt, appliedAt, lastRawAt })
        assert.ok(
          !trace.some((frame) => frame.raw && frame.at >= appliedAt),
          'Raw decoded frame after applied-frost'
        )
        for (let i = 0; i < 20; i++)
          assertFrostPixels((await sample(page)).pixels, `${name} after observation`)
        const composed = join(output, `privacy-${scenario}-${name}.png`)
        await page.screenshot({ path: composed })
        assertNoSecretPixels(
          runMedia(h.ffmpeg, [
            '-v',
            'error',
            '-i',
            composed,
            '-pix_fmt',
            'rgba',
            '-f',
            'rawvideo',
            'pipe:1'
          ]),
          `${name} composed output`
        )
        // Record the real decoded subscriber track, then inspect the FINISHED
        // artifact; a successful ack or a screenshot alone is insufficient.
        const bytes = await page.evaluate(async () => {
          const video = [...document.querySelectorAll('video')].find(
            (v) => v.videoWidth === 640 && v.videoHeight === 360
          )
          const recorder = new MediaRecorder(video.srcObject, { mimeType: 'video/webm;codecs=vp8' })
          const chunks = []
          recorder.ondataavailable = (e) => chunks.push(e.data)
          const done = new Promise((resolve) => (recorder.onstop = resolve))
          recorder.start()
          await new Promise((resolve) => setTimeout(resolve, 1000))
          recorder.stop()
          await done
          return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
        })
        const file = join(output, `privacy-${scenario}-${name}.webm`)
        writeFileSync(file, Buffer.from(bytes))
        const decoded = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          'scale=32:32',
          '-pix_fmt',
          'rgba',
          '-f',
          'rawvideo',
          'pipe:1'
        ])
        assert.ok(decoded.length >= 32 * 32 * 4 * 10, 'Recording needs at least ten decoded frames')
        for (let at = 0; at < decoded.length; at += 4096)
          assertFrostPixels(decoded.subarray(at, at + 4096), `${name} finished recording`)
        return {
          name,
          lastRawAt,
          firstFrostAt,
          artifact: file,
          decodedFrames: decoded.length / 4096
        }
      })
    )
    result.cases.push({ scenario, epoch, checks })
  }
  // The fixture doesn't relay server-authorized observations: the UI MUST stay unconfirmed.
  await waitFor(
    () =>
      h.eval(`return window.__videorcSmokeScenePresets.roomPrivacy()?.status === 'unconfirmed'`),
    'missing authenticated acknowledgement stays unconfirmed'
  )
  const finalProgramVideo = recording.video()
  await recording.close()
  const finalProgramPath = await finalProgramVideo.path()
  const programFrames = runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-sseof',
    '-1',
    '-i',
    finalProgramPath,
    '-vf',
    'scale=640:360',
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
  assertNoSecretPixels(programFrames, 'finished composed program recording')
  result.finalProgramArtifact = finalProgramPath
  await h.eval('await window.__videorcSmokeScenePresets.roomScreenStop();')
  result.status = 'passed'
}
