import type { Banner, OverlayItem, OverlayLayout } from '@/lib/backend'
import {
  OVERLAY_ITEM_LABELS,
  overlayStartNotices,
  type OverlaySessionShape
} from '@/lib/overlay-layout'

// The Go Live sheet's D13 sentences with banners (plan 186, "Which leg
// carries a banner"). Every banner that is showing counts as one item, named
// `banners` mid-sentence, and each kind of sentence is said once however
// many banners would cause it. The Rust twin (`overlay_start_notices`) builds
// the same sentences byte for byte; `lib/overlay-layout.test.ts` pins them.
// This module is separate from `lib/overlay-layout.ts`, which is in the
// eager bundle: only the Go Live dialog (a lazy chunk) imports it.

export const BANNER_NOTICE_ITEM = 'banners'

/** What a Go Live notice is about: an overlay item, or every banner showing. */
export type StartNoticeItem = OverlayItem | typeof BANNER_NOTICE_ITEM

export interface StartNotice {
  item: StartNoticeItem
  notice: string
}

/** The notice's lead word in the sheet ("Highlight · …", "Banners · …"). */
export const START_NOTICE_LABELS: Record<StartNoticeItem, string> = {
  ...OVERLAY_ITEM_LABELS,
  banners: 'Banners'
}

/** How a sentence names banners mid-sentence (mirrors Rust). */
const BANNERS_SENTENCE_LABEL = 'banners'

/** A banner's two "Appears in" switches, and whether it is showing. */
export type BannerNoticeSwitches = Pick<Banner, 'shown' | 'showOnStream' | 'showInRecording'>

/**
 * Every D13 sentence the showing banners need for this session shape: a
 * banner whose switches differ follows the overlay leg plan, and the sheet
 * says what the shared leg will carry. A hidden banner, or one whose two
 * switches agree, needs none.
 */
export function bannerStartNotices(
  shape: OverlaySessionShape,
  banners: readonly BannerNoticeSwitches[]
): StartNotice[] {
  if (!(shape.recordEnabled && shape.streamEnabled) || shape.auxLeg === 'stream') return []
  const split = banners.filter(
    (banner) => banner.shown && banner.showOnStream !== banner.showInRecording
  )
  if (!split.length) return []
  const label = BANNERS_SENTENCE_LABEL
  if (shape.auxLeg === 'none') {
    return [
      {
        item: BANNER_NOTICE_ITEM,
        notice: `Both the stream and the recording will include ${label}: this computer shares one encode for them.`
      }
    ]
  }
  const notices: StartNotice[] = []
  if (split.some((banner) => banner.showOnStream))
    notices.push({
      item: BANNER_NOTICE_ITEM,
      notice: `Recording will include ${label} while streaming vertical.`
    })
  if (split.some((banner) => banner.showInRecording))
    notices.push({
      item: BANNER_NOTICE_ITEM,
      notice: `The horizontal stream will include ${label} while streaming vertical.`
    })
  return notices
}

/** The overlay items' notices, then the banners' (D5 draws banners under them). */
export function overlayAndBannerStartNotices(
  shape: OverlaySessionShape,
  layout: OverlayLayout,
  banners: readonly BannerNoticeSwitches[]
): StartNotice[] {
  return [...overlayStartNotices(shape, layout), ...bannerStartNotices(shape, banners)]
}
