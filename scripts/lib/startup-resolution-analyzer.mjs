// Startup-resolution analyzer.
//
// This is the first-2-seconds gate from the OBS parity polish plan. It inspects
// the decoded artifact, not the live preview proxy, so it can prove whether the
// recorded file starts at the intended output size/layout before we touch the
// deeper startup barrier.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  maxConsecutiveRun,
  parseFramemd5,
  probeMedia,
} from './recording-analyzer.mjs'

export const DEFAULT_STARTUP_GATES = Object.freeze({
  requireMotion: true,
  seconds: 2,
  frameLimit: 60,
  maxRepeatedFrameRun: 2,
  minFrameCoverage: 0.9,
  blackFramePercent: 98,
  blackFrameThreshold: 32,
})

export function startupReportBaseName(file) {
  return basename(file.replaceAll('\\', '/')).replace(/\.[^.]+$/, '')
}

// ---------------------------------------------------------------------------
// Pure parsers / evaluators
// ---------------------------------------------------------------------------

export function parseBlackframe(stderr) {
  const frames = []
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.includes('Parsed_blackframe')) continue
    const frame = parseTaggedNumber(line, 'frame')
    const pblack = parseTaggedNumber(line, 'pblack')
    const time = parseTaggedNumber(line, 't')
    if (frame != null || pblack != null) {
      frames.push({ frame, pblack, time })
    }
  }
  return frames
}

export function parseCropdetect(stderr) {
  const crops = []
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(/\bcrop=(\d+):(\d+):(\d+):(\d+)\b/)
    if (!match) continue
    crops.push({
      width: Number(match[1]),
      height: Number(match[2]),
      x: Number(match[3]),
      y: Number(match[4]),
    })
  }
  return crops
}

export function normalizeStartupFrames(ffprobeJson, fallback = {}) {
  const raw = typeof ffprobeJson === 'string' ? JSON.parse(ffprobeJson) : ffprobeJson
  const frames = Array.isArray(raw.frames) ? raw.frames : []
  return frames.map((frame, index) => ({
    index,
    time:
      parseMaybeFloat(frame.best_effort_timestamp_time) ??
      parseMaybeFloat(frame.pkt_pts_time) ??
      parseMaybeFloat(frame.pts_time),
    width: parseMaybeInt(frame.width) ?? fallback.width ?? null,
    height: parseMaybeInt(frame.height) ?? fallback.height ?? null,
    pictType: frame.pict_type ?? null,
  }))
}

export function summarizeDimensionRuns(frames) {
  const runs = []
  for (const frame of frames) {
    const previous = runs[runs.length - 1]
    if (previous && previous.width === frame.width && previous.height === frame.height) {
      previous.endIndex = frame.index
      previous.endTime = frame.time
      previous.count += 1
      continue
    }
    runs.push({
      startIndex: frame.index,
      endIndex: frame.index,
      startTime: frame.time,
      endTime: frame.time,
      width: frame.width,
      height: frame.height,
      count: 1,
    })
  }
  return runs
}

