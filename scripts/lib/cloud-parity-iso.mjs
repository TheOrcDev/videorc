/** Plan 249 S22 `iso` acquisition and analysis. Heavy/live: NEVER a unit test.
 *
 * One take, three views of it, all on one machine clock:
 * 1. The REAL desktop app (managedHarness) opens the talk room and publishes
 *    the host camera (solid-colour Y4M through Chromium fake capture), the
 *    S7b native room microphone (synthetic 440 Hz device, switched mid-take
 *    through the real device switch to the 880 Hz alternate: a new SID) and
 *    the S3 soundboard aux (1 kHz loop, exact aux name). Three real GuestRoom
 *    guests publish unique colours/tones with a white-flash / tone-gap marker
 *    on a shared wall-clock grid. Two allow separate recording through the
 *    REAL consent card and web handler (`handleGuestIsoConsent`); one does not.
 * 2. The REAL program page is tab-captured with its final audio bus for the
 *    whole take: the take's mixed program artifact, bound to the same take id.
 * 3. The REAL durable web ISO runtime (`handleIsoHttp` / `handleIsoFile` over
 *    the web's in-memory media store twin) runs behind the fake web; the
 *    desktop enables it with `cloud.iso.enable` and imports with
 *    `cloud.iso.import` into Library. A hidden `EG_` MediaRecorder page is the
 *    local stand-in for raw track egress (local LiveKit has no Egress service).
 *
 * Does NOT call LiveKit Cloud, a paid provider or a deployed service, and does
 * not qualify managed cost, concurrency or provider clock accuracy. Importing
 * this module launches nothing; only `acquireIsoEvidence` does.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { get as httpsGet } from 'node:https'
import { dirname, extname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { redactParityFailure, requireLoopback } from './cloud-parity-contract.mjs'
import {
  ISO_ANALYSIS,
  ISO_AUX_NAME,
  ISO_COLORS,
  ISO_CONSENTING,
  ISO_GUESTS,
  ISO_NOT_EXERCISED,
  ISO_SOURCES,
  ISO_TONES,
  analyzeIsoEvidence,
  areaDropOnsets,
  audioGapOnsets,
  colorMatch,
  envelopeGapOnsets,
  isoAcquisitionConfig,
  isoLibraryId,
  toneEnvelope,
  videoMarkerOnsets
} from './cloud-parity-iso-contract.mjs'
import { MEDIA, cameraY4m, colorFraction, toneDbfs, toneWav } from './cloud-parity-media.mjs'

/** The program tab's title: Chrome auto-selects it for tab capture. */
const PROGRAM_TITLE = 'Videorc ISO Program'
const NATIVE_MIC = 'microphone:coreaudio:4294967295'
const ALTERNATE_MIC = 'microphone:coreaudio:4294967294'
const TERMINAL = ['complete', 'failed', 'expired']

const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safeName = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '_')

/** Polls `fn` every `everyMs` until it returns a truthy value. */
async function until(fn, label, ms, everyMs = 1000) {
  const deadline = Date.now() + ms
  for (;;) {
    const started = Date.now()
    const value = await fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await sleep(Math.max(0, everyMs - (Date.now() - started)))
  }
}

function download(url, ca, file) {
  requireLoopback(url, ['https:'])
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { ca }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`Storage GET answered ${response.statusCode}`))
      }
      const out = createWriteStream(file)
      response.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
    })
    request.on('error', reject)
  })
}

