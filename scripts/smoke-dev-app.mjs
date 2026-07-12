import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { runBackendRecordingSmoke } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-dev-smoke-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-dev-smoke-user-data-'))
const vendorWindowsFfmpeg = resolve(
  import.meta.dirname,
  '..',
  'vendor',
  'ffmpeg',
  'windows-x64',
  'bin',
  'ffmpeg.exe'
)
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  // Windows dev boxes rarely have ffmpeg on PATH; prefer the pinned vendor
  // build from `pnpm ffmpeg:fetch:windows` (same one dev mode wires in).
  (process.platform === 'win32' && existsSync(vendorWindowsFfmpeg) ? vendorWindowsFfmpeg : 'ffmpeg')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)

let stopApp = async () => {}

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  await runBackendRecordingSmoke({
    connection: launch.connections['backend-ready'],
    smoke: launch.connections['preview-motion-ready'],
    ffmpegPath,
    outputDirectory,
    timeoutMs,
    label: 'Dev app'
  })
} finally {
  await stopApp()
}
