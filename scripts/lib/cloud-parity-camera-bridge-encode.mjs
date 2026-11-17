// Plan 249 S13a: encoder-output association for the native camera bridge.
//
// Inputs are what the renderer OBSERVED: native-frame writes (`sequence`,
// `ptsUs`, `writtenAtMs` in renderer performance ms) and encoded frames seen
// by the sender's `RTCRtpScriptTransform` (`rtpTimestamp` as provided, `atMs`
// in renderer performance ms plus the drain's measured clock bracket).
//
// The RTP-to-native mapping is a HYPOTHESIS that each run must prove: RTP =
// constant offset + 90 kHz x VideoFrame timestamp (ptsUs). When the data does
// not prove it, the result is `unavailable`; no pts is ever derived from RTP
// and no timing is synthesized.

import { percentile } from './cloud-parity-camera-bridge-contract.mjs'

export const OBSERVED = 'renderer-encoded-transform'
export const RTP_TICKS_PER_US = 0.09
export const RTP_WRAP = 2 ** 32

export const PUBLISH_LIMITATION =
  'The encoded transform (RTCRtpScriptTransform on RTCRtpSender.transform) runs after the encoder and before packetization, pacing and send. Per-frame wire-send time and SFU arrival are not observable from supported APIs (RTCOutboundRtpStreamStats are aggregate counters only), so packetized and sent timing stay unavailable.'

export const ENCODE_ASSOCIATION_RULES = Object.freeze({
  minimumEncodedFrames: 30,
  minimumMatchFraction: 0.95,
  toleranceTicks: 1,
  // Only bounds the offset CANDIDATE search; acceptance is the global test.
  candidateWindowMs: 5000,
  candidateSampleFrames: 512,
  candidateOffsets: 8,
  sampleLimit: 600
})

/** A declared budget, not a measurement. */
export const ENCODE_OBSERVATION_BUDGET = Object.freeze({
  kind: 'declared budget, not a measurement',
  encodeDelayUpperP95Ms: 100
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Unwrap 32-bit RTP timestamps in encoder output order (shortest signed step). */
export function unwrapRtp(values) {
  const out = []
  let previous = null
  let unwrapped = 0
  for (const value of values) {
    if (previous === null) unwrapped = value
    else {
      let delta = (value - previous) % RTP_WRAP
      if (delta < 0) delta += RTP_WRAP
      if (delta >= RTP_WRAP / 2) delta -= RTP_WRAP
      unwrapped += delta
    }
    previous = value
    out.push(unwrapped)
  }
  return out
}

/**
 * Flatten renderer `{ phase: 'encoded' }` observations of one generation into
 * `associateEncodedFrames` input, keeping each drain's measured bracket.
 */
export function encodedRecordsFromObservations(observations, generation) {
  const encoded = []
  let dropped = 0
  for (const o of observations ?? []) {
    if (o?.phase !== 'encoded' || (generation !== undefined && o.generation !== generation))
      continue
    if (finite(o.dropped)) dropped = Math.max(dropped, o.dropped)
    const bracket = o.bracket?.timeOriginBracketMs
    for (const r of o.records ?? [])
      encoded.push({
        rtpTimestamp: r.rtpTimestamp,
        atMs: r.atMs,
        type: r.type ?? null,
        offsetLowMs: finite(bracket?.lowMs) ? bracket.lowMs : null,
        offsetHighMs: finite(bracket?.highMs) ? bracket.highMs : null
      })
  }
  return { encoded, observerDropped: dropped }
}

function stats(values) {
  return values.length
    ? {
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        max: values.reduce((a, b) => (b > a ? b : a), -Infinity)
      }
    : null
}

function evenlySample(items, limit) {
  if (items.length <= limit) return items
  const out = []
  for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * items.length) / limit)])
  return out
}

/**
 * @param written native-frame observations `{ sequence, ptsUs, writtenAtMs }`
 * @param encoded `{ rtpTimestamp, atMs, offsetLowMs?, offsetHighMs? }` (renderer ms)
 * @param options `{ observerDropped }` plus rule overrides
 */
