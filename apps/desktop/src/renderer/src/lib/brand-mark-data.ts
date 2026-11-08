import youtubeIconData from '../assets/brand/youtube/youtube-icon-red.svg?inline'
import xLogoWhiteData from '../assets/brand/x/x-logo-white.svg?inline'
import verifiedBusinessData from '../assets/brand/x/verified-business-gold.svg?inline'
import verifiedGovernmentData from '../assets/brand/x/verified-government-gray.svg?inline'
import verifiedPremiumData from '../assets/brand/x/verified-premium-blue.svg?inline'

import type { LiveChatAuthorVerified } from '@/lib/backend'

// The brand marks the on-stream highlight card draws on a canvas, as data
// URIs: the packaged renderer is a file:// page, and a file image would taint
// the canvas it reads back. Only the card (a lazy chunk) imports this module,
// so these copies stay out of the eager bundle; the React marks use the files
// in youtube-mark.ts and x-mark.ts. The art is the same unmodified files.

/** YouTube's official icon (plan 165), for the card. */
export const YOUTUBE_ICON_DATA_URL: string = youtubeIconData

/** The X mark in white, for the card. */
export const X_LOGO_WHITE_DATA_URL: string = xLogoWhiteData

/** X's verified checks, for the card. Never tinted. */
export const X_VERIFIED_DATA_URL: Record<LiveChatAuthorVerified, string> = {
  blue: verifiedPremiumData,
  business: verifiedBusinessData,
  government: verifiedGovernmentData
}
