import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { arch, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  openh264ComparisonArgs,
  openh264ComparisonCases,
  measureOpenh264Comparison
} from './lib/windows-openh264-comparison.mjs'

import {
  runOwnedPcmEof,
  ownedPcmEofAggregate,
  runIndependentToneEof,
  independentToneEofAggregate
} from './lib/windows-owned-pcm-eof.mjs'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const options = {}
while (argv.length) {
  const name = argv.shift(),
    value = argv.shift()
  if (
    ![
      '--ffmpeg',
      '--ffprobe',
      '--output',
      '--eof-stability-passes',
      '--tone-eof-stability-passes'
    ].includes(name) ||
    !value ||
    value.startsWith('--')
  )
    throw new Error(
      'Expected a tool path, output path or EOF stability-pass option followed by a value'
    )
  options[name] = value
}
const eofStabilityPasses = Number(options['--eof-stability-passes'] ?? '1')
if (!Number.isInteger(eofStabilityPasses) || eofStabilityPasses < 1 || eofStabilityPasses > 25)
  throw new Error('EOF stability passes must be an integer from 1 through 25')
const toneEofStabilityPasses = Number(options['--tone-eof-stability-passes'] ?? '0')
if (
  !Number.isInteger(toneEofStabilityPasses) ||
  toneEofStabilityPasses < 0 ||
  toneEofStabilityPasses > 25
)
  throw new Error('Tone EOF comparison passes must be an integer from 0 through 25')
