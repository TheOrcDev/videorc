/** Plan 249 S13a runnable acquisition: native frame fixture -> authenticated
 * main/preload -> renderer VideoFrame/MediaStreamTrackGenerator -> LiveKit camera
 * -> real web program page decode. Importing this module launches nothing.
 * Requires an existing debug backend built from this slice, installed desktop/web
 * dependencies, local LiveKit, FFmpeg/ffprobe and Chrome. No paid egress.
 *
 * Cycle 0 is the endurance/load owner: host plus guests on stage for the full
 * duration and periodic native surface resets. Cycle 1 also replaces the source
 * in place (new generation). Later cycles prove real close/reopen ownership.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pcmWithDeadline } from './cloud-parity-pcm-acquisition-contract.mjs'
import { readFileSync, rmSync } from 'node:fs'
import {
  ROOM_FRAME,
  cameraBridgeConfig,
  compositeProbes,
  captureRgb,
  cameraPublication,
  cameraRemaining,
  deriveCameraClocks,
  stampCellCenters,
  STAMP_ROW,
  PATCH_ROW,
  ALPHA_PATCH_PROBES,
  FLASH_X
} from './cloud-parity-camera-bridge-contract.mjs'
import {
  cameraFrameGeometry,
  installCameraRendererCollector,
  installCameraProgramObserver,
  sampleMonitorCameraFrame
} from './cloud-parity-camera-bridge-page.mjs'
import { requireLoopback, redactParityFailure } from './cloud-parity-contract.mjs'
import {
  associateEncodedFrames,
  encodedRecordsFromObservations,
  encodeObservationGate,
  PUBLISH_LIMITATION
} from './cloud-parity-camera-bridge-encode.mjs'
import { cameraSceneCases } from './cloud-parity-camera-bridge-scenes.mjs'
import { analyzeCompositedRecording } from './cloud-parity-camera-bridge-recording.mjs'

const monotonicUs = () => Number(process.hrtime.bigint() / 1000n)
const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
/** The guest fixture page loads no Tailwind (plan 249 S6), so the utilities the
 * guest call tile uses are supplied here. Labelled fixture CSS in the evidence,
 * not production Tailwind; composited guest checks measure what it lays out. */
const GUEST_FIXTURE_CSS = [
  '.relative{position:relative}',
  '.absolute{position:absolute}',
  '.inset-0{inset:0}',
  '.h-full{height:100%}',
  '.w-full{width:100%}',
  '.size-full{width:100%;height:100%}',
  '.overflow-hidden{overflow:hidden}',
  '.rounded-2xl{border-radius:16px}',
  '.object-cover{object-fit:cover}',
  '.object-contain{object-fit:contain}',
  '.-scale-x-100{transform:scaleX(-1)}'
].join('')
const GUEST_COLORS = [
  [220, 40, 40],
  [40, 200, 60],
  [40, 80, 220],
  [220, 200, 40],
  [200, 40, 200],
  [40, 200, 200],
  [240, 140, 40]
]