export async function acquireIsoEvidence({
  desktopRoot,
  webRoot,
  config = isoAcquisitionConfig()
}) {
  assert.ok(webRoot, 'VIDEORC_PARITY_WEB_ROOT must name a clean, installed web checkout')
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: webRoot,
      encoding: 'utf8'
    }).trim(),
    '',
    'Use a clean web consumer checkout'
  )
  // Bundle every web/desktop module first: a missing export fails before any launch.
  const { loadIsoModules, createIsoWebFixture, recorderScript, startRecorderOrigin, sha256File } =
    await import('./cloud-parity-iso-web.mjs')
  const modules = await loadIsoModules(webRoot, desktopRoot)
  const { web, desktop: desktopIso } = modules
  const { managedHarness, OUTPUT, waitFor } = await import('./cloud-managed-smoke.mjs')
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages, installProgramAudioTap } = await import('./cloud-parity-browser.mjs')
  const { installIsoGuestFixture, startProgramCapture, stopProgramCapture } =
    await import('./cloud-parity-iso-pages.mjs')
  const { chromium } = await import('playwright-core')

  const h = await managedHarness('talk', 1, { maximumLogEntries: 4096 })
  const output = join(h.root, 'iso-acquisition')
  const storageRoot = join(output, 'storage')
  const importedRoot = join(output, 'imported')
  for (const dir of [storageRoot, importedRoot]) mkdirSync(dir, { recursive: true })
  const evidenceFile = join(output, 'evidence.json')
  const evidence = {
    schemaVersion: 2,
    kind: 'local-livekit-iso-desktop',
    acquisition: 'running',
    productionQualified: false,
    managed: 'not-run',
    config,
    revisions: {
      desktop: revision(desktopRoot),
      desktopDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD'], { cwd: desktopRoot })),
      web: revision(webRoot),
      programBundleSha256: sha256(readFileSync(join(webRoot, 'public/cloud/program/v1/stage.js')))
    },
    notExercised: ISO_NOT_EXERCISED,
    blockers: [],
    qualification: null,
    desktop: { rpc: 'unknown' },
    hostCamera: {
      // Recorded assumption: the desktop camera here is an opaque solid-colour
      // Y4M through Chromium fake capture with no background effect, so its
      // picture may be judged. The manifest still says layout unknown (v1).
      assumption: 'opaque-desktop-fixture',
      publisher: 'desktop renderer camera, Chromium fake capture of a solid-colour Y4M',
      trackName: null
    },
    published: {},
    unexpectedPublications: [],
    microphoneSwitch: null,
    consent: null,
    programTake: null,
    program: null,
    passes: [],
    manifestValid: false,
    manifestFile: null,
    routeChecks: {},
    imported: [],
    library: null,
    egress: null,
    isoState: null,
    cleanup: { ok: false },
    failures: []
  }
  const save = () => writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n')
  save()
  let iso, pages, browser, recorderOrigin, recorder, program, stand
  let programRecording = false
  const contexts = []
  const secrets = () => [
    ...(h.web?.tokens ?? []),
    h.livekit.apiKey,
    h.livekit.apiSecret,
    ...(iso?.secrets ?? [])
  ]
  const redact = (error) => redactParityFailure(error, secrets())
  try {
    // The harness's own localhost leaf and test root (managedHarness writes both).
    const tls = {
      cert: readFileSync(join(h.root, 'local-cert.pem')),
      key: readFileSync(join(h.root, 'local-key.pem'))
    }
    const ca = readFileSync(h.env.VIDEORC_CLOUD_FEED_CA_FILE)
    iso = await createIsoWebFixture({ modules, h, storageRoot, tls, config, evidence })
    await iso.startStorage()
    h.web.hooks.iso(iso.routes)

    // --- 1. The real desktop publisher ---------------------------------------
    Object.assign(h.env, {
      VIDEORC_ROOM_NATIVE_MIC: '1',
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1'
    })
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO, cameraY4m(ISO_COLORS['host-camera']))
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO, toneWav(ISO_TONES['host-microphone:g1']))
    await h.destinations(0)
    await h.launch()
    await h.eval('return window.__videorcSmokeScenePresets.roomNativeMicrophone(true)')
    await h.eval(
      'window.__videorcSmokeScenePresets.setSettings(current => ({ ...current, keepMicrophoneWarm: false })); return true'
    )
    await prepareParityRoom(h, false)
    await h.eval(
      `const seam=window.__videorcSmokeScenePresets; const config=seam.streamingState().captureConfig; seam.configure({audio:{...config.audio,microphoneGainDb:0,microphoneNoiseSuppression:'off',microphoneSyncOffsetMs:0,microphoneMuted:false}}); return true`
    )
    const soundPath = join(output, 'soundboard.wav')
    writeFileSync(soundPath, toneWav(ISO_TONES['host-aux'], 8))
    const soundGrant = await h.command('authorize-smoke-resource', {
      kind: 'input-file',
      path: soundPath
    })
    const sound = await h.rpc('sounds.import', { sourceCapability: soundGrant.capabilityId })
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Plan 249 ISO',
      platforms: []
    })
    h.showId = opened.show.id
    requireLoopback(h.livekit.url)
    await h.status((s) => s.room?.client === 'connected', 'desktop publisher joins')
    await waitFor(
      async () =>
        (await h.eval('return window.__videorcSmokeScenePresets.roomNativeMicrophone()'))?.state ===
        'published',
      'native host microphone published',
      config.readinessMs
    )
    const rooms = new modules.RoomServiceClient(
      h.livekit.httpUrl,
      h.livekit.apiKey,
      h.livekit.apiSecret
    )
    const sourceKeyOf = (p) => {
      const who =
        p.identity === `host:${h.showId}`
          ? 'host'
          : Object.keys(ISO_GUESTS).find((k) => ISO_GUESTS[k] === p.identity)
      if (!who) return null
      return (
        ISO_SOURCES.find(
          (s) =>
            s.who === who && s.source === p.source && (s.name === undefined || s.name === p.name)
        )?.key ?? null
      )
    }
    const publications = async () =>
      (await rooms.listParticipants(h.showId)).flatMap(web.toIsoPublications)
    const notePublished = (list) => {
      for (const p of list) {
        if (p.identity.startsWith('EG_')) continue
        const key = sourceKeyOf(p)
        if (!key) {
          const seen = evidence.unexpectedPublications
          if (!seen.some((u) => u.trackSid === p.trackSid))
            seen.push({
              subject: p.identity.startsWith('host:') ? 'host' : p.identity,
              source: p.source,
              name: p.name,
              trackSid: p.trackSid
            })
          continue
        }
        const sids = (evidence.published[key] ??= [])
        if (!sids.includes(p.trackSid)) sids.push(p.trackSid)
        if (key === 'host-camera') evidence.hostCamera.trackName = p.name
      }
      return list
    }

    // --- 2. The track-egress stand-in (hidden EG_ recorder) -------------------
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        `--auto-select-tab-capture-source-by-title=${PROGRAM_TITLE}`,
        '--enable-usermedia-screen-capturing',
        '--allow-http-screen-capture'
      ]
    })
    const newContext = async (viewport) => {
      const context = await browser.newContext({ viewport })
      contexts.push(context)
      // Page scripts may only reach local fixtures; everything else fails.
      await context.route('**/*', (route) => {
        try {
          requireLoopback(route.request().url())
          return route.continue()
        } catch {
          return route.abort('blockedbyclient')
        }
      })
      return context
    }
    const watch = (page, name) =>
      page.on('pageerror', (error) => evidence.failures.push(`${name}: ${redact(error)}`))
    recorderOrigin = await startRecorderOrigin(modules.livekitClient)
    recorder = await (await newContext({ width: 320, height: 180 })).newPage()
    watch(recorder, 'recorder')
    await recorder.exposeFunction('isoChunk', (egressId, b64) => stand?.chunk(egressId, b64))
    await recorder.goto(`${recorderOrigin.origin}/`)
    await recorder.waitForFunction(() => !!window.LivekitClient)
    await recorder.evaluate(`(${recorderScript})()`)
    await recorder.evaluate((a) => window.__rec.connect(a), {
      url: h.livekit.url,
      token: h.web.tokenFor(h.showId, 'EG_isotrackrecorder', 'recorder')
    })
    stand = iso.attachRecorder({
      recorder,
      failSource: config.failSource,
      sourceKeyOf,
      readinessMs: config.readinessMs
    })

    // --- 3. The desktop asks for ISO through its own RPC ----------------------
    const enable = { showId: h.showId, consent: true, ...config.request }
    try {
      const answer = await h.rpc('cloud.iso.status', { showId: h.showId })
      evidence.desktop = {
        rpc: 'present',
        before: { enabled: answer?.availability?.enabled ?? null, iso: answer?.iso ? 'set' : null }
      }
    } catch (error) {
      // Only a backend without the method falls back; any other error is a real failure.
      if (!/unknown backend method|unknown-method/i.test(String(error?.message))) throw error
      evidence.desktop = { rpc: 'missing', rpcError: redact(error) }
      evidence.blockers.push(
        'desktop-cloud-iso-rpc: the backend answered cloud.iso.status with an error. crates/videorc-backend/src/main.rs must dispatch cloud.iso.status/enable/disable/import/imports/cancelImport (contract section 5; renderer contract already in apps/desktop/src/shared/backend-rpc-contract.ts), call the web ISO routes with the account bearer, and register imports in Library. Until then the case continues over the fake web HTTP fallback so every other check has evidence; every desktop check fails.'
      )
    }
    if (evidence.desktop.rpc === 'present') {
      const answer = await h.rpc('cloud.iso.enable', enable)
      evidence.desktop.enable = {
        via: 'desktop-rpc',
        ok: answer?.iso?.request?.consentVersion === 'iso-consent-v1',
        fixtureQualified: answer?.availability?.productionQualified ?? null
      }
    } else {
      const { showId: _id, ...body } = enable
      const answer = await h.webRequest('iso', {
        action: 'enable',
        consentVersion: 'iso-consent-v1',
        ...body
      })
      evidence.desktop.enable = {
        via: 'harness-http-fallback',
        ok: false,
        httpOk: answer.status === 200 && !!answer.body?.iso?.request
      }
    }
    assert.ok(
      evidence.desktop.enable.ok || evidence.desktop.enable.httpOk,
      'ISO enable was refused'
    )
    save()

    // --- 4. Real GuestRoom guests, real consent card and handler --------------
    const guests = new Map(
      Object.entries(ISO_GUESTS).map(([name, identity]) => [
        name,
        { identity, url: h.livekit.url, token: h.web.tokenFor(h.showId, identity, 'guest') }
      ])
    )
    pages = await startParityPages(webRoot, guests, {
      show: h.showId,
      relay: {
        participantSession: async (show, identity) =>
          (await h.web.roomRpc('GetParticipant', { room: show, identity })).sid,
        auxiliarySid: async (show) => {
          const host = await h.web.roomRpc('GetParticipant', {
            room: show,
            identity: `host:${show}`
          })
          const tracks = (host.tracks ?? []).filter((t) => t.name === ISO_AUX_NAME)
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
    })
    const guestPages = {}
    for (const [name, guest] of guests) {
      const context = await newContext({ width: 960, height: 540 })
      const cookie = iso.admitGuest(name, guest.identity)
      await context.addCookies([{ name: 'vrc_guest', value: cookie, url: pages.origin }])
      await context.route('**/api/guest/*/iso-consent', iso.consentRoute(h.showId))
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      watch(page, name)
      await page.addInitScript(installIsoGuestFixture, {
        color: ISO_COLORS[`${name}-camera`],
        hz: ISO_TONES[`${name}-microphone`],
        peak: MEDIA.tonePeak,
        slug: name,
        period: ISO_ANALYSIS.markerPeriodMs,
        length: ISO_ANALYSIS.markerLengthMs
      })
      await page.goto(`${pages.origin}/guest/${name}`)
      guestPages[name] = page
    }
    await h.status(
      (s) => s.room?.participants?.length === 1 + guests.size,
      'real guest components publish',
      config.readinessMs
    )
    const COPY = web.ISO_CONSENT_COPY
    const cards = {}
    for (const name of guests.keys()) {
      const page = guestPages[name]
      await page.locator('[data-slot="iso-consent"]').waitFor({ timeout: config.readinessMs })
      const allow = ISO_CONSENTING.includes(name)
      await page
        .getByRole('button', { name: allow ? COPY.allowLabel : COPY.notNowLabel, exact: true })
        .click()
      await page
        .getByText(allow ? COPY.onTitle : COPY.offTitle, { exact: true })
        .first()
        .waitFor({ timeout: config.readinessMs })
      cards[name] = allow ? 'allowed' : 'not-now'
    }
    evidence.consent = {
      via: 'GuestRoom IsoConsentCard -> handleGuestIsoConsent (real web handler, fixture cookie)',
      cards,
      answers: iso.consentAnswers,
      stateGuests: Object.keys((await iso.isoState(h.showId))?.guestConsent ?? {})
    }
    await h.rpc('cloud.stage.set', {
      layout: 'side-by-side',
      onStage: [`host:${h.showId}`, ...[...guests.values()].map((g) => g.identity)]
    })

    // --- 5. The real program page, tab-captured with its final mix ------------
    program = await (await newContext({ width: 1280, height: 720 })).newPage()
    program.setDefaultTimeout(15000)
    watch(program, 'program')
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
    await waitFor(
      () =>
        program.evaluate(
          (n) =>
            [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2).length >= n,
          1 + guests.size
        ),
      'every camera decoded by the real program',
      config.readinessMs
    )

    // Host aux: the S3 soundboard publication, negotiated by the program page.
    await h.rpc('sounds.settings', { monitor: false, volumeDb: 0 })
    await h.eval('return window.__videorcSmokeScenePresets.roomSounds(true)')
    await waitFor(
      async () =>
        (await h.eval('return window.__videorcSmokeScenePresets.roomSounds()'))?.state ===
        'published',
      'host aux published',
      config.readinessMs
    )
    await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
    await h.rpc('sounds.play', { id: sound.id })
    await waitFor(
      async () => {
        const keys = new Set(notePublished(await publications()).map(sourceKeyOf))
        return ISO_SOURCES.every((s) => keys.has(s.key))
      },
      'every fixture source visible to the server',
      config.readinessMs
    )

    const programFile = join(output, 'program.webm')
    writeFileSync(programFile, '')
    let programBytes = 0
    await program.exposeFunction('__isoProgramChunk', (b64) => {
      const bytes = Buffer.from(b64, 'base64')
      programBytes += bytes.length
      if (programBytes > config.maximumArtifactBytes) throw new Error('Program byte budget')
      appendFileSync(programFile, bytes)
    })
    await program.bringToFront()
    await program.mouse.click(1, 1)
    const programStartedAt = await program.evaluate(startProgramCapture, { title: PROGRAM_TITLE })
    programRecording = true
    evidence.program = {
      source: 'actual-program-tab-and-final-audio-bus',
      file: relative(output, programFile),
      startedAtWallMs: programStartedAt,
      endedAtWallMs: null,
      bytes: 0,
      sha256: null
    }

    // --- 6. The take: program recording + ISO through the real runtime -------
    await h.rpc('cloud.recording.start')
    await waitFor(() => h.web.snapshot(h.showId).state.recording?.active, 'program take recording')
    const take = await iso.syncProgramTake(h.showId)
    assert.ok(take, 'The fake web must expose the recording take')
    evidence.programTake = {
      takeId: take.takeId,
      since: take.since,
      originAtMs: take.originAtMs,
      programRecordingId: iso.programRecordingId(take.takeId),
      mixedArtifact: evidence.program.file
    }
    save()
    // LiveKit webhooks schedule production ticks; here the owner route's
    // `reconcile` runs the same runIsoTick once a second, through the fake web.
    const tick = async (label) => {
      const at = Date.now()
      const { status, body } = await h.webRequest('iso', { action: 'reconcile' })
      const manifest =
        body?.iso?.takes?.find((t) => t.manifest.takeId === take.takeId)?.manifest ?? null
      evidence.passes.push({
        atMs: at - take.originAtMs,
        label,
        status,
        entries: manifest?.entries.map((e) => `${e.id}:${e.state}`) ?? [],
        refused: manifest?.refused.length ?? 0
      })
      notePublished(await publications())
      return manifest
    }
    while (Date.now() - take.originAtMs < config.durationMs) {
      const started = Date.now()
      if (!evidence.microphoneSwitch && started - take.originAtMs >= config.switchMicrophoneAtMs) {
        const before = (await publications()).find((p) => sourceKeyOf(p) === 'host-microphone')
        await h.eval(
          `await window.__videorcSmokeScenePresets.roomMicrophoneSelect(${JSON.stringify(ALTERNATE_MIC)}, 'Alternate parity microphone'); return true`
        )
        const after = await waitFor(
          async () =>
            (await publications()).find(
              (p) => sourceKeyOf(p) === 'host-microphone' && p.trackSid !== before?.trackSid
            ),
          'replacement host microphone published',
          config.readinessMs
        )
        notePublished([after])
        evidence.microphoneSwitch = {
          via: 'desktop-device-switch',
          seam: 'renderer roomMicrophoneSelect -> switchSourceDeviceLive (S7b unpublish, then publish)',
          from: NATIVE_MIC,
          to: ALTERNATE_MIC,
          atMs: Date.now() - take.originAtMs,
          sids: [before?.trackSid ?? null, after.trackSid]
        }
      }
      await tick('take')
      await sleep(Math.max(0, config.reconcileEveryMs - (Date.now() - started)))
    }
    await h.rpc('cloud.recording.stop')
    await waitFor(() => !h.web.snapshot(h.showId).state.recording?.active, 'program take stopped')
    await iso.syncProgramTake(h.showId)
    let manifest = null
    await until(
      async () => {
        manifest = await tick('settle')
        const state = await iso.isoState(h.showId)
        return (
          !!manifest &&
          manifest.stoppedAtMs !== null &&
          manifest.entries.every((e) => !['starting', 'recording'].includes(e.state)) &&
          !manifest.entries.some((e) => e.state === 'partial' && !e.objectKey) &&
          state?.keys.length === 0
        )
      },
      'ISO files settled and keys revoked',
      config.settleMs,
      config.reconcileEveryMs
    )
    await sleep(1000)
    evidence.program.endedAtWallMs = await program.evaluate(stopProgramCapture)
    programRecording = false
    evidence.program.bytes = statSync(programFile).size
    evidence.program.sha256 = await sha256File(programFile)
    await h.rpc('sounds.stop')

    // --- 7. Manifest, owner route, file route ---------------------------------
    manifest = (await iso.isoState(h.showId)).takes[take.takeId]
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    evidence.manifestFile = 'manifest.json'
    web.parseIsoManifest(manifest)
    const desktopManifest = desktopIso.parseIsoManifest(manifest)
    evidence.manifestValid = true
    const owner = await h.webRequest('iso')
    const routed = owner.body?.iso?.takes?.find((t) => t.manifest.takeId === take.takeId)
    const firstEntry = manifest.entries[0]?.id ?? 'none'
    const fileQuery = (entry) =>
      `iso/file?take=${encodeURIComponent(take.takeId)}&entry=${encodeURIComponent(entry)}`
    evidence.routeChecks = {
      ownerStatus: owner.status,
      ownerManifestMatches: isDeepStrictEqual(routed?.manifest, manifest),
      programRecordingId: routed?.programRecordingId ?? null,
      strangerStatus: (await iso.direct(`/api/cloud/shows/${h.showId}/iso`, 'someone-else')).status,
      strangerFileStatus: (
        await iso.direct(`/api/cloud/shows/${h.showId}/${fileQuery(firstEntry)}`, 'someone-else')
      ).status
    }
    const camera = manifest.entries.find((e) => e.role === 'host-camera' && e.state === 'complete')
    if (camera) {
      const file = await h.webRequest(fileQuery(camera.id))
      evidence.routeChecks.hostCameraFile = {
        status: file.status,
        frameLayout: file.body?.frameLayout ?? null,
        partial: file.body?.partial ?? null,
        servedByLoopbackStorage: String(file.body?.url ?? '').startsWith(iso.storageOrigin)
      }
    }
    save()

    // --- 8. Desktop import into Library ---------------------------------------
    const plan = desktopIso.planIsoImport(desktopManifest, Date.now())
    const takeGroup = evidence.programTake.programRecordingId
    const keep = async (item, source, via, extra = {}) => {
      const target = join(
        importedRoot,
        `${safeName(item.entryId)}${extname(item.fileName) || '.bin'}`
      )
      copyFileSync(source, target)
      const storagePath = stand.storagePath(item.objectKey)
      evidence.imported.push({
        entryId: item.entryId,
        via,
        file: relative(output, target),
        bytes: statSync(target).size,
        sha256: await sha256File(target),
        storageSha256: storagePath ? await sha256File(storagePath) : null,
        partial: item.partial,
        ...extra
      })
    }
    if (evidence.desktop.rpc === 'present') {
      const { capabilityId } = await h.command('authorize-smoke-resource', {
        kind: 'output-directory',
        path: h.env.VIDEORC_RECORDINGS_DIR
      })
      const job = await h.rpc('cloud.iso.import', {
        showId: h.showId,
        takeId: take.takeId,
        outputDirectoryCapability: capabilityId
      })
      const finals = await waitFor(
        () => {
          const latest = new Map()
          for (const e of h.events)
            if (e.event === 'cloud.iso.import' && e.payload.jobId === job.jobId)
              latest.set(e.payload.entryId, e.payload)
          if (latest.get(null)?.state === 'failed') return latest
          return plan.every((i) => TERMINAL.includes(latest.get(i.entryId)?.state)) && latest
        },
        'desktop ISO import',
        config.importMs
      )
      evidence.desktop.import = {
        jobId: job.jobId,
        states: Object.fromEntries([...finals].map(([id, e]) => [id ?? 'job', e.state])),
        errors: [...finals.values()].map((e) => e.error).filter(Boolean)
      }
      const journal = await h.rpc('cloud.iso.imports', {})
      const mine = journal.find((j) => j.showId === h.showId && j.takeId === take.takeId)
      evidence.desktop.journal = mine
        ? {
            programRecordingId: mine.programRecordingId,
            records: mine.records.map((r) => ({
              entryId: r.entryId,
              state: r.state,
              bytes: r.bytes
            }))
          }
        : null
      const sql = (q) =>
        JSON.parse(
          execFileSync('sqlite3', ['-json', join(h.appData, 'videorc.sqlite3'), q], {
            encoding: 'utf8'
          }) || '[]'
        )
      assert.match(take.takeId, /^tk_[0-9A-Za-z]{12}$/)
      const rows = sql(
        `SELECT s.id, s.mode, s.take_id, s.recording_role, s.mp4_path, s.output_path, s.diagnostics_json, f.final_path AS iso_path FROM sessions s JOIN cloud_iso_import_files f ON f.session_id = s.id WHERE s.id LIKE 'cloud-iso-${take.takeId}-%'`
      )
      const listed = new Set(
        (await h.rpc('sessions.list', { limit: 100 })).items.map((item) => item.id)
      )
      const libraryRows = []
      for (const item of plan) {
        const entry = manifest.entries.find((e) => e.id === item.entryId)
        const id = isoLibraryId(take.takeId, entry)
        const row = rows.find((r) => r.id === id)
        let diagnostics = {}
        try {
          diagnostics = JSON.parse(row?.diagnostics_json ?? '{}')
        } catch {}
        const layout = diagnostics.cloudIso?.frameLayout
        libraryRows.push({
          id,
          present: !!row,
          mode: row?.mode ?? null,
          takeId: row?.take_id ?? null,
          recordingRole: row?.recording_role ?? null,
          frameLayout: typeof layout === 'object' && layout ? layout.layout : (layout ?? null),
          partial: diagnostics.cloudIso?.partial ?? null,
          ordinaryPlaybackPath: row?.mp4_path ?? row?.output_path ?? null,
          listed: listed.has(id)
        })
        const path = row?.iso_path
        if (path && finals.get(item.entryId)?.state === 'complete')
          await keep(item, path, 'desktop-rpc', { librarySessionId: id })
      }
      evidence.library = { takeGroup, rows: libraryRows }
      const disabled = await h.rpc('cloud.iso.disable', { showId: h.showId })
      evidence.desktop.disable = { via: 'desktop-rpc', ok: disabled?.iso?.request === null }
    } else {
      for (const item of plan) {
        const answer = await h.webRequest(fileQuery(item.entryId))
        if (answer.status !== 200) continue
        const target = join(importedRoot, `download-${safeName(item.entryId)}`)
        await download(answer.body.url, ca, target)
        await keep(item, target, 'harness-http-fallback')
      }
      evidence.library = { takeGroup, rows: [], note: 'No desktop import ran (RPC missing).' }
      const disabled = await h.webRequest('iso', { action: 'disable' })
      evidence.desktop.disable = {
        via: 'harness-http-fallback',
        ok: false,
        httpOk: disabled.status === 200 && disabled.body?.iso?.request === null
      }
    }
    const finalState = await iso.isoState(h.showId)
    evidence.isoState = {
      keys: finalState?.keys.length ?? null,
      request: finalState?.request ? 'present' : null,
      ...iso.keys()
    }
    evidence.egress = stand.summary()
    await h.rpc('cloud.room.close')
    evidence.acquisition = 'acquired'
  } catch (error) {
    evidence.acquisition = 'failed'
    evidence.failures.push(redact(error))
  } finally {
    const leaked = []
    const attempt = async (label, run) => {
      try {
        await run()
      } catch {
        leaked.push(label)
      }
    }
    if (programRecording)
      await attempt('program-recorder', () => program.evaluate(stopProgramCapture))
    if (stand) evidence.egress ??= stand.summary()
    if (recorder) await attempt('recorder', () => recorder.evaluate(() => window.__rec?.close()))
    for (const context of contexts) await attempt('context', () => context.close())
    if (browser) await attempt('browser', () => browser.close())
    if (pages) await attempt('pages', () => pages.close())
    if (recorderOrigin) await attempt('recorder-origin', () => recorderOrigin.close())
    if (iso) await attempt('storage', () => iso.close())
    h.web?.hooks.iso(null)
    await attempt('managed-harness', () => h.close())
    evidence.cleanup = { ok: leaked.length === 0, leaked }
    save()
  }
  return { evidenceFile, output }
}