const ffmpeg = resolve(options['--ffmpeg'] ?? 'vendor/ffmpeg/windows-x64/bin/ffmpeg.exe')
const ffprobe = resolve(options['--ffprobe'] ?? join(dirname(ffmpeg), 'ffprobe.exe'))
if (!options['--output']) throw new Error('A new --output directory is required')
const output = resolve(options['--output'])
if (existsSync(output)) throw new Error('Refusing to replace existing comparison evidence')
mkdirSync(output, { recursive: true, mode: 0o700 })
const inputs = mkdtempSync(join(tmpdir(), 'videorc-openh264-inputs-'))
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const report = {
  schemaVersion: 1,
  kind: 'videorc.openh264-skip-comparison',
  qualification:
    'Standalone synthetic FFmpeg diagnostic; no hardware, backend or release qualification',
  platform: platform(),
  osRelease: release(),
  architecture: arch(),
  generatedAt: new Date().toISOString(),
  ffmpeg: { path: ffmpeg },
  ffprobe: { path: ffprobe },
  quality: {
    state: 'not-measured',
    reason:
      'No PSNR/SSIM or perceptual qualification; frame count, tail and rate are diagnostic measurements'
  },
  cases: [],
  measurementComplete: false,
  error: null
}
function save() {
  const pending = join(output, 'report.pending.json')
  writeFileSync(pending, JSON.stringify(report, null, 2))
  renameSync(pending, join(output, 'report.json'))
}
function run(executable, args) {
  const start = performance.now()
  const child = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 60000,
    killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  })
  const evidence = {
    executable,
    argv: args,
    exitCode: child.status,
    signal: child.signal,
    wallMs: performance.now() - start,
    stderr: (child.stderr ?? '').slice(-64000)
  }
  if (child.error || child.status !== 0)
    throw Object.assign(
      new Error(`Bounded tool invocation failed: ${child.error?.message ?? child.status}`),
      { evidence }
    )
  return { evidence, stdout: child.stdout }
}
try {
  report.ffmpeg.sha256 = hash(ffmpeg)
  report.ffprobe.sha256 = hash(ffprobe)
  report.ffmpeg.version = run(ffmpeg, ['-version']).stdout.split(/\r?\n/)[0]
  report.ffprobe.version = run(ffprobe, ['-version']).stdout.split(/\r?\n/)[0]
  save()
  for (const profile of openh264ComparisonCases) {
    const id = `${profile.width}x${profile.height}-${profile.content}`
    const video = join(inputs, `${id}.yuv`),
      audio = join(inputs, `${id}.f32le`)
    const source =
      `testsrc2=size=${profile.width}x${profile.height}:rate=${profile.fps}:duration=${profile.seconds}` +
      (profile.content === 'terminal-noise'
        ? ",noise=alls=40:allf=t+u:all_seed=67:enable='gte(t,2.5)'"
        : '')
    const row = { id, profile, inputs: null, attempts: [] }
    report.cases.push(row)
    save()
    const videoGeneration = run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      source,
      '-pix_fmt',
      'yuv420p',
      '-f',
      'rawvideo',
      video
    ])
    const audioGeneration = run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${profile.seconds}`,
      '-ac',
      '2',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      audio
    ])
    const videoBytes = statSync(video).size
    const audioBytes = statSync(audio).size
    if (
      videoBytes !== profile.width * profile.height * 1.5 * profile.fps * profile.seconds ||
      audioBytes !== 48000 * 2 * 4 * profile.seconds
    )
      throw new Error('Generated finite input size does not match the declared frame/sample count')
    row.inputs = {
      videoBytes,
      audioBytes,
      expectedVideoFrames: profile.fps * profile.seconds,
      expectedAudioFrames: 48000 * profile.seconds,
      videoSha256: hash(video),
      audioSha256: hash(audio),
      videoGeneration: videoGeneration.evidence,
      audioGeneration: audioGeneration.evidence,
      rawFilesRetained: false
    }
    save()
    for (const skip of [1, 0]) {
      const media = join(output, `${id}-skip${skip}.flv`)
      const attempt = { skip, output: media, completed: false }
      row.attempts.push(attempt)
      save()
      try {
        const encoded = run(ffmpeg, openh264ComparisonArgs(profile, skip, video, audio, media))
        attempt.process = encoded.evidence
        const probe = run(ffprobe, [
          '-v',
          'error',
          '-show_entries',
          'packet=codec_type,pts_time,duration_time,size',
          '-of',
          'json',
          media
        ])
        attempt.probe = probe.evidence
        attempt.metrics = measureOpenh264Comparison(
          profile,
          JSON.parse(probe.stdout).packets,
          encoded.evidence.wallMs
        )
        attempt.sha256 = hash(media)
        attempt.completed = true
        save()
      } catch (error) {
        attempt.error = error.message
        attempt.failureProcess = error.evidence ?? null
        save()
        // Preserve the independent peer even if the first skip setting fails.
      }
    }
    rmSync(video)
    rmSync(audio)
  }
  report.ownedPcmEof = []
  const baselines = new Map()
  for (let pass = 0; pass <= eofStabilityPasses; pass++) {
    for (const initialAudioDelayMs of [0, 600]) {
      const keepAudioAlive = pass > 0
      const directory = join(output, `owned-pcm-pass${pass}-delay${initialAudioDelayMs}`)
      mkdirSync(directory, { mode: 0o700 })
      const row = { pass, initialAudioDelayMs, keepAudioAlive, state: 'running' }
      report.ownedPcmEof.push(row)
      save()
      Object.assign(
        row,
        await runOwnedPcmEof({
          ffmpeg,
          ffprobe,
          output: directory,
          queuedAudioMs: initialAudioDelayMs,
          initialAudioDelayMs,
          keepAudioAlive
        }),
        { state: 'complete' }
      )
      if (!keepAudioAlive) baselines.set(initialAudioDelayMs, row)
      else {
        const baseline = baselines.get(initialAudioDelayMs)
        row.firstOutputDeltaFromEarlyEofMs =
          Number.isFinite(row.firstOutputMs) && Number.isFinite(baseline.firstOutputMs)
            ? row.firstOutputMs - baseline.firstOutputMs
            : null
        row.stopDeltaFromEarlyEofMs =
          Number.isFinite(row.stopMs) && Number.isFinite(baseline.stopMs)
            ? row.stopMs - baseline.stopMs
            : null
      }
      save()
      if (row.unsafeCleanup || row.cancelled)
        throw new Error(
          'Owned PCM probe cancelled or cleanup incomplete; refusing further processes'
        )
    }
  }
  report.ownedPcmEofVerdict = ownedPcmEofAggregate(report.ownedPcmEof, eofStabilityPasses)
  report.independentToneEof = []
  // Opt-in causal experiment, not a shipping input policy. Retain the unpaced
  // baseline and every paced attempt; a shorter tail alone is not a pass.
  for (let pass = 0; toneEofStabilityPasses > 0 && pass <= toneEofStabilityPasses; pass++) {
    const directory = join(output, `independent-tone-pass${pass}`)
    mkdirSync(directory, { mode: 0o700 })
    const row = { pass, paceTone: pass > 0, state: 'running' }
    report.independentToneEof.push(row)
    save()
    Object.assign(
      row,
      await runIndependentToneEof({
        ffmpeg,
        ffprobe,
        output: directory,
        paceTone: pass > 0
      }),
      { state: 'complete' }
    )
    save()
    if (row.unsafeCleanup || row.cancelled)
      throw new Error(
        'Independent tone probe cancelled or cleanup incomplete; refusing further processes'
      )
  }
  report.independentToneEofVerdict =
    toneEofStabilityPasses > 0
      ? independentToneEofAggregate(report.independentToneEof, toneEofStabilityPasses)
      : { pass: false, state: 'NOT_REQUESTED' }
  report.measurementComplete =
    report.cases.length === openh264ComparisonCases.length &&
    report.cases.every(
      (row) => row.attempts.length === 2 && row.attempts.every((attempt) => attempt.completed)
    )
  report.measurementComplete &&= report.ownedPcmEof.every(
    (row) =>
      row.childReaped && row.exitCode === 0 && Number.isFinite(row.packetTail?.tailMismatchMs)
  )
  report.measurementComplete &&= report.independentToneEof.every(
    (row) =>
      row.childReaped && row.exitCode === 0 && Number.isFinite(row.packetTail?.tailMismatchMs)
  )
  if (
    !report.measurementComplete ||
    !report.ownedPcmEofVerdict.pass ||
    (toneEofStabilityPasses > 0 && !report.independentToneEofVerdict.pass)
  ) {
    report.error = 'Paired measurement, owned PCM or independent tone EOF regression failed'
    process.exitCode = 1
  }
} catch (error) {
  report.error = error.message
  report.failureProcess = error.evidence ?? null
  process.exitCode = 1
} finally {
  save()
  rmSync(inputs, { recursive: true, force: true })
}
console.log(
  JSON.stringify({ output, measurementComplete: report.measurementComplete, error: report.error })
)
