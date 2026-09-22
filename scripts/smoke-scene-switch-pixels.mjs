import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { assertSceneSwitchPixels } from './lib/scene-switch-pixels.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'

const root = resolve(import.meta.dirname, '..')
const directory = mkdtempSync(join(tmpdir(), 'videorc-scene-switch-pixels-'))
const ffmpeg = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
console.log(`Scene switch artifact evidence: ${directory}`)
await run(
  'cargo',
  [
    'test',
    '-p',
    'videorc-backend',
    '--bin',
    'videorc-backend',
    'compositor::scene_switch_tests::scene_switch_artifact_fixture',
    '--',
    '--exact',
    '--nocapture'
  ],
  { ...process.env, VIDEORC_SCENE_SWITCH_ARTIFACT_DIR: directory }
)

for (const mode of process.platform === 'darwin' ? ['cpu', 'metal'] : ['cpu']) {
  const primary = join(directory, `${mode}-primary.yuv`)
  const stream = join(directory, `${mode}-stream.yuv`)
  const recording = join(directory, `${mode}-recording.mp4`)
  const receivedPath = join(directory, `${mode}-stream.ts`)
  const finalizedStream = join(directory, `${mode}-stream.mp4`)
  // An actual encoded stream over loopback with an explicit listening edge.
  // Production RTMP/session coverage remains in the live-layout app smoke.
  const chunks = []
  let socket
  const { promise: received, resolve: finishReceive, reject: failReceive } = Promise.withResolvers()
  // Observe an early socket error while FFmpeg is still running; awaiting the
  // original promise below will still surface the failure.
  void received.catch(() => {})
  const server = createServer((connected) => {
    socket = connected
    connected.on('data', (chunk) => chunks.push(chunk))
    connected.on('end', finishReceive)
    connected.on('error', failReceive)
  })
  server.on('error', failReceive)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const encoder = [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-c:a',
      'aac',
      '-shortest'
    ]
    await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'yuv420p',
      '-video_size',
      '64x36',
      '-framerate',
      '30',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-i',
      primary,
      '-f',
      'rawvideo',
      '-pixel_format',
      'yuv420p',
      '-video_size',
      '36x64',
      '-framerate',
      '30',
      '-color_range',
      'tv',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-i',
      stream,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-map',
      '0:v',
      '-map',
      '2:a',
      ...encoder,
      recording,
      '-map',
      '1:v',
      '-map',
      '2:a',
      ...encoder,
      '-f',
      'mpegts',
      `tcp://127.0.0.1:${server.address().port}`
    ])
    await Promise.race([
      received,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Stream did not finish within 10s')), 10000)
        timer.unref()
      })
    ])
    writeFileSync(receivedPath, Buffer.concat(chunks))
  } finally {
    socket?.destroy()
    server.close()
  }
  // Index the received packets without transcoding. MPEG-TS stream duration
  // estimates omit the final AAC PES even though its packets are present;
  // MP4 provides exact sample durations for the final-artifact A/V analyzer.
  await run(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-i',
    receivedPath,
    '-map',
    '0',
    '-c',
    'copy',
    finalizedStream
  ])
  for (const [artifact, reference, width, height] of [
    [recording, primary, 64, 36],
    [finalizedStream, stream, 36, 64]
  ]) {
    const result = spawnSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-i',
        artifact,
        '-map',
        '0:v:0',
        '-pix_fmt',
        'yuv420p',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    if (result.status !== 0) throw new Error(result.stderr?.toString() ?? String(result.error))
    const pixels = assertSceneSwitchPixels(readFileSync(reference), result.stdout, {
      width,
      height,
      label: artifact
    })
    const quality = await analyzeRecording(artifact, {
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      intendedFps: 30,
      expectAudio: true,
      // The reference deliberately holds static screens between switches.
      // Frame-by-frame comparison above proves the expected motion separately.
      gates: { requireMotion: false }
    })
    writeReports(quality)
    if (!quality.verdict.pass)
      throw new Error(`${artifact}: ${quality.verdict.failures.join('; ')}`)
    console.log(
      `${artifact}: PASS ${pixels.frames} frames, worst mean error ${pixels.worstMean.toFixed(2)}`
    )
  }
}

function run(command, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
    let forceKill
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000)
      forceKill.unref()
    }, 600000)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(forceKill)
      rejectRun(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(forceKill)
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} exited ${code ?? signal}`))
    })
  })
}
