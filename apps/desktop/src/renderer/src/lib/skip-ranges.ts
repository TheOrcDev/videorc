// Virtual-preview range math for the session player (plan 119, S11).
//
// Clean cut review plays the source recording while skipping the spans the
// cut list removes, so the user hears the edit before it renders. Pure and
// framework-free: the player feeds it the playhead on each video frame and
// seeks to whatever this returns.

export type SkipRange = { startMs: number; endMs: number }

/**
 * Sorted, merged, non-empty ranges clamped to `[0, durationMs]`. Touching and
 * overlapping ranges become one, so a jump out of a range never lands inside
 * the next; invalid or empty ranges are dropped.
 */
export function normalizeSkipRanges(
  ranges: readonly SkipRange[] | null | undefined,
  durationMs?: number
): SkipRange[] {
  if (!ranges || ranges.length === 0) return []
  const limit =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : Number.POSITIVE_INFINITY
  const cleaned: SkipRange[] = []
  for (const range of ranges) {
    if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs)) continue
    const startMs = Math.max(0, range.startMs)
    const endMs = Math.min(limit, range.endMs)
    if (endMs <= startMs) continue
    cleaned.push({ startMs, endMs })
  }
  cleaned.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  const merged: SkipRange[] = []
  for (const range of cleaned) {
    const last = merged[merged.length - 1]
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
      continue
    }
    merged.push({ startMs: range.startMs, endMs: range.endMs })
  }
  return merged
}

/**
 * Where playback jumps when `positionMs` sits inside a removed range (its
 * end), or null when it plays kept content. `ranges` must be normalized.
 * `lookaheadMs` treats a position that close before a range as inside it, so
 * a player can jump before the first removed frame is shown. The target is
 * always ahead of the position, so playback never loops back.
 */
export function skipTargetMs(
  ranges: readonly SkipRange[],
  positionMs: number,
  lookaheadMs = 0
): number | null {
  if (!Number.isFinite(positionMs)) return null
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const range = ranges[middle]
    if (positionMs < range.startMs - lookaheadMs) {
      high = middle - 1
    } else if (positionMs >= range.endMs) {
      low = middle + 1
    } else {
      return range.endMs
    }
  }
  return null
}

/** Total removed time of normalized ranges. */
export function skippedDurationMs(ranges: readonly SkipRange[]): number {
  let total = 0
  for (const range of ranges) total += range.endMs - range.startMs
  return total
}

/** The length of the virtual preview: the recording minus what is skipped. */
export function keptDurationMs(durationMs: number, ranges: readonly SkipRange[]): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  return Math.max(0, durationMs - skippedDurationMs(normalizeSkipRanges(ranges, durationMs)))
}
