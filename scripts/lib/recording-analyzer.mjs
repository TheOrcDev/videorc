// Honest final-file recording analyzer.
//
// Phase 1 of the OBS Quality Root Fix plan: a metric that cannot lie. Given a
// finished recording, this decodes the actual artifact (not a proxy) and judges
// it against the plan's strict OBS-quality gates:
//
//   - no freeze segment above 100ms                  (ffmpeg freezedetect)
//   - no repeated-frame burst above 2 consecutive    (ffmpeg framemd5 exact dupes)
//   - constant/stable frame pacing, frame count ≈ duration × fps  (ffprobe frames)
//   - no audio gap above 20ms                        (audio packet PTS gaps + silencedetect)
//   - A/V skew target 100ms, hard fail above 150ms   (stream start/duration)
//
// The pure parsers are exported separately from the ffmpeg/ffprobe runners so the
// parsing logic is unit-testable without spawning anything, and the runners are
// integration-tested against synthetic fixtures with known ground-truth defects.
//
// Mirrors the proven freezedetect/ffprobe parsing in crates/videorc-backend/src/repair.rs.
// The backend post-recording gate intentionally keeps these strict thresholds in sync
// so app status cannot drift from the artifact analyzer.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  cadenceMismatch,
  classifyFrameRate,
  corroborateFreezes,
  longestSegmentSeconds
} from './frame-cadence.mjs'

/**
 * Strict OBS-quality gates. All thresholds come from the root-fix plan's
 * "Final recording gate" / "Audio gate" sections.
 */
export const DEFAULT_GATES = Object.freeze({
  requireMotion: true, // when false, freeze/exact-repeat segments warn instead of hard-failing
  maxFreezeMs: 100, // no freeze segment above 100ms
  maxRepeatedFrameRun: 2, // no repeated-frame burst above 2 consecutive frames
  maxAudioGapMs: 20, // no audio gap above 20ms
  avSyncTargetMs: 100, // A/V skew target (warn above)
  avSyncHardFailMs: 150, // A/V skew hard fail above
  frameCountTolerance: 0.02, // observed vs expected (duration × fps) frame count
  // Duplicate container PTS = broken timestamping, full stop (plan 023: the
  // split-output wallclock path wrote bursts of frames on IDENTICAL stamps —
  // 353 of them in the owner's 52s file). Tolerate a lone rounding pair.
  maxDuplicatePtsCount: 2, // total near-zero (<1ms) inter-frame deltas allowed
  maxDuplicatePtsRun: 2, // consecutive frames sharing one stamp allowed
  maxDurationStretchRatio: 1.1, // container duration must not stretch far past decoded frames at intended FPS
  freezeNoiseDb: -60, // freezedetect near-identical noise floor (matches repair.rs)
  silenceDb: -50, // silencedetect dropout noise floor
  minSilenceGapMs: 20, // silence run that counts as a candidate dropout
  // Recording colorimetry law (2026-07 quality plan Q1): artifacts must be
  // TAGGED BT.709 video-range. Warn by default (legacy files and third-party
  // callers); the recording matrix smoke sets true to hard-fail.
  requireColorTags: false,
  // Spec-valid H.264 level for the stream's real macroblock rate (Q3). Warn by
  // default; the matrix smoke sets true to hard-fail.
  requireValidLevel: false,
  // Max keyframe interval in seconds (recordings pin a 2s GOP); null disables
  // the check (it decodes frame metadata — the matrix smoke enables it).
  keyframeMaxIntervalSeconds: null,
  // Max A/V stream tail mismatch in ms (stop drain); null keeps the combined
  // avSkew gates as the only sync check.
  maxTailMismatchMs: null,
  // 2026-07 lesson (the "4K feels laggy" incident): freezedetect similarity hits
  // on a person holding still are NOT pipeline freezes. When true, a freeze only
  // hard-fails if exact decoded-frame repeats (framemd5) overlap it; similarity-only
  // segments downgrade to warnings. Set false to restore the raw freezedetect gate.
  freezeRequireCorroboration: true,
  // Container cadence vs intended fps: fail when the file's real rate deviates
  // beyond this from an EXPLICITLY intended rate (e.g. a 23.976p file from a 24p
  // camera HDMI feed against a 30fps session). Only applies when the caller
  // passes intendedFps; the NTSC offset (29.97 vs 30) counts as matching.
  cadenceMismatchTolerancePct: 2
})

// H.264 High-profile level table (label ×10 as ffprobe reports `level`),
// mirrored from crates/videorc-backend/src/h264_profile.rs: (level, MaxFS
// macroblocks, MaxMBPS macroblocks/second).
const H264_LEVELS = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [41, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600]
]

/**
 * Smallest spec-valid H.264 level (ffprobe integer form, e.g. 42) for the
 * stream's dimensions × fps, or null beyond level 5.2.
 */
export function requiredH264Level(width, height, fps) {
  if (!width || !height || !fps) return null
  const frameMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const macroblocksPerSecond = frameMacroblocks * fps
  const row = H264_LEVELS.find(
    ([, maxFs, maxMbps]) => frameMacroblocks <= maxFs && macroblocksPerSecond <= maxMbps
  )
  return row ? row[0] : null
}

// ---------------------------------------------------------------------------
// Pure parsers (no I/O — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Parse FFmpeg freezedetect stderr into freeze segments. Each freeze emits a
 * `freeze_start: T` line followed by a `freeze_duration: D` line.
 * @returns {{start:number, duration:number}[]}
 */
export function parseFreezedetect(stderr) {
  const segments = []
  let pendingStart = null
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim()
    const startIdx = line.indexOf('freeze_start:')
    if (startIdx !== -1) {
      const value = Number.parseFloat(line.slice(startIdx + 'freeze_start:'.length).trim())
      pendingStart = Number.isFinite(value) ? value : null
      continue
    }
    const durIdx = line.indexOf('freeze_duration:')
    if (durIdx !== -1 && pendingStart !== null) {
      const duration = Number.parseFloat(line.slice(durIdx + 'freeze_duration:'.length).trim())
      if (Number.isFinite(duration)) {
        segments.push({ start: pendingStart, duration })
      }
      pendingStart = null
    }
  }
  return segments
}

