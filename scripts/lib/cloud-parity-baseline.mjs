import {
  prepareGraphics,
  exerciseGraphics,
  assertGraphicsArtifacts
} from './cloud-parity-graphics.mjs'
import { exerciseAudioRouting, installRoutingGuestScreen } from './cloud-parity-audio-routing.mjs'
import { audioRoutingConfig, SCREEN_TONE_HZ } from './cloud-parity-audio-routing-contract.mjs'
import {
  prepareAvatar,
  exerciseAvatar,
  assertAvatarVideo,
  wearAvatarFixture
} from './cloud-parity-avatar.mjs'
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
import { paritySeams } from './cloud-parity-seams.mjs'
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
  toneDbfs,
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
  outputs = false,
  markers = false,
  controls = false,
  privacy = false,
  soundboard = false,
  avatar = false,
  scenes = false,
  sources = false,
  archive = false,
  clips = false,
  replayRing = false,
  avatarAnimation = false,
  views = false,
  graphics = false,
  handoff = false,
  audioRouting = false,
  health = false
}) {
  // Plan 249 S5: the animation case runs on the avatar case's real pages.
  // Plan 249 S24: so does the handoff case, after the avatar phase.
  avatar = avatar || avatarAnimation || handoff
  // Plan 249 S14: the sources case runs on the scenes case's real pages.
  const sourcesCase = sources
  scenes = scenes || sources
  const report = baselineReport({
    desktop: revision(desktopRoot),
    web: revision(webRoot),
    template: 'v1'
  })
  const routingConfig = audioRouting ? audioRoutingConfig() : null
  report.case = health
    ? 'health'
    : sourcesCase
      ? 'sources'
      : clips
        ? 'clips'
        : audioRouting
          ? 'audio-routing'
          : markers
            ? 'markers'
            : handoff
              ? 'handoff'
              : outputs
                ? 'outputs'
                : captions
                  ? 'captions'
                  : archive
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
  const h = await managedHarness('talk', 1, {
    speech: captions || outputs || markers,
    localEgress: outputs,
    maximumLogEntries: 4096
  })
  // The seams into the app, for both apps (`h.studio.*`, `h.room.*`): the
  // renderer's on Electron, the Rust app's commands and the backend room's
  // presentation on GPUI (`cloud-parity-seams.mjs`).
  const seams = paritySeams(h)
  h.studio = seams.studio
  h.room = seams.room
  if (markers) {
    const { installMarkers } = await import('./cloud-parity-markers.mjs')
    await installMarkers(h, webRoot)
  }
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
              routingConfig?.seconds ?? MEDIA.captureSeconds
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
        const tones = {
          ...audioMeasurements(samples),
          ...(audioRouting ? { screen: toneDbfs(samples, SCREEN_TONE_HZ) } : {})
        }
        // Preserve the whole artifact and full-window measurements. Controls
        // allow at most one second for WebRTC/fade settlement, then require
        // continuous silence/restoration in the remaining decoded window.
        assert.ok(samples.length >= MEDIA.sampleRate * 2, 'Audio capture is too short')
        const settledTones = {
          ...audioMeasurements(samples.subarray(MEDIA.sampleRate)),
          ...(audioRouting
            ? { screen: toneDbfs(samples.subarray(MEDIA.sampleRate), SCREEN_TONE_HZ) }
            : {})
        }
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
    await h.destinations(controls || markers ? 1 : 0)
    if (audioRouting) h.env.VIDEORC_ROOM_NATIVE_SYSTEM = '1'
    await h.launch()
    if (avatar || views) await wearAvatarFixture(h)
    const cameraId = await prepareParityRoom(h, controls)
    if (outputs) {
      // S17: an unmeasured profile is refused by the real app and fake web
      // before any room exists, with its reason; nothing opens.
      await assert.rejects(
        h.rpc('cloud.room.open', {
          outputs: [{ ...OUTPUT, width: 3840, height: 2160, videoKbps: 20000 }],
          title: 'Plan 249 outputs 4K',
          platforms: []
        }),
        /4K hasn't been measured/
      )
      assert.equal((await h.rpc('cloud.status')).room?.phase ?? 'closed', 'closed')
    }
    const opened = await h.rpc('cloud.room.open', {
      outputs: outputs
        ? [OUTPUT, { ...OUTPUT, orientation: 'vertical', width: 720, height: 1280 }]
        : [OUTPUT],
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
          {
            identity,
            screenShareAllowed: audioRouting && name === 'guest1',
            url: h.livekit.url,
            token: h.web.tokenFor(h.showId, identity, 'guest', audioRouting && name === 'guest1')
          }
        ]
      })
    )
    // The cases whose fixture relays the program page's receipt with a
    // graphics lane (`graphicsLanes.EG_parity_baseline` below): only there
    // can the host's static graphics lane reach the program page.
    const staticLane = Boolean(outputs || captions || avatar || scenes || graphics || views)
    pages = await startParityPages(
      webRoot,
      guests,
      outputs ||
        soundboard ||
        avatar ||
        scenes ||
        replayRing ||
        captions ||
        views ||
        graphics ||
        audioRouting
        ? {
            ...(outputs || captions || avatar || scenes || graphics
              ? {
                  graphicsLanes: {
                    EG_parity_baseline: { output: 'stream', orientation: 'h' },
                    EG_parity_avatar_recording: { output: 'recording', orientation: 'h' },
                    // S12 scenes reuse S9's vertical stream lane identity.
                    ...(outputs || graphics || scenes
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
        ...(audioRouting ? ['--mute-audio'] : []),
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
    const guestSaid = new Map()
    for (const [name] of guests) {
      const page = await newPage(name)
      await page.addInitScript(installGuestFixture, {
        color: MEDIA.colors[name],
        hz: MEDIA.tones[name],
        peak: MEDIA.tonePeak,
        slug: name
      })
      if (audioRouting && name === 'guest1')
        await page.addInitScript(installRoutingGuestScreen, {
          hz: SCREEN_TONE_HZ,
          peak: MEDIA.tonePeak
        })
      // What each guest page said, for the timeout below: a guest that never
      // publishes says why only in its own console.
      const said = []
      const note = (line) => {
        said.push(String(line).slice(0, 300))
        if (said.length > 40) said.shift()
      }
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          note(`${message.type()}: ${message.text()}`)
      })
      page.on('pageerror', (error) => note(`pageerror: ${error.message}`))
      page.on('requestfailed', (request) =>
        note(`requestfailed: ${request.method()} ${new URL(request.url()).pathname}`)
      )
      guestSaid.set(name, said)
      await page.goto(`${pages.origin}/guest/${name}`)
      clients.push({ name, page })
    }
    await h
      .status((s) => s.room?.participants?.length === 3, 'real guest components publish')
      .catch(async (error) => {
        const status = await h.rpc('cloud.status').catch(() => null)
        const pagesSay = {}
        for (const { name, page } of clients)
          pagesSay[name] = {
            shows: await page
              .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200))
              .catch((e) => String(e)),
            said: guestSaid.get(name)
          }
        throw new Error(
          `${error.message} (room participants: ${JSON.stringify(
            (status?.room?.participants ?? []).map((p) => p.identity)
          )}; guest pages: ${JSON.stringify(pagesSay)})`,
          { cause: error }
        )
      })
    await h.rpc('cloud.stage.set', {
      layout: 'side-by-side',
      onStage: [`host:${h.showId}`, ...[...guests.values()].map((g) => g.identity)]
    })
    if (graphics || outputs) await prepareGraphics({ h, report, output })
    // S6 views also needs the real avatar producer for guest graphics (D4).
    if (avatar || views) await prepareAvatar({ h, report })
    if (scenes) await prepareScenes({ h, report })
    const program = await newPage('program')
    // The program video's clock, for the card's window in it.
    const programVideoStartedAtMs = Date.now()
    let cardWindow = null
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
    if (outputs) {
      const { exerciseOutputs } = await import('./cloud-parity-outputs.mjs')
      report.outputs = await exerciseOutputs({
        h,
        report,
        webRoot,
        output,
        programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`
      })
      report.status = 'passed'
      writeReport()
    } else if (markers) {
      const { exerciseMarkers } = await import('./cloud-parity-markers.mjs')
      report.markers = await exerciseMarkers({ h, output })
      report.status = 'passed'
      writeReport()
    } else if (captions) {
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
      if (!graphics) {
        // The page withholds the legacy card only once the host's static
        // lane has reached it (its first snapshot, an empty one here, moves
        // the graphics roots into `.overlays`). That takes the page's
        // receipt and the host's answer, so wait for it: the card below is
        // then the withheld one, on a loaded Mac too.
        if (staticLane)
          await waitFor(
            () =>
              program.evaluate(
                () =>
                  [...(document.querySelector('.overlays')?.children ?? [])].filter(
                    (child) => !child.classList.contains('overlay')
                  ).length > 1
              ),
            'the static graphics lane live on the program page'
          )
        const fromMs = Date.now() - programVideoStartedAtMs
        await overlay('card', MEDIA.colors.card)
        cardWindow = { fromMs, toMs: Date.now() - programVideoStartedAtMs }
      }
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
      if (audioRouting)
        await exerciseAudioRouting({
          h,
          clients,
          captureAudio,
          report,
          sound,
          guests,
          output,
          config: routingConfig
        })
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
      if (sourcesCase) {
        const { exerciseSources } = await import('./cloud-parity-sources.mjs')
        await exerciseSources({
          h,
          report,
          clients,
          newPage,
          programUrl: `${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`,
          output
        })
      } else if (scenes)
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
      if (handoff)
        await (await import('./cloud-parity-handoff.mjs')).exerciseHandoff({ h, report, clients })
      // Plan 249 S26: the health scenarios, on the open room with its pages.
      if (health) await (await import('./cloud-parity-health.mjs')).exerciseHealth({ h, report })
      assert.equal(h.web.snapshot(h.showId).state.legs.length, 0)
      h.assertNoDirect()
      if (clips) {
        const { exerciseProgramClips } = await import('./cloud-parity-clips.mjs')
        await exerciseProgramClips({
          h,
          artifact: report.replayRing.artifacts[0].file,
          webRoot,
          output,
          report
        })
      }
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
      let cardWindowHits = 0
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
            if (fraction > MEDIA.analysis.minimumColorFraction) {
              hits[key]++
              // The card's colour while the card was up (a second of slack
              // each side for the video's own start). Later frames may carry
              // it for another reason: a hidden screen's frosted still keeps
              // the privacy fixture's magenta as a soft band.
              const atMs = (at / frameBytes) * 200
              if (
                name === 'program' &&
                key === 'card' &&
                cardWindow &&
                atMs >= cardWindow.fromMs - 1000 &&
                atMs <= cardWindow.toMs + 1000
              )
                cardWindowHits++
            }
          }
        }
        recordArtifact(report, h.root, file, `${name}-browser-video`)
        colorPeaks[name] = peaks
        frameHits[name] = hits
      }
      report.videoMeasurements = {
        colorPeaks,
        frameHits,
        sampledFps: 5,
        ...(cardWindow ? { cardWindow, cardWindowHits } : {})
      }
      if (avatar) assertAvatarVideo(report)
      if (graphics) assertGraphicsArtifacts(report)
      if (scenes && !sourcesCase) assertScenesVideo(report)
      const seen = (key) => frameHits.program[key] >= 5
      observations.push(
        {
          name: 'programCamera',
          passed: ['host', 'guest1', 'guest2'].every(seen),
          fractions: colorPeaks.program
        },
        {
          name: 'programCard',
          // A managed room's program takes its cards from the host's static
          // graphics lane (S9), which is live once the page's receipt has
          // reached the host (an empty snapshot is enough). The page then
          // withholds the legacy overlay card by design; the graphics case
          // proves the lane's own card. A case whose fixture relays no
          // receipt for the program page never has that lane, so there the
          // legacy card is the card and must show. Both are read in the
          // card's own window of the program video.
          passed: graphics
            ? report.graphics.cases.includes('chat-emoji-and-milestone')
            : staticLane
              ? cardWindowHits < 5
              : cardWindowHits >= 5,
          ...(graphics ? {} : { staticLane, cardWindowHits })
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
