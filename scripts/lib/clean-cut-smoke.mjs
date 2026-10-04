import { isFiller, scriptedDrops } from './fake-transcript-service.mjs'

/**
 * Pure helpers for `pnpm smoke:clean-cut` (plan 119 S16,
 * `scripts/smoke-clean-cut-app.mjs`):
 *
 * - the scripted take: speech bursts and silences the smoke records;
 * - speech bursts measured in decoded PCM, and the script's words laid over
 *   them, which is what the fake transcription service then serves;
 * - the cut list the decision 16 rules must build from those words, with the
 *   rule numbers read from `crates/videorc-backend/src/clean_cut/rules.rs` so
 *   the smoke never keeps a second copy of them;
 * - the frame math that mirrors `clean_cut/edl.rs` and `clean_cut/render.rs`;
 * - small readers for SRT text and ffprobe JSON.
 *
 * Nothing here starts a process, opens a socket or reads the clock.
 */

/**
 * The take the smoke records, in order. `speechMs` steps are speech (a tone
 * injected into the debug synthetic microphone), `silenceMs` steps are
 * digital silence. Every sentence ends with a full stop and has none inside,
 * so the desktop groups one sentence per burst.
 *
 * - The lead and the tail are long: a head cut and a tail cut.
 * - The second sentence is a retake: the third holds the fake analysis
 *   job's marker "let me say that again", so the job drops the second. The
 *   short pauses around it are under the silence rule, so its cut stands
 *   alone and keeps the kind `retake`.
 * - Three long pauses are silences to shorten.
 * - "um" is a filler with a kept word on each side.
 */
export const CLEAN_CUT_SMOKE_TIMELINE = Object.freeze([
  Object.freeze({ silenceMs: 3_000 }),
  Object.freeze({ speechMs: 2_400, text: 'Welcome back to the channel.' }),
  Object.freeze({ silenceMs: 800 }),
  Object.freeze({
    speechMs: 2_400,
    text: 'Today we build the thing the wrong way.',
    retaken: true
  }),
  Object.freeze({ silenceMs: 800 }),
  Object.freeze({
    speechMs: 3_200,
    text: 'Let me say that again, today we build it the right way.'
  }),
  Object.freeze({ silenceMs: 4_500 }),
  Object.freeze({ speechMs: 3_000, text: 'So um that is the whole trick.' }),
  Object.freeze({ silenceMs: 5_000 }),
  Object.freeze({ speechMs: 2_600, text: 'It works on every machine we tried.' }),
  Object.freeze({ silenceMs: 4_000 }),
  Object.freeze({ speechMs: 2_200, text: 'Thanks for watching.' }),
  Object.freeze({ silenceMs: 4_000 })
])