/**
 * Parse FFmpeg silencedetect stderr into silence segments. `silence_start: T`
 * opens a segment; `silence_end: T | silence_duration: D` closes it.
 * @returns {{start:number, end:number|null, duration:number}[]}
 */
export function parseSilencedetect(stderr) {
  const segments = []
  let pendingStart = null
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim()
    const startIdx = line.indexOf('silence_start:')
    if (startIdx !== -1) {
      const value = Number.parseFloat(line.slice(startIdx + 'silence_start:'.length).trim())
      pendingStart = Number.isFinite(value) ? value : null
      continue
    }
    const endIdx = line.indexOf('silence_end:')
    if (endIdx !== -1 && pendingStart !== null) {
      // The line is e.g. "silence_end: 1.234 | silence_duration: 0.2"
      const tail = line.slice(endIdx + 'silence_end:'.length)
      const end = Number.parseFloat(tail.trim())
      let duration = Number.NaN
      const durIdx = tail.indexOf('silence_duration:')
      if (durIdx !== -1) {
        duration = Number.parseFloat(tail.slice(durIdx + 'silence_duration:'.length).trim())
      }
      if (!Number.isFinite(duration) && Number.isFinite(end)) {
        duration = end - pendingStart
      }
      segments.push({
        start: pendingStart,
        end: Number.isFinite(end) ? end : null,
        duration: Number.isFinite(duration) ? duration : 0
      })
      pendingStart = null
    }
  }
  return segments
}

/**
 * Parse FFmpeg `-f framemd5` stdout into the ordered list of per-frame hashes.
 * Lines beginning with `#` are headers/comments. Data lines look like:
 *   `0,        0,        0,        1,    27648, d41d8cd9...`
 * The last comma-separated field is the frame hash.
 * @returns {string[]}
 */
export function parseFramemd5(stdout) {
  const hashes = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const fields = line.split(',')
    if (fields.length < 2) {
      continue
    }
    hashes.push(fields[fields.length - 1].trim())
  }
  return hashes
}

/**
 * Find the longest run of consecutive identical values and every run longer than
 * `threshold`. A "run" of N identical frames means N−1 repeated frames following
 * the first. We report run length as the count of identical consecutive frames.
 * @returns {{maxRun:number, bursts:{startIndex:number, run:number}[]}}
 */
export function maxConsecutiveRun(values, threshold = 1) {
  let maxRun = values.length > 0 ? 1 : 0
  const bursts = []
  let runStart = 0
  let runLen = values.length > 0 ? 1 : 0
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] === values[i - 1]) {
      runLen += 1
    } else {
      if (runLen > maxRun) maxRun = runLen
      if (runLen > threshold) bursts.push({ startIndex: runStart, run: runLen })
      runStart = i
      runLen = 1
    }
  }
  if (runLen > maxRun) maxRun = runLen
  if (values.length > 0 && runLen > threshold) bursts.push({ startIndex: runStart, run: runLen })
  return { maxRun, bursts }
}

/**
 * Parse a CSV (`-of csv=p=0`) stream of one float per line (e.g. frame pts_time)
 * into a numeric array, skipping non-numeric ("N/A") entries.
 * @returns {number[]}
 */
export function parseCsvFloatColumn(text, column = 0) {
  const values = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const field = line.split(',')[column]
    const value = Number.parseFloat(field)
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/**
 * Frame-pacing statistics from an ordered list of presentation timestamps (s).
 * Detects variable frame rate and the largest inter-frame gap.
 * @returns {{count:number, meanIntervalMs:number|null, maxGapMs:number|null,
 *   jitterMs:number|null, observedFps:number|null}}
 */
export function pacingStats(ptsTimes) {
  const sorted = [...ptsTimes].sort((a, b) => a - b)
  const count = sorted.length
  if (count < 2) {
    return { count, meanIntervalMs: null, maxGapMs: null, jitterMs: null, observedFps: null }
  }
  const intervals = []
  for (let i = 1; i < count; i += 1) intervals.push(sorted[i] - sorted[i - 1])
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length
  const maxGap = Math.max(...intervals)
  const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length
  const span = sorted[count - 1] - sorted[0]
  return {
    count,
    meanIntervalMs: mean * 1000,
    maxGapMs: maxGap * 1000,
    jitterMs: Math.sqrt(variance) * 1000,
    observedFps: span > 0 ? (count - 1) / span : null
  }
}

/**
 * Duplicate-PTS statistics: container video packets stacked on (near-)identical
 * presentation stamps. Healthy encoders never emit these; wallclock-stamped
 * bursty inputs do (plan 023). `runLength` counts frames sharing one stamp.
 * @returns {{duplicateCount:number, maxDuplicateRun:number}}
 */
export function duplicatePtsStats(ptsTimes, toleranceSeconds = 0.001) {
  const sorted = [...ptsTimes].sort((a, b) => a - b)
  let duplicateCount = 0
  let maxDuplicateRun = 1
  let run = 1
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] <= toleranceSeconds) {
      duplicateCount += 1
      run += 1
      if (run > maxDuplicateRun) maxDuplicateRun = run
    } else {
      run = 1
    }
  }
  return { duplicateCount, maxDuplicateRun }
}

/**
 * Detect gaps between consecutive audio packets: a packet whose presentation time
 * jumps further than its predecessor's duration (plus tolerance) implies missing
 * samples. `packets` is an ordered list of {ptsTime, durationTime}.
 * @returns {{maxGapMs:number, gaps:{at:number, gapMs:number}[]}}
 */
