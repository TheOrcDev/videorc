import { BANNER_MAX_COUNT, type Banner } from '@/lib/backend'
import type { BannerImportPhase } from '@/lib/banner-import'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { OFFLINE_REASON, UserFacingError } from '@/lib/user-error'

// Plan 186: the banner words and rules every surface shares (Assets, the
// Scene page, the Stream Manager relay and the remotes). Pure: no React, no
// backend client. Never imported statically by eager code: the Studio
// provider loads it when a banner call fails, so it stays out of the shell.

/** Import refused at the cap (plan 186 D7, `BANNER_MAX_COUNT`). */
export const BANNER_COUNT_LIMIT_REASON = 'You have 24 banners. Delete one to import another.'
/** Show refused at the cap (plan 186 D7, `BANNER_MAX_SHOWN`). */
export const BANNER_SHOWN_LIMIT_REASON = 'Four banners are showing. Hide one first.'

/**
 * The backend's refusals, verbatim (plan 186 "Refusals"). Each one is "can't
 * now", so it shows as a warning with this sentence, never as an error or the
 * generic next step (plan 174 S2.4).
 */
export const BANNER_REFUSALS: readonly string[] = [
  "This file isn't a PNG, JPEG or WebP image.",
  "Animated images aren't supported yet. Export a still PNG.",
  'This image is too large. Use one under 25 MB and 40 megapixels.',
  'This image is too small. Use one at least 16 × 16 px.',
  BANNER_COUNT_LIMIT_REASON,
  BANNER_SHOWN_LIMIT_REASON,
  "This recording can't add banners after it starts. Show the banner before you press Record.",
  'Hide this banner before you delete it.'
]

/** The refusal sentence a failed `banners.*` call carries, or null for any other failure. */
export function bannerRefusal(error: unknown): string | null {
  const raw = ipcErrorMessage(error)
  return BANNER_REFUSALS.find((sentence) => raw.includes(sentence)) ?? null
}

/**
 * A refusal as the error `toastUserError` reads: its sentence, as a warning.
 * Null for any other failure, which keeps the generic copy.
 */
export function bannerRefusalError(error: unknown): UserFacingError | null {
  const sentence = bannerRefusal(error)
  return sentence ? new UserFacingError(sentence, 'warning') : null
}

/** The Import button's words: what it does, then what it is doing. */
export function bannerImportLabel(phase: BannerImportPhase): string {
  return phase === 'choosing'
    ? 'Choosing image…'
    : phase === 'importing'
      ? 'Importing…'
      : 'Import image…'
}

/**
 * Why Import is off, or null when it can run. Recording or being live never
 * blocks it (plan 182): only Videorc reconnecting, an import already running
 * and the 24-banner cap do.
 */
export function bannerImportBlockedReason(state: {
  offline: boolean
  phase: BannerImportPhase
  count: number
}): string | null {
  if (state.offline) return OFFLINE_REASON
  if (state.phase !== 'idle') return 'Wait for this import to finish.'
  if (state.count >= BANNER_MAX_COUNT) return BANNER_COUNT_LIMIT_REASON
  return null
}

/**
 * Every id in Assets order after moving `id` to `targetIndex` (clamped), for
 * `banners.reorder`; null when nothing moves. Assets order is also the drawing
 * order: later is on top, so the last index is "Bring to front".
 */
export function bannerOrderAfterMove(
  banners: readonly Pick<Banner, 'id'>[],
  id: string,
  targetIndex: number
): string[] | null {
  const ids = banners.map((banner) => banner.id)
  const from = ids.indexOf(id)
  const to = Math.max(0, Math.min(ids.length - 1, targetIndex))
  if (from === -1 || from === to) return null
  ids.splice(from, 1)
  ids.splice(to, 0, id)
  return ids
}
