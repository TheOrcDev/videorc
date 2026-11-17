import {
  prepareGraphics,
  exerciseGraphics,
  assertGraphicsArtifacts
} from './cloud-parity-graphics.mjs'
import { prepareAvatar, exerciseAvatar, assertAvatarVideo } from './cloud-parity-avatar.mjs'
import { exerciseAvatarAnimation } from './cloud-parity-avatar-animation.mjs'
import { prepareScenes, exerciseScenes, assertScenesVideo } from './cloud-parity-scenes.mjs'
import { exerciseSoundboard } from './cloud-parity-soundboard.mjs'
import { exercisePrivacy } from './cloud-parity-privacy.mjs'
import { exerciseViews } from './cloud-parity-views.mjs'
import { roomShownFromBeacon } from './cloud-parity-views-contract.mjs'
import {
  prepareParityRoom,
  assertInitialRoomControls,
  exerciseControls
} from './cloud-parity-controls.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { managedHarness, OUTPUT, runMedia, waitFor } from './cloud-managed-smoke.mjs'
import { writeBuddyPetFixturePack } from './buddy-pet-fixture.mjs'
import {
  baselineReport,
  finishBaseline,
  requireLoopback,
  redactParityFailure
} from './cloud-parity-contract.mjs'
import {
  MEDIA,
  toneWav,
  cameraY4m,
  audioMeasurements,
  colorFraction
} from './cloud-parity-media.mjs'
import {
  startParityPages,
  installGuestFixture,
  installProgramAudioTap,
  recordPageAudio
} from './cloud-parity-browser.mjs'

const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const recordArtifact = (report, root, file, kind) => {
  const bytes = readFileSync(file)
  report.artifacts.push({
    kind,
    file: relative(root, file),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })
}

/** No build, paid egress, provider destination or live service is started.
 * This is deliberately NOT invoked by focused tests or --help/check modes.
 */