export function audioPtsGaps(packets, toleranceMs = 5) {
  const gaps = []
  let maxGapMs = 0
  for (let i = 1; i < packets.length; i += 1) {
    const prev = packets[i - 1]
    const cur = packets[i]
    if (!Number.isFinite(prev.ptsTime) || !Number.isFinite(cur.ptsTime)) continue
    const expected = Number.isFinite(prev.durationTime) ? prev.durationTime : 0
    const actual = cur.ptsTime - prev.ptsTime
    const gapMs = (actual - expected) * 1000
    if (gapMs > toleranceMs) {
      gaps.push({ at: prev.ptsTime, gapMs })
      if (gapMs > maxGapMs) maxGapMs = gapMs
    }
  }
  return { maxGapMs, gaps }
}

/**
 * A/V skew in ms, preferring stream start-time offset, falling back to a duration
 * mismatch. Mirrors repair.rs::av_skew_ms. This is a coarse container-level signal,
 * NOT measured lip-sync (which needs capture-clock instrumentation).
 * @returns {number|null}
 */
export function avSkewMs(probe) {
  const video = probe.video
  const audio = probe.audio?.[0]
  if (!video || !audio) return null
  // Report the WORSE of the start-time offset and the duration mismatch. A constant audio
  // delay (e.g. the mic starting late) shows up as equal start_times but a shorter audio
  // stream — so trusting start_time alone misses it (real recordings have start_time=0 on
  // both streams yet can be hundreds of ms out of sync).
  let skew = null
  if (Number.isFinite(video.startTime) && Number.isFinite(audio.startTime)) {
    skew = Math.abs(video.startTime - audio.startTime) * 1000
  }
  if (Number.isFinite(video.duration) && Number.isFinite(audio.duration)) {
    // A shorter audio stream can reveal delayed audio when muxing normalized both
    // start times to zero. Audio extending beyond video is only an end-of-file tail;
    // it does not move audio relative to video during their shared content window.
    const delayedAudioSkew = Math.max(video.duration - audio.duration, 0) * 1000
    skew = skew == null ? delayedAudioSkew : Math.max(skew, delayedAudioSkew)
  }
  return skew
}

/**
 * The two components the combined avSkewMs folds together, reported
 * separately: `startSkewMs` (streams begin apart — perceived through the whole
 * file) and `tailMismatchMs` (one stream outlives the other at stop — the
 * uncontrolled-drain signature the 2026-07 audit measured at up to 273ms on
 * 60fps legacy recordings).
 * @returns {{startSkewMs:number|null, tailMismatchMs:number|null}}
 */
export function avSkewComponents(probe) {
  const video = probe.video
  const audio = probe.audio?.[0]
  if (!video || !audio) return { startSkewMs: null, tailMismatchMs: null }
  const startSkewMs =
    Number.isFinite(video.startTime) && Number.isFinite(audio.startTime)
      ? Math.abs(video.startTime - audio.startTime) * 1000
      : null
  const tailMismatchMs =
    Number.isFinite(video.duration) && Number.isFinite(audio.duration)
      ? Math.abs(video.duration - audio.duration) * 1000
      : null
  return { startSkewMs, tailMismatchMs }
}

function parseFraction(value) {
  if (typeof value !== 'string') return null
  const [num, den] = value.split('/')
  const n = Number.parseFloat(num)
  const d = Number.parseFloat(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
  const fps = n / d
  return Number.isFinite(fps) && fps > 0 ? fps : null
}

function parseMaybeFloat(value) {
  const v = Number.parseFloat(value)
  return Number.isFinite(v) ? v : null
}

function parseMaybeInt(value) {
  const v = Number.parseInt(value, 10)
  return Number.isFinite(v) ? v : null
}

/**
 * Normalize ffprobe `-show_format -show_streams -of json` into a compact probe.
 * @returns {{formatDuration:number|null, video:object|null, audio:object[],
 *   encoderTag:string|null}}
 */
export function normalizeProbe(ffprobeJson) {
  const raw = typeof ffprobeJson === 'string' ? JSON.parse(ffprobeJson) : ffprobeJson
  const streams = Array.isArray(raw.streams) ? raw.streams : []
  const videoRaw = streams.find((s) => s.codec_type === 'video')
  const video = videoRaw
    ? {
        codec: videoRaw.codec_name ?? '',
        width: videoRaw.width ?? 0,
        height: videoRaw.height ?? 0,
        avgFps: parseFraction(videoRaw.avg_frame_rate),
        nominalFps: parseFraction(videoRaw.r_frame_rate),
        nbFrames: parseMaybeInt(videoRaw.nb_frames),
        duration: parseMaybeFloat(videoRaw.duration),
        startTime: parseMaybeFloat(videoRaw.start_time),
        pixFmt: videoRaw.pix_fmt ?? null,
        profile: videoRaw.profile ?? null,
        level: parseMaybeInt(videoRaw.level),
        colorSpace: videoRaw.color_space ?? null,
        colorPrimaries: videoRaw.color_primaries ?? null,
        colorTransfer: videoRaw.color_transfer ?? null,
        colorRange: videoRaw.color_range ?? null,
        encoderTag: videoRaw.tags?.encoder ?? null,
        handler: videoRaw.tags?.handler_name ?? null
      }
    : null
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      codec: s.codec_name ?? '',
      channels: s.channels ?? 0,
      channelLayout: s.channel_layout ?? null,
      sampleRate: parseMaybeInt(s.sample_rate),
      duration: parseMaybeFloat(s.duration),
      startTime: parseMaybeFloat(s.start_time)
    }))
  return {
    formatDuration: parseMaybeFloat(raw.format?.duration),
    video,
    audio,
    encoderTag: raw.format?.tags?.encoder ?? video?.encoderTag ?? null
  }
}

// ---------------------------------------------------------------------------
// Gate evaluation (pure)
// ---------------------------------------------------------------------------

/**
 * Apply the gates to a computed metrics object and return pass/fail with reasons.
 * `metrics` carries the numbers produced by the runners below.
 * @returns {{pass:boolean, failures:string[], warnings:string[]}}
 */
