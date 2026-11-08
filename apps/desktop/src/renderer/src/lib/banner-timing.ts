import type { Banner } from '@/lib/backend'

// Plan 186 S10: the banner timer's words, for sponsor rotation. "Hide after"
// hides a banner that long after it shows; "Show every" shows it again on a
// cycle, only while a recording or a livestream runs. The backend owns the
// timer; the Scene inspector sets it, and the Scene row and the Assets tile
// say it in one line. Pure: no React, no backend client.

/** The two timer fields, both omitted when off. */
export type BannerTiming = Pick<Banner, 'hideAfterSec' | 'repeatEveryMin'>

/** "Hide after": Off, 10 s, 30 s, 1 min or 5 min, as `hideAfterSec`. 0 is Off. */
export const BANNER_HIDE_AFTER_CHOICES: readonly number[] = [0, 10, 30, 60, 300]

/** "Show every": Off, 5, 10, 15 or 30 min, as `repeatEveryMin`. 0 is Off. */
export const BANNER_REPEAT_CHOICES: readonly number[] = [0, 5, 10, 15, 30]

/** Why "Show every" waits: it runs only during a recording or a livestream. */
export const BANNER_REPEAT_DESCRIPTION = "Repeats only while you're recording or live."

/** Seconds as the app spells a span: "30 s", "1 min", "1 min 30 s". */
export function bannerSecondsLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** Minutes as the app spells a span: "15 min". */
export function bannerMinutesLabel(minutes: number): string {
  return `${minutes} min`
}

/**
 * The choices a timer's Select lists: the standard ones, plus a stored value
 * outside them, so the trigger never shows a blank.
 */
export function bannerTimingChoices(standard: readonly number[], current: number): number[] {
  if (standard.includes(current)) return [...standard]
  return [...standard, current].sort((a, b) => a - b)
}

/**
 * One line for a banner's timer, or null when both are off: "Shows for 30 s
 * every 15 min", "Every 15 min" or "Hides after 30 s". The Timing fold, the
 * Scene row and the Assets tile all say it this way.
 */
export function bannerTimingSummary(banner: BannerTiming): string | null {
  const hideAfter = banner.hideAfterSec ?? 0
  const repeat = banner.repeatEveryMin ?? 0
  if (hideAfter > 0 && repeat > 0) {
    return `Shows for ${bannerSecondsLabel(hideAfter)} every ${bannerMinutesLabel(repeat)}`
  }
  if (repeat > 0) return `Every ${bannerMinutesLabel(repeat)}`
  if (hideAfter > 0) return `Hides after ${bannerSecondsLabel(hideAfter)}`
  return null
}