// `edl.rs` `ends_sentence`: sentence punctuation, then any closing quotes.
const SENTENCE_END = /[.?!…]["')\]”’]*$/

/** The decision 16 numbers the smoke's expectations need from `rules.rs`. */
export const REQUIRED_CLEAN_CUT_RULES = Object.freeze([
  'HEAD_LEAD_MS',
  'TAIL_TRAIL_MS',
  'SILENCE_MIN_GAP_MS',
  'SILENCE_KEEP_MS',
  'FILLER_PAD_MS',
  'DROP_CONFIDENCE_ON',
  'SLIVER_MAX_MS'
])

/**
 * Every numeric `pub const NAME: <type> = <literal>;` of a Rust source, with
 * `_` digit separators removed. Pure.
 */
export function parseRustNumericConstants(source) {
  const constants = {}
  const pattern =
    /^\s*pub const ([A-Z][A-Z0-9_]*): (?:u8|u16|u32|u64|usize|i32|i64|f32|f64) = (-?[0-9][0-9_]*(?:\.[0-9_]+)?);/gm
  for (const match of String(source ?? '').matchAll(pattern)) {
    constants[match[1]] = Number(match[2].replaceAll('_', ''))
  }
  return constants
}

/** The rule numbers from the text of `rules.rs`; throws when one is missing. */
export function readCleanCutRules(rulesSource) {
  const constants = parseRustNumericConstants(rulesSource)
  const missing = REQUIRED_CLEAN_CUT_RULES.filter((name) => !Number.isFinite(constants[name]))
  if (missing.length > 0) {
    throw new Error(`clean_cut/rules.rs no longer defines ${missing.join(', ')}.`)
  }
  return constants
}

/**
 * The take as `{leadMs, tailMs, totalMs, sentences[{text, speechMs, retaken,
 * gapAfterMs}]}`: the silence before the first sentence, after the last one,
 * and between neighbours. Pure.
 */
export function timelineShape(timeline) {
  const sentences = []
  let leadMs = 0
  let pendingMs = 0
  let totalMs = 0
  for (const step of timeline) {
    if (typeof step.text === 'string') {
      if (sentences.length === 0) {
        leadMs = pendingMs
      } else {
        sentences[sentences.length - 1].gapAfterMs = pendingMs
      }
      sentences.push({
        text: step.text,
        speechMs: step.speechMs,
        retaken: step.retaken === true,
        gapAfterMs: null
      })
      pendingMs = 0
      totalMs += step.speechMs
    } else {
      pendingMs += step.silenceMs ?? 0
      totalMs += step.silenceMs ?? 0
    }
  }
  return { leadMs, tailMs: pendingMs, totalMs, sentences }
}

/**
 * The same shape measured in a recording: burst `i` carries sentence `i` of
 * the script. Pure.
 */
export function measuredShape(bursts, durationMs, scriptedSentences = []) {
  const sentences = bursts.map((burst, index) => ({
    text: scriptedSentences[index]?.text ?? '',
    speechMs: burst.endMs - burst.startMs,
    retaken: scriptedSentences[index]?.retaken === true,
    gapAfterMs: index + 1 < bursts.length ? bursts[index + 1].startMs - burst.endMs : null
  }))
  return {
    leadMs: bursts[0]?.startMs ?? 0,
    tailMs: bursts.length > 0 ? durationMs - bursts[bursts.length - 1].endMs : durationMs,
    totalMs: durationMs,
    sentences
  }
}

/**
 * Why a take (scripted or measured) cannot prove the cut list: an empty list
 * means every assumption the smoke's expectations rest on holds for these
 * rules. Pure.
 */
export function scenarioProblems(shape, rules) {
  const problems = []
  const {
    HEAD_LEAD_MS,
    TAIL_TRAIL_MS,
    SILENCE_MIN_GAP_MS,
    SILENCE_KEEP_MS,
    SLIVER_MAX_MS,
    DROP_CONFIDENCE_ON
  } = rules
  if (shape.sentences.length < 2) {
    problems.push('the take needs at least two sentences')
  }
  if (shape.leadMs < HEAD_LEAD_MS + 500) {
    problems.push(`the lead silence (${shape.leadMs} ms) must exceed HEAD_LEAD_MS + 500 ms`)
  }
  if (shape.tailMs < TAIL_TRAIL_MS + 500) {
    problems.push(`the tail silence (${shape.tailMs} ms) must exceed TAIL_TRAIL_MS + 500 ms`)
  }
  shape.sentences.forEach((sentence, index) => {
    const gap = sentence.gapAfterMs
    if (gap === null) return
    const shortGap = gap > SLIVER_MAX_MS + 200 && gap < SILENCE_MIN_GAP_MS - 100
    const longGap = gap >= SILENCE_MIN_GAP_MS + 1_000 && gap - SILENCE_KEEP_MS > SLIVER_MAX_MS
    if (!shortGap && !longGap) {
      problems.push(
        `the pause after sentence ${index + 1} (${gap} ms) is neither clearly under ` +
          `SILENCE_MIN_GAP_MS (${SILENCE_MIN_GAP_MS} ms) nor clearly over it`
      )
    }
  })
  shape.sentences.forEach((sentence, index) => {
    if (!sentence.retaken) return
    const before = shape.sentences[index - 1]?.gapAfterMs
    const after = sentence.gapAfterMs
    if (
      before === undefined ||
      after === null ||
      before >= SILENCE_MIN_GAP_MS ||
      after >= SILENCE_MIN_GAP_MS
    ) {
      problems.push(
        `the retaken sentence ${index + 1} needs a short pause on both sides, so its cut stands alone`
      )
    }
  })
  const segments = shape.sentences.map((sentence, index) => ({
    id: `s${index + 1}`,
    text: sentence.text
  }))
  const dropped = scriptedDrops(segments)
    .filter((drop) => drop.confidence >= DROP_CONFIDENCE_ON)
    .map((drop) => drop.fromId)
    .sort()
  const retaken = segments
    .filter((_, index) => shape.sentences[index].retaken)
    .map((segment) => segment.id)
    .sort()
  if (JSON.stringify(dropped) !== JSON.stringify(retaken)) {
    problems.push(
      `the fake analysis job would drop ${JSON.stringify(dropped)}, the take marks ` +
        `${JSON.stringify(retaken)} as retaken`
    )
  }
  shape.sentences.forEach((sentence, index) => {
    const tokens = sentence.text.trim().split(/\s+/).filter(Boolean)
    tokens.forEach((token, position) => {
      if (isFiller(token) && (position === 0 || position === tokens.length - 1)) {
        problems.push(`the filler "${token}" in sentence ${index + 1} needs a word on each side`)
      }
    })
    tokens.slice(0, -1).forEach((token) => {
      if (SENTENCE_END.test(token)) {
        problems.push(`sentence ${index + 1} ends early at "${token}"`)
      }
    })
    if (tokens.length > 0 && !SENTENCE_END.test(tokens[tokens.length - 1])) {
      problems.push(`sentence ${index + 1} must end with a full stop, question or exclamation mark`)
    }
  })
  return problems
}

/**
 * Where a measured take strays from the script by more than `toleranceMs`:
 * sentence count, speech lengths and the pauses between sentences. The lead
 * and the tail are left out; they hold the start and stop latency. Pure.
 */
export function compareShapes(measured, scripted, { toleranceMs = 300 } = {}) {
  const problems = []
  if (measured.sentences.length !== scripted.sentences.length) {
    problems.push(
      `measured ${measured.sentences.length} speech burst(s), the script has ` +
        `${scripted.sentences.length} sentence(s)`
    )
    return problems
  }
  scripted.sentences.forEach((sentence, index) => {
    const got = measured.sentences[index]
    if (Math.abs(got.speechMs - sentence.speechMs) > toleranceMs) {
      problems.push(
        `sentence ${index + 1} lasts ${got.speechMs} ms, the script says ${sentence.speechMs} ms`
      )
    }
    if (
      sentence.gapAfterMs !== null &&
      Math.abs(got.gapAfterMs - sentence.gapAfterMs) > toleranceMs
    ) {
      problems.push(
        `the pause after sentence ${index + 1} lasts ${got.gapAfterMs} ms, the script says ` +
          `${sentence.gapAfterMs} ms`
      )
    }
  })
  return problems
}

/**
 * Speech bursts in s16le mono PCM: runs of `frameMs` frames whose RMS is at
 * or above `thresholdDbfs`, merged across gaps shorter than `mergeGapMs`,
 * dropped when shorter than `minBurstMs`. `{startMs, endMs}` in PCM time.
 * Pure.
 */
export function detectSpeechBursts(
  pcm,
  {
    sampleRate = 16_000,
    frameMs = 20,
    thresholdDbfs = -40,
    mergeGapMs = 300,
    minBurstMs = 300
  } = {}
) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? [])
  const sampleCount = Math.floor(bytes.length / 2)
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1_000))
  const runs = []
  let run = null
  for (let start = 0; start < sampleCount; start += frameSamples) {
    const end = Math.min(sampleCount, start + frameSamples)
    let sumSquares = 0
    for (let sample = start; sample < end; sample += 1) {
      const value = bytes.readInt16LE(sample * 2) / 32_768
      sumSquares += value * value
    }
    const rms = Math.sqrt(sumSquares / (end - start))
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity
    const startMs = Math.round((start * 1_000) / sampleRate)
    const endMs = Math.round((end * 1_000) / sampleRate)
    if (dbfs >= thresholdDbfs) {
      if (run) {
        run.endMs = endMs
      } else {
        run = { startMs, endMs }
        runs.push(run)
      }
    } else {
      run = null
    }
  }
  const merged = []
  for (const candidate of runs) {
    const last = merged[merged.length - 1]
    if (last && candidate.startMs - last.endMs < mergeGapMs) {
      last.endMs = candidate.endMs
    } else {
      merged.push({ ...candidate })
    }
  }
  return merged.filter((burst) => burst.endMs - burst.startMs >= minBurstMs)
}