export function evaluateGates(metrics, gates = DEFAULT_GATES) {
  const failures = []
  const warnings = []

  if (!metrics.hasVideo) {
    failures.push('no video stream in the recording')
  }

  // Freeze segments. This is a hard gate only when the caller expects visible motion.
  // Real screen/camera baselines can be intentionally static, so they should use the
  // exact repeated-frame and pacing gates for artifact proof while keeping this as evidence.
  //
  // With freezeRequireCorroboration (default), only freezes overlapping exact
  // decoded-frame repeats count as pipeline freezes; similarity-only segments are
  // still content (a person holding still) and warn instead. Callers whose metrics
  // predate the corroboration fields keep the raw freezedetect behavior.
  const corroborationAvailable =
    gates.freezeRequireCorroboration !== false && metrics.longestCorroboratedFreezeMs != null
  const gatedFreezeMs = corroborationAvailable
    ? metrics.longestCorroboratedFreezeMs
    : metrics.longestFreezeMs
  const gatedFreezeCount = corroborationAvailable
    ? metrics.corroboratedFreezeCount
    : metrics.freezeCount
  if (gatedFreezeMs != null && gatedFreezeMs > gates.maxFreezeMs) {
    const message =
      `freeze segment ${gatedFreezeMs.toFixed(0)}ms exceeds ${gates.maxFreezeMs}ms ` +
      `(${gatedFreezeCount} segment(s)${corroborationAvailable ? ', exact-repeat corroborated' : ''})`
    if (gates.requireMotion === false) {
      warnings.push(
        `${message} — motion not required for this run; inspect repeated-frame and pacing gates`
      )
    } else {
      failures.push(message)
    }
  }
  if (
    corroborationAvailable &&
    metrics.similarityOnlyFreezeCount > 0 &&
    metrics.longestSimilarityOnlyFreezeMs > gates.maxFreezeMs
  ) {
    warnings.push(
      `${metrics.similarityOnlyFreezeCount} similarity-only low-motion segment(s) ` +
        `(longest ${metrics.longestSimilarityOnlyFreezeMs.toFixed(0)}ms) with zero exact ` +
        `frame repeats — likely a still subject or static content, not a pipeline freeze`
    )
  }

  // Container cadence vs explicitly intended rate (e.g. a 23.976p file produced by
  // a 24p camera HDMI feed while the session intended 30fps). Names the actionable
  // cause instead of leaving it implied by the frame-count percentage.
  if (metrics.cadenceMismatchPct != null) {
    failures.push(
      `container cadence ${fmt(metrics.cadenceFps, 3)}fps` +
        `${metrics.cadenceLabel ? ` (${metrics.cadenceLabel})` : ''} does not match intended ` +
        `${fmt(metrics.cadenceIntendedFps, 2)}fps (${metrics.cadenceMismatchPct.toFixed(1)}% off) — ` +
        `the source device is likely delivering that rate (check camera HDMI/movie output settings)`
    )
  }

  // Repeated-frame bursts (exact decoded-frame duplicates). Like freezedetect,
  // this is only a hard artifact gate when visible motion is guaranteed.
  if (
    metrics.maxRepeatedFrameRun != null &&
    metrics.maxRepeatedFrameRun > gates.maxRepeatedFrameRun
  ) {
    const message =
      `repeated-frame burst of ${metrics.maxRepeatedFrameRun} consecutive identical frames ` +
      `exceeds ${gates.maxRepeatedFrameRun} (${metrics.repeatedBurstCount} burst(s))`
    if (gates.requireMotion === false) {
      warnings.push(
        `${message} — motion not required for this run; inspect bridge repeat and pacing gates`
      )
    } else {
      failures.push(message)
    }
  }

  // Duplicate container PTS: broken timestamping is a hard fail regardless of
  // motion expectations — stamps are wrong even when the pixels are static.
  if (
    metrics.duplicatePtsCount != null &&
    (metrics.duplicatePtsCount > gates.maxDuplicatePtsCount ||
      (metrics.maxDuplicatePtsRun ?? 1) > gates.maxDuplicatePtsRun)
  ) {
    failures.push(
      `duplicate video PTS: ${metrics.duplicatePtsCount} near-zero inter-frame delta(s), ` +
        `longest same-stamp run ${metrics.maxDuplicatePtsRun} ` +
        `(allowed: ${gates.maxDuplicatePtsCount} total / run of ${gates.maxDuplicatePtsRun}) — ` +
        `frames are being stamped at mux time, not capture time`
    )
  }

  // Frame count vs expected (dropped-frame evidence).
  if (
    metrics.expectedFrames != null &&
    metrics.observedFrames != null &&
    metrics.expectedFrames > 0
  ) {
    const diff = Math.abs(metrics.observedFrames - metrics.expectedFrames)
    const ratio = diff / metrics.expectedFrames
    if (ratio > gates.frameCountTolerance) {
      failures.push(
        `frame count ${metrics.observedFrames} vs expected ~${metrics.expectedFrames} ` +
          `(${(ratio * 100).toFixed(1)}% off, tolerance ${(gates.frameCountTolerance * 100).toFixed(0)}%)`
      )
    }
  }
  if (
    metrics.durationStretchRatio != null &&
    metrics.durationStretchRatio > gates.maxDurationStretchRatio
  ) {
    failures.push(
      `timestamp/duration stretch: container duration ${metrics.durationSeconds.toFixed(2)}s ` +
        `vs ${metrics.frameDerivedDurationSeconds.toFixed(2)}s implied by ` +
        `${metrics.observedFrames} frame(s) at ${metrics.intendedFps}fps ` +
        `(${metrics.durationStretchRatio.toFixed(1)}x, max ${gates.maxDurationStretchRatio.toFixed(1)}x)`
    )
  }

  // Audio gaps (only when audio is expected/present).
  if (metrics.hasAudio) {
    if (metrics.maxAudioGapMs != null && metrics.maxAudioGapMs > gates.maxAudioGapMs) {
      failures.push(
        `audio PTS gap ${metrics.maxAudioGapMs.toFixed(0)}ms exceeds ${gates.maxAudioGapMs}ms`
      )
    }
    if (metrics.longestSilenceMs != null && metrics.longestSilenceMs > gates.minSilenceGapMs) {
      // Silence can be intentional; surface as a warning to inspect, not a hard fail.
      warnings.push(
        `silence segment ${metrics.longestSilenceMs.toFixed(0)}ms detected ` +
          `(${metrics.silenceCount} segment(s)) — verify it is intentional, not a dropout`
      )
    }
  } else if (metrics.expectAudio) {
    failures.push('audio expected but no audio stream present')
  }

  // Colorimetry tags (Q1): untagged output makes every player guess.
  if (metrics.hasVideo) {
    const wrongTags = []
    if (metrics.colorSpace !== 'bt709') wrongTags.push(`color_space=${metrics.colorSpace ?? 'unknown'}`)
    if (metrics.colorPrimaries !== 'bt709') {
      wrongTags.push(`color_primaries=${metrics.colorPrimaries ?? 'unknown'}`)
    }
    if (metrics.colorTransfer !== 'bt709') {
      wrongTags.push(`color_transfer=${metrics.colorTransfer ?? 'unknown'}`)
    }
    if (metrics.colorRange !== 'tv') wrongTags.push(`color_range=${metrics.colorRange ?? 'unknown'}`)
    if (wrongTags.length > 0) {
      const message = `colorimetry not tagged BT.709 video-range: ${wrongTags.join(', ')}`
      if (gates.requireColorTags) {
        failures.push(message)
      } else {
        warnings.push(`${message} — players will guess the color matrix`)
      }
    }
  }

  // H.264 level validity (Q3): the level tag must cover the stream's real
  // macroblock rate or strict decoders/upload validators may reject the file.
  if (metrics.hasVideo && metrics.level != null) {
    const fpsForLevel = metrics.intendedFps ?? metrics.observedFps ?? metrics.avgFps
    const required = requiredH264Level(metrics.width, metrics.height, fpsForLevel)
    if (required != null && metrics.level < required) {
      const message =
        `H.264 level ${(metrics.level / 10).toFixed(1)} below spec minimum ` +
        `${(required / 10).toFixed(1)} for ${metrics.width}x${metrics.height}@${fmt(fpsForLevel, 0)}`
      if (gates.requireValidLevel) {
        failures.push(message)
      } else {
        warnings.push(message)
      }
    }
  }

  // Keyframe cadence (recordings pin a 2s GOP for seekability).
  if (
    gates.keyframeMaxIntervalSeconds != null &&
    metrics.maxKeyframeIntervalSeconds != null &&
    metrics.maxKeyframeIntervalSeconds > gates.keyframeMaxIntervalSeconds
  ) {
    failures.push(
      `keyframe interval ${metrics.maxKeyframeIntervalSeconds.toFixed(2)}s exceeds ` +
        `${gates.keyframeMaxIntervalSeconds}s (${metrics.keyframeCount} keyframe(s) sampled)`
    )
  }

  // Stream tail mismatch (stop drain), separate from the combined skew gate.
  if (
    gates.maxTailMismatchMs != null &&
    metrics.tailMismatchMs != null &&
    metrics.tailMismatchMs > gates.maxTailMismatchMs
  ) {
    failures.push(
      `A/V tail mismatch ${metrics.tailMismatchMs.toFixed(0)}ms exceeds ` +
        `${gates.maxTailMismatchMs}ms — one stream outlives the other at stop`
    )
  }

  // A/V skew.
  if (metrics.avSkewMs != null) {
    if (metrics.avSkewMs > gates.avSyncHardFailMs) {
      failures.push(
        `A/V skew ${metrics.avSkewMs.toFixed(0)}ms exceeds hard-fail ${gates.avSyncHardFailMs}ms`
      )
    } else if (metrics.avSkewMs > gates.avSyncTargetMs) {
      warnings.push(
        `A/V skew ${metrics.avSkewMs.toFixed(0)}ms exceeds target ${gates.avSyncTargetMs}ms ` +
          `(below hard-fail ${gates.avSyncHardFailMs}ms)`
      )
    }
  }

  return { pass: failures.length === 0, failures, warnings }
}

