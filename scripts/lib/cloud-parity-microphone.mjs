/** Maintained real acquisition; import is inert. Never run as a helper test. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  microphoneAcquisitionConfig,
  microphoneMeasurements,
  assessMicrophoneEvidence
} from './cloud-parity-microphone-contract.mjs'
import { pcmRemaining, pcmWithDeadline } from './cloud-parity-pcm-acquisition-contract.mjs'
import { requireLoopback, redactParityFailure } from './cloud-parity-contract.mjs'
import { installPcmRendererCollector } from './cloud-parity-pcm-page.mjs'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function acquireMicrophone({
  desktopRoot,
  webRoot,
  config = microphoneAcquisitionConfig()
}) {
  assert.ok(webRoot, 'Set VIDEORC_PARITY_WEB_ROOT to a clean compatible local checkout')
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: webRoot,
      encoding: 'utf8'
    }).trim(),
    ''
  )
  const { managedHarness, OUTPUT, runMedia, waitFor } = await import('./cloud-managed-smoke.mjs')
  const { prepareParityRoom } = await import('./cloud-parity-controls.mjs')
  const { startParityPages, installProgramAudioTap, recordPageAudio } =
    await import('./cloud-parity-browser.mjs')
  const { cameraY4m, toneWav, MEDIA, toneDbfs } = await import('./cloud-parity-media.mjs')
  const { chromium } = await import('playwright-core')
  const h = await managedHarness('talk', 1, { maximumLogEntries: 4096 })
  const output = join(h.root, 'microphone')
  mkdirSync(output)
  const file = join(output, 'evidence.json')
  const evidence = {
    kind: 'native-room-microphone',
    acquisition: 'running',
    config,
    productionQualified: false,
    revisions: {},
    steps: [],
    artifacts: [],
    closeCycles: [],
    failures: [],
    unavailable: [
      'S13a video clock',
      'Encoder completion',
      'Native speaker AEC',
      'Physical unplug qualification'
    ]
  }
  let pages, browser, context, program, failure
  const save = () => writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
  const artifact = (name, bytes, kind) => {
    assert.ok(bytes.length > 0 && bytes.length < 32 * 1024 * 1024)
    writeFileSync(join(output, name), bytes)
    evidence.artifacts.push({ file: name, bytes: bytes.length, sha256: hash(bytes), kind })
    return name
  }
  const resources = async () => ({
    main: await h.eval('return await window.videorc.getRoomNativeMicrophoneResources()'),
    renderer: await h.eval('return window.__videorcSmokeScenePresets.roomNativeMicrophone()')
  })
  const tracks = async () => {
    const participants = await h.web.roomRpc('ListParticipants', { room: h.showId })
    assert.ok(
      participants &&
        typeof participants === 'object' &&
        (participants.participants === undefined || Array.isArray(participants.participants))
    )
    return (participants.participants ?? [])
      .filter((p) => p.identity === `host:${h.showId}`)
      .flatMap((p) => p.tracks ?? [])
      .filter((t) => t.source === 'MICROPHONE' || t.source === 2)
  }
  const capture = async (name) => {
    const encoded = Buffer.from(
      await pcmWithDeadline('Program audio capture', 20000, () =>
        recordPageAudio(program, 'program', config.seconds)
      ),
      'base64'
    )
    const encodedFile = artifact(`${name}.webm`, encoded, 'real-program-opus')
    const args = [
      '-v',
      'error',
      '-i',
      join(output, encodedFile),
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ]
    const raw = runMedia(h.ffmpeg, args)
    const decodedFile = artifact(`${name}.f32le`, raw, 'decoded-program-audio')
    const samples = Float32Array.from({ length: raw.length / 4 }, (_, i) =>
      raw.readFloatLE(i * 4)
    ).subarray(48000)
    const observation = await resources()
    const diagnostics = await h.eval('return window.__parityPcmRenderer.drain()')
    assert.equal(diagnostics.dropped, 0, 'Raw renderer observation queue overflow')
    const publications = await tracks()
    assert.ok(publications.length <= 1, 'Duplicate microphone producer')
    evidence.steps.push({
      name,
      encodedFile,
      decodedFile,
      decode: { executable: h.ffmpeg, args },
      ffprobe: JSON.parse(
        runMedia(h.ffprobe, [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          join(output, encodedFile)
        ])
      ),
      measurements: {
        ...microphoneMeasurements(samples),
        tone440: toneDbfs(samples, 440),
        tone880: toneDbfs(samples, 880)
      },
      observation,
      publications,
      diagnostics
    })
    save()
  }
  const configure = (patch) =>
    h.eval(
      `const seam=window.__videorcSmokeScenePresets; const config=seam.streamingState().captureConfig; seam.configure({audio:{...config.audio,...${JSON.stringify(patch)}}}); return true`
    )
  const select = (id, name) =>
    h.eval(
      `await window.__videorcSmokeScenePresets.roomMicrophoneSelect(${JSON.stringify(id)},${JSON.stringify(name)}); return true`
    )
  try {
    evidence.revisions = {
      desktop: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: desktopRoot,
        encoding: 'utf8'
      }).trim(),
      web: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: webRoot, encoding: 'utf8' }).trim(),
      desktopDiff: hash(execFileSync('git', ['diff', 'HEAD'], { cwd: desktopRoot })),
      programBundle: hash(readFileSync(join(webRoot, 'public/cloud/program/v1/stage.js')))
    }
    evidence.revisions.untrackedSources = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: desktopRoot, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((name) =>
        /^(apps\/desktop\/src|crates\/videorc-backend\/src|scripts\/lib|protocol-fixtures)\//.test(
          name
        )
      )
      .map((name) => ({ file: name, sha256: hash(readFileSync(join(desktopRoot, name))) }))
    Object.assign(h.env, {
      VIDEORC_ROOM_NATIVE_MIC: '1',
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1'
    })
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_VIDEO, cameraY4m(MEDIA.colors.host))
    writeFileSync(h.env.VIDEORC_SMOKE_FAKE_MEDIA_AUDIO, toneWav(440))
    await h.destinations(0)
    await h.launch()
    await h.eval(
      `(${installPcmRendererCollector.toString()})(); return window.__videorcSmokeScenePresets.roomNativeMicrophone(true)`
    )
    await h.eval(
      'window.__videorcSmokeScenePresets.setSettings(current => ({ ...current, keepMicrophoneWarm: false })); return true'
    )
    await prepareParityRoom(h, false)
    await configure({
      microphoneGainDb: 0,
      microphoneNoiseSuppression: 'off',
      microphoneSyncOffsetMs: 0,
      microphoneMuted: false
    })
    pages = await startParityPages(webRoot, new Map())
    browser = await chromium.launch({
      executablePath:
        process.env.VIDEORC_SMOKE_CHROME ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required']
    })
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      const opened = await h.rpc('cloud.room.open', {
        outputs: [OUTPUT],
        title: 'Microphone processing fixture',
        platforms: []
      })
      h.showId = opened.show.id
      await h.status((s) => s.room?.client === 'connected', 'Host microphone room connected', 30000)
      await waitFor(
        async () => (await resources()).renderer.state === 'published',
        'Native microphone published',
        30000
      )
      assert.equal((await resources()).main.nativeSources, 1)
      await h.rpc('cloud.stage.set', { layout: 'solo', onStage: [`host:${h.showId}`] })
      if (cycle === 0) {
        context = await browser.newContext({
          viewport: { width: 640, height: 360 },
          recordVideo: { dir: output, size: { width: 640, height: 360 } }
        })
        await context.route('**/*', (route) => {
          try {
            requireLoopback(route.request().url())
            return route.continue()
          } catch {
            return route.abort()
          }
        })
        program = await context.newPage()
        program.setDefaultTimeout(15000)
        await program.addInitScript(installProgramAudioTap)
        const search = new URLSearchParams({
          show: h.showId,
          k: 'talk',
          pt: 'vcp1.dGVzdA.dGVzdA',
          layout: 'h',
          url: h.livekit.url,
          token: h.web.tokenFor(h.showId, 'EG_microphone', 'recorder')
        })
        await program.goto(`${pages.origin}${pages.wire.PROGRAM_PAGE_PATH}?${search}`)
        await waitFor(
          () => program.evaluate(() => window.__parityProgramTaps?.length === 1),
          'Real final program bus',
          30000
        )
        await capture('baseline')
        await h.eval(
          "await window.__videorcSmokeScenePresets.roomMicrophoneDisconnect('starve'); return true"
        )
        await capture('underrun')
        await h.eval(
          "await window.__videorcSmokeScenePresets.roomMicrophoneDisconnect('resume'); return true"
        )
        await capture('underrun-recovered')
        await configure({ microphoneGainDb: -6 })
        await capture('gain-minus-six')
        await configure({ microphoneMuted: true })
        await capture('muted')
        await configure({
          microphoneMuted: false,
          microphoneGainDb: 0,
          microphoneNoiseSuppression: 'rnnoise'
        })
        await capture('noise-on')
        await configure({ microphoneNoiseSuppression: 'off', microphoneSyncOffsetMs: 100 })
        await capture('offset-configured')
        await configure({ microphoneSyncOffsetMs: 0 })
        await select('microphone:coreaudio:4294967294', 'Alternate parity microphone')
        await capture('switched')
        await select(null, null)
        await capture('none')
        assert.equal((await resources()).main.nativeSources, 0)
        await select('microphone:coreaudio:4294967295', 'Parity microphone')
        await configure({ microphoneMuted: false })
        await waitFor(
          async () => (await resources()).renderer.state === 'published',
          'Fixture reopened',
          30000
        )
        await h.eval(
          'await window.__videorcSmokeScenePresets.roomMicrophoneDisconnect(); return true'
        )
        await waitFor(
          async () => (await tracks()).length === 0,
          'Actual capture EOF unpublished',
          30000
        )
        await capture('disconnected')
        await select('microphone:coreaudio:4294967295', 'Parity microphone')
        await configure({ microphoneMuted: false })
        await capture('recovered')
        await h.cutHostRoom()
        await h.status((s) => s.room?.client === 'reconnecting', 'SDK reconnect', 30000)
        await h.forwardHostRoom()
        await h.status((s) => s.room?.client === 'connected', 'SDK reconnected', 30000)
        await capture('reconnected')
        const video = program.video()
        await context.close()
        context = null
        if (video) {
          const path = await video.path()
          artifact('program-video.webm', readFileSync(path), 'unsynchronized-program-video')
        }
      }
      const active = await resources()
      const generation = active.renderer.owners.find((owner) =>
        Number.isSafeInteger(owner.generation)
      )?.generation
      assert.ok(generation, 'Actual native owner generation unavailable')
      await h.rpc('cloud.room.close')
      let observation
      try {
        await waitFor(
          async () => {
            const r = await resources()
            const listing = await h.web.roomRpc('ListRooms', { names: [h.showId] })
            assert.ok(
              listing &&
                typeof listing === 'object' &&
                (listing.rooms === undefined || Array.isArray(listing.rooms))
            )
            const remaining = (listing.rooms ?? []).some((room) => room.name === h.showId)
              ? await tracks()
              : []
            observation = pcmRemaining(r.main, r.renderer, remaining)
            return observation.status === 'closed'
          },
          'Actual microphone owner release',
          10000
        )
      } catch (error) {
        observation ??= { status: 'unavailable', reason: redactParityFailure(error) }
      }
      evidence.closeCycles.push({ cycle, generation, ...observation })
      save()
      assert.equal(observation.status, 'closed', 'Microphone resources did not close')
      h.assertNoDirect()
      // Drain raw diagnostics between owners; never allow the collector to grow.
      await h.eval('return window.__parityPcmRenderer.drain()')
    }
    evidence.acquisition = 'completed'
  } catch (error) {
    evidence.acquisition = 'failed'
    evidence.failures.push(
      redactParityFailure(error, [...h.web.tokens, h.livekit.apiKey, h.livekit.apiSecret])
    )
    failure = new Error(`Microphone acquisition failed: ${file}`)
  } finally {
    const cleanup = await Promise.allSettled([
      context?.close(),
      browser?.close(),
      pages?.close(),
      h.close()
    ])
    evidence.harnessCleanup = cleanup.map((c) => c.status)
    if (cleanup.some((c) => c.status === 'rejected')) {
      evidence.acquisition = 'failed'
      failure ??= new Error(`Cleanup failed: ${file}`)
    }
    save()
  }
  if (failure) throw failure
  return file
}
export async function analyzeMicrophone(file) {
  const { toneDbfs } = await import('./cloud-parity-media.mjs')
  assert.ok(file, 'Set VIDEORC_PCM_EVIDENCE to acquired microphone evidence')
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(
    Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0,
    'Acquired artifacts unavailable'
  )
  const artifacts = new Map()
  for (const artifact of evidence.artifacts) {
    assert.equal(
      basename(artifact.file),
      artifact.file,
      'Artifact must be local to its acquisition'
    )
    assert.ok(!artifacts.has(artifact.file), 'Duplicate artifact identity')
    assert.ok(
      Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0 &&
        artifact.bytes < 32 * 1024 * 1024
    )
    const bytes = readFileSync(join(dirname(file), artifact.file))
    assert.equal(bytes.length, artifact.bytes)
    assert.equal(hash(bytes), artifact.sha256)
    artifacts.set(artifact.file, bytes)
  }
  for (const step of evidence.steps ?? []) {
    const raw = artifacts.get(step.decodedFile)
    assert.ok(
      raw && artifacts.has(step.encodedFile),
      'Registered encoded and decoded artifacts required'
    )
    assert.ok(raw.length % 4 === 0)
    const samples = Float32Array.from({ length: raw.length / 4 }, (_, i) =>
      raw.readFloatLE(i * 4)
    ).subarray(48000)
    step.measurements = {
      ...microphoneMeasurements(samples),
      tone440: toneDbfs(samples, 440),
      tone880: toneDbfs(samples, 880)
    }
  }
  return assessMicrophoneEvidence(evidence)
}
