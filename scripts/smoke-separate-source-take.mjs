#!/usr/bin/env node
// Separate source recordings take gate (plan 157).
//
// Given the Combined file of a take recorded with "Separate source recordings"
// on, this finds the Screen and Camera siblings beside it, probes all three,
// runs the honest recording analyzer on each, and judges the take as a whole:
// every role present, one video + one audio stream each on the recording
// canvas, the audio track each role promises (System audio on Screen,
// Microphone on Camera, Mix on Combined; a swapped pairing fails), and no
// duration drift between the files. Exits non-zero on any failure.
//
//   node scripts/smoke-separate-source-take.mjs <combined-file> [options]
//
// Options:
//   --width <n> --height <n> --fps <n>
//                        The recording canvas every file must match. Defaults
//                        to the Combined file's own video stream.
//   --roles <a,b,c>      Roles the session armed (default combined,screen,camera).
//   --no-analyze         Skip the per-file analyzer passes (probe-only gates).
//   --no-motion          Analyzer: treat freezes as warnings (static desktops).
//   --max-spread-seconds <n>
//                        Allowed duration spread between files (default 1.0).
//   --ffmpeg <path> / --ffprobe <path>
//                        Binaries (or VIDEORC_SMOKE_FFMPEG_PATH / _FFPROBE_PATH).
//
// The dev app has no camera TCC grant, so a take can only be recorded through
// the packaged app; run this against that recording as device acceptance.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { analyzeRecording } from './lib/recording-analyzer.mjs'
import {
  DEFAULT_TAKE_GATES,
  TAKE_ROLES,
  evaluateTake,
  summarizeRoleProbe,
  takeSiblingPaths
} from './lib/separate-source-take-gates.mjs'

function parseArgs(argv) {
  const args = { roles: [...TAKE_ROLES], analyze: true, requireMotion: true, gates: {} }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    switch (arg) {
      case '--width':
        args.width = Number(next())
        break
      case '--height':
        args.height = Number(next())
        break
      case '--fps':
        args.fps = Number(next())
        break
      case '--roles':
        args.roles = String(next())
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean)
        break
      case '--no-analyze':
        args.analyze = false
        break
      case '--no-motion':
        args.requireMotion = false
        break
      case '--max-spread-seconds':
        args.gates.maxDurationSpreadSeconds = Number(next())
        break
      case '--ffmpeg':
        args.ffmpegPath = next()
        break
      case '--ffprobe':
        args.ffprobePath = next()
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
        positionals.push(arg)
    }
  }
  args.combinedPath = positionals[0]
  return args
}

function run(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdout += text
    })
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', (code) => resolveRun({ status: code ?? 1, stdout, stderr }))
  })
}

async function probeRaw(filePath, ffprobePath) {
  if (!existsSync(filePath)) return null
  const { status, stdout, stderr } = await run(ffprobePath, [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    filePath
  ])
  if (status !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${stderr.trim()}`)
  }
  return JSON.parse(stdout)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.combinedPath) {
    console.log(
      'usage: node scripts/smoke-separate-source-take.mjs <combined-file> [--width n --height n --fps n] [--roles a,b] [--no-analyze] [--no-motion]'
    )
    process.exit(args.help ? 0 : 2)
  }
  const ffmpegPath = args.ffmpegPath ?? process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = args.ffprobePath ?? process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'

  const paths = takeSiblingPaths(args.combinedPath)
  const summaries = {}
  for (const role of TAKE_ROLES) {
    summaries[role] = summarizeRoleProbe(await probeRaw(paths[role], ffprobePath))
    const summary = summaries[role]
    console.log(
      summary
        ? `${role.padEnd(8)} ${paths[role]}  ${summary.width}x${summary.height}@${summary.fps.toFixed(2)}  ${summary.durationSeconds.toFixed(2)}s  audio=${summary.audioTitle ?? 'untitled'}`
        : `${role.padEnd(8)} ${paths[role]}  (missing)`
    )
  }

  const canvasSource = summaries.combined ?? summaries.screen ?? summaries.camera
  const video =
    args.width && args.height
      ? { width: args.width, height: args.height, fps: args.fps ?? canvasSource?.fps ?? 0 }
      : canvasSource
        ? { width: canvasSource.width, height: canvasSource.height, fps: canvasSource.fps }
        : null

  const verdict = evaluateTake(
    summaries,
    { roles: args.roles, video },
    { ...DEFAULT_TAKE_GATES, ...args.gates }
  )
  const failures = [...verdict.failures]
  const warnings = [...verdict.warnings]

  if (args.analyze) {
    for (const role of args.roles) {
      if (!summaries[role]) continue
      const report = await analyzeRecording(paths[role], {
        ffmpegPath,
        ffprobePath,
        expectAudio: true,
        intendedFps: video?.fps || undefined,
        gates: { requireMotion: args.requireMotion }
      })
      for (const failure of report.verdict.failures) {
        failures.push(`${role}: ${failure}`)
      }
      for (const warning of report.verdict.warnings) {
        warnings.push(`${role}: ${warning}`)
      }
      console.log(`${role.padEnd(8)} analyzer ${report.verdict.pass ? 'pass' : 'FAIL'}`)
    }
  }

  for (const warning of warnings) console.log(`warning: ${warning}`)
  for (const failure of failures) console.error(`failure: ${failure}`)
  if (failures.length > 0) {
    console.error(`separate source take FAILED (${failures.length} failure(s))`)
    process.exit(1)
  }
  console.log('separate source take OK')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