export async function acquireCameraBridgeEvidence({
  desktopRoot,
  webRoot,
  config = cameraBridgeConfig()
}) {
  assert.ok(webRoot, 'VIDEORC_PARITY_WEB_ROOT must name the local web fixture checkout')
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: webRoot,
      encoding: 'utf8'
    }).trim(),
    '',
    'Use a clean web consumer checkout'
  )
  const { managedHarness, OUTPUT, waitFor, runMedia } = await import('./cloud-managed-smoke.mjs')
  const bridge = config.variant === 'bridge'
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages, installGuestFixture } = await import('./cloud-parity-browser.mjs')
  const { cameraY4m, toneWav, MEDIA } = await import('./cloud-parity-media.mjs')
  const { chromium } = await import('playwright-core')
  const h = await managedHarness('talk', 1, { maximumLogEntries: 4096 })
  const output = join(h.root, 'camera-bridge-acquisition')
  mkdirSync(output)
  const reportFile = join(output, 'evidence.json')
  const evidence = {
    schemaVersion: 1,
    kind: 'local-livekit-camera-bridge',
    // `baseline`: matched no-bridge run (browser camera), for the dropped-frame delta.
    variant: config.variant,
    // Evidence labels: `raw` = decoded packed transport, `adapter` = unpacked
    // canvas, `composited` = final browser/desktop compositor capture.
    labels: { raw: 'patchSamples', adapter: 'unpackedSamples', composited: 'composites' },
    composites: [],
    rateEvents: [],
    acquisition: 'running',
    productionQualified: false,
    platform: process.platform,
    transport: 'frame-copy',
    sharedTexture: 'unavailable-in-electron-39',
    cameraRole: { role: ROOM_FRAME.cameraRole, alphaMode: 'packed', packing: ROOM_FRAME.packing },
    config,
    revisions: {},
    artifacts: [],
    cycles: [],
    closeCycles: [],
    resets: [],
    replacement: null,
    patchSamples: [],
    flashSamples: [],
    unpackedSamples: [],
    packedExposure: [],
    authorityChecks: [],
    memorySamples: [],
    senderStats: [],
    load: null,
    unavailable: [],
    failures: [],
    managed: 'not-run',
    devices: 'not-run'
  }
  const save = () => writeFileSync(reportFile, JSON.stringify(evidence, null, 2) + '\n')
  const artifact = async (file, kind) => {
    const bytes = statSync(file).size
    assert.ok(bytes > 0 && bytes <= config.maximumArtifactBytes, 'Artifact missing or oversized')
    const item = { file: relative(output, file), kind, bytes, sha256: await digest(file) }
    evidence.artifacts.push(item)
    return item
  }
  const calibrate = async (kind, operation) => {
    const beforeUs = monotonicUs(),
      reply = await pcmWithDeadline(`${kind} observation`, config.readinessMs, operation),
      afterUs = monotonicUs()
    return { kind, beforeUs, afterUs, reply }
  }
  const spec = {
    surface: 'program',
    logicalWidth: ROOM_FRAME.width,
    packedWidth: ROOM_FRAME.packedWidth,
    height: ROOM_FRAME.height,
    stampRow: STAMP_ROW,
    patchRow: PATCH_ROW,
    cells: stampCellCenters(),
    patches: [...ALPHA_PATCH_PROBES.map((p) => p.x), FLASH_X],
    alphaOffset: ROOM_FRAME.width + ROOM_FRAME.gutter,
    flashX: FLASH_X
  }
  const guests = new Map()
  /** The desktop's authority, accepted only when it equals the SFU's own facts. */
  const trustedAuthority = async (cycle) => {
    const bound = await waitFor(
      () => h.eval('return window.__videorcSmokeScenePresets.roomFrameAuthority()'),
      'Desktop camera-frame authority bound from the publish answer',
      config.readinessMs
    )
    const participant = await h.web.roomRpc('GetParticipant', {
      room: h.showId,
      identity: `host:${h.showId}`
    })
    const camera = cameraPublication(participant)
    const check = {
      cycle,
      generation: bound.authority.generation,
      participantSid: participant?.sid === bound.authority.publisherSid,
      trackSid: camera?.sid === bound.authority.trackSid,
      packedDescriptor: bound.descriptor?.alphaMode === 'packed'
    }
    evidence.authorityChecks.push(check)
    assert.ok(
      check.participantSid && check.trackSid && check.packedDescriptor,
      'Camera-frame authority does not match the SFU publication'
    )
    return bound.authority
  }
  const authorize = async (page, authority) => {
    await waitFor(
      () => page.evaluate(() => typeof window.__videorcCameraFrame?.set === 'function'),
      'Loopback camera-frame experiment hook',
      config.readinessMs
    )
    assert.equal(
      await page.evaluate((value) => window.__videorcCameraFrame.set(value), authority),
      true,
      'Page refused the trusted camera-frame authority'
    )
  }
  const guestPages = []
  let programRecording = null
  /** Decode a PNG with the harness's FFmpeg; never trusts a screenshot by size. */
  const decodePng = (file) => {
    const probe = JSON.parse(
      runMedia(h.ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        file
      ]).toString()
    )
    const { width, height } = probe.streams[0]
    const raw = `${file}.rgba`
    runMedia(h.ffmpeg, ['-v', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw])
    const rgba = readFileSync(raw)
    rmSync(raw, { force: true })
    assert.equal(rgba.length, width * height * 4, 'Decoded capture size mismatch')
    return { width, height, rgba }
  }
  let compositeIndex = 0
  /** Final composited pixels: Playwright page captures (Chromium compositor) for
   * the program and a guest, and the desktop window capture for the monitor. */
  const captureComposites = async (cycleDir, program, atMs, sceneCase = null) => {
    const surfaces = [
      { surface: 'program', page: program.page },
      ...guestPages.map((guest) => ({ surface: guest.name, page: guest.page })),
      { surface: 'monitor', page: null }
    ]
    for (const { surface, page } of surfaces) {
      const index = ++compositeIndex
      try {
        const geometry = page
          ? await page.evaluate(
              cameraFrameGeometry,
              surface === 'program'
                ? '.scene.current canvas[data-camera-frame]'
                : 'canvas[data-camera-frame]'
            )
          : await h.eval(
              `return (${cameraFrameGeometry.toString()})('[data-testid="show-stage-program"] canvas[data-camera-frame]')`
            )
        const g = geometry.find((g) => g.content.w > 0 && g.content.h > 0)
        if (!g) {
          evidence.composites.push({
            surface,
            sceneCase,
            atMs,
            label: 'composited',
            status: 'no-camera-frame-canvas'
          })
          continue
        }
        const probes = compositeProbes(g)
        const file = join(cycleDir, `composite-${surface}-${index}.png`)
        let clip
        if (page) {
          const pad = 4
          clip = {
            x: Math.max(0, Math.floor((g.tile?.x ?? g.content.x) - pad)),
            y: Math.max(0, Math.floor((g.tile?.y ?? g.content.y) - pad)),
            width: Math.ceil((g.tile?.w ?? g.content.w) + pad * 2),
            height: Math.ceil((g.tile?.h ?? g.content.h) + pad * 2)
          }
          await page.screenshot({ path: file, clip, type: 'png' })
        } else {
          const shot = await h.command('capture-page', { name: `camera-composite-${index}` })
          assert.ok(shot?.file, 'Desktop window capture produced no file')
          writeFileSync(file, readFileSync(shot.file))
          clip = { x: 0, y: 0 }
        }
        const decoded = decodePng(file)
        const capture = {
          ...decoded,
          clip,
          // Page captures are CSS pixels at the default scale; window captures are device pixels.
          scale: page ? decoded.width / clip.width : g.dpr
        }
        const item = await artifact(file, `composited-${surface}-capture`)
        evidence.composites.push({
          surface,
          sceneCase,
          atMs,
          label: 'composited',
          file: item.file,
          geometry: g,
          ground: g.ground,
          clip,
          scale: capture.scale,
          probes,
          samples: probes.map((probe) => ({
            name: probe.name,
            rgb: captureRgb(capture, probe.page)
          }))
        })
      } catch (error) {
        evidence.composites.push({
          surface,
          sceneCase,
          atMs,
          label: 'composited',
          status: 'capture-failed',
          reason: redactParityFailure(error)
        })
      }
    }
  }
  let pages,
    browser,
    failure,
    roomOpen = false
  const contexts = []
  const inspectClosed = async (showId) => {
    let last
    const until = monotonicUs() + config.closeMs * 1000
    do {
      try {
        const rooms = await h.web.roomRpc('ListRooms', { names: [showId] })
        if (!bridge) {
          // Baseline: no frame owner exists; only the SFU publication must be gone.
          const listed = (rooms?.rooms ?? []).some((room) => room.name === showId)
          const participants = listed
            ? await h.web.roomRpc('ListParticipants', { room: showId })
            : { participants: [] }
          const publications = (participants?.participants ?? [])
            .filter((p) => p.identity === `host:${showId}`)
            .flatMap((p) => p.tracks ?? [])
          last = { status: publications.length ? 'live' : 'closed', publications }
          if (last.status === 'closed') return last
          await sleep(100)
          continue
        }
        const main = await h.eval('return await window.videorc.getRoomFrameTestResources()')
        const renderer = await h.eval('return window.__videorcSmokeScenePresets.roomFrameTest()')
        const roomList = rooms?.rooms ?? []
        let publications = []
        if (roomList.some((room) => room.name === showId)) {
          const participants = await h.web.roomRpc('ListParticipants', { room: showId })
          publications = (participants?.participants ?? [])
            .filter((p) => p.identity === `host:${showId}`)
            .flatMap((p) => p.tracks ?? [])
        }
        last = { ...cameraRemaining(main, renderer, publications), main, renderer }
      } catch (error) {
        last = { status: 'unavailable', reason: redactParityFailure(error) }
      }
      if (last.status === 'closed') return last
      await sleep(100)
    } while (monotonicUs() < until)
    return last
  }
  const newPage = async (name, dir, size) => {
    const context = await browser.newContext({
      viewport: size,
      recordVideo: { dir, size }
    })
    contexts.push(context)
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
    return { name, page, context }
  }
  try {
    evidence.revisions = {
      desktop: revision(desktopRoot),
      web: revision(webRoot),
      template: 'camera-acquisition-v2'
    }
    evidence.revisions.desktopDiffSha256 = createHash('sha256')
      .update(execFileSync('git', ['diff', 'HEAD'], { cwd: desktopRoot }))
      .digest('hex')
    evidence.revisions.untrackedSources = []
    for (const file of execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: desktopRoot,
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .filter(Boolean))
      if (
        /^(apps\/desktop\/src|crates\/videorc-backend\/src|scripts\/lib|protocol-fixtures)\//.test(
          file
        )
      )
        evidence.revisions.untrackedSources.push({
          file,
          sha256: await digest(join(desktopRoot, file))
        })
    evidence.revisions.webDiffSha256 = createHash('sha256')
      .update(execFileSync('git', ['diff', 'HEAD'], { cwd: webRoot }))
      .digest('hex')
    evidence.revisions.programBundleSha256 = await digest(
      join(webRoot, 'public/cloud/program/v1/stage.js')
    )
    save()
    if (bridge) h.env.VIDEORC_ROOM_FRAME_TEST = '1'
    writeFileSync(
      h.env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO,
      cameraY4m(MEDIA.colors.host, {
        width: ROOM_FRAME.width,
        height: ROOM_FRAME.height,
        fps: ROOM_FRAME.fps
      })
    )
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO, toneWav(440))
    await h.destinations(0)
    await h.launch()
    await prepareParityRoom(h, false)
    await h.eval(
      `(${installCameraRendererCollector.toString()})(); window.__videorcSmokeScenePresets.roomFrameEncodeObserver(true); return window.__videorcSmokeScenePresets.roomFrameTest(${bridge})`
    )
    requireLoopback(h.livekit.url)
    pages = await startParityPages(webRoot, guests, {
      graphicsLanes: { EG_parity_baseline: { output: 'stream', orientation: 'h' } },
      get show() {
        return h.showId
      },
      relay: {
        participantSession: async (show, identity) =>
          (await h.web.roomRpc('GetParticipant', { room: show, identity })).sid,
        auxiliarySid: async () => null,
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
    evidence.workload = {
      logicalCamera: { width: ROOM_FRAME.width, height: ROOM_FRAME.height, fps: ROOM_FRAME.fps },
      programViewport: { width: 1280, height: 720 },
      guestViewport: { width: 640, height: 360 },
      layout: config.guests ? 'side-by-side' : 'solo',
      guestFixtureCss: {
        label: 'fixture-utilities-not-production-tailwind',
        sha256: createHash('sha256').update(GUEST_FIXTURE_CSS).digest('hex')
      },
      encodeObserverRequested: true,
      comparison:
        'Whole-pipeline cost including packed-width encoding and bridge-only encoded observer; not equal encoded pixel load'
    }
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
    })
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      const cycleDir = join(output, `cycle-${String(cycle).padStart(2, '0')}`)
      mkdirSync(cycleDir)
      const traceFile = join(cycleDir, 'observations.ndjson')
      const attempt = { cycle, status: 'running', observations: relative(output, traceFile) }
      evidence.cycles.push(attempt)
      save()
      const traceFd = openSync(traceFile, 'wx')
      let traceBytes = 0,
        generation = null,
        program = null
      const clockRecords = []
      const generations = new Set()
      let maxNativeLeases = 0
      const write = (record) => {
        const line = JSON.stringify(record) + '\n'
        traceBytes += Buffer.byteLength(line)
        assert.ok(traceBytes <= config.maximumTraceBytes, 'Raw observation bound exceeded')
        writeSync(traceFd, line)
      }
      const ingest = (record) => {
        write(record)
        assert.equal(record.reply?.dropped ?? 0, 0, 'Observation queue overflow')
        for (const event of record.reply?.events ?? []) {
          if (record.kind === 'renderer' && event.phase === 'native-frame') {
            generation ??= event.generation
            generations.add(event.generation)
          }
          if (cycle === 0 && event.phase === 'unpacked' && evidence.unpackedSamples.length < 8192)
            evidence.unpackedSamples.push(event)
          if (cycle === 0 && event.phase === 'rate' && evidence.rateEvents.length < 100_000)
            evidence.rateEvents.push(event)
          if (event.phase === 'decoded' && event.adapter)
            evidence.packedExposure.push({
              cycle,
              surface: event.surface,
              visible: event.packedVideoVisible
            })
          if (cycle === 0 && record.kind === 'program' && event.phase === 'patch') {
            if (evidence.patchSamples.length < 4096) evidence.patchSamples.push(event)
            if (evidence.flashSamples.length < 4096)
              evidence.flashSamples.push({ sequence: event.sequence, luma: event.flashLuma })
          }
        }
        if (cycle === 0 && record.kind === 'renderer' && Number.isFinite(record.reply?.heapBytes))
          evidence.memorySamples.push(record.reply.heapBytes)
        if (cycle === 0) clockRecords.push(record)
      }
      const pollAll = async () => {
        ingest(
          await calibrate('renderer', () => h.eval('return window.__parityCameraRenderer.drain()'))
        )
        if (program)
          ingest(
            await calibrate('program', () =>
              program.page.evaluate(() => window.__parityCameraProgram.drain())
            )
          )
        // Guest observations are adapter evidence only; their clocks are not mapped.
        for (const guest of guestPages)
          ingest({
            kind: 'guest',
            name: guest.name,
            reply: await guest.page.evaluate(() => window.__parityCameraProgram.drain())
          })
        if (bridge) {
          const main = await h.eval('return await window.videorc.getRoomFrameTestResources()')
          maxNativeLeases = Math.max(maxNativeLeases, main.nativeLeases)
          write({ kind: 'main-resources', atUs: monotonicUs(), main })
        }
        for (const list of [h.events, h.logs, h.web.calls])
          if (list.length > 4096) list.splice(0, list.length - 4096)
      }
      try {
        const opened = await h.rpc('cloud.room.open', {
          outputs: [OUTPUT],
          title: 'Camera bridge acquisition',
          platforms: []
        })
        h.showId = opened.show.id
        roomOpen = true
        await h.status(
          (s) => s.room?.client === 'connected',
          'Camera bridge host joined',
          config.readinessMs
        )
        const participant = await waitFor(
          async () => {
            const value = await h.web.roomRpc('GetParticipant', {
              room: h.showId,
              identity: `host:${h.showId}`
            })
            return cameraPublication(value) ? value : null
          },
          'Exactly one unmuted camera-bridge publication',
          config.readinessMs
        )
        if (bridge) {
          const active = await h.eval('return await window.videorc.getRoomFrameTestResources()')
          assert.equal(active.nativeSources, 1, 'Native frame source missing or duplicated')
          assert.equal(active.sockets, 1, 'Main frame socket missing or duplicated')
        }
        write({
          kind: 'publications',
          tracks: (participant.tracks ?? []).map(({ sid, source, muted, name }) => ({
            sid,
            source,
            muted,
            name
          }))
        })
        const onStage = [`host:${h.showId}`]
        guests.clear()
        guestPages.length = 0
        // Trusted controller step: the desktop's bound authority must equal the SFU facts.
        let authority = bridge ? await trustedAuthority(cycle) : null
        if (cycle === 0) {
          for (let i = 0; i < config.guests; i++) {
            const name = `guest${i + 1}`,
              identity = `g_${String(i + 1).repeat(22)}`
            guests.set(name, {
              identity,
              url: h.livekit.url,
              token: h.web.tokenFor(h.showId, identity, 'guest')
            })
            const guest = await newPage(name, cycleDir, { width: 640, height: 360 })
            await guest.page.addInitScript(installGuestFixture, {
              color: GUEST_COLORS[i],
              hz: 300 + i * 110,
              peak: MEDIA.tonePeak,
              slug: name
            })
            await guest.page.addInitScript(installCameraProgramObserver, {
              ...spec,
              surface: name
            })
            await guest.page.goto(`${pages.origin}/guest/${name}?cameraFrameExperiment=1`)
            await guest.page.addStyleTag({ content: GUEST_FIXTURE_CSS })
            guestPages.push(guest)
            onStage.push(identity)
          }
          await h.status(
            (s) => s.room?.participants?.length === config.guests + 1,
            'Real guest components publish',
            config.readinessMs
          )
        }
        await h.rpc('cloud.stage.set', {
          layout: onStage.length > 1 ? 'side-by-side' : 'solo',
          onStage
        })
        program = await newPage('program', cycleDir, { width: 1280, height: 720 })
        programRecording = program.page.video()
        await program.page.addInitScript(installCameraProgramObserver, spec)
        const search = new URLSearchParams({
          show: h.showId,
          k: 'talk',
          pt: 'vcp1.dGVzdA.dGVzdA',
          layout: 'h',
          url: h.livekit.url,
          token: h.web.tokenFor(h.showId, 'EG_parity_baseline', 'recorder'),
          // Loopback-only experiment gate; a deployed page never takes authority.
          cameraFrameExperiment: '1'
        })
        await program.page.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
        await waitFor(
          () =>
            program.page.evaluate(() =>
              [...document.querySelectorAll('video')].some((v) => v.readyState >= 2)
            ),
          'Real program decodes video',
          config.readinessMs
        )
        if (authority) {
          await authorize(program.page, authority)
          for (const guest of guestPages) await authorize(guest.page, authority)
        }
        if (cycle === 0) {
          evidence.guestSurfaces = guestPages.map((guest) => guest.name)
          evidence.load = {
            participants: config.guests + 1,
            onStage: onStage.length,
            maxNativeLeases: 0
          }
        }
        const durationMs = cycle === 0 ? config.durationMs : config.cycleMs
        const started = monotonicUs() / 1000
        let nextReset = started + config.resetEveryMs
        // First composite after warm-up, then every compositeEveryMs.
        let nextComposite = started + Math.min(10_000, config.compositeEveryMs)
        let replaced = false
        while (monotonicUs() / 1000 - started < durationMs) {
          await pollAll()
          const now = monotonicUs() / 1000
          if (bridge && cycle === 0 && now >= nextReset) {
            nextReset = now + config.resetEveryMs
            const before = await h.eval('return window.__videorcSmokeScenePresets.roomFrameTest()')
            await h.eval('return await window.__videorcSmokeScenePresets.roomFrameResetSurface()')
            await sleep(2000)
            await pollAll()
            const after = await h.eval('return window.__videorcSmokeScenePresets.roomFrameTest()')
            const owner = (o) => o?.owners?.find((x) => x.generation === generation)
            const main = await h.eval('return await window.videorc.getRoomFrameTestResources()')
            evidence.resets.push({
              atMs: now - started,
              epochBefore: owner(before)?.surfaceEpoch ?? null,
              epochAfter: owner(after)?.surfaceEpoch ?? null,
              epochAdvanced: (owner(after)?.surfaceEpoch ?? 0) > (owner(before)?.surfaceEpoch ?? 0),
              framesAfter: (owner(after)?.written ?? 0) - (owner(before)?.written ?? 0),
              leasesAfter: main.nativeLeases
            })
          }
          // Replacement runs in a short cycle so the endurance span keeps one generation.
          if (bridge && cycle === 1 && !replaced && now - started >= durationMs / 2) {
            replaced = true
            const before = generation
            await h.eval('return await window.__videorcSmokeScenePresets.roomFrameReplace()')
            await sleep(3000)
            // A replacement is a new publication: authority is re-derived and re-checked.
            authority = await trustedAuthority(cycle)
            await authorize(program.page, authority)
            await pollAll()
            const after = await h.eval('return window.__videorcSmokeScenePresets.roomFrameTest()')
            const live = after.owners.filter((o) => o.generators === 1)
            evidence.replacement = {
              generationBefore: before,
              generationAfter: live[0]?.generation ?? null,
              generationAdvanced: live.length === 1 && live[0].generation > before,
              framesAfter: live[0]?.written ?? 0
            }
          }
          if (bridge && cycle === 0 && now >= nextComposite) {
            nextComposite = now + config.compositeEveryMs
            await captureComposites(cycleDir, program, now - started)
          }
          if (bridge && cycle === 0) {
            const monitor = await h.eval(
              `return (${sampleMonitorCameraFrame.toString()})(${JSON.stringify(spec)})`
            )
            evidence.packedExposure.push({
              cycle,
              surface: 'monitor',
              visible: monitor.packedVideosVisible > 0
            })
            if (monitor.sample && evidence.unpackedSamples.length < 8192)
              evidence.unpackedSamples.push(monitor.sample)
          }
          if (cycle === 0) {
            const stats = await h.eval(
              'return await window.__videorcSmokeScenePresets.roomCameraSenderStats()'
            )
            if (stats && evidence.senderStats.length < 8192)
              evidence.senderStats.push({ atUs: monotonicUs(), stats })
          }
          await sleep(config.pollMs)
        }
        await pollAll()
        if (bridge)
          assert.ok(generation, 'No native frame generation observed through the actual preload')
        else generation = `baseline-${cycle}`
        if (cycle === 0) {
          evidence.load.maxNativeLeases = maxNativeLeases
          evidence.clock = deriveCameraClocks(clockRecords)
          evidence.generationsInEnduranceCycle = [...generations]
          const events = clockRecords
            .filter((record) => record.kind === 'renderer')
            .flatMap((record) => record.reply?.events ?? [])
          const encoded = encodedRecordsFromObservations(events, generation)
          evidence.encodeObserver = events.filter((event) => event.phase === 'encode-observer')
          evidence.encoderAssociation = associateEncodedFrames(
            events.filter(
              (event) => event.phase === 'native-frame' && event.generation === generation
            ),
            encoded.encoded,
            { observerDropped: encoded.observerDropped }
          )
          evidence.encoderObservation = encodeObservationGate(evidence.encoderAssociation)
          // Close the stable endurance recording BEFORE changing any scene geometry.
          await program.context.close()
          contexts.splice(contexts.indexOf(program.context), 1)
          const recordingFile = await programRecording.path()
          await artifact(recordingFile, 'composited-program-page-recording')
          const captures = evidence.composites.filter(
            (c) => c.surface === 'program' && c.geometry && !c.sceneCase
          )
          const first = captures[0],
            last = captures.at(-1)
          const stable =
            first && last && JSON.stringify(first.geometry) === JSON.stringify(last.geometry)
          evidence.recordingAnalysis =
            bridge && stable
              ? await analyzeCompositedRecording({
                  file: recordingFile,
                  geometry: first.geometry,
                  scale: 1,
                  ground: first.ground,
                  ffmpeg: h.ffmpeg,
                  ffprobe: h.ffprobe
                })
              : {
                  status: 'unavailable',
                  reason: 'No stable measured camera geometry for the endurance recording'
                }
          programRecording = null
          program = null
          if (bridge) {
            // Real S12 scene save/apply and lane receipts, on a separate recording.
            program = await newPage('program-scenes', cycleDir, { width: 1280, height: 720 })
            await program.page.addInitScript(installCameraProgramObserver, spec)
            await program.page.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
            await authorize(program.page, authority)
            await h.eval('window.__videorcSmokeScenePresets.roomScenes(true)')
            evidence.sceneCases = []
            for (const one of cameraSceneCases()) {
              const before = await h.eval(
                'return window.__videorcSmokeScenePresets.roomScenes().status?.generation ?? 0'
              )
              await h.eval(
                `window.__videorcSmokeScenePresets.roomSceneSave(${JSON.stringify(one.scene)}); await window.__videorcSmokeScenePresets.apply(${JSON.stringify(one.scene.id)})`
              )
              const receipt = await waitFor(
                async () => {
                  const state = await h.eval(
                    'return window.__videorcSmokeScenePresets.roomScenes()'
                  )
                  return state.status?.state === 'applied' && state.status.generation > before
                    ? state
                    : null
                },
                `${one.id}: S12 applied receipt`,
                config.readinessMs
              )
              await waitFor(
                async () => {
                  const boxes = await program.page.evaluate(
                    cameraFrameGeometry,
                    '.scene.current .tile-scene-full canvas[data-camera-frame]'
                  )
                  return boxes.some(
                    (g) =>
                      g.logical.w === ROOM_FRAME.width &&
                      g.logical.h === ROOM_FRAME.height &&
                      g.content.w > 0
                  )
                },
                `${one.id}: unpacked logical scene canvas`,
                config.readinessMs
              )
              const startCapture = evidence.composites.length
              await captureComposites(cycleDir, program, monotonicUs() / 1000 - started, one.id)
              evidence.sceneCases.push({
                id: one.id,
                expect: one.expect,
                receipt,
                captures: evidence.composites.slice(startCapture).map((c) => ({
                  surface: c.surface,
                  file: c.file,
                  geometry: c.geometry,
                  status: c.status
                }))
              })
            }
            await h.eval('await window.__videorcSmokeScenePresets.roomSceneClear()')
          }
        }
      } finally {
        try {
          if (program)
            ingest(
              await calibrate('program', () =>
                program.page.evaluate(() => window.__parityCameraProgram.close())
              )
            )
        } catch {
          evidence.failures.push(`Cycle ${cycle}: program observer close unavailable`)
        }
        try {
          if (roomOpen) {
            await h.rpc('cloud.room.close')
            roomOpen = false
          }
          const observation = await inspectClosed(h.showId)
          evidence.closeCycles.push({ cycle, generation, ...observation })
        } finally {
          closeSync(traceFd)
          for (const context of contexts.splice(0)) await context.close().catch(() => {})
          program = null
          const closed = evidence.closeCycles.at(-1)
          if (closed?.cycle === cycle) closed.browserContexts = browser.contexts().length
          save()
        }
      }
      await artifact(traceFile, 'native-renderer-program-raw-observations')
      programRecording = null
      Object.assign(attempt, { status: 'completed', generation, showId: h.showId })
      assert.equal(evidence.closeCycles.at(-1).status, 'closed', 'Owner cleanup not confirmed')
      assert.equal(evidence.closeCycles.at(-1).browserContexts, 0, 'Browser context leaked')
      h.assertNoDirect()
      save()
    }
    evidence.unavailable.push(
      {
        measurement: 'packetizedSentTiming',
        owner: 'Supported browser WebRTC APIs',
        reason: PUBLISH_LIMITATION
      },
      {
        measurement: 'managedRecorderBudgets',
        owner: 'Separately authorized managed egress run',
        reason: 'Local harness only; managed recorder budgets remain unmeasured.'
      },
      {
        measurement: 'otherPlatform',
        owner: process.platform === 'darwin' ? 'Windows acceptance' : 'macOS acceptance',
        reason: 'Each platform is qualified only by its own run.'
      }
    )
    evidence.acquisition = 'completed'
    save()
  } catch (error) {
    evidence.acquisition = 'failed'
    const attempt = evidence.cycles.find((cycle) => cycle.status === 'running')
    if (attempt) attempt.status = 'failed'
    evidence.failures.push(
      redactParityFailure(error, [...h.web.tokens, h.livekit.apiKey, h.livekit.apiSecret])
    )
    save()
    failure = new Error(`Camera bridge acquisition failed; evidence: ${reportFile}`)
  } finally {
    const cleanup = await Promise.allSettled([
      ...contexts.map((context) => context.close()),
      browser?.close(),
      pages?.close(),
      h.close()
    ])
    evidence.harnessCleanup = cleanup.map((value) => value.status)
    if (cleanup.some((value) => value.status === 'rejected')) {
      evidence.acquisition = 'failed'
      failure ??= new Error(`Camera bridge owned harness cleanup failed; evidence: ${reportFile}`)
    }
    save()
  }
  if (failure) throw failure
  return { evidenceFile: reportFile, output }
}
