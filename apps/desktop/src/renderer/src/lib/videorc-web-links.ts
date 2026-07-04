// Single source of truth for Videorc product web URLs (account, login, premium,
// billing). Don't scatter https://videorc.com/... across components — import from
// here so the origin and paths live in exactly one place (Account Dropdown plan).

// Dev builds default to a local videorc-web (matching the Rust API base URL) so
// sign-in testing is zero-config; override with VITE_VIDEORC_WEB_ORIGIN. Packaged
// builds always use production.
//
// BETA: the live web app (account, auth bridge, premium, updates feed) is the
// Vercel host; videorc.com is only a teaser landing page until launch. Switch
// this to https://videorc.com when we ship.
const DEV_ORIGIN_OVERRIDE = (import.meta.env as Record<string, string | undefined>)
  .VITE_VIDEORC_WEB_ORIGIN
const VIDEORC_WEB_ORIGIN =
  import.meta.env.MODE === 'development'
    ? (DEV_ORIGIN_OVERRIDE ?? 'http://localhost:3000')
    : 'https://videorc-web.vercel.app'

export const VIDEORC_WEB_LINKS = {
  account: `${VIDEORC_WEB_ORIGIN}/account`,
  login: `${VIDEORC_WEB_ORIGIN}/login`,
  // Desktop sign-in entry point: signs in, then hands a one-time token back to
  // the app through the videorc:// deep-link (Desktop Auth Token Bridge plan).
  desktopAuthorize: `${VIDEORC_WEB_ORIGIN}/desktop/authorize`,
  premium: `${VIDEORC_WEB_ORIGIN}/premium`,
  billing: `${VIDEORC_WEB_ORIGIN}/account/billing`,
  // Published changelog (compiled from videorc changelog/ on each release):
  // JSON for the in-app What's New, pages for humans.
  changelogApi: `${VIDEORC_WEB_ORIGIN}/api/changelog`,
  changelog: `${VIDEORC_WEB_ORIGIN}/changelog`
} as const

export function releaseNotesUrl(version: string): string {
  return `${VIDEORC_WEB_ORIGIN}/releases/${version}`
}

export type VideorcWebLink = keyof typeof VIDEORC_WEB_LINKS

// Re-exported by premium-upgrade.ts so existing
// `import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'` callers keep working.
export const VIDEORC_PREMIUM_URL = VIDEORC_WEB_LINKS.premium

// Open a Videorc web link in the user's browser. Uses the main-process opener
// (the same path premium/OAuth links already use); falls back to window.open
// outside Electron.
export function openVideorcWebLink(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}