/**
 * The script's words laid over the measured bursts: sentence `i` fills burst
 * `i` edge to edge, each word as long as its share of the characters, the
 * words back to back. Fillers carry `filler: true`. Integer milliseconds,
 * so they survive the chunk round trip unchanged. Pure.
 */
export function layScriptOverBursts(sentences, bursts) {
  if (sentences.length !== bursts.length) {
    throw new Error(
      `${sentences.length} sentence(s) cannot be laid over ${bursts.length} speech burst(s).`
    )
  }
  const words = []
  sentences.forEach((sentence, index) => {
    const tokens = String(sentence.text).trim().split(/\s+/).filter(Boolean)
    const { startMs, endMs } = bursts[index]
    const span = endMs - startMs
    const weights = tokens.map((token) => token.length + 1)
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let cumulative = 0
    tokens.forEach((token, position) => {
      const wordStart = startMs + Math.round((span * cumulative) / total)
      cumulative += weights[position]
      const wordEnd = startMs + Math.round((span * cumulative) / total)
      const word = { text: token, startMs: wordStart, endMs: wordEnd }
      if (isFiller(token)) word.filler = true
      words.push(word)
    })
  })
  return words
}

/**
 * The enabled removals decision 16 must produce for words laid over a take
 * that satisfies `scenarioProblems`: head, tail, the silent pauses longer
 * than the silence rule, padded fillers and the retaken sentences. Before
 * frame snapping, sorted by start. Every pause in the smoke's take is digital
 * silence, so the noisy-gap rule never applies. Pure.
 */
