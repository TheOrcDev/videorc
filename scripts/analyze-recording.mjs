#!/usr/bin/env node
// CLI for the honest final-file recording analyzer.
//
// Analyze any finished recording against the strict OBS-quality gates and write a
// markdown + JSON quality report next to it. Exits non-zero when the recording
// fails a gate, so it doubles as a CI/harness gate.
//
//   node scripts/analyze-recording.mjs <file> [options]
//
// Options:
//   --fps <n>            Intended/selected fps (for the frame-count gate). Defaults to
//                        the file's nominal rate.
//   --expect-audio       Treat a missing audio stream as a failure.
//   --no-expect-audio    Do not require audio (default infers from the file).
//   --out-dir <dir>      Where to write reports (default: beside the recording).
//   --no-report          Print the verdict only; do not write report files.
//   --json               Print the full report as JSON to stdout instead of text.
//   --min-unique-frame-ratio <n>
//                        Fail when decoded frame uniqueness is below n (opt-in).
//   --ffmpeg <path>      ffmpeg binary (or VIDEORC_SMOKE_FFMPEG_PATH).
//   --ffprobe <path>     ffprobe binary (or VIDEORC_SMOKE_FFPROBE_PATH).
//
// Gate-threshold overrides (rarely needed): --max-freeze-ms, --max-repeat-run,
//   --max-audio-gap-ms, --av-target-ms, --av-hardfail-ms.

import { analyzeRecording, renderMarkdownReport, writeReports } from './lib/recording-analyzer.mjs'

function parseArgs(argv) {
  const args = { gates: {} }
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[(i += 1)]
    switch (arg) {
      case '--fps':
        args.intendedFps = Number(next())
        break
      case '--expect-audio':
        args.expectAudio = true
        break
      case '--no-expect-audio':
        args.expectAudio = false
        break
      case '--out-dir':
        args.outDir = next()
        break
      case '--no-report':
        args.noReport = true
        break
      case '--json':
        args.json = true
        break
      case '--ffmpeg':
        args.ffmpegPath = next()
        break
      case '--ffprobe':
        args.ffprobePath = next()
        break
      case '--max-freeze-ms':
        args.gates.maxFreezeMs = Number(next())
        break
      case '--max-repeat-run':
        args.gates.maxRepeatedFrameRun = Number(next())
        break
      case '--max-audio-gap-ms':
        args.gates.maxAudioGapMs = Number(next())
        break
      case '--av-target-ms':
        args.gates.avSyncTargetMs = Number(next())
        break
      case '--av-hardfail-ms':
        args.gates.avSyncHardFailMs = Number(next())
        break
      case '--min-unique-frame-ratio':
        args.gates.minUniqueFrameRatio = Number(next())
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        positionals.push(arg)
    }
  }
  args.file = positionals[0]
  return args
}

const HELP = `Analyze a finished recording against strict OBS-quality gates.

Usage: node scripts/analyze-recording.mjs <file> [--fps 30] [--expect-audio]
         [--min-unique-frame-ratio 0.95]
         [--out-dir DIR] [--no-report] [--json]

Exits 0 when the recording passes every gate, 1 when it fails one.`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    console.log(HELP)
    process.exit(args.file ? 0 : 2)
  }

  if (
    args.gates.minUniqueFrameRatio != null &&
    (!Number.isFinite(args.gates.minUniqueFrameRatio) ||
      args.gates.minUniqueFrameRatio < 0 ||
      args.gates.minUniqueFrameRatio > 1)
  ) {
    throw new Error('--min-unique-frame-ratio must be a finite number between 0 and 1')
  }

  const ffmpegPath = args.ffmpegPath ?? process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = args.ffprobePath ?? process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'

  const report = await analyzeRecording(args.file, {
    ffmpegPath,
    ffprobePath,
    intendedFps: Number.isFinite(args.intendedFps) ? args.intendedFps : undefined,
    expectAudio: args.expectAudio,
    gates: Object.keys(args.gates).length > 0 ? args.gates : undefined
  })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMarkdownReport(report))
  }

  if (!args.noReport) {
    const { jsonPath, mdPath } = writeReports(report, { outDir: args.outDir })
    if (!args.json) {
      console.log(`\nReports written:\n  ${mdPath}\n  ${jsonPath}`)
    }
  }

  process.exit(report.verdict.pass ? 0 : 1)
}

main().catch((error) => {
  console.error(`analyze-recording failed: ${error.message}`)
  process.exit(2)
})
