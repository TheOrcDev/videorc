// Frame-cadence classification and freeze corroboration.
//
// Born from the 2026-07 "4K feels laggy" incident: the reported file had ZERO
// dropped/duplicated frames — it was a perfect 23.976fps CFR transfer of a camera
// whose HDMI output was set to 24p, while every intent in the chain said 30fps.
// Similarity-based freezedetect additionally flagged a person merely holding
// still as "freeze segments". Two lessons, two tools:
//
//   1. classifyFrameRate / cadenceMismatch — name the file's real cadence
//      (snapped to a broadcast-standard rate) and call out an intent mismatch
//      ("file is 23.976p, session intended 30p — camera HDMI likely set to 24p")
//      instead of leaving it implied by a frame-count percentage.
//   2. corroborateFreezes — a freezedetect segment only proves a *pipeline*
//      freeze when exact decoded-frame repeats (framemd5) overlap it. Similarity
//      hits without exact repeats are "still content", not defects.
//
// Pure logic only — no I/O — so it is unit-testable and mirrors cleanly into
// crates/videorc-backend/src/repair.rs (which keeps thresholds in sync).

/**
 * Broadcast/production frame rates the classifier snaps to. NTSC-family rates
 * use their exact rationals so 23.976/29.97/59.94 don't round away.
 */
export const STANDARD_FRAME_RATES = Object.freeze([
  { fps: 24000 / 1001, label: '23.976p (NTSC film)' },
  { fps: 24, label: '24p (film)' },
  { fps: 25, label: '25p (PAL)' },
  { fps: 30000 / 1001, label: '29.97p (NTSC)' },
  { fps: 30, label: '30p' },
  { fps: 48, label: '48p' },
  { fps: 50, label: '50p (PAL)' },
  { fps: 60000 / 1001, label: '59.94p (NTSC)' },
  { fps: 60, label: '60p' }
])

/**
 * Snap a measured rate to the nearest standard rate.
 * @param {number|null|undefined} fps
 * @param {number} [tolerancePct] max deviation from a standard rate to snap (percent)
 * @returns {{fps:number, label:string, deviationPct:number}|null} null when fps is
 *   not finite/positive or no standard rate is within tolerance (unstable cadence).
 */
export function classifyFrameRate(fps, tolerancePct = 0.5) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null
  let best = null
  for (const standard of STANDARD_FRAME_RATES) {
    const deviationPct = (Math.abs(fps - standard.fps) / standard.fps) * 100
    if (deviationPct <= tolerancePct && (best == null || deviationPct < best.deviationPct)) {
      best = { fps: standard.fps, label: standard.label, deviationPct }
    }
  }
  return best
}

/**
 * Compare the file's real cadence against the intended session rate.
 * 23.976 vs 24 (and 29.97 vs 30, 59.94 vs 60) count as matching — the NTSC
 * offset is a timebase convention, not a content-cadence problem.
 *
 * @param {number|null|undefined} containerFps the file's measured/nominal rate
 * @param {number|null|undefined} intendedFps the session's selected rate
 * @param {number} [tolerancePct] deviation that still counts as matching (percent)
 * @returns {{containerFps:number, intendedFps:number, deviationPct:number,
 *   containerLabel:string|null}|null} null when either rate is missing or they match.
 */
export function cadenceMismatch(containerFps, intendedFps, tolerancePct = 2) {
  if (
    typeof containerFps !== 'number' ||
    !Number.isFinite(containerFps) ||
    containerFps <= 0 ||
    typeof intendedFps !== 'number' ||
    !Number.isFinite(intendedFps) ||
    intendedFps <= 0
  ) {
    return null
  }
  const deviationPct = (Math.abs(containerFps - intendedFps) / intendedFps) * 100
  if (deviationPct <= tolerancePct) return null
  return {
    containerFps,
    intendedFps,
    deviationPct,
    containerLabel: classifyFrameRate(containerFps)?.label ?? null
  }
}

/**
 * Split freezedetect segments into pipeline-proven and similarity-only.
 *
 * A freeze segment [start, start+duration] is CORROBORATED when an exact
 * repeated-frame burst (framemd5) overlaps it — the decoder produced literally
 * identical frames, which a live camera/screen source never does on its own.
 * A similarity-only segment (no overlapping exact burst) is characteristic of
 * legitimately still content: a person holding still, a static screen region,
 * flat walls denoised by the encoder.
 *
 * @param {{start:number, duration:number}[]} freezes freezedetect segments (seconds)
 * @param {{startIndex:number, run:number}[]} repeatedBursts framemd5 bursts (frame indices)
 * @param {number|null|undefined} fps rate used to map burst frame indices to seconds
 * @returns {{corroborated:{start:number,duration:number}[],
 *   similarityOnly:{start:number,duration:number}[]}}
 */
export function corroborateFreezes(freezes, repeatedBursts, fps) {
  const segments = Array.isArray(freezes) ? freezes : []
  const bursts = Array.isArray(repeatedBursts) ? repeatedBursts : []
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || bursts.length === 0) {
    // Without a usable rate we cannot place bursts in time; with no bursts at all
    // every freeze is similarity-only by definition.
    return { corroborated: [], similarityOnly: [...segments] }
  }
  const frameInterval = 1 / fps
  const burstWindows = bursts.map((burst) => ({
    start: burst.startIndex * frameInterval - frameInterval,
    end: (burst.startIndex + burst.run) * frameInterval + frameInterval
  }))
  const corroborated = []
  const similarityOnly = []
  for (const freeze of segments) {
    const start = freeze.start
    const end = freeze.start + (freeze.duration ?? 0)
    const overlaps = burstWindows.some((window) => window.start <= end && window.end >= start)
    if (overlaps) {
      corroborated.push(freeze)
    } else {
      similarityOnly.push(freeze)
    }
  }
  return { corroborated, similarityOnly }
}

/** Longest duration (seconds) across segments, 0 when empty. */
export function longestSegmentSeconds(segments) {
  const items = Array.isArray(segments) ? segments : []
  return items.reduce((max, segment) => Math.max(max, segment.duration ?? 0), 0)
}