export function expectedCleanCutRemovals({ words, sentences, bursts, durationMs, rules }) {
  const out = []
  if (words.length === 0) return out
  const kept = words.filter((word) => word.filler !== true)
  const first = kept[0] ?? words[0]
  const last = kept[kept.length - 1] ?? words[words.length - 1]
  const headEnd = Math.min(Math.max(0, first.startMs - rules.HEAD_LEAD_MS), durationMs)
  if (headEnd > 0) out.push({ kind: 'head', startMs: 0, endMs: headEnd })
  const tailStart = last.endMs + rules.TAIL_TRAIL_MS
  if (tailStart < durationMs) out.push({ kind: 'tail', startMs: tailStart, endMs: durationMs })
  const keepEachSide = Math.floor(rules.SILENCE_KEEP_MS / 2)
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].startMs - words[index - 1].endMs
    if (gap > rules.SILENCE_MIN_GAP_MS) {
      out.push({
        kind: 'silence',
        startMs: words[index - 1].endMs + keepEachSide,
        endMs: words[index].startMs - keepEachSide
      })
    }
  }
  words.forEach((word, index) => {
    if (word.filler !== true) return
    const lower = index > 0 ? words[index - 1].endMs : 0
    const upper = Math.min(
      index + 1 < words.length ? words[index + 1].startMs : durationMs,
      durationMs
    )
    const start = Math.max(word.startMs - rules.FILLER_PAD_MS, lower)
    const end = Math.min(word.endMs + rules.FILLER_PAD_MS, upper)
    if (end > start) out.push({ kind: 'filler', startMs: start, endMs: end })
  })
  sentences.forEach((sentence, index) => {
    if (sentence.retaken && bursts[index]) {
      out.push({ kind: 'retake', startMs: bursts[index].startMs, endMs: bursts[index].endMs })
    }
  })
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/** `[{kind, count, ms}]` totals of a removal list, in first-seen kind order. Pure. */
export function countByKind(removals) {
  const counts = new Map()
  for (const removal of removals) {
    const entry = counts.get(removal.kind) ?? { kind: removal.kind, count: 0 }
    entry.count += 1
    counts.set(removal.kind, entry)
  }
  return [...counts.values()]
}

/**
 * Where a cut list's enabled removals differ from the expected ones: count,
 * order, kind, and each boundary beyond `toleranceMs`. Pure.
 */
