/** Runnable local Electron -> authenticated IPC -> worklet -> LiveKit -> real
 * program acquisition. Importing this module launches nothing; only acquire does.
 * Requires existing debug native binaries/dependencies; the dev launcher prepares
 * JS assets. No native prebuild or paid egress.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  pcmAcquisitionConfig,
  drivePcmCapture,
  pcmWithDeadline,
  pcmRemaining,
  pcmMicrophonePublication,
  derivePcmClocks
} from './cloud-parity-pcm-acquisition-contract.mjs'
import { installPcmRendererCollector, startPcmProgramRecorder } from './cloud-parity-pcm-page.mjs'
import { requireLoopback, redactParityFailure } from './cloud-parity-contract.mjs'
const monotonicUs = () => Number(process.hrtime.bigint() / 1000n)
const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function slimClockRecord(record) {
  const events = record.reply?.events ?? []
  if (record.kind === 'program') return record
  const kept = new Set([
    events.find((e) => e.phase === 'native-frame'),
    events.findLast((e) => e.phase === 'native-frame'),
    events.find((e) => e.phase === 'worklet' && e.clock),
    events.findLast((e) => e.phase === 'worklet' && e.clock),
    ...events.filter((e) => e.marker)
  ])
  kept.delete(undefined)
  return { ...record, reply: { ...record.reply, events: [...kept] } }
}

export async function acquirePcmEvidence({
  desktopRoot,
  webRoot,
  config = pcmAcquisitionConfig()
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
  // All launch-capable imports are below configuration validation and explicit call.
  const { managedHarness, OUTPUT, waitFor, runMedia } = await import('./cloud-managed-smoke.mjs')
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages, installProgramAudioTap } = await import('./cloud-parity-browser.mjs')
  const { cameraY4m, toneWav, MEDIA } = await import('./cloud-parity-media.mjs')
  const { chromium } = await import('playwright-core')
  const h = await managedHarness('talk', 1, { maximumLogEntries: 4096 })
  const output = join(h.root, 'pcm-acquisition')
  mkdirSync(output)
  const reportFile = join(output, 'evidence.json')
  const evidence = {
    schemaVersion: 2,
    kind: 'local-livekit-program-pcm',
    acquisition: 'running',
    productionQualified: false,
    sampleRate: 48000,
    channels: 1,
    config,
    revisions: {},
    artifacts: [],
    cycles: [],
    closeCycles: [],
    diagnostics: [],
    unavailable: [],
    failures: [],
    captureSurface:
      'real local program final audio bus through MediaRecorder; separate real-page browser video',
    managed: 'not-run',
    devices: 'not-run'
  }
  const save = () => writeFileSync(reportFile, JSON.stringify(evidence, null, 2) + '\n')
  const artifact = async (file, kind) => {
    const bytes = statSync(file).size
    assert.ok(
      bytes > 0 && bytes <= config.maximumArtifactBytes,
      'Artifact missing or exceeds configured size bound'
    )
    const item = { file: relative(output, file), kind, bytes, sha256: await digest(file) }
    evidence.artifacts.push(item)
    return item
  }
  let pages,
    browser,
    context,
    program,
    failure,
    roomOpen = false
  const calibrate = async (kind, operation) => {
    const beforeUs = monotonicUs(),
      reply = await pcmWithDeadline(`${kind} observation`, config.readinessMs, operation),
      afterUs = monotonicUs()
    return { kind, beforeUs, afterUs, reply }
  }
  const inspectClosed = async (showId) => {
    let last
    const until = monotonicUs() + config.closeMs * 1000
    do {
      try {
        const main = await h.eval('return await window.videorc.getRoomPcmTestResources()')
        const renderer = await h.eval('return window.__videorcSmokeScenePresets.roomPcmTest()')
        const rooms = await h.web.roomRpc('ListRooms', { names: [showId] })
        assert.ok(
          rooms &&
            typeof rooms === 'object' &&
            Object.keys(rooms).every((k) => k === 'rooms') &&
            (rooms.rooms === undefined || Array.isArray(rooms.rooms)),
          'SFU room-list observation missing'
        )
        const roomList = rooms.rooms ?? [] // Protobuf JSON omits an empty repeated field.
        let publications = []
        if (roomList.some((room) => room.name === showId)) {
          const participants = await h.web.roomRpc('ListParticipants', { room: showId })
          assert.ok(
            participants &&
              typeof participants === 'object' &&
              Object.keys(participants).every((k) => k === 'participants') &&
              (participants.participants === undefined || Array.isArray(participants.participants)),
            'SFU participant observation missing'
          )
          publications = (participants.participants ?? [])
            .filter((p) => p.identity === `host:${showId}`)
            .flatMap((p) => p.tracks ?? [])
        }
        last = {
          ...pcmRemaining(main, renderer, publications),
          main,
          renderer,
          sfuResponse: rooms,
          sfuRooms: roomList.map((r) => r.name),
          publications
        }
      } catch (error) {
        last = { status: 'unavailable', reason: redactParityFailure(error) }
      }
      if (last.status === 'closed') return last
      await sleep(100)
    } while (monotonicUs() < until)
    return last
  }
  try {
    evidence.revisions = { desktop: revision(desktopRoot), web: revision(webRoot), template: 'v1' }
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
      .filter(Boolean)) {
      if (
        /^(apps\/desktop\/src|crates\/videorc-backend\/src|scripts\/lib|protocol-fixtures)\//.test(
          file
        )
      )
        evidence.revisions.untrackedSources.push({
          file,
          sha256: await digest(join(desktopRoot, file))
        })
    }
    evidence.revisions.programBundleSha256 = await digest(
      join(webRoot, 'public/cloud/program/v1/stage.js')
    )
    const assets = new Map(
      ['cloud-parity-pcm-marker.mjs', 'cloud-parity-pcm-observer.mjs'].map((file) => [
        `/__parity/${file}`,
        readFileSync(new URL(file, import.meta.url))
      ])
    )
    save()
    h.env.VIDEORC_ROOM_PCM_TEST = '1'
    // managedHarness already sets the explicit debug-native smoke gate.
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO, cameraY4m(MEDIA.colors.host))
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO, toneWav(440))
    await h.destinations(0)
    await h.launch()
    await prepareParityRoom(h, false)
    await h.eval(
      `(${installPcmRendererCollector.toString()})(); return window.__videorcSmokeScenePresets.roomPcmTest(true)`
    )
    requireLoopback(h.livekit.url)
    pages = await startParityPages(webRoot, new Map(), null, assets)
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required']
    })
    // First owner supplies endurance evidence; subsequent owners prove real close/reopen.
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      const cycleDir = join(output, `cycle-${String(cycle).padStart(2, '0')}`)
      mkdirSync(cycleDir)
      const traceFile = join(cycleDir, 'observations.ndjson'),
        encodedFile = join(cycleDir, 'program-audio.webm')
      const attempt = {
        cycle,
        status: 'running',
        observations: relative(output, traceFile),
        encoded: relative(output, encodedFile)
      }
      evidence.cycles.push(attempt)
      save()
      const traceFd = openSync(traceFile, 'wx'),
        audioFd = openSync(encodedFile, 'wx')
      let traceBytes = 0,
        audioBytes = 0,
        generation = null,
        video,
        recorderStarted = false
      const clockRecords = []
      const write = (record) => {
        const line = JSON.stringify(record) + '\n'
        traceBytes += Buffer.byteLength(line)
        assert.ok(traceBytes <= config.maximumTraceBytes, 'Raw observation bound exceeded')
        writeSync(traceFd, line)
      }
      const ingest = (record) => {
        for (const chunk of record.reply?.chunks ?? []) {
          const bytes = Buffer.from(chunk.base64, 'base64')
          assert.equal(bytes.length, chunk.bytes, 'Program chunk length mismatch')
          audioBytes += bytes.length
          assert.ok(audioBytes <= config.maximumArtifactBytes, 'Encoded audio bound exceeded')
          writeSync(audioFd, bytes)
          // Persist timing/size, not a duplicate base64 copy of the artifact.
          delete chunk.base64
        }
        write(record)
        if (cycle === 0) clockRecords.push(slimClockRecord(record))
        if (record.kind === 'renderer') {
          for (const event of record.reply?.events ?? []) {
            if (event.phase === 'worklet') generation ??= event.generation
          }
          const last = record.reply?.events?.findLast((e) => e.phase === 'worklet')
          if (cycle === 0 && last) evidence.diagnostics.push(last)
        }
        assert.equal(
          record.reply?.failed ?? null,
          null,
          'Program recorder/observer reported failure'
        )
        assert.equal(record.reply?.dropped ?? 0, 0, 'Observation queue overflow')
      }
      try {
        // Capture the source clock from open onward, before creating the consumer.
        const opened = await h.rpc('cloud.room.open', {
          outputs: [OUTPUT],
          title: 'PCM bridge acquisition',
          platforms: []
        })
        h.showId = opened.show.id
        roomOpen = true
        await h.status(
          (s) => s.room?.client === 'connected',
          'PCM host room joined',
          config.readinessMs
        )
        const publications = await waitFor(
          async () => {
            const participant = await h.web.roomRpc('GetParticipant', {
              room: h.showId,
              identity: `host:${h.showId}`
            })
            return pcmMicrophonePublication(participant) ? participant : null
          },
          'Exactly one unmuted fixture microphone publication',
          config.readinessMs
        )
        const activeMain = await h.eval('return await window.videorc.getRoomPcmTestResources()')
        const activeRenderer = await h.eval(
          'return window.__videorcSmokeScenePresets.roomPcmTest()'
        )
        assert.equal(
          activeMain.nativeSources,
          1,
          'Actual native fixture owner is missing or duplicated'
        )
        assert.equal(
          activeMain.sockets,
          1,
          'Actual main/preload PCM socket is missing or duplicated'
        )
        assert.equal(
          activeRenderer.owners.filter((owner) => owner.worklets === 1 && owner.tracks === 1)
            .length,
          1,
          'Actual renderer worklet/track owner is missing or duplicated'
        )
        write({ kind: 'active-resources', main: activeMain, renderer: activeRenderer })

        write({
          kind: 'publications',
          tracks: (publications.tracks ?? []).map(({ sid, source, muted }) => ({
            sid,
            source,
            muted
          }))
        })
        ingest(
          await calibrate('renderer', () => h.eval('return window.__parityPcmRenderer.drain()'))
        )
        await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [`host:${h.showId}`] })
        context = await browser.newContext({
          viewport: { width: 640, height: 360 },
          recordVideo: { dir: cycleDir, size: { width: 640, height: 360 } }
        })
        await context.route('**/*', (route) => {
          try {
            requireLoopback(route.request().url())
            return route.continue()
          } catch {
            return route.abort('blockedbyclient')
          }
        })
        program = await context.newPage()
        video = program.video()
        await program.addInitScript(installProgramAudioTap)
        const search = new URLSearchParams({
          show: h.showId,
          k: 'talk',
          pt: 'vcp1.dGVzdA.dGVzdA',
          layout: 'h',
          url: h.livekit.url,
          token: h.web.tokenFor(h.showId, `EG_pcm_${cycle}`, 'recorder')
        })
        await program.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
        await waitFor(
          () =>
            program.evaluate(
              () =>
                window.__parityProgramTaps?.length === 1 &&
                [...document.querySelectorAll('video')].some((v) => v.readyState >= 2)
            ),
          'Real program final audio bus and host video ready',
          config.readinessMs
        )
        await drivePcmCapture(
          { durationMs: cycle === 0 ? config.durationMs : config.cycleMs, pollMs: config.pollMs },
          {
            now: () => monotonicUs() / 1000,
            wait: sleep,
            start: async () => {
              const value = await pcmWithDeadline(
                'Program recorder start',
                config.readinessMs,
                () => program.evaluate(startPcmProgramRecorder)
              )
              recorderStarted = true
              return value
            },
            poll: async () => {
              ingest(
                await calibrate('renderer', () =>
                  h.eval('return window.__parityPcmRenderer.drain()')
                )
              )
              ingest(
                await calibrate('program', () =>
                  program.evaluate(() => window.__parityPcmProgram.drain())
                )
              )
              // Keep inherited harness telemetry bounded during the long capture.
              for (const list of [h.events, h.logs, h.web.calls])
                if (list.length > 4096) list.splice(0, list.length - 4096)
              return { monotonicUs: monotonicUs() }
            },
            stop: async () => {
              const record = await calibrate('program', () =>
                program.evaluate(() => window.__parityPcmProgram.close())
              )
              recorderStarted = false
              ingest(record)
              return { recorderState: record.reply.recorderState }
            },
            record: async (kind, value) => write({ kind: `capture-${kind}`, value })
          }
        )
        assert.ok(generation, 'No native/worklet generation observed through actual preload')
        if (cycle === 0) evidence.clock = derivePcmClocks(clockRecords)
      } finally {
        if (recorderStarted) {
          try {
            ingest(
              await calibrate('program', () =>
                program.evaluate(() => window.__parityPcmProgram.close())
              )
            )
          } catch {
            evidence.failures.push(`Cycle ${cycle}: recorder finalization unavailable`)
          }
        }
        try {
          if (roomOpen) {
            await h.rpc('cloud.room.close')
            roomOpen = false
          }
          ingest(
            await calibrate('renderer', () => h.eval('return window.__parityPcmRenderer.drain()'))
          )
          const observation = await inspectClosed(h.showId)
          ingest(
            await calibrate('renderer', () => h.eval('return window.__parityPcmRenderer.drain()'))
          )
          evidence.closeCycles.push({ cycle, generation, ...observation })
        } finally {
          closeSync(audioFd)
          closeSync(traceFd)
          await context?.close()
          context = null
          program = null
          if (browser && evidence.closeCycles.at(-1)?.cycle === cycle)
            evidence.closeCycles.at(-1).browserContexts = browser.contexts().length
          save()
        }
      }
      await artifact(traceFile, 'native-worklet-renderer-program-raw-observations')
      const encoded = await artifact(encodedFile, 'real-program-opus')
      if (video) await artifact(await video.path(), 'real-program-browser-video-unsynchronized')
      const decodedFile = join(cycleDir, 'program.f32le')
      const decodeArgs = [
        '-v',
        'error',
        '-i',
        encodedFile,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        'f32le',
        decodedFile
      ]
      runMedia(h.ffmpeg, decodeArgs)
      const decoded = await artifact(decodedFile, 'decoded-program-pcm')
      const probe = JSON.parse(
        runMedia(h.ffprobe, [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          encodedFile
        ])
      )
      Object.assign(attempt, {
        status: 'completed',
        cycle,
        generation,
        showId: h.showId,
        encoded: encoded.file,
        decoded: decoded.file,
        ffprobe: probe,
        decode: {
          executable: h.ffmpeg,
          args: decodeArgs.map((arg) => (arg.startsWith(output) ? relative(output, arg) : arg))
        }
      })
      if (cycle === 0) {
        evidence.decodedF32le = decoded.file
        evidence.decodedSha256 = decoded.sha256
      }
      assert.equal(
        evidence.closeCycles.at(-1).status,
        'closed',
        'Real owner cleanup was not confirmed'
      )
      assert.equal(evidence.closeCycles.at(-1).browserContexts, 0, 'Program browser context leaked')
      assert.equal(h.web.snapshot(h.showId)?.state?.legs?.length ?? 0, 0)
      h.assertNoDirect()
      save()
    }
    evidence.unavailable.push(
      {
        measurement: 'encoderDeliveryLatency',
        owner: 'Browser MediaRecorder',
        api: 'BlobEvent.timecode/ondataavailable',
        reason:
          'Chunk timestamps/emission times are retained, but this API exposes no per-sample encoder completion timestamp. Decoded marker IDs prove artifact continuity, not encoder delivery timing.'
      },
      {
        measurement: 'finalAvSync',
        owner: 'Plan 249 S13a native video clock bridge',
        api: 'Capture timestamp to published video frame mapping',
        reason:
          'S7a supplies no shared timestamped video source. Browser video artifact is retained separately; its start time cannot be assumed synchronized with the program audio recorder.'
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
    failure = new Error(`PCM acquisition failed; evidence: ${reportFile}`)
  } finally {
    const cleanup = await Promise.allSettled([
      context?.close(),
      browser?.close(),
      pages?.close(),
      h.close()
    ])
    evidence.harnessCleanup = cleanup.map((value) => value.status)
    if (cleanup.some((value) => value.status === 'rejected')) {
      evidence.acquisition = 'failed'
      failure ??= new Error(`PCM owned harness cleanup failed; evidence: ${reportFile}`)
    }
    save()
  }
  if (failure) throw failure
  return { evidenceFile: reportFile, output }
}