// ---------------------------------------------------------------------------
// Process runners (I/O)
// ---------------------------------------------------------------------------

function run(command, args, { maxBufferMb = 256 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    const cap = maxBufferMb * 1024 * 1024
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdoutBytes += text.length
      if (stdoutBytes <= cap) stdout += text
    })
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', (code) => resolveRun({ status: code ?? 1, stdout, stderr }))
  })
}

export async function probeMedia(filePath, { ffprobePath = 'ffprobe' } = {}) {
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
  return normalizeProbe(stdout)
}

export async function runFreezedetect(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    noiseDb = DEFAULT_GATES.freezeNoiseDb,
    minFreezeMs = DEFAULT_GATES.maxFreezeMs
  } = {}
) {
  const seconds = (minFreezeMs / 1000).toFixed(3)
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-vf',
    `freezedetect=n=${noiseDb}dB:d=${seconds}`,
    '-f',
    'null',
    '-'
  ])
  return parseFreezedetect(stderr)
}

export async function runSilencedetect(
  filePath,
  {
    ffmpegPath = 'ffmpeg',
    noiseDb = DEFAULT_GATES.silenceDb,
    minSilenceMs = DEFAULT_GATES.minSilenceGapMs
  } = {}
) {
  const seconds = (minSilenceMs / 1000).toFixed(3)
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${seconds}`,
    '-f',
    'null',
    '-'
  ])
  return parseSilencedetect(stderr)
}

export async function runFramemd5(filePath, { ffmpegPath = 'ffmpeg' } = {}) {
  const { status, stdout, stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-an',
    '-map',
    '0:v:0',
    '-f',
    'framemd5',
    '-'
  ])
  if (status !== 0 && stdout === '') {
    throw new Error(`framemd5 failed for ${filePath}: ${stderr.trim()}`)
  }
  return parseFramemd5(stdout)
}

export async function runVideoPacing(filePath, { ffprobePath = 'ffprobe' } = {}) {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    filePath
  ])
  return parseCsvFloatColumn(stdout, 0)
}

/**
 * Keyframe presentation times (seconds) from the first `sampleSeconds` of the
 * video stream. Uses packet flags (no decode) so it stays cheap at 4K.
 * @returns {Promise<number[]>}
 */
export async function runKeyframeTimes(filePath, { ffprobePath = 'ffprobe', sampleSeconds = 30 } = {}) {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
    '-of',
    'csv=p=0',
    '-read_intervals',
    `%+${sampleSeconds}`,
    filePath
  ])
  const times = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [pts, flags] = line.split(',')
    if (typeof flags === 'string' && flags.includes('K')) {
      const time = Number.parseFloat(pts)
      if (Number.isFinite(time)) times.push(time)
    }
  }
  return times.sort((a, b) => a - b)
}

/** Longest gap between consecutive keyframes, in seconds. */
export function maxKeyframeInterval(keyframeTimes) {
  let max = null
  for (let i = 1; i < keyframeTimes.length; i += 1) {
    const gap = keyframeTimes[i] - keyframeTimes[i - 1]
    if (max == null || gap > max) max = gap
  }
  return max
}

export async function runAudioPackets(filePath, { ffprobePath = 'ffprobe' } = {}) {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'packet=pts_time,duration_time',
    '-of',
    'csv=p=0',
    filePath
  ])
  const packets = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [pts, dur] = line.split(',')
    packets.push({ ptsTime: Number.parseFloat(pts), durationTime: Number.parseFloat(dur) })
  }
  packets.sort((a, b) => a.ptsTime - b.ptsTime)
  return packets
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Analyze a finished recording against the strict OBS-quality gates.
 *
 * @param {string} filePath
 * @param {object} options
 * @param {string} [options.ffmpegPath]
 * @param {string} [options.ffprobePath]
 * @param {number} [options.intendedFps] - the session's selected fps (for the frame-count gate)
 * @param {boolean} [options.expectAudio] - whether a mic was selected (default: infer from stream)
 * @param {object} [options.gates] - overrides for DEFAULT_GATES
 * @returns {Promise<object>} the full report (verdict + metrics + raw findings)
 */
export async function analyzeRecording(filePath, options = {}) {
  if (!existsSync(filePath)) {
    throw new Error(`recording not found: ${filePath}`)
  }
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg'
  const ffprobePath = options.ffprobePath ?? 'ffprobe'
  const gates = { ...DEFAULT_GATES, ...(options.gates ?? {}) }

  const fileBytes = statSync(filePath).size
  const probe = await probeMedia(filePath, { ffprobePath })
  const hasVideo = probe.video != null
  const hasAudio = probe.audio.length > 0
  const expectAudio = options.expectAudio ?? hasAudio

  // Run the video passes (freeze, exact-dup frames, pacing) and the audio passes
  // (packet gaps, silence) concurrently. A frozen/black source can still produce a
  // technically valid file, so every pass observes the decoded artifact directly.
  const [freezes, frameHashes, ptsTimes, audioPackets, silences, keyframeTimes] =
    await Promise.all([
      hasVideo
        ? runFreezedetect(filePath, {
            ffmpegPath,
            noiseDb: gates.freezeNoiseDb,
            minFreezeMs: gates.maxFreezeMs
          })
        : [],
      hasVideo ? runFramemd5(filePath, { ffmpegPath }) : [],
      hasVideo ? runVideoPacing(filePath, { ffprobePath }) : [],
      hasAudio ? runAudioPackets(filePath, { ffprobePath }) : [],
      hasAudio
        ? runSilencedetect(filePath, {
            ffmpegPath,
            noiseDb: gates.silenceDb,
            minSilenceMs: gates.minSilenceGapMs
          })
        : [],
      hasVideo && gates.keyframeMaxIntervalSeconds != null
        ? runKeyframeTimes(filePath, { ffprobePath })
        : []
    ])

  const pacing = pacingStats(ptsTimes)
  const duplicatePts = duplicatePtsStats(ptsTimes)
  const repeated = maxConsecutiveRun(frameHashes, gates.maxRepeatedFrameRun)
  const longestFreeze = freezes.reduce((max, f) => Math.max(max, f.duration), 0)
  const longestSilence = silences.reduce((max, s) => Math.max(max, s.duration), 0)
  const containerFps =
    probe.video?.avgFps ?? probe.video?.nominalFps ?? pacing.observedFps ?? null
  const cadence = classifyFrameRate(containerFps)
  const explicitIntendedFps = Number.isFinite(options.intendedFps) ? options.intendedFps : null
  const mismatch = cadenceMismatch(
    containerFps,
    explicitIntendedFps,
    gates.cadenceMismatchTolerancePct
  )
  const freezeEvidence = corroborateFreezes(freezes, repeated.bursts, containerFps)
  const audioGaps = audioPtsGaps(audioPackets)
  const skew = avSkewMs(probe)
  const skewComponents = avSkewComponents(probe)

  const intendedFps = options.intendedFps ?? probe.video?.nominalFps ?? probe.video?.avgFps ?? null
  const durationForCount = probe.video?.duration ?? probe.formatDuration ?? null
  const observedFrames =
    probe.video?.nbFrames ?? (frameHashes.length > 0 ? frameHashes.length : pacing.count || null)
  const expectedFrames =
    intendedFps != null && durationForCount != null
      ? Math.round(intendedFps * durationForCount)
      : null
  const frameDerivedDurationSeconds =
    intendedFps != null && observedFrames != null && intendedFps > 0
      ? observedFrames / intendedFps
      : null
  const durationStretchRatio =
    durationForCount != null &&
    frameDerivedDurationSeconds != null &&
    frameDerivedDurationSeconds > 0
      ? durationForCount / frameDerivedDurationSeconds
      : null

  const metrics = {
    fileBytes,
    hasVideo,
    hasAudio,
    expectAudio,
    intendedFps,
    durationSeconds: durationForCount,
    codec: probe.video?.codec ?? null,
    pixFmt: probe.video?.pixFmt ?? null,
    profile: probe.video?.profile ?? null,
    level: probe.video?.level ?? null,
    colorSpace: probe.video?.colorSpace ?? null,
    colorPrimaries: probe.video?.colorPrimaries ?? null,
    colorTransfer: probe.video?.colorTransfer ?? null,
    colorRange: probe.video?.colorRange ?? null,
    encoderTag: probe.encoderTag,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    avgFps: probe.video?.avgFps ?? null,
    nominalFps: probe.video?.nominalFps ?? null,
    observedFps: pacing.observedFps,
    duplicatePtsCount: hasVideo ? duplicatePts.duplicateCount : null,
    maxDuplicatePtsRun: hasVideo ? duplicatePts.maxDuplicateRun : null,
    meanIntervalMs: pacing.meanIntervalMs,
    maxFrameGapMs: pacing.maxGapMs,
    frameJitterMs: pacing.jitterMs,
    observedFrames,
    expectedFrames,
    frameDerivedDurationSeconds,
    durationStretchRatio,
    freezeCount: freezes.length,
    longestFreezeMs: hasVideo ? longestFreeze * 1000 : null,
    corroboratedFreezeCount: hasVideo ? freezeEvidence.corroborated.length : null,
    longestCorroboratedFreezeMs: hasVideo
      ? longestSegmentSeconds(freezeEvidence.corroborated) * 1000
      : null,
    similarityOnlyFreezeCount: hasVideo ? freezeEvidence.similarityOnly.length : null,
    longestSimilarityOnlyFreezeMs: hasVideo
      ? longestSegmentSeconds(freezeEvidence.similarityOnly) * 1000
      : null,
    cadenceFps: containerFps,
    cadenceLabel: cadence?.label ?? null,
    cadenceIntendedFps: explicitIntendedFps,
    cadenceMismatchPct: mismatch?.deviationPct ?? null,
    maxRepeatedFrameRun: hasVideo ? repeated.maxRun : null,
    repeatedBurstCount: repeated.bursts.length,
    maxAudioGapMs: hasAudio ? audioGaps.maxGapMs : null,
    audioGapCount: audioGaps.gaps.length,
    silenceCount: silences.length,
    longestSilenceMs: hasAudio ? longestSilence * 1000 : null,
    avSkewMs: skew,
    startSkewMs: skewComponents.startSkewMs,
    tailMismatchMs: skewComponents.tailMismatchMs,
    keyframeCount: keyframeTimes.length > 0 ? keyframeTimes.length : null,
    maxKeyframeIntervalSeconds: maxKeyframeInterval(keyframeTimes)
  }

  const verdict = evaluateGates(metrics, gates)

  return {
    file: filePath,
    analyzedAtIso: new Date().toISOString(),
    gates,
    verdict,
    metrics,
    probe,
    findings: {
      freezes,
      repeatedBursts: repeated.bursts,
      audioGaps: audioGaps.gaps,
      silences
    }
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

function fmtSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(3)}s` : 'n/a'
}

