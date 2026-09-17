// Validity rules for vendor/ffmpeg/windows-pin.json, the committed pin the
// Windows bundle's FFmpeg is fetched from.
//
// BtbN/FFmpeg-Builds PRUNES its autobuild releases. Roughly the last two weeks
// of daily builds survive, plus the last build of each month, which is kept for
// years. A mid-month daily therefore works fine until it silently starts
// 404ing — which is exactly how every Windows installer build broke in August
// 2026, four minutes into each run, once the pinned 2026-07-23 build aged out.
// Pin month-end autobuilds only; they are the durable ones.
//
// A pin that points somewhere other than a BtbN autobuild (a mirror we host) is
// durable by construction, so the month-end rule does not apply to it. The
// LGPL-only rule always does: it mirrors scripts/build-ffmpeg-macos.sh, and the
// checksum is what actually authenticates the bytes.

const AUTOBUILD_DOWNLOAD =
  /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}\//

const SHA256 = /^[0-9a-f]{64}$/

/** Last calendar day of the given 1-indexed month (UTC, leap-year aware). */
export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * True when the URL is a BtbN autobuild that upstream retains long-term.
 * Non-BtbN URLs are not subject to the rule and report `null`.
 */
export function autobuildDurability(url) {
  const match = AUTOBUILD_DOWNLOAD.exec(String(url ?? ''))
  if (!match) {
    return null
  }
  const [, year, month, day] = match.map(Number)
  return {
    tagDate: `${match[1]}-${match[2]}-${match[3]}`,
    durable: day === lastDayOfMonth(year, month)
  }
}

/** Collect every reason the pin is unusable. Empty problems means it is fine. */
export function assessFfmpegWindowsPin(pin) {
  const problems = []
  const url = pin?.url
  const sha256 = pin?.sha256

  if (!url || typeof url !== 'string') {
    problems.push('missing "url"')
  }
  if (!sha256 || typeof sha256 !== 'string') {
    problems.push('missing "sha256"')
  } else if (!SHA256.test(sha256)) {
    problems.push(`"sha256" must be 64 lowercase hex characters, got "${sha256}"`)
  }
  if (typeof url === 'string' && url && !/lgpl/.test(url)) {
    problems.push(`not an LGPL build: ${url} (LGPL-only is the repo's ffmpeg policy)`)
  }

  const durability = autobuildDurability(url)
  if (durability && !durability.durable) {
    problems.push(
      `autobuild-${durability.tagDate} is a mid-month daily build, which BtbN deletes after ~2 weeks. ` +
        'Pin the last autobuild of a month instead — those are retained for years.'
    )
  }

  return { ok: problems.length === 0, problems }
}