export function evaluateStartupGates(metrics, gates = DEFAULT_STARTUP_GATES) {
  const failures = []
  const warnings = []

  if (!metrics.hasVideo) {
    failures.push('no video stream in the recording')
  }

  if (metrics.expectedWidth != null && metrics.metadataWidth !== metrics.expectedWidth) {
    failures.push(
      `metadata width ${metrics.metadataWidth ?? 'n/a'} does not match expected ${metrics.expectedWidth}`
    )
  }
  if (metrics.expectedHeight != null && metrics.metadataHeight !== metrics.expectedHeight) {
    failures.push(
      `metadata height ${metrics.metadataHeight ?? 'n/a'} does not match expected ${metrics.expectedHeight}`
    )
  }

  if (metrics.expectedStartupFrames != null && metrics.expectedStartupFrames > 0) {
    const minimum = Math.ceil(metrics.expectedStartupFrames * gates.minFrameCoverage)
    if ((metrics.startupFrameCount ?? 0) < minimum) {
      failures.push(
        `startup decoded ${metrics.startupFrameCount ?? 0} frame(s), below ${minimum} required for ` +
          `${metrics.expectedStartupFrames} expected startup frame(s)`
      )
    }
  } else if ((metrics.startupFrameCount ?? 0) === 0 && metrics.hasVideo) {
    failures.push('no decoded video frames found in the startup window')
  }

  if ((metrics.dimensionMismatchCount ?? 0) > 0) {
    failures.push(
      `${metrics.dimensionMismatchCount} startup frame(s) decoded at the wrong dimensions`
    )
  }

  if (metrics.maxRepeatedFrameRun != null && metrics.maxRepeatedFrameRun > gates.maxRepeatedFrameRun) {
    const message =
      `startup repeated-frame burst of ${metrics.maxRepeatedFrameRun} consecutive identical frames ` +
      `exceeds ${gates.maxRepeatedFrameRun}`
    if (gates.requireMotion === false) {
      warnings.push(`${message} — motion not required for this run; inspect startup dimensions and live source readiness`)
    } else {
      failures.push(message)
    }
  }

  if ((metrics.previewSizedFrameCount ?? 0) > 0) {
    failures.push(
      `${metrics.previewSizedFrameCount} startup frame(s) matched the known preview size ` +
        `${metrics.previewWidth}x${metrics.previewHeight}`
    )
  }

  if ((metrics.blackFrameCount ?? 0) > 0) {
    warnings.push(
      `${metrics.blackFrameCount} near-black startup frame(s) detected; inspect the thumbnail sheet`
    )
  }

  if ((metrics.letterboxCandidateCount ?? 0) > 0) {
    warnings.push(
      `${metrics.letterboxCandidateCount} cropdetect sample(s) suggest possible letterbox/pillarbox borders`
    )
  }

  if (metrics.syntheticEvidence == null) {
    warnings.push(
      'synthetic-frame detection from pixels is inconclusive; use encoderBridgeSyntheticFrames diagnostics for proof'
    )
  } else if (metrics.syntheticEvidence > 0) {
    failures.push(`${metrics.syntheticEvidence} synthetic filler frame(s) reported by live diagnostics`)
  }

  return { pass: failures.length === 0, failures, warnings }
}

function parseTaggedNumber(line, key) {
  const match = line.match(new RegExp(`\\b${key}:([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\b`))
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function parseMaybeFloat(value) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseMaybeInt(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function maybeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function expectedStartupFrameCount({ fps, seconds, frameLimit }) {
  if (!Number.isFinite(fps) || fps <= 0) return null
  return Math.min(frameLimit, Math.round(fps * seconds))
}

function dimensionTarget(options, probe) {
  const expectedWidth = maybeNumber(options.expectedWidth)
  const expectedHeight = maybeNumber(options.expectedHeight)
  return {
    width: expectedWidth ?? probe.video?.width ?? null,
    height: expectedHeight ?? probe.video?.height ?? null,
  }
}

function frameEvidence(frame, hashes) {
  return {
    index: frame.index,
    time: frame.time,
    width: frame.width,
    height: frame.height,
    pictType: frame.pictType,
    hash: hashes[frame.index] ?? null,
  }
}

// ---------------------------------------------------------------------------
// Process runners
// ---------------------------------------------------------------------------

function run(command, args, { maxBufferMb = 128 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const cap = maxBufferMb * 1024 * 1024
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdoutBytes += text.length
      if (stdoutBytes <= cap) stdout += text
    })
    child.stderr.on('data', (text) => {
      stderrBytes += text.length
      if (stderrBytes <= cap) stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', (code) => resolveRun({ status: code ?? 1, stdout, stderr }))
  })
}

export async function runStartupFrameProbe(filePath, { ffprobePath = 'ffprobe', seconds = DEFAULT_STARTUP_GATES.seconds, fallback = {} } = {}) {
  const { status, stdout, stderr } = await run(ffprobePath, [
    '-v',
    'error',
    '-read_intervals',
    `0%+${seconds}`,
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=best_effort_timestamp_time,pkt_pts_time,pts_time,width,height,pict_type',
    '-of',
    'json',
    filePath,
  ])
  if (status !== 0) {
    throw new Error(`ffprobe startup frame probe failed for ${filePath}: ${stderr.trim()}`)
  }
  return normalizeStartupFrames(stdout, fallback)
}

export async function runStartupFramemd5(filePath, { ffmpegPath = 'ffmpeg', frameLimit = DEFAULT_STARTUP_GATES.frameLimit } = {}) {
  const { status, stdout, stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-an',
    '-map',
    '0:v:0',
    '-frames:v',
    String(frameLimit),
    '-f',
    'framemd5',
    '-',
  ])
  if (status !== 0 && stdout === '') {
    throw new Error(`startup framemd5 failed for ${filePath}: ${stderr.trim()}`)
  }
  return parseFramemd5(stdout)
}

