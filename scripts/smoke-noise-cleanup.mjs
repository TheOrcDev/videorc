import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runNoiseCleanupArtifactSmoke } from './lib/noise-cleanup-artifact.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireBundled = process.argv.includes('--require-bundled')
const bundledBin =
  process.platform === 'win32'
    ? join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin')
    : join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin')
const bundledFfmpeg = join(bundledBin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const bundledFfprobe = join(bundledBin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
if (requireBundled && (!existsSync(bundledFfmpeg) || !existsSync(bundledFfprobe))) {
  throw new Error(
    `bundled Noise Cleanup proof requested, but ${bundledFfmpeg} or ${bundledFfprobe} is missing`
  )
}
const usingOverride = Boolean(process.env.VIDEORC_SMOKE_FFMPEG_PATH)
const usingBundled = requireBundled || (!usingOverride && existsSync(bundledFfmpeg))
const ffmpegPath = requireBundled
  ? bundledFfmpeg
  : (process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? (usingBundled ? bundledFfmpeg : 'ffmpeg'))
const ffprobePath = requireBundled
  ? bundledFfprobe
  : (process.env.VIDEORC_SMOKE_FFPROBE_PATH ??
    (usingBundled
      ? bundledFfprobe
      : ffmpegPath === 'ffmpeg'
        ? 'ffprobe'
        : join(dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')))
const outputDir = mkdtempSync(join(tmpdir(), 'videorc-noise-cleanup-smoke-'))

try {
  console.log(
    `noise-cleanup smoke: ffmpeg=${ffmpegPath} ffprobe=${ffprobePath} ` +
      `mode=${usingBundled ? 'bundled' : usingOverride ? 'override' : 'PATH'}`
  )
  const evidence = []
  for (const container of ['mp4', 'mkv']) {
    const cleanedPath = join(outputDir, `source-noise-cleaned.${container}`)
    const result = await runNoiseCleanupArtifactSmoke({
      ffmpegPath,
      ffprobePath,
      sourcePath: join(outputDir, `source.${container}`),
      outputPath: cleanedPath
    })
    const analysis = await analyzeRecording(cleanedPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: 30,
      expectAudio: true
    })

    if (
      !result.sourceFileUnchanged ||
      !result.videoStreamCopied ||
      result.noiseReductionDb < 3 ||
      result.snrImprovementDb < 2 ||
      result.voiceLevelDeltaDb > 1 ||
      result.durationDeltaMs > 50 ||
      !analysis.verdict.pass
    ) {
      throw new Error(
        `artifact contract failed: ${JSON.stringify({ container, result, analyzer: analysis.verdict })}`
      )
    }
    evidence.push({ container, result })
  }

  const summary = evidence
    .map(
      ({ container, result }) =>
        `${container.toUpperCase()} ${result.noiseReductionDb.toFixed(1)} dB noise reduction / ` +
        `${result.snrImprovementDb.toFixed(1)} dB SNR gain / ` +
        `${result.voiceLevelDeltaDb.toFixed(1)} dB voice delta / ` +
        `${result.durationDeltaMs.toFixed(1)} ms duration delta`
    )
    .join('; ')
  console.log(
    `noise-cleanup smoke PASS — speech-v1 preserved both MP4/MKV sources, stream-copied ` +
      `video, and passed the maintained final-artifact A/V analyzer (${summary}).`
  )
} finally {
  rmSync(outputDir, { recursive: true, force: true })
}
