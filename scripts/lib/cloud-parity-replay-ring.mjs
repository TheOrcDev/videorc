/** S21a acquisition + reconstruction acceptance. Heavy/live, NEVER a unit test.
 * Captures the real program tab's pixels and final audio mix in one recorder.
 * No synthetic muxed output, separate-audio alignment, provider or recording start.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { MEDIA, audioMeasurements, colorFraction } from './cloud-parity-media.mjs'
import { assertRingPacketClock } from './cloud-parity-ring-clock.mjs'
import { analyzeRecording } from './recording-analyzer.mjs'

async function loadRing(webRoot) {
  const require = createRequire(join(webRoot, 'package.json'))
  const { build } = createRequire(require.resolve('tsx'))('esbuild')
  const code = await build({
    stdin: {
      contents: `export * from './lib/cloud/replay/ring'; export * from './lib/cloud/replay/local-hls'; export * from './lib/cloud/replay/route';`,
      loader: 'ts',
      resolveDir: webRoot
    },
    absWorkingDir: webRoot,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    alias: { '@': webRoot },
    logLevel: 'silent'
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code.outputFiles[0].text)(
    require,
    module,
    module.exports
  )
  return module.exports
}

export async function exerciseReplayRing({ h, program, webRoot, output, report, sound }) {
  const { ProgramRing, LocalHlsAdapter, RING_LIMITS, handleProgramRing } = await loadRing(webRoot)
  const generation = randomUUID(),
    root = join(output, 'replay-ring'),
    directory = join(root, generation)
  mkdirSync(directory, { recursive: true })
  const ring = new ProgramRing(
    {
      userId: 'fixture-owner',
      showId: h.showId,
      generation,
      orientation: 'h',
      output: 'stream',
      // No stream or provider recording is started in this local acquisition.
      liveInterval: null,
      takeId: null
    },
    {
      environment: 'local-fixture',
      consent: true,
      costCeilingMicros: 0,
      providerCallsAllowed: false
    },
    Date.now(),
    {
      ...RING_LIMITS,
      maxDurationMs: 8000,
      maxSegments: 4,
      maxBytes: 16 * 1024 * 1024
    }
  )
  const adapter = await LocalHlsAdapter.open(root, generation, ring)
  let nowOffset = 0,
    failure,
    recorderStarted = false,
    firstId,
    acquiredBeforeFinalize = false
  const observations = (report.replayRing = {
    status: 'running',
    managedAcceptance: 'not-run',
    managedCost: 'unmeasured',
    productionQualified: false,
    artifacts: [],
    clockQualification: 'unmeasured',
    avSyncP95: 'unmeasured',
    source: 'actual-program-tab-and-final-audio-bus'
  })
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const show = url.pathname.split('/').at(-1)
      const response = await handleProgramRing(new Request(url, { method: req.method }), show, {
        session: req.headers.cookie === 'parity=owner' ? { user: { id: 'fixture-owner' } } : null,
        store: {
          shows: {
            findById: async (id) => ({
              id,
              userId: 'fixture-owner',
              expiresAt: new Date(Date.now() + 3600000)
            })
          }
        },
        now: () => Date.now() + nowOffset,
        localFixture: { ring }
      })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      res.writeHead(500)
      res.end('Fixture route failed')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/ring/`
  const get = (query = '', show = h.showId, auth = true) =>
    fetch(`${base}${show}?generation=${generation}${query}`, {
      headers: auth ? { cookie: 'parity=owner' } : {}
    })
  // One owned process, constant bitrate ceiling + finite 18s input + rolling HLS.
  const encoder = spawn(
    h.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '2500k',
      '-maxrate',
      '2500k',
      '-bufsize',
      '5000k',
      '-g',
      '60',
      '-keyint_min',
      '60',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-fps_mode',
      'passthrough',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_list_size',
      '6',
      '-hls_delete_threshold',
      '1',
      '-hls_flags',
      'delete_segments+independent_segments+program_date_time+temp_file',
      '-hls_segment_filename',
      join(directory, 'segment-%06d.ts'),
      join(directory, 'program.m3u8')
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  )
  let stderr = '',
    inputBytes = 0,
    exited = false,
    processError
  encoder.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  encoder.stdin.on('error', (error) => {
    processError = error
  })
  encoder.on('error', (error) => {
    processError = error
  })
  const closed = new Promise((resolve) =>
    encoder.on('close', (code) => {
      exited = true
      resolve(code)
    })
  )
  const deadline = setTimeout(() => {
    processError = new Error('Ring acquisition deadline')
    encoder.kill('SIGKILL')
  }, 45000)
  try {
    await h.rpc('sounds.settings', { monitor: false, volumeDb: 0 })
    await h.eval('return window.__videorcSmokeScenePresets.roomSounds(true)')
    await waitFor(
      async () =>
        (await h.eval('return window.__videorcSmokeScenePresets.roomSounds()')).state ===
        'published',
      'ring auxiliary negotiation'
    )
    await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
    await h.rpc('sounds.play', { id: sound.id })
    const png = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=0xdc28b4:s=64x64',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1'
    ])
    await h.rpc('cloud.overlay.set', {
      slot: 'card',
      orientation: 'h',
      pngBase64: png.toString('base64'),
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    })
    await program.exposeFunction('__ringChunk', async (encoded) => {
      const bytes = Buffer.from(encoded, 'base64')
      inputBytes += bytes.length
      assert.ok(
        bytes.length <= 8 * 1024 * 1024 && inputBytes <= 128 * 1024 * 1024,
        'Capture byte budget'
      )
      if (processError) throw processError
      assert.ok(!exited, `Ring muxer exited: ${stderr}`)
      if (!encoder.stdin.write(bytes)) await once(encoder.stdin, 'drain')
    })
    await program.bringToFront()
    await program.mouse.click(1, 1)
    await program.evaluate(async () => {
      document.title = 'Videorc Replay Ring'
      const taps = window.__parityProgramTaps ?? []
      if (taps.length !== 1) throw new Error('Expected one final program mix')
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 30 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include'
      })
      const video = display.getVideoTracks()[0]
      if (video.getSettings().displaySurface !== 'browser') {
        display.getTracks().forEach((track) => track.stop())
        throw new Error('Tab capture unavailable; no fake screen fallback allowed')
      }
      const audio = taps[0].tap.stream.getAudioTracks()[0]
      if (!audio || audio.readyState !== 'live') throw new Error('No live program mix')
      const recorder = new MediaRecorder(new MediaStream([video, audio]), {
        mimeType: 'video/webm;codecs=vp8,opus',
        videoBitsPerSecond: 2500000
      })
      const state = (window.__ringCapture = {
        recorder,
        video,
        pending: Promise.resolve(),
        queued: 0,
        error: null
      })
      recorder.ondataavailable = (event) => {
        state.queued += event.data.size
        if (state.queued > 8 * 1024 * 1024) {
          state.error = 'Capture backpressure exceeded'
          recorder.stop()
          return
        }
        state.pending = state.pending
          .then(async () => {
            const bytes = new Uint8Array(await event.data.arrayBuffer())
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            await window.__ringChunk(btoa(binary))
            state.queued -= event.data.size
          })
          .catch(() => {
            state.error = 'Capture chunk delivery failed'
          })
      }
      recorder.onerror = () => {
        state.error = 'MediaRecorder failed'
      }
      recorder.start(250)
    })
    recorderStarted = true
    const endAt = Date.now() + 18000
    while (Date.now() < endAt) {
      if (processError) throw processError
      const capture = await program.evaluate(() => ({
        state: window.__ringCapture.recorder.state,
        error: window.__ringCapture.error
      }))
      assert.equal(capture.error, null)
      assert.equal(capture.state, 'recording')
      try {
        const poll = await adapter.poll(Date.now())
        const response = await get(),
          manifest = await response.json()
        assert.equal(response.status, 200)
        if (poll.added) {
          assert.equal(
            poll.finalized,
            false,
            'Segments must arrive BEFORE recorder/egress finalization'
          )
          acquiredBeforeFinalize = true
          firstId ??= manifest.segments[0]?.id
        }
        assert.ok(manifest.metering.retainedBytes <= manifest.limits.maxBytes)
        assert.ok(manifest.segments.length <= 4)
        if (manifest.segments.length)
          assert.ok(manifest.segments.at(-1).endMs - manifest.segments[0].startMs <= 8000)
        const sourceBytes = readdirSync(directory).reduce(
          (sum, file) => sum + statSync(join(directory, file)).size,
          0
        )
        assert.ok(sourceBytes <= 32 * 1024 * 1024, 'Local muxer disk ceiling')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await delay(200)
    }
    assert.ok(acquiredBeforeFinalize, 'No segments before finalization; adapter cannot qualify')
    const manifest = await (await get()).json()
    assert.ok(manifest.segments.length >= 3, 'Need contiguous retained window')
    assert.ok(manifest.segments[0].startMs > 0, 'Retention must evict old program media')
    assert.equal((await get(`&segment=${firstId}`)).status, 410)
    assert.equal((await get('', `sh_${'x'.repeat(22)}`)).status, 404)
    assert.equal((await get('', h.showId, false)).status, 401)
    const start = manifest.segments[0].startMs,
      end = manifest.segments.at(-1).endMs
    const window = await (await get(`&startMs=${start}&endMs=${end}`)).json()
    assert.deepEqual(window.actual, { startMs: start, endMs: end })
    const files = [],
      probes = []
    for (const segment of window.segments) {
      const response = await get(`&segment=${segment.id}`)
      assert.equal(response.status, 200)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(createHash('sha256').update(bytes).digest('hex'), segment.sha256)
      const name = `reconstructed-${segment.sequence}.ts`,
        file = join(root, name)
      writeFileSync(file, bytes)
      files.push(name)
      probes.push(
        JSON.parse(
          runMedia(h.ffprobe, [
            '-v',
            'error',
            '-show_packets',
            '-show_entries',
            'packet=codec_type,pts_time,duration_time,flags',
            '-of',
            'json',
            file
          ]).toString()
        )
      )
    }
    observations.packetClock = assertRingPacketClock(window.segments, probes)
    nowOffset = 9000
    assert.equal((await get(`&segment=${window.segments[0].id}`)).status, 410)
    nowOffset = 0
    writeFileSync(
      join(root, 'window.ffconcat'),
      `ffconcat version 1.0\n${files.map((file) => `file '${file}'`).join('\n')}\n`
    )
    // Stop before decode; no more ring writes race the final manifest evidence.
    await program.evaluate(async () => {
      const state = window.__ringCapture
      const stopped = new Promise((resolve) => {
        state.recorder.onstop = resolve
      })
      state.recorder.stop()
      await stopped
      await state.pending
      state.video.stop()
      if (state.error) throw new Error(state.error)
    })
    recorderStarted = false
    encoder.stdin.end()
    assert.equal(await closed, 0, stderr)
    clearTimeout(deadline)
    const artifact = join(root, 'program-window.mp4')
    runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '1',
      '-i',
      join(root, 'window.ffconcat'),
      '-c',
      'copy',
      artifact
    ])
    const analysis = await analyzeRecording(artifact, {
      ffmpegPath: h.ffmpeg,
      ffprobePath: h.ffprobe,
      intendedFps: 30,
      expectAudio: true,
      gates: { avSyncTargetMs: 80, avSyncHardFailMs: 80 }
    })
    writeFileSync(join(root, 'analysis.json'), JSON.stringify(analysis, null, 2))
    assert.equal(analysis.verdict.pass, true, analysis.verdict.failures.join('; '))
    const raw = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      artifact,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ])
    const pcm = new Float32Array(raw.length / 4)
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readFloatLE(i * 4)
    const tones = audioMeasurements(pcm)
    for (const voice of ['host', 'guest1', 'guest2', 'soundboard'])
      assert.ok(tones[voice] > MEDIA.analysis.audibleDbfs, `Missing program ${voice}`)
    assert.ok(tones.system < MEDIA.analysis.absentDbfs, 'Prohibited system-audio stem')
    const pixels = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      artifact,
      '-vf',
      'fps=5,scale=160:90',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    for (const identity of ['host', 'guest1', 'guest2', 'card']) {
      let hits = 0
      for (let at = 0; at + 43200 <= pixels.length; at += 43200)
        if (
          colorFraction(pixels.subarray(at, at + 43200), MEDIA.colors[identity]) >
          MEDIA.analysis.minimumColorFraction
        )
          hits++
      assert.ok(hits >= 5, `Missing actual program pixels: ${identity}`)
    }
    const bytes = readFileSync(artifact)
    observations.artifacts.push({
      file: artifact,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
    Object.assign(observations, {
      status: 'passed-local-acquisition',
      acquiredBeforeFinalize,
      manifest,
      window,
      tones,
      inputBytes
    })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(observations, null, 2))
  } catch (error) {
    failure = error
    observations.status = 'failed'
  } finally {
    clearTimeout(deadline)
    if (recorderStarted)
      await program
        .evaluate(() => {
          const state = window.__ringCapture
          if (state?.recorder.state === 'recording') state.recorder.stop()
          state?.video.stop()
        })
        .catch(() => {})
    if (!exited) {
      encoder.kill('SIGKILL')
      await closed
    }
    await new Promise((resolve) => server.close(resolve))
    await adapter.dispose(generation)
    await h.rpc('sounds.stop')
    await h.eval('return window.__videorcSmokeScenePresets.roomSounds(false)')
    await h.rpc('cloud.overlay.clear', { slot: 'card', orientation: 'h' })
  }
  if (failure) throw failure
}