export async function runStartupBlackframe(filePath, { ffmpegPath = 'ffmpeg', frameLimit = DEFAULT_STARTUP_GATES.frameLimit, amount = DEFAULT_STARTUP_GATES.blackFramePercent, threshold = DEFAULT_STARTUP_GATES.blackFrameThreshold } = {}) {
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-an',
    '-map',
    '0:v:0',
    '-frames:v',
    String(frameLimit),
    '-vf',
    `blackframe=amount=${amount}:threshold=${threshold}`,
    '-f',
    'null',
    '-',
  ])
  return parseBlackframe(stderr)
}

export async function runStartupCropdetect(filePath, { ffmpegPath = 'ffmpeg', frameLimit = DEFAULT_STARTUP_GATES.frameLimit } = {}) {
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-an',
    '-map',
    '0:v:0',
    '-frames:v',
    String(frameLimit),
    '-vf',
    'cropdetect=limit=24/255:round=2:reset=0:skip=0',
    '-f',
    'null',
    '-',
  ])
  return parseCropdetect(stderr)
}

export async function writeStartupThumbnailSheet(report, { ffmpegPath = 'ffmpeg', outDir } = {}) {
  const dir = outDir ?? dirname(report.file)
  mkdirSync(dir, { recursive: true })
  const base = startupReportBaseName(report.file)
  const imagePath = join(dir, `${base}.startup-thumbnails.jpg`)
  const columns = 10
  const rows = Math.ceil(report.metrics.hashes.length / columns) || 1
  const filter = `select='lt(n,${report.metrics.hashes.length})',scale=320:-1,tile=${columns}x${rows}:padding=2:margin=2`
  const { status, stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-y',
    '-i',
    report.file,
    '-an',
    '-map',
    '0:v:0',
    '-vf',
    filter,
    '-frames:v',
    '1',
    imagePath,
  ])
  if (status !== 0) {
    throw new Error(`startup thumbnail sheet failed for ${report.file}: ${stderr.trim()}`)
  }
  return imagePath
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function analyzeStartupResolution(filePath, options = {}) {
  if (!existsSync(filePath)) {
    throw new Error(`recording not found: ${filePath}`)
  }
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  const ffprobePath = options.ffprobePath ?? 'ffprobe'
  const gates = { ...DEFAULT_STARTUP_GATES, ...(options.gates ?? {}) }
  const seconds = maybeNumber(options.seconds) ?? gates.seconds
  const frameLimit = maybeNumber(options.frameLimit) ?? gates.frameLimit

  const fileBytes = statSync(filePath).size
  const probe = await probeMedia(filePath, { ffprobePath })
  const hasVideo = probe.video != null
  const target = dimensionTarget(options, probe)
  const intendedFps = maybeNumber(options.intendedFps) ?? probe.video?.nominalFps ?? probe.video?.avgFps ?? null
  const expectedFrames = expectedStartupFrameCount({ fps: intendedFps, seconds, frameLimit })

  const [frames, hashes, blackFrames, crops] = await Promise.all([
    hasVideo ? runStartupFrameProbe(filePath, { ffprobePath, seconds, fallback: { width: probe.video?.width, height: probe.video?.height } }) : [],
    hasVideo ? runStartupFramemd5(filePath, { ffmpegPath, frameLimit }) : [],
    hasVideo ? runStartupBlackframe(filePath, { ffmpegPath, frameLimit, amount: gates.blackFramePercent, threshold: gates.blackFrameThreshold }) : [],
    hasVideo ? runStartupCropdetect(filePath, { ffmpegPath, frameLimit }) : [],
  ])

  const dimensionMismatches = frames.filter(
    (frame) =>
      target.width != null &&
      target.height != null &&
      (frame.width !== target.width || frame.height !== target.height)
  )
  const previewWidth = maybeNumber(options.previewWidth) ?? 640
  const previewHeight = maybeNumber(options.previewHeight) ?? 360
  const previewSizedFrames = frames.filter((frame) => frame.width === previewWidth && frame.height === previewHeight)
  const repeated = maxConsecutiveRun(hashes, gates.maxRepeatedFrameRun)
  const letterboxCandidates = crops.filter((crop) => {
    if (target.width == null || target.height == null) return false
    return crop.width <= target.width * 0.96 || crop.height <= target.height * 0.96
  })
  const dimensionRuns = summarizeDimensionRuns(frames)
  const startupFrameManifest = frames.map((frame) => frameEvidence(frame, hashes))

  const metrics = {
    fileBytes,
    hasVideo,
    expectedWidth: maybeNumber(options.expectedWidth),
    expectedHeight: maybeNumber(options.expectedHeight),
    metadataWidth: probe.video?.width ?? null,
    metadataHeight: probe.video?.height ?? null,
    targetWidth: target.width,
    targetHeight: target.height,
    intendedFps,
    seconds,
    frameLimit,
    expectedStartupFrames: expectedFrames,
    startupFrameCount: frames.length,
    hashCount: hashes.length,
    hashes,
    startupFrameManifest,
    firstStartupFrame: frames[0] ? frameEvidence(frames[0], hashes) : null,
    dimensionRuns,
    dimensionMismatchSamples: dimensionMismatches.slice(0, 10).map((frame) => frameEvidence(frame, hashes)),
    previewSizedFrameSamples: previewSizedFrames.slice(0, 10).map((frame) => frameEvidence(frame, hashes)),
    maxRepeatedFrameRun: hasVideo ? repeated.maxRun : null,
    repeatedBurstCount: repeated.bursts.length,
    dimensionMismatchCount: dimensionMismatches.length,
    previewWidth,
    previewHeight,
    previewSizedFrameCount: previewSizedFrames.length,
    blackFrameCount: blackFrames.length,
    letterboxCandidateCount: letterboxCandidates.length,
    syntheticEvidence: options.syntheticEvidence ?? null,
  }

  const verdict = evaluateStartupGates(metrics, gates)

  return {
    file: filePath,
    analyzedAtIso: new Date().toISOString(),
    gates,
    verdict,
    metrics,
    probe,
    findings: {
      frames,
      dimensionMismatches,
      repeatedBursts: repeated.bursts,
      blackFrames,
      cropdetect: crops,
      letterboxCandidates,
      previewSizedFrames,
    },
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(value, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function fmtBytes(value) {
  if (typeof value !== 'number') return 'n/a'
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function fmtFrameTime(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(3)}s` : 'n/a'
}

function fmtFrameEvidence(frame) {
  return (
    `frame ${frame.index} @ ${fmtFrameTime(frame.time)} ` +
    `${frame.width ?? 'n/a'}x${frame.height ?? 'n/a'} ` +
    `${frame.pictType ?? 'unknown'} hash ${frame.hash ?? 'n/a'}`
  )
}

function fmtDimensionRun(run) {
  const frameRange = run.startIndex === run.endIndex ? `${run.startIndex}` : `${run.startIndex}-${run.endIndex}`
  return (
    `frames ${frameRange} (${run.count}): ${run.width ?? 'n/a'}x${run.height ?? 'n/a'} ` +
    `${fmtFrameTime(run.startTime)}-${fmtFrameTime(run.endTime)}`
  )
}

function fmtManifestFrame(frame) {
  const size = `${frame.width ?? 'n/a'}x${frame.height ?? 'n/a'}`
  const hash = frame.hash ? `\`${frame.hash}\`` : 'n/a'
  return `| ${frame.index} | ${fmtFrameTime(frame.time)} | ${size} | ${frame.pictType ?? 'unknown'} | ${hash} |`
}

export function renderStartupMarkdownReport(report) {
  const { metrics: m, verdict } = report
  const lines = []
  lines.push('# Recording Startup Resolution Report')
  lines.push('')
  lines.push(`- File: \`${report.file}\``)
  lines.push(`- Analyzed: ${report.analyzedAtIso}`)
  lines.push(`- Verdict: **${verdict.pass ? 'PASS' : 'FAIL'}**`)
  lines.push(`- Startup window: first ${fmt(m.seconds, 2)}s / max ${m.frameLimit} frame(s)`)
  lines.push('')
  if (verdict.failures.length > 0) {
    lines.push('## Gate failures')
    lines.push('')
    for (const failure of verdict.failures) lines.push(`- FAIL: ${failure}`)
    lines.push('')
  }
  if (verdict.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const warning of verdict.warnings) lines.push(`- WARN: ${warning}`)
    lines.push('')
  }
  lines.push('## Metrics')
  lines.push('')
  lines.push(`- File size: ${fmtBytes(m.fileBytes)}`)
  lines.push(`- Metadata resolution: ${m.metadataWidth ?? 'n/a'}x${m.metadataHeight ?? 'n/a'}`)
  lines.push(`- Expected resolution: ${m.expectedWidth ?? 'not provided'}x${m.expectedHeight ?? 'not provided'}`)
  lines.push(`- Dimension target used: ${m.targetWidth ?? 'n/a'}x${m.targetHeight ?? 'n/a'}`)
  lines.push(`- FPS: intended ${fmt(m.intendedFps, 2)}`)
  lines.push(`- Startup frames: decoded ${m.startupFrameCount} | expected ~${m.expectedStartupFrames ?? 'n/a'} | hashes ${m.hashCount}`)
  lines.push(`- First decoded frame: ${m.firstStartupFrame ? fmtFrameEvidence(m.firstStartupFrame) : 'n/a'}`)
  lines.push(`- Dimension mismatches: ${m.dimensionMismatchCount}`)
  lines.push(`- Repeated frames: max run ${m.maxRepeatedFrameRun ?? 'n/a'} across ${m.repeatedBurstCount} burst(s)`)
  lines.push(`- Preview-sized frames (${m.previewWidth}x${m.previewHeight}): ${m.previewSizedFrameCount}`)
  lines.push(`- Near-black frames: ${m.blackFrameCount}`)
  lines.push(`- Letterbox/pillarbox candidates: ${m.letterboxCandidateCount}`)
  lines.push(`- Synthetic evidence: ${m.syntheticEvidence == null ? 'not available from pixels' : `${m.syntheticEvidence} diagnostic frame(s)`}`)
  lines.push('')
  if (m.dimensionRuns?.length) {
    lines.push('## Startup frame dimensions')
    lines.push('')
    for (const run of m.dimensionRuns) lines.push(`- ${fmtDimensionRun(run)}`)
    lines.push('')
  }
  if (m.dimensionMismatchSamples?.length) {
    lines.push('## Dimension mismatch samples')
    lines.push('')
    for (const frame of m.dimensionMismatchSamples) lines.push(`- ${fmtFrameEvidence(frame)}`)
    lines.push('')
  }
  if (m.previewSizedFrameSamples?.length) {
    lines.push('## Preview-sized frame samples')
    lines.push('')
    for (const frame of m.previewSizedFrameSamples) lines.push(`- ${fmtFrameEvidence(frame)}`)
    lines.push('')
  }
  if (m.startupFrameManifest?.length) {
    lines.push('## Startup frame manifest')
    lines.push('')
    lines.push('| Frame | Time | Size | Type | Hash |')
    lines.push('| ---: | ---: | --- | --- | --- |')
    for (const frame of m.startupFrameManifest) {
      lines.push(fmtManifestFrame(frame))
    }
    lines.push('')
  } else {
    lines.push('## First-frame hashes')
    lines.push('')
    for (const [index, hash] of m.hashes.entries()) {
      lines.push(`- ${index}: \`${hash}\``)
    }
    lines.push('')
  }
  lines.push('## Caveats')
  lines.push('')
  lines.push('- Resolution gates observe the decoded file directly and are hard gates.')
  lines.push('- Repeated-frame gates are hard only when visible motion is required; otherwise they are evidence for inspection.')
  lines.push('- Black-frame and cropdetect signals are evidence for inspection because real screens can be dark or static.')
  lines.push('- Synthetic filler cannot be proven from arbitrary pixels; live diagnostics remain the authoritative synthetic-frame signal.')
  lines.push('')
  return lines.join('\n')
}

export async function writeStartupReports(report, { outDir, ffmpegPath = 'ffmpeg', thumbnails = true } = {}) {
  const dir = outDir ?? dirname(report.file)
  mkdirSync(dir, { recursive: true })
  const base = startupReportBaseName(report.file)
  const jsonPath = join(dir, `${base}.startup.json`)
  const mdPath = join(dir, `${base}.startup.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  let thumbnailPath = null
  if (thumbnails && report.metrics.hashes.length > 0) {
    thumbnailPath = await writeStartupThumbnailSheet(report, { ffmpegPath, outDir: dir })
  }
  const markdown = thumbnailPath
    ? `${renderStartupMarkdownReport(report)}\n## Thumbnail Sheet\n\n![startup thumbnails](${thumbnailPath})\n`
    : renderStartupMarkdownReport(report)
  writeFileSync(mdPath, markdown)
  return { jsonPath, mdPath, thumbnailPath }
}
