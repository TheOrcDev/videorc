import xLockupDarkUrl from '../assets/brand/x/x-logo-lockup-white-on-black.svg'
import xLockupLightUrl from '../assets/brand/x/x-logo-lockup-black-on-white.svg'
import xLogoWhiteUrl from '../assets/brand/x/x-logo-white.svg'
import verifiedBusinessUrl from '../assets/brand/x/verified-business-gold.svg'
import verifiedGovernmentUrl from '../assets/brand/x/verified-government-gray.svg'
import verifiedPremiumUrl from '../assets/brand/x/verified-premium-blue.svg'

import type { LiveChatAuthorVerified } from '@/lib/backend'

// X's partner icon kit (plan 167): the mark, its app-icon lockups and the
// verified checks, shared by the React marks and the on-stream highlight
// card. The files are X's, unmodified. See assets/brand/x/README.md.

/** The X mark's one path on its 24 x 24 grid, as in every kit logo file. */
export const X_MARK_PATH =
  'm21.62 21.5-7.47-10.9 6.97-8.1H18.7l-5.62 6.54L8.6 2.5H2.48L9.68 13l-7.3 8.5H4.8l5.96-6.93 4.76 6.93zM7.8 4.03l10.93 15.94H16.3L5.38 4.03z'

/** The mark in white, for dark surfaces that are not React (the stream card). */
export const X_LOGO_WHITE_URL: string = xLogoWhiteUrl

/** The rounded-square app-icon lockups: white on black for dark mode, black
 * on white for light mode. */
export const X_LOCKUP_URL = { dark: xLockupDarkUrl, light: xLockupLightUrl } as const

/** X's verified checks, in X's production colours. Never tinted. */
export const X_VERIFIED_URL: Record<LiveChatAuthorVerified, string> = {
  blue: verifiedPremiumUrl,
  business: verifiedBusinessUrl,
  government: verifiedGovernmentUrl
}

/** What each check means, for its alt text and hover title. */
export const X_VERIFIED_LABEL: Record<LiveChatAuthorVerified, string> = {
  blue: 'Verified on X',
  business: 'Verified organization on X',
  government: 'Government account on X'
}

/** The kit's minimum size for the X mark. */
export const X_MARK_MIN_PX = 16