function sampledFindings(values, formatter, limit = 10) {
  const items = Array.isArray(values) ? values : []
  const rendered = items.slice(0, limit).map(formatter)
  const omitted = items.length - rendered.length
  if (omitted > 0) {
    rendered.push(`${omitted} more`)
  }
  return rendered.join('; ')
}

/** Render a human-readable markdown report from an analyzeRecording() result. */
export function renderMarkdownReport(report) {
  const { metrics: m, verdict } = report
  const lines = []
  lines.push(`# Recording Quality Report`)
  lines.push('')
  lines.push(`- File: \`${report.file}\``)
  lines.push(`- Analyzed: ${report.analyzedAtIso}`)
  lines.push(`- Verdict: **${verdict.pass ? 'PASS' : 'FAIL'}**`)
  lines.push('')
  if (verdict.failures.length > 0) {
    lines.push('## Gate failures')
    lines.push('')
    for (const f of verdict.failures) lines.push(`- ❌ ${f}`)
    lines.push('')
  }
  if (verdict.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const w of verdict.warnings) lines.push(`- ⚠️ ${w}`)
    lines.push('')
  }
  lines.push('## Metrics')
  lines.push('')
  lines.push(
    `- Container: ${m.codec ?? 'n/a'} ${m.width ?? '?'}×${m.height ?? '?'} ${m.pixFmt ?? ''}`.trim()
  )
  lines.push(
    `- Profile/level: ${m.profile ?? 'n/a'}@${m.level != null ? (m.level / 10).toFixed(1) : 'n/a'} | ` +
      `Color: ${m.colorSpace ?? 'unknown'}/${m.colorPrimaries ?? 'unknown'}/${m.colorTransfer ?? 'unknown'} range=${m.colorRange ?? 'unknown'}`
  )
  lines.push(`- Encoder tag: ${m.encoderTag ?? 'n/a'}`)
  lines.push(`- Size: ${fmtBytes(m.fileBytes)} | Duration: ${fmt(m.durationSeconds, 2)}s`)
  lines.push(
    `- FPS: intended ${fmt(m.intendedFps, 2)} | avg ${fmt(m.avgFps, 2)} | nominal ${fmt(m.nominalFps, 2)} | observed ${fmt(m.observedFps, 2)}`
  )
  lines.push(
    `- Cadence: ${m.cadenceLabel ?? `${fmt(m.cadenceFps, 3)}fps (non-standard/unstable)`}` +
      (m.cadenceMismatchPct != null
        ? ` — MISMATCH vs intended ${fmt(m.cadenceIntendedFps, 2)}fps (${fmt(m.cadenceMismatchPct, 1)}% off)`
        : '')
  )
  lines.push(
    `- Frames: observed ${m.observedFrames ?? 'n/a'} | expected ~${m.expectedFrames ?? 'n/a'}`
  )
  lines.push(
    `- Duration stretch: frame-derived ${fmt(m.frameDerivedDurationSeconds, 2)}s | ratio ${fmt(m.durationStretchRatio, 2)}x`
  )
  lines.push(
    `- Frame pacing: mean ${fmt(m.meanIntervalMs)}ms | max gap ${fmt(m.maxFrameGapMs)}ms | jitter ${fmt(m.frameJitterMs)}ms`
  )
  lines.push(`- Freeze: longest ${fmt(m.longestFreezeMs)}ms across ${m.freezeCount} segment(s)`)
  if (m.corroboratedFreezeCount != null) {
    lines.push(
      `- Freeze evidence: ${m.corroboratedFreezeCount} exact-repeat corroborated ` +
        `(longest ${fmt(m.longestCorroboratedFreezeMs)}ms) | ` +
        `${m.similarityOnlyFreezeCount} similarity-only (longest ${fmt(m.longestSimilarityOnlyFreezeMs)}ms, ` +
        `likely still content)`
    )
  }
  lines.push(
    `- Repeated frames: max run ${m.maxRepeatedFrameRun ?? 'n/a'} across ${m.repeatedBurstCount} burst(s)`
  )
  if (m.hasAudio) {
    lines.push(`- Audio gaps: max ${fmt(m.maxAudioGapMs)}ms across ${m.audioGapCount} gap(s)`)
    lines.push(
      `- Silence: longest ${fmt(m.longestSilenceMs)}ms across ${m.silenceCount} segment(s)`
    )
  } else {
    lines.push(`- Audio: ${m.expectAudio ? 'EXPECTED BUT MISSING' : 'none (not expected)'}`)
  }
  lines.push(`- A/V skew: ${m.avSkewMs == null ? 'n/a' : `${fmt(m.avSkewMs)}ms`}`)
  lines.push(
    `- A/V components: start skew ${m.startSkewMs == null ? 'n/a' : `${fmt(m.startSkewMs)}ms`} | ` +
      `tail mismatch ${m.tailMismatchMs == null ? 'n/a' : `${fmt(m.tailMismatchMs)}ms`}`
  )
  if (m.keyframeCount != null) {
    lines.push(
      `- Keyframes: ${m.keyframeCount} sampled | max interval ${fmt(m.maxKeyframeIntervalSeconds, 2)}s`
    )
  }
  lines.push('')
  const findings = report.findings ?? {}
  if (
    findings.freezes?.length > 0 ||
    findings.repeatedBursts?.length > 0 ||
    findings.audioGaps?.length > 0 ||
    findings.silences?.length > 0
  ) {
    lines.push('## Findings')
    lines.push('')
    if (findings.freezes?.length > 0) {
      lines.push(
        `- Freeze segments: ${sampledFindings(
          findings.freezes,
          (freeze) => `${fmtSeconds(freeze.start)} for ${fmt((freeze.duration ?? 0) * 1000)}ms`
        )}`
      )
    }
    if (findings.repeatedBursts?.length > 0) {
      const fps = typeof m.intendedFps === 'number' && m.intendedFps > 0 ? m.intendedFps : null
      lines.push(
        `- Repeated-frame bursts: ${sampledFindings(findings.repeatedBursts, (burst) => {
          const time = fps == null ? 'time n/a' : `about ${fmtSeconds(burst.startIndex / fps)}`
          return `frame ${burst.startIndex} (${time}), run ${burst.run}`
        })}`
      )
    }
    if (findings.audioGaps?.length > 0) {
      lines.push(
        `- Audio PTS gaps: ${sampledFindings(
          findings.audioGaps,
          (gap) => `${fmtSeconds(gap.at)} gap ${fmt(gap.gapMs)}ms`
        )}`
      )
    }
    if (findings.silences?.length > 0) {
      lines.push(
        `- Silence segments: ${sampledFindings(
          findings.silences,
          (silence) => `${fmtSeconds(silence.start)} for ${fmt((silence.duration ?? 0) * 1000)}ms`
        )}`
      )
    }
    lines.push('')
  }
  lines.push('## Caveats')
  lines.push('')
  lines.push(
    '- `freezedetect` flags any near-identical run, including legitimately static screen content ' +
      'and a person holding still. The freeze gate therefore only hard-fails segments corroborated ' +
      'by exact decoded-frame repeats (framemd5); similarity-only segments surface as warnings.'
  )
  lines.push(
    '- Audio A/V skew here is a container start/duration delta, not measured lip-sync. ' +
      'True lip-sync needs capture-clock instrumentation (backend Phase 5).'
  )
  lines.push(
    '- `aresample=async=1` in the recording pipeline can mask capture-side audio gaps in the final ' +
      'file, so a clean audio-gap result does not by itself prove the mic never stalled.'
  )
  lines.push('')
  return lines.join('\n')
}

/**
 * Write `<base>.quality.json` and `<base>.quality.md` next to the recording (or in
 * `options.outDir`). Returns the two written paths.
 */
export function writeReports(report, { outDir } = {}) {
  const dir = outDir ?? dirname(report.file)
  mkdirSync(dir, { recursive: true })
  const base = basename(report.file).replace(/\.[^.]+$/, '')
  const jsonPath = join(dir, `${base}.quality.json`)
  const mdPath = join(dir, `${base}.quality.md`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  writeFileSync(mdPath, renderMarkdownReport(report))
  return { jsonPath, mdPath }
}
