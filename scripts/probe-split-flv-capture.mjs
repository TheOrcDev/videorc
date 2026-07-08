#!/usr/bin/env node
// Plan 032 investigation probe: capture the SPLIT-profile (4K record + 1080p
// stream) FLV leg against a local RTMP listener and report codec/extradata
// facts — the exact bytes a platform ingest sees. Scratch probe promoted to a
// script so the repro is one command.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
const outputDirectory =
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-split-flv-'))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const streamMs = Number(process.env.VIDEORC_SPLIT_FLV_STREAM_MS ?? 9000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const streamPort = Number(process.env.VIDEORC_SPLIT_FLV_STREAM_PORT ?? 19617)

const streamKey = 'split-probe'
const listenUrl = `rtmp://127.0.0.1:${streamPort}/live/${streamKey}`
const recvPath = join(outputDirectory, 'split-stream-received.flv')

function spawnListener() {
  const proc = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-timeout',
      '30',
      '-i',
      listenUrl,
      '-c',
      'copy',
      recvPath
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  return proc
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

mkdirSync(outputDirectory, { recursive: true })

const timestamp = new Date().toISOString()
const sessionParams = {
  sources: { testPattern: true },
  layout: {
    layoutPreset: 'screen-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  },
  output: {
    recordEnabled: true,
    streamEnabled: true,
    outputDirectory,
    ffmpegPath,
    // Split profile: 4K record + 1080p stream — two VideoToolbox encoders,
    // the stream FLV leg copies the SECOND encoder's transport stream.
    video: { preset: 'custom', width: 3840, height: 2160, fps: 30, bitrateKbps: 8000 },
    rtmp: { preset: 'custom', serverUrl: `rtmp://127.0.0.1:${streamPort}/live`, streamKey }
  },
  streaming: {
    enabled: true,
    mode: 'single',
    targets: [
      {
        id: 'split-probe-target',
        platform: 'custom',
        label: 'Split probe',
        enabled: true,
        serverUrl: `rtmp://127.0.0.1:${streamPort}/live`,
        urlMode: 'server-and-key',
        streamKey,
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    defaultOutputPreset: 'tutorial-1080p30',
    defaultBitrateKbps: 6000,
    enabledTargetIds: ['split-probe-target']
  }
}

let ws = null
let listener = null
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
  }
})
try {
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  listener = spawnListener()
  await sleep(1200)

  const started = await request(ws, timeoutMs, 'session.start', sessionParams)
  if (!started?.sessionId) {
    throw new Error(`session.start did not return a sessionId: ${JSON.stringify(started)}`)
  }
  console.log(`[split-flv] session ${started.sessionId} running for ${streamMs}ms`)
  await sleep(streamMs)
  await request(ws, timeoutMs, 'session.stop')
  await sleep(2500)
} finally {
  ws?.close()
  if (listener) {
    listener.kill('SIGTERM')
    await sleep(500)
    listener.kill('SIGKILL')
  }
  await launched.stop()
}

// Dissect what the platform would have received.
const probe = spawn(
  ffprobePath,
  [
    '-v',
    'error',
    '-show_streams',
    '-show_entries',
    'stream=codec_name,profile,extradata_size,width,height,sample_rate',
    '-of',
    'json',
    recvPath
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] }
)
let probeJson = ''
probe.stdout.on('data', (chunk) => {
  probeJson += chunk
})
await new Promise((resolveExit) => probe.on('exit', resolveExit))
console.log('[split-flv] received FLV streams:')
console.log(probeJson)
console.log(`[split-flv] capture: ${recvPath}`)