export function associateEncodedFrames(written, encoded, options = {}) {
  const rules = { ...ENCODE_ASSOCIATION_RULES, ...options }
  const observerDropped = finite(options.observerDropped) ? options.observerDropped : 0
  const natives = (written ?? []).filter(
    (w) => Number.isInteger(w?.sequence) && finite(w.ptsUs) && finite(w.writtenAtMs)
  )
  const frames = (encoded ?? [])
    .map((e, index) => ({ ...e, index }))
    .filter((e) => Number.isInteger(e.rtpTimestamp) && e.rtpTimestamp >= 0 && finite(e.atMs))
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index)
  const invalidEncoded = (encoded?.length ?? 0) - frames.length
  const unwrapped = unwrapRtp(frames.map((e) => e.rtpTimestamp))
  frames.forEach((e, i) => (e.rtp = unwrapped[i]))
  const base = {
    observed: OBSERVED,
    limitation: PUBLISH_LIMITATION,
    hypothesis: 'rtp = offset + round(ptsUs * 0.09) within toleranceTicks, writtenAtMs <= atMs',
    toleranceTicks: rules.toleranceTicks
  }
  const counts = {
    writtenFrames: natives.length,
    encodedFrames: frames.length,
    invalidEncoded,
    observerDropped,
    wrapped: frames.some((e, i) => i > 0 && e.rtpTimestamp < frames[i - 1].rtpTimestamp)
  }
  const refuse = (reason, evidence = {}) => ({
    ...base,
    status: 'unavailable',
    reason,
    evidence: { ...counts, ...evidence }
  })
  if (frames.length < rules.minimumEncodedFrames)
    return refuse(
      `Too few encoded frames to test the mapping (${frames.length} < ${rules.minimumEncodedFrames})`
    )
  if (natives.length === 0) return refuse('No native frame writes were observed')

  const ticksOf = (w) => Math.round(w.ptsUs * RTP_TICKS_PER_US)
  const byTicks = new Map()
  for (const w of natives) {
    const key = ticksOf(w)
    const list = byTicks.get(key)
    if (list) list.push(w)
    else byTicks.set(key, [w])
  }

  // Candidate offsets from pairs written near the encode time (either side, so
  // an order violation is still found and reported); acceptance is global.
  const byWrite = [...natives].sort((a, b) => a.writtenAtMs - b.writtenAtMs)
  const votes = new Map()
  for (const e of evenlySample(frames, rules.candidateSampleFrames)) {
    let lo = 0
    let hi = byWrite.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (byWrite[mid].writtenAtMs < e.atMs - rules.candidateWindowMs) lo = mid + 1
      else hi = mid
    }
    for (
      let i = lo;
      i < byWrite.length && byWrite[i].writtenAtMs <= e.atMs + rules.candidateWindowMs;
      i++
    ) {
      const offset = e.rtp - ticksOf(byWrite[i])
      votes.set(offset, (votes.get(offset) ?? 0) + 1)
    }
  }
  const scored = [...votes.keys()]
    .map((offset) => {
      let score = 0
      for (let d = -rules.toleranceTicks; d <= rules.toleranceTicks; d++)
        score += votes.get(offset + d) ?? 0
      return { offset, score }
    })
    .sort((a, b) => b.score - a.score || a.offset - b.offset)
    .slice(0, rules.candidateOffsets)

  const evaluate = (offset) => {
    const used = new Set()
    const matches = []
    let orderViolations = 0
    let duplicates = 0
    const residuals = []
    for (const e of frames) {
      const target = e.rtp - offset
      let best = null
      let residualOnly = false
      for (let d = -rules.toleranceTicks; d <= rules.toleranceTicks; d++) {
        for (const w of byTicks.get(target + d) ?? []) {
          if (w.writtenAtMs > e.atMs) {
            residualOnly = true
            continue
          }
          if (!best || w.writtenAtMs > best.writtenAtMs) best = w
        }
      }
      if (!best) {
        if (residualOnly) orderViolations++
        continue
      }
      if (used.has(best.sequence)) {
        duplicates++
        continue
      }
      used.add(best.sequence)
      residuals.push(e.rtp - offset - ticksOf(best))
      matches.push({ encoded: e, written: best })
    }
    return { offset, matches, orderViolations, duplicates, residuals, used }
  }
  let best = null
  let orderViolationsMax = 0
  const passing = []
  for (const { offset } of scored) {
    const candidate = evaluate(offset)
    orderViolationsMax = Math.max(orderViolationsMax, candidate.orderViolations)
    if (!best || candidate.matches.length > best.matches.length) best = candidate
    if (candidate.matches.length / frames.length >= rules.minimumMatchFraction)
      passing.push(candidate)
  }
  const fraction = best ? best.matches.length / frames.length : 0
  // Distinct mappings: offsets further apart than the tolerance pair frames differently.
  const distinct = passing.filter(
    (c) => c === best || Math.abs(c.offset - best.offset) > 2 * rules.toleranceTicks
  )
  const evidence = {
    bestOffsetTicks: best?.offset ?? null,
    bestMatchFraction: fraction,
    matched: best?.matches.length ?? 0,
    orderViolations: best?.orderViolations ?? 0,
    // Frames an RTP-consistent candidate paired only with a write AFTER the encode.
    orderViolationsMax,
    duplicateMatches: best?.duplicates ?? 0,
    candidateOffsetsTested: scored.length,
    passingOffsets: distinct.map((c) => ({
      offsetTicks: c.offset,
      matchFraction: c.matches.length / frames.length,
      pointDelayP50Ms: percentile(
        c.matches.map((m) => m.encoded.atMs - m.written.writtenAtMs),
        50
      )
    }))
  }
  if (!best || fraction < rules.minimumMatchFraction)
    return refuse(
      'RTP timestamps are not derived from native VideoFrame timestamps in this run',
      evidence
    )
  // An unknown constant offset fixes pairing only up to a whole-frame shift.
  // When native pts are evenly spaced, several shifts pass: which native frame
  // each encoded frame carries is then NOT proven, so nothing is mapped.
  if (distinct.length > 1)
    return refuse(
      `Ambiguous: ${distinct.length} distinct RTP offsets each match >= ${rules.minimumMatchFraction * 100}% of encoded frames (evenly spaced native pts); the native-to-encoded pairing is not proven`,
      evidence
    )

  // Per matched frame: an interval from the drain's measured clock bracket.
  const samples = []
  const lower = []
  const upper = []
  let unbracketed = 0
  for (const { encoded: e, written: w } of best.matches) {
    const point = e.atMs - w.writtenAtMs
    const bracketed = finite(e.offsetLowMs) && finite(e.offsetHighMs)
    if (!bracketed) unbracketed++
    const low = bracketed ? e.atMs - e.offsetHighMs - w.writtenAtMs : null
    const high = bracketed ? e.atMs - e.offsetLowMs - w.writtenAtMs : null
    if (bracketed) {
      lower.push(low)
      upper.push(high)
    }
    samples.push({
      sequence: w.sequence,
      ptsUs: w.ptsUs,
      rtpTimestamp: e.rtpTimestamp,
      type: e.type ?? null,
      encodeDelayMs: { point, low, high }
    })
  }
  samples.sort((a, b) => a.ptsUs - b.ptsUs)

  const firstAt = frames[0].atMs
  const lastAt = frames[frames.length - 1].atMs
  let inside = 0
  let outside = 0
  for (const w of natives) {
    if (best.used.has(w.sequence)) continue
    if (w.writtenAtMs >= firstAt && w.writtenAtMs <= lastAt) inside++
    else outside++
  }
  return {
    ...base,
    status: 'mapped',
    offsetTicks: best.offset,
    ...counts,
    matched: best.matches.length,
    matchFraction: fraction,
    evidence,
    residualTicks: stats(best.residuals.map(Math.abs)),
    unmatched: {
      // Inside the observed window with a lossless observer ring: never encoded.
      droppedByEncoder: observerDropped === 0 ? inside : null,
      notObserved: outside + (observerDropped === 0 ? 0 : inside),
      encodedWithoutNative: frames.length - best.matches.length
    },
    encodeDelayMs: {
      bracketedFrames: lower.length,
      unbracketedFrames: unbracketed,
      point: stats(samples.map((s) => s.encodeDelayMs.point)),
      lower: stats(lower),
      upper: stats(upper)
    },
    samples: evenlySample(samples, rules.sampleLimit),
    samplesTruncated: samples.length > rules.sampleLimit
  }
}

export function encodeObservationGate(result, budget = ENCODE_OBSERVATION_BUDGET) {
  const common = {
    observed: OBSERVED,
    budget,
    limitation: PUBLISH_LIMITATION,
    packetizedSentTiming: 'unavailable'
  }
  if (!result || result.status !== 'mapped')
    return {
      ...common,
      status: 'unavailable',
      reason: result?.reason ?? 'No encoded-frame association was produced'
    }
  const upperP95 = result.encodeDelayMs?.upper?.p95
  if (!finite(upperP95))
    return {
      ...common,
      status: 'unavailable',
      reason: 'No matched frame has a measured clock bracket; the delay interval is unavailable'
    }
  const passed = upperP95 <= budget.encodeDelayUpperP95Ms
  return {
    ...common,
    status: passed ? 'passed' : 'failed',
    measured: { encodeDelayUpperP95Ms: upperP95, matched: result.matched },
    reason: passed
      ? `Encode delay upper p95 ${upperP95} ms is within the declared budget`
      : `Encode delay upper p95 ${upperP95} ms exceeds the declared budget of ${budget.encodeDelayUpperP95Ms} ms`
  }
}
