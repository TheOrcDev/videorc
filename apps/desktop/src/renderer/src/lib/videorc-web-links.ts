// Single source of truth for Videorc product web URLs (account, login, premium,
// billing). Don't scatter https://videorc.com/... across components — import from
// here so the origin and paths live in exactly one place (Account Dropdown plan).

// Dev builds default to a local videorc-web (matching the Rust API base URL) so
// sign-in testing is zero-config; override with VITE_VIDEORC_WEB_ORIGIN. Packaged
// builds always use production.
//
// LAUNCHED (2026-07-07): the live web app is videorc.com. The WWW host is
// deliberate — the apex 307-redirects every path to www.videorc.com, and
// redirect hops drop Authorization headers in some clients; bake the host
// that answers directly.
const DEV_ORIGIN_OVERRIDE = (import.meta.env as Record<string, string | undefined>)
  .VITE_VIDEORC_WEB_ORIGIN
const VIDEORC_WEB_ORIGIN =
  import.meta.env.MODE === 'development'
    ? (DEV_ORIGIN_OVERRIDE ?? 'http://localhost:3000')
    : 'https://www.videorc.com'

export const VIDEORC_WEB_LINKS = {
  account: `${VIDEORC_WEB_ORIGIN}/account`,
  login: `${VIDEORC_WEB_ORIGIN}/login`,
  // Desktop sign-in entry point: explicit consent returns only a short-lived,
  // state + PKCE-bound opaque code through the videorc:// deep-link. The app
  // exchanges it server-to-server; browser and deep-link never carry a session.
  desktopAuthorize: `${VIDEORC_WEB_ORIGIN}/desktop/authorize/v2`,
  premium: `${VIDEORC_WEB_ORIGIN}/premium`,
  privacy: `${VIDEORC_WEB_ORIGIN}/privacy`,
  terms: `${VIDEORC_WEB_ORIGIN}/terms`,
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