export async function runBaseline({
  desktopRoot,
  webRoot,
  captions = false,
  controls = false,
  privacy = false,
  soundboard = false,
  avatar = false,
  scenes = false,
  archive = false,
  replayRing = false,
  avatarAnimation = false,
  views = false,
  graphics = false
}) {
  // Plan 249 S5: the animation case runs on the avatar case's real pages.
  avatar = avatar || avatarAnimation
  const report = baselineReport({
    desktop: revision(desktopRoot),
    web: revision(webRoot),
    template: 'v1'
  })
  report.case = archive
    ? 'archive'
    : graphics
      ? 'graphics'
      : scenes
        ? 'scenes'
        : replayRing
          ? 'replay-ring'
          : avatarAnimation
            ? 'avatar-animation'
            : views
              ? 'views'
              : avatar
                ? 'avatar'
                : soundboard
                  ? 'soundboard'
                  : privacy
                    ? 'privacy'
                    : controls
                      ? 'controls'
                      : 'baseline'
  // A dirty web consumer makes its revision misleading. Require a dedicated,
  // installed checkout; inspect it read-only and never change the active one.
  const webDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: webRoot,
    encoding: 'utf8'
  }).trim()
  assert.equal(
    webDirty,
    '',
    'Use a clean web fixture checkout so its revision identifies the consumer'
  )
  report.revisions.desktopDiffSha256 = createHash('sha256')
    .update(execFileSync('git', ['diff', 'HEAD'], { cwd: desktopRoot }))
    .digest('hex')
  report.revisions.programBundleSha256 = createHash('sha256')
    .update(readFileSync(join(webRoot, 'public/cloud/program/v1/stage.js')))
    .digest('hex')
  const h = await managedHarness('talk', 1, { speech: captions })
  const output = join(h.root, 'parity')
  mkdirSync(output)
  let pages, browser, failure
  const contexts = [],
    videos = [],
    observations = []
  const writeReport = () =>
    writeFileSync(join(output, `${report.case}.json`), JSON.stringify(report, null, 2) + '\n')
  const audible = (db) => db > MEDIA.analysis.audibleDbfs
  const captureAudio = async (label, clients) => {
    const captures = await Promise.all(
      clients.map(async ({ name, page }) => {
        const file = join(output, `${label}-${name}.webm`)
        writeFileSync(
          file,
          Buffer.from(
            await recordPageAudio(
              page,
              name === 'program' ? 'program' : 'guest',
              MEDIA.captureSeconds
            ),
            'base64'
          )
        )
        const raw = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(MEDIA.sampleRate),
          '-f',
          'f32le',
          'pipe:1'
        ])
        const samples = new Float32Array(raw.length / 4)
        for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4)
        const tones = audioMeasurements(samples)
        // Preserve the whole artifact and full-window measurements. Controls
        // allow at most one second for WebRTC/fade settlement, then require
        // continuous silence/restoration in the remaining decoded window.
        assert.ok(samples.length >= MEDIA.sampleRate * 2, 'Audio capture is too short')
        const settledTones = audioMeasurements(samples.subarray(MEDIA.sampleRate))
        recordArtifact(report, h.root, file, 'decoded-output-audio')
        return { name, tones, settledTones, settledAfterMs: 1000 }
      })
    )
    report.observations.push({ name: label, captures })
    return captures
  }
  try {
    writeReport()
    // Replace only the harness-owned device files before Electron opens them.
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO, cameraY4m(MEDIA.colors.host))
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO, toneWav(MEDIA.tones.host))
    await h.destinations(controls ? 1 : 0)
    await h.launch()
    const cameraId = await prepareParityRoom(h, controls)
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Plan 249 baseline',
      platforms: []
    })
    h.showId = opened.show.id
    await h.status((s) => s.room?.client === 'connected', 'desktop publisher joins')
    if (controls) await assertInitialRoomControls(h, cameraId)
    requireLoopback(h.livekit.url)
    const guests = new Map(
      ['guest1', 'guest2'].map((name, i) => {
        const identity = `g_${String(i + 1).repeat(22)}`
        return [
          name,
          { identity, url: h.livekit.url, token: h.web.tokenFor(h.showId, identity, 'guest') }
        ]
      })
    )
    pages = await startParityPages(
      webRoot,
      guests,
      soundboard || avatar || scenes || replayRing || captions || views || graphics
        ? {
            ...(avatar || scenes || graphics
              ? {
                  graphicsLanes: {
                    EG_parity_baseline: { output: 'stream', orientation: 'h' },
                    EG_parity_avatar_recording: { output: 'recording', orientation: 'h' },
                    // S12 scenes reuse S9's vertical stream lane identity.
                    ...(graphics || scenes
                      ? {
                          EG_parity_graphics_v: { output: 'stream', orientation: 'v' },
                          ...(graphics
                            ? { EG_parity_graphics_vrec: { output: 'recording', orientation: 'v' } }
                            : {})
                        }
                      : {})
                  }
                }
              : views
                ? { graphicsLanes: { EG_parity_baseline: { output: 'stream', orientation: 'h' } } }
                : {}),
            show: h.showId,
            ...(views
              ? {
                  shown: async (shown) =>
                    h.web.hooks.shown(
                      h.showId,
                      roomShownFromBeacon(shown, new Date().toISOString())
                    )
                }
              : {}),
            relay: {
              participantSession: async (show, identity) =>
                (await h.web.roomRpc('GetParticipant', { room: show, identity })).sid,
              auxiliarySid: async (show) => {
                const host = await h.web.roomRpc('GetParticipant', {
                  room: show,
                  identity: `host:${show}`
                })
                const tracks = (host.tracks ?? []).filter(
                  (t) => t.name === 'videorc:v2:host-aux:stereo'
                )
                return tracks.length === 1 ? tracks[0].sid : null
              },
              send: async (show, payload) =>
                h.web.roomRpc('SendData', {
                  room: show,
                  data: Buffer.from(payload).toString('base64'),
                  kind: 'RELIABLE',
                  destinationIdentities: [`host:${show}`],
                  topic: 'videorc.media-capability.v2'
                })
            }
          }
        : null
    )
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        ...(replayRing
          ? [
              '--auto-select-tab-capture-source-by-title=Videorc Replay Ring',
              '--enable-usermedia-screen-capturing',
              '--allow-http-screen-capture'
            ]
          : ['--use-fake-device-for-media-stream'])
      ]
    })
    const newPage = async (name) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: output, size: { width: 1280, height: 720 } }
      })
      contexts.push(context)
      // Real page scripts can only call local fixtures; external requests fail.
      await context.route('**/*', (route) => {
        try {
          requireLoopback(route.request().url())
          return route.continue()
        } catch {
          return route.abort('blockedbyclient')
        }
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      videos.push({ name, video: page.video() })
      return page
    }
    const clients = []
    for (const [name] of guests) {
      const page = await newPage(name)
      await page.addInitScript(installGuestFixture, {
        color: MEDIA.colors[name],
        hz: MEDIA.tones[name],
        peak: MEDIA.tonePeak,
        slug: name
      })
      await page.goto(`${pages.origin}/guest/${name}`)
      clients.push({ name, page })
    }
    await h.status((s) => s.room?.participants?.length === 3, 'real guest components publish')
    await h.rpc('cloud.stage.set', {
      layout: 'side-by-side',
      onStage: [`host:${h.showId}`, ...[...guests.values()].map((g) => g.identity)]
    })
    if (graphics) await prepareGraphics({ h, report, output })
    // S6 views also needs the real avatar producer for guest graphics (D4).
    if (avatar || views) await prepareAvatar({ h, report })
    if (scenes) await prepareScenes({ h, report })
    const program = await newPage('program')
    await program.addInitScript(installProgramAudioTap)
    const search = new URLSearchParams({
      show: h.showId,
      k: 'talk',
      pt: 'vcp1.dGVzdA.dGVzdA',
      layout: 'h',
      url: h.livekit.url,
      token: h.web.tokenFor(h.showId, 'EG_parity_baseline', 'recorder')
    })
    await program.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
    clients.unshift({ name: 'program', page: program })
    await waitFor(
      () =>
        program.evaluate(
          () => [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2).length >= 3
        ),
      'three cameras decoded by real program'
    )
    for (const { page, name } of clients.slice(1)) {
      await waitFor(
        () =>
          page.evaluate(
            () =>
              [...document.querySelectorAll('audio')].filter((a) => a.srcObject && !a.paused)
                .length >= 2
          ),
        `${name} actual return attached`
      )
    }
    if (captions) {
      const { exerciseCaptions } = await import('./cloud-parity-captions.mjs')
      report.captions = await exerciseCaptions({
        h,
        clients,
        newPage,
        programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`,
        output
      })
      report.status = 'passed'
      writeReport()
    } else {
      const base = await captureAudio('camera-mic', clients)
      const publications = await h.web.roomRpc('ListParticipants', { room: h.showId })
      report.sources = {
        observation: 'LiveKit publications, not an applied-output acknowledgement',
        participants: (publications.participants ?? []).map((person) => ({
          identity: person.identity,
          tracks: (person.tracks ?? []).map(({ sid, type, source, muted }) => ({
            sid,
            type,
            source,
            muted
          }))
        })),
        requestedOutput: OUTPUT,
        platformDestinations: [],
        nativeRecording: (await h.rpc('recording.status')).state,
        programSurface: 'local-real-page-browser-capture',
        encodedManagedOutput: 'not-run'
      }
      const programTones = base.find((c) => c.name === 'program').tones
      observations.push({
        name: 'programMicrophone',
        passed: ['host', 'guest1', 'guest2'].every((name) => audible(programTones[name])),
        tones: programTones
      })
      for (const name of ['guest1', 'guest2']) {
        const tones = base.find((c) => c.name === name).tones,
          other = name === 'guest1' ? 'guest2' : 'guest1'
        observations.push({
          name: `${name}Return`,
          passed:
            audible(tones.host) && audible(tones[other]) && tones[name] < MEDIA.analysis.absentDbfs,
          tones
        })
      }
      const overlay = async (slot, color) => {
        const png = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=0x${color.map((v) => v.toString(16).padStart(2, '0')).join('')}:s=64x64`,
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-c:v',
          'png',
          'pipe:1'
        ])
        await h.rpc('cloud.overlay.set', {
          slot,
          orientation: 'h',
          pngBase64: png.toString('base64'),
          rect: slot === 'card' ? { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } : { x: 0, y: 0, w: 1, h: 1 }
        })
        // Media window, not a readiness handshake: analysis below requires the
        // marker in decoded recording frames, independently of this RPC reply.
        const captured = await captureAudio(slot, clients)
        if (controls && slot === 'takeover') {
          const program = captured.find((c) => c.name === 'program')
          for (const voice of ['host', 'guest1', 'guest2'])
            assert.ok(
              program.settledTones[voice] < MEDIA.analysis.absentDbfs,
              `Takeover must silence ${voice} in program; web PR #118 is required`
            )
          report.takeoverPolicy = 'all-program-silence'
        }
        await h.rpc('cloud.overlay.clear', { slot, orientation: 'h' })
      }
      if (!graphics) await overlay('card', MEDIA.colors.card)
      await overlay('takeover', MEDIA.colors.takeover)
      if (controls) await exerciseControls({ h, clients, captureAudio, report, cameraId })
      if (privacy)
        await exercisePrivacy({
          h,
          clients,
          pages,
          report,
          output,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`
        })

      const soundPath = join(output, 'soundboard.wav')
      writeFileSync(soundPath, toneWav(MEDIA.tones.soundboard, 8))
      const auth = await h.command('authorize-smoke-resource', {
        kind: 'input-file',
        path: soundPath
      })
      const sound = await h.rpc('sounds.import', { sourceCapability: auth.capabilityId })
      if (replayRing) {
        const { exerciseReplayRing } = await import('./cloud-parity-replay-ring.mjs')
        await exerciseReplayRing({ h, program, webRoot, output, report, sound })
      }
      if (soundboard) await exerciseSoundboard({ h, clients, captureAudio, report, sound, guests })
      if (views) await exerciseViews({ h, clients, captureAudio, report, sound, guests, output })
      await h.rpc('sounds.play', { id: sound.id })
      const soundCaptures = await captureAudio('soundboard', clients)
      observations.push({
        name: 'soundboard',
        observed: soundCaptures.every((c) => c.tones.soundboard < MEDIA.analysis.absentDbfs)
          ? 'absent'
          : 'present',
        captures: soundCaptures
      })
      await h.rpc('sounds.stop')

      // Existing fixture pack and manual Say exercise the real avatar producer;
      // no AI provider or guest transcription is involved.
      const settings = await h.rpc('cohost.settings.get'),
        packId = randomUUID()
      writeBuddyPetFixturePack(
        join(h.env.VIDEORC_USER_DATA_DIR, 'buddy-assets', settings.persona.id, 'pets', packId)
      )
      await h.command('backend-debug-rpc', {
        method: 'cohost.pet.import',
        params: { folderToken: `${settings.persona.id}/pets/${packId}` },
        timeoutMs: 15000
      })
      await h.rpc('cohost.settings.set', {
        persona: { ...settings.persona, avatar: { kind: 'alive', packId } }
      })
      const layout = await h.rpc('overlays.layout.get')
      await h.rpc('overlays.layout.set', {
        ...layout,
        buddy: { ...layout.buddy, showOnStream: true, showInRecording: true }
      })
      await h.rpc('cohost.utterance.say', { text: 'Parity fixture bubble' })
      await captureAudio('avatar', clients)
      if (avatarAnimation)
        await exerciseAvatarAnimation({
          h,
          report,
          clients,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`
        })
      else if (avatar)
        await exerciseAvatar({
          h,
          report,
          clients,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`,
          captureAudio,
          output
        })
      if (graphics)
        await exerciseGraphics({
          h,
          report,
          clients,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`,
          output
        })
      if (scenes)
        await exerciseScenes({
          h,
          report,
          clients,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`,
          output,
          desktopRoot,
          guestIds: [...guests.values()].map((g) => g.identity)
        })
      assert.equal(h.web.snapshot(h.showId).state.legs.length, 0)
      h.assertNoDirect()
      if (archive) {
        const { exerciseLocalArchive } = await import('./cloud-parity-archive.mjs')
        await exerciseLocalArchive({
          h,
          artifact: report.replayRing.artifacts[0].file,
          output,
          report
        })
      }
      await h.rpc('cloud.room.close')
      for (const context of contexts) await context.close()
      contexts.length = 0
      const colors = { ...MEDIA.colors, ...(graphics ? { graphics: [0, 255, 255] } : {}) }
      const colorPeaks = {},
        frameHits = {}
      for (const { name, video } of videos) {
        const file = await video.path()
        const raw = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          'fps=5,scale=160:90',
          '-pix_fmt',
          'rgb24',
          '-f',
          'rawvideo',
          'pipe:1'
        ])
        const frameBytes = 160 * 90 * 3
        assert.ok(
          raw.length >= frameBytes * 5 && raw.length % frameBytes === 0,
          `${name}: incomplete video artifact`
        )
        const peaks = Object.fromEntries(Object.keys(colors).map((key) => [key, 0]))
        const hits = Object.fromEntries(Object.keys(colors).map((key) => [key, 0]))
        for (let at = 0; at < raw.length; at += frameBytes) {
          const frame = raw.subarray(at, at + frameBytes)
          for (const [key, color] of Object.entries(colors)) {
            const fraction = colorFraction(frame, color)
            peaks[key] = Math.max(peaks[key], fraction)
            if (fraction > MEDIA.analysis.minimumColorFraction) hits[key]++
          }
        }
        recordArtifact(report, h.root, file, `${name}-browser-video`)
        colorPeaks[name] = peaks
        frameHits[name] = hits
      }
      report.videoMeasurements = { colorPeaks, frameHits, sampledFps: 5 }
      if (avatar) assertAvatarVideo(report)
      if (graphics) assertGraphicsArtifacts(report)
      if (scenes) assertScenesVideo(report)
      const seen = (key) => frameHits.program[key] >= 5
      observations.push(
        {
          name: 'programCamera',
          passed: ['host', 'guest1', 'guest2'].every(seen),
          fractions: colorPeaks.program
        },
        {
          name: 'programCard',
          passed: graphics
            ? report.graphics.cases.includes('chat-emoji-and-milestone')
            : seen('card')
        },
        { name: 'programTakeover', passed: seen('takeover') },
        {
          name: 'avatar',
          observed: seen('avatar') ? 'present' : 'absent',
          fraction: colorPeaks.program.avatar
        }
      )
      finishBaseline(report, [...report.observations, ...observations])
      writeReport()
      assert.equal(report.status, 'passed', report.blockers.join('; '))
    }
  } catch (error) {
    report.status = 'failed'
    // Do not serialize page URLs/errors (which may contain ephemeral JWTs).
    report.blockers.push(
      redactParityFailure(error, [...h.web.tokens, h.livekit.apiKey, h.livekit.apiSecret])
    )
    writeReport()
    // Retain only the error class: the original cause/stack can contain a JWT URL.
    failure = new Error(
      `Cloud parity baseline failed; report: ${join(output, `${report.case}.json`)}`,
      {
        cause: new Error(error.name)
      }
    )
  } finally {
    const cleanups = await Promise.allSettled([browser?.close(), pages?.close(), h.close()])
    if (cleanups.some((r) => r.status === 'rejected')) {
      report.status = 'failed'
      report.blockers.push('Owned resource cleanup failed')
      writeReport()
      failure ??= new Error('Cloud parity owned resource cleanup failed')
    }
  }
  if (failure) throw failure
  return { report, output }
}
