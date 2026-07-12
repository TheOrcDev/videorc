import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-encoder-bridge-smoke-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const scenario = {
  width: Number(process.env.VIDEORC_ENCODER_BRIDGE_WIDTH ?? 640),
  height: Number(process.env.VIDEORC_ENCODER_BRIDGE_HEIGHT ?? 360),
  fps: Number(process.env.VIDEORC_ENCODER_BRIDGE_FPS ?? 30),
  durationMs: Number(process.env.VIDEORC_ENCODER_BRIDGE_DURATION_MS ?? 2000),
  bitrateKbps: Number(process.env.VIDEORC_ENCODER_BRIDGE_BITRATE_KBPS ?? 2000)
}

let launched

mkdirSync(outputDirectory, { recursive: true })

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory
    }
  })
  await runEncoderBridgeSmoke(
    launched.connections['backend-ready'],
    launched.connections['preview-motion-ready']
  )
} finally {
  await launched?.stop()
}

async function runEncoderBridgeSmoke(connection, smoke) {
  const outputPath = join(outputDirectory, 'encoder-bridge-synthetic.mp4')
  const ws = await connectBackend(connection, timeoutMs)
  const diagnosticSamples = []
  try {
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message?.event === 'diagnostics.stats') {
          diagnosticSamples.push(message.payload)
        }
      } catch {
        // Ignore unrelated websocket messages.
      }
    })

    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for encoder bridge smoke.')
    }
    assertFfprobeAvailable()
    console.log(`Encoder bridge smoke using FFmpeg: ${ffmpegPath}`)
    console.log(`Encoder bridge smoke using FFprobe: ${ffprobePath}`)

    const result = await requestSmokeCommand(
      smoke,
      'backend-debug-rpc',
      {
        method: 'encoder_bridge.synthetic_record',
        params: {
          ffmpegPath,
          outputPath,
          width: scenario.width,
          height: scenario.height,
          fps: scenario.fps,
          durationMs: scenario.durationMs,
          bitrateKbps: scenario.bitrateKbps
        },
        timeoutMs
      },
      { timeoutMs }
    )
    verifyBridgeResult(result, outputPath)
    const probe = probeVideo(outputPath)
    verifyProbe(probe)
    const finalDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    verifyDiagnostics([...diagnosticSamples, finalDiagnostics])

    console.log(
      `Encoder bridge smoke OK: ${outputPath} (${formatBytes(result.fileBytes)}), ${result.framesWritten} frames, ${format(result.inputFps)}fps input, queue ${result.queueDepthMax}, drops ${result.droppedFrames}, speed ${format(result.encoderSpeed)}x, probed ${format(probe.fps)}fps/${format(probe.durationSeconds)}s.`
    )
  } finally {
    ws.close()
  }
}

function verifyBridgeResult(result, outputPath) {
  if (result.outputPath !== outputPath) {
    throw new Error(`Unexpected bridge output path: ${result.outputPath}`)
  }
  if (!existsSync(outputPath)) {
    throw new Error(`Encoder bridge output was not created: ${outputPath}`)
  }
  const size = statSync(outputPath).size
  if (size <= 0 || size !== result.fileBytes) {
    throw new Error(
      `Encoder bridge output has wrong size: stat=${size}, result=${result.fileBytes}`
    )
  }
  const expectedFrames = Math.ceil((scenario.durationMs / 1000) * scenario.fps)
  if (result.framesWritten !== expectedFrames) {
    throw new Error(`Expected ${expectedFrames} bridge frames, got ${result.framesWritten}.`)
  }
  if (result.queueDepthMax > 1) {
    throw new Error(`Expected bridge queue depth <= 1, got ${result.queueDepthMax}.`)
  }
  if (result.droppedFrames !== 0) {
    throw new Error(`Expected no bridge/FFmpeg dropped frames, got ${result.droppedFrames}.`)
  }
  if (typeof result.inputFps !== 'number' || result.inputFps < scenario.fps * 0.85) {
    throw new Error(`Bridge input FPS too low: ${result.inputFps}`)
  }
}

function verifyProbe(probe) {
  if (Math.abs(probe.fps - scenario.fps) > 1) {
    throw new Error(`Expected probed FPS near ${scenario.fps}, got ${probe.fps}.`)
  }
  const expectedSeconds = scenario.durationMs / 1000
  if (
    probe.durationSeconds < expectedSeconds - 0.35 ||
    probe.durationSeconds > expectedSeconds + 0.75
  ) {
    throw new Error(`Expected duration near ${expectedSeconds}s, got ${probe.durationSeconds}s.`)
  }
}

function verifyDiagnostics(samples) {
  const bridgeSamples = samples.filter((sample) => sample?.activeOutputMode === 'encoder-bridge')
  if (bridgeSamples.length === 0) {
    throw new Error('Diagnostics never reported encoder-bridge as the active output mode.')
  }
  if (!bridgeSamples.some((sample) => typeof sample.encoderBridgeInputFps === 'number')) {
    throw new Error('Diagnostics never reported encoder bridge input FPS.')
  }
  if (bridgeSamples.some((sample) => sample.encoderBridgeDroppedFrames > 0)) {
    throw new Error('Diagnostics reported encoder bridge dropped frames.')
  }
  const final = bridgeSamples.at(-1)
  if (final.encoderBridgeQueueDepth !== 0) {
    throw new Error(`Expected final bridge queue depth 0, got ${final.encoderBridgeQueueDepth}.`)
  }
  if (final.encoderBridgeError) {
    throw new Error(`Diagnostics reported bridge error: ${final.encoderBridgeError}`)
  }
}

function probeVideo(outputPath) {
  const result = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=avg_frame_rate,duration,nb_frames',
      '-of',
      'json',
      outputPath
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`Could not ffprobe encoder bridge output: ${result.stderr || result.stdout}`)
  }
  const payload = JSON.parse(result.stdout)
  const stream = payload.streams?.[0]
  if (!stream) {
    throw new Error(`FFprobe returned no video stream for ${outputPath}.`)
  }
  return {
    fps: fpsFromRate(stream.avg_frame_rate),
    durationSeconds: Number(stream.duration),
    frames: stream.nb_frames == null ? null : Number(stream.nb_frames)
  }
}

function fpsFromRate(rate) {
  const [num, den] = String(rate ?? '')
    .split('/')
    .map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return 0
  }
  return num / den
}

function assertFfprobeAvailable() {
  const result = spawnSync(ffprobePath, ['-version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `FFprobe is unavailable for encoder bridge smoke: ${result.stderr || result.stdout}`
    )
  }
}

function format(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'n/a'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'n/a'
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KiB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`
}
