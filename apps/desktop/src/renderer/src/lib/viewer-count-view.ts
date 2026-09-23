import type { ViewerSample } from '@/lib/backend'

// Viewer rider V2: chip presentation rules. Terminology honesty — the count
// is concurrent VIEWERS ("watching"), never "subs". A sample older than 2×
// the sampler cadence greys out instead of freezing at a confident number.

const SAMPLE_STALE_AFTER_MS = 75_000

export function formatViewerCount(count: number): string {
  // Promote on the ROUNDED value: 999,999 is "1m", never "1000k".
  if (count >= 999_950) {
    return `${compactUnit(count / 1_000_000)}m`
  }
  if (count >= 1_000) {
    return `${compactUnit(count / 1_000)}k`
  }
  return String(count)
}

function compactUnit(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function viewerSampleStale(sample: ViewerSample, nowMs: number): boolean {
  const at = Date.parse(sample.at)
  if (!Number.isFinite(at)) {
    return true
  }
  return nowMs - at > SAMPLE_STALE_AFTER_MS
}

/** The number alone: what a narrow Chat header keeps when "watching" drops. */
export function viewerChipCount(sample: ViewerSample): string {
  return formatViewerCount(sample.total)
}

export function viewerChipLabel(sample: ViewerSample): string {
  return `${viewerChipCount(sample)} watching`
}

export function viewerChipDetail(sample: ViewerSample): string {
  return sample.platforms
    .map((entry) => `${entry.platform}: ${formatViewerCount(entry.count)}`)
    .join(' · ')
}