export function compareRemovals(actual, expected, { toleranceMs }) {
  const problems = []
  const enabled = actual
    .filter((removal) => removal.enabled)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const describe = (list) =>
    list.map((removal) => `${removal.kind} ${removal.startMs}-${removal.endMs}`).join(', ')
  if (enabled.length !== expected.length) {
    problems.push(
      `expected ${expected.length} enabled removal(s) [${describe(expected)}], the cut list has ` +
        `${enabled.length} [${describe(enabled)}]`
    )
    return problems
  }
  expected.forEach((want, index) => {
    const got = enabled[index]
    if (got.kind !== want.kind) {
      problems.push(`removal ${index + 1} is ${got.kind}, expected ${want.kind}`)
    }
    if (
      Math.abs(got.startMs - want.startMs) > toleranceMs ||
      Math.abs(got.endMs - want.endMs) > toleranceMs
    ) {
      problems.push(
        `${want.kind} removal ${index + 1} spans ${got.startMs}-${got.endMs} ms, expected ` +
          `${want.startMs}-${want.endMs} ms within ${toleranceMs.toFixed(1)} ms`
      )
    }
  })
  return problems
}

// --- Frame math (mirrors clean_cut/edl.rs and clean_cut/render.rs) ----------

/** One frame of `{num, den}`, in milliseconds. */
export function frameDurationMs(frameRate) {
  return (1_000 * frameRate.den) / frameRate.num
}

/** Nearest frame on the grid (`edl.rs` `ms_to_frame`). */
export function msToFrame(ms, frameRate) {
  return Math.max(0, Math.round((ms * frameRate.num) / (1_000 * frameRate.den)))
}

/** A frame boundary rounded to a millisecond (`edl.rs` `frame_to_ms`). */
export function frameToMs(frame, frameRate) {
  return Math.max(0, Math.round((frame * 1_000 * frameRate.den) / frameRate.num))
}

/**
 * The complement of the enabled removals over the recording, in frames
 * (`render.rs` `kept_ranges`). `endFrame` is exclusive. Pure.
 */
export function keptRangesFromEdl(edl) {
  const totalFrames = msToFrame(edl.durationMs, edl.frameRate)
  const removed = (edl.removals ?? [])
    .filter((removal) => removal.enabled)
    .map((removal) => [
      Math.min(removal.startFrame, totalFrames),
      Math.min(removal.endFrame, totalFrames)
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const kept = []
  let cursor = 0
  for (const [start, end] of removed) {
    if (start > cursor) kept.push({ startFrame: cursor, endFrame: start })
    cursor = Math.max(cursor, end)
  }
  if (cursor < totalFrames) kept.push({ startFrame: cursor, endFrame: totalFrames })
  return kept
}

export function keptFrameCount(ranges) {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.endFrame - range.startFrame), 0)
}

/**
 * The output frame index that starts each kept range after the first: the
 * joins, where a frozen frame would show. Pure.
 */
export function joinFrameIndices(ranges) {
  const joins = []
  let cumulative = 0
  ranges.forEach((range, index) => {
    cumulative += Math.max(0, range.endFrame - range.startFrame)
    if (index + 1 < ranges.length) joins.push(cumulative)
  })
  return joins
}

// --- Readers --------------------------------------------------------------------

/** `HH:MM:SS,mmm --> HH:MM:SS,mmm` cues with their text; index lines optional. Pure. */
export function parseSrtCues(text) {
  const cues = []
  for (const block of String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0) continue
    const [rawStart, rawEnd] = lines[timing].split('-->').map((part) => part.trim())
    const startMs = srtTimestampMs(rawStart)
    const endMs = srtTimestampMs(rawEnd)
    const cueText = lines
      .slice(timing + 1)
      .join(' ')
      .trim()
    if (startMs === null || endMs === null || !cueText) continue
    cues.push({ startMs, endMs, text: cueText })
  }
  return cues
}

function srtTimestampMs(value) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/.exec(String(value ?? ''))
  if (!match) return null
  const [, hours, minutes, seconds, millis = '0'] = match
  return (
    ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000 +
    Number(millis.padEnd(3, '0'))
  )
}

/** Streams by `codec_type` in `ffprobe -show_streams -of json` output. Pure. */
export function streamCounts(ffprobeJson) {
  const counts = {}
  for (const stream of ffprobeJson?.streams ?? []) {
    const type = stream?.codec_type ?? 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}
