// Update feed routes.
//
// videorc-web answers /api/updates/* with a redirect to the primary release
// storage origin and /api/updates/mirror/* with a redirect to the second one.
// Court-ordered IP blocks (Spain, matchday evenings) intercept whole storage
// providers, so when the primary route fails in transport the updater retries
// once on the mirror. electron-updater resolves the update file relative to
// the feed base, which is why the mirror is a path and not a query string.

export const PRIMARY_UPDATE_FEED_URL = 'https://www.videorc.com/api/updates/'
export const MIRROR_UPDATE_FEED_URL = 'https://www.videorc.com/api/updates/mirror/'

export type UpdateFeedRoute = 'primary' | 'mirror'

export const UPDATE_FEED_URLS: Record<UpdateFeedRoute, string> = {
  mirror: MIRROR_UPDATE_FEED_URL,
  primary: PRIMARY_UPDATE_FEED_URL
}

// Failures that say something about the update itself. A second origin serves
// the same signed bytes, so retrying these elsewhere is never the answer, and
// an integrity failure must stay loud.
const NON_TRANSPORT_FAILURE = [
  'cannot find channel',
  'checksum mismatch',
  'sha512',
  'sha256',
  'code signature',
  'not signed',
  'signature',
  'update info',
  'no published versions',
  'cancelled',
  'canceled',
  'enospc',
  'eacces',
  'eperm'
]

const TRANSPORT_FAILURE = [
  // Chromium network stack (Electron net): certificate, reset, timeout, DNS.
  'net::err_',
  // Node-level socket errors surfaced by the differential downloader.
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'eai_again',
  'epipe',
  'socket hang up',
  'timed out',
  'timeout',
  'self signed certificate',
  'self-signed certificate',
  'unable to verify',
  'cert_',
  'certificate'
]

// The storage origin itself refusing or failing the redirected request: an
// expired presign or an origin outage (403/5xx). A 404 is a missing object, not
// a blocked path.
const STORAGE_STATUS_FAILURE = /\b(?:status code|http ?error:?|httperror:?)\s*(?:403|5\d\d)\b/

export function isUpdateTransportFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  if (NON_TRANSPORT_FAILURE.some((marker) => normalized.includes(marker))) {
    return false
  }
  return (
    TRANSPORT_FAILURE.some((marker) => normalized.includes(marker)) ||
    STORAGE_STATUS_FAILURE.test(normalized)
  )
}

// The pilot feed carries an operator bearer that must stay on the branded
// proxy, and a failure on the mirror has nowhere further to go.
export function shouldRetryUpdateOnMirror(input: {
  message: string
  pilot: boolean
  route: UpdateFeedRoute
}): boolean {
  return !input.pilot && input.route === 'primary' && isUpdateTransportFailure(input.message)
}