// --- Analysis ----------------------------------------------------------------

const ffmpeg = () => process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
function decodeRgb(file, width, height) {
  return execFileSync(
    ffmpeg(),
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `fps=30,scale=${width}:${height}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: 1024 << 20 }
  )
}
function decodePcm(file) {
  const raw = execFileSync(
    ffmpeg(),
    ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1024 << 20 }
  )
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4))
}

function decodeVideo(file) {
  const raw = decodeRgb(file, 16, 9)
  const frame = 16 * 9 * 3
  const frames = []
  for (let offset = 0; offset + frame <= raw.length; offset += frame) {
    const mean = [0, 0, 0]
    for (let i = offset; i < offset + frame; i += 3)
      for (let c = 0; c < 3; c++) mean[c] += raw[i + c]
    frames.push(mean.map((v) => v / (16 * 9)))
  }
  const plain = frames.filter(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b <= 220)
  return {
    frames: frames.length,
    durationMs: Math.round((frames.length * 1000) / 30),
    colors: Object.fromEntries(
      Object.entries(ISO_COLORS).map(([key, color]) => [key, colorMatch(plain, color)])
    ),
    onsetsMs: videoMarkerOnsets(frames, 30)
  }
}

function decodeAudio(file) {
  const samples = decodePcm(file)
  return {
    durationMs: Math.round(samples.length / 48),
    tones: Object.fromEntries(
      Object.entries(ISO_TONES).map(([key, hz]) => [
        key,
        samples.length >= 48000 ? toneDbfs(samples, hz, 48000) : -200
      ])
    ),
    onsetsMs: audioGapOnsets(samples, 48000)
  }
}

/** The mixed program: per-source on-screen area and per-tone level over time. */
function decodeProgram(file) {
  const width = 160,
    height = 90,
    frame = width * height * 3
  const raw = decodeRgb(file, width, height)
  const series = Object.fromEntries(Object.keys(ISO_COLORS).map((key) => [key, []]))
  for (let at = 0; at + frame <= raw.length; at += frame) {
    const pixels = raw.subarray(at, at + frame)
    for (const [key, color] of Object.entries(ISO_COLORS))
      series[key].push(colorFraction(pixels, color))
  }
  const frames = series['host-camera'].length
  const samples = decodePcm(file)
  const onsetsMs = {}
  const presence = {}
  for (const [key, values] of Object.entries(series)) {
    presence[key] = frames
      ? values.filter((v) => v > ISO_ANALYSIS.programPixelFraction).length / frames
      : 0
    onsetsMs[key] = areaDropOnsets(values, 30)
  }
  const tones = {}
  for (const [key, hz] of Object.entries(ISO_TONES)) {
    tones[key] = samples.length >= 48000 ? toneDbfs(samples, hz, 48000) : -200
    onsetsMs[key] = envelopeGapOnsets(toneEnvelope(samples, 48000, hz))
  }
  return {
    durationMs: Math.max(Math.round((frames * 1000) / 30), Math.round(samples.length / 48)),
    frames,
    presence,
    tones,
    onsetsMs
  }
}

/** Decode every imported file and the program, then judge. Writes `<evidence>.qualification.json`. */
export async function analyzeIsoEvidenceFile(evidenceFile, config = isoAcquisitionConfig()) {
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'))
  const output = dirname(evidenceFile)
  const manifest = evidence.manifestFile
    ? JSON.parse(readFileSync(join(output, evidence.manifestFile), 'utf8'))
    : null
  const decoded = {}
  for (const item of evidence.imported ?? []) {
    const entry = manifest?.entries.find((e) => e.id === item.entryId)
    if (!entry || !item.file) continue
    const file = join(output, item.file)
    decoded[entry.id] =
      entry.kind === 'video' ? { video: decodeVideo(file) } : { audio: decodeAudio(file) }
  }
  const program =
    evidence.program?.sha256 && evidence.program.file
      ? decodeProgram(join(output, evidence.program.file))
      : null
  const result = {
    ...analyzeIsoEvidence({ evidence, manifest, decoded, program, config }),
    acquisition: evidence.acquisition,
    acquisitionFailures: evidence.failures,
    revisions: evidence.revisions,
    programFacts: program
      ? {
          durationMs: program.durationMs,
          presence: program.presence,
          tones: program.tones,
          markers: Object.fromEntries(
            Object.entries(program.onsetsMs).map(([k, v]) => [k, v.length])
          )
        }
      : null
  }
  if (evidence.acquisition !== 'acquired') {
    result.status = 'failed'
    result.failures.unshift('acquisition')
  }
  writeFileSync(`${evidenceFile}.qualification.json`, JSON.stringify(result, null, 2) + '\n')
  return result
}
