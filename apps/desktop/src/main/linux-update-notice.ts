// Linux "a newer version is available" notice.
//
// Linux builds never update themselves: no `latest-linux.yml` feed is
// published, and the Alpha AppImage is a sign-in download. Instead the app
// asks the public, unauthenticated changelog (videorc-web /api/changelog,
// compiled from changelog/ on each release) for the newest entry that names
// `linux`, and says so in Settings → About with a link to the downloads page.
// It never downloads anything.
//
// The changelog only publishes a Linux entry once that Linux release is
// public, so an entry is the release process's own "this version is out"
// signal. Until the changelog lists the running Linux line, the check proves
// nothing either way and reports 'unknown': never "You're on the latest
// version" on a guess, and never a version that was not published.
//
// Pure and electron-free so it is unit-testable; updater.ts wires it up.

import type { UpdateStatus } from '../shared/backend'

export const LINUX_UPDATE_NOTICE_URL = 'https://www.videorc.com/api/changelog'
// Dev-only override, for the fake-endpoint verification. Packaged builds
// refuse it (see linuxUpdateNoticeSource).
export const LINUX_UPDATE_NOTICE_URL_ENV = 'VIDEORC_LINUX_UPDATE_NOTICE_URL'
export const LINUX_UPDATE_NOTICE_TIMEOUT_MS = 15_000

interface ReleaseVersion {
  core: [number, number, number]
  preRelease: Array<string | number>
}

const RELEASE_VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseReleaseVersion(version: string): ReleaseVersion | null {
  const match = RELEASE_VERSION.exec(version.trim())
  if (!match) {
    return null
  }
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number]
  if (!core.every(Number.isSafeInteger)) {
    return null
  }
  const preRelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []
  return { core, preRelease }
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.sign(a - b)
  }
  // Numeric identifiers sort before alphanumeric ones (semver 11.4.3).
  if (typeof a === 'number') {
    return -1
  }
  if (typeof b === 'number') {
    return 1
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence: <0 when a is older, 0 when equal, >0 when newer. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = Math.sign(a.core[index] - b.core[index])
    if (difference !== 0) {
      return difference
    }
  }
  // A release outranks any pre-release of the same core.
  if (a.preRelease.length === 0 || b.preRelease.length === 0) {
    return Math.sign(b.preRelease.length - a.preRelease.length)
  }
  const length = Math.max(a.preRelease.length, b.preRelease.length)
  for (let index = 0; index < length; index += 1) {
    if (a.preRelease[index] === undefined) {
      return -1
    }
    if (b.preRelease[index] === undefined) {
      return 1
    }
    const difference = compareIdentifiers(a.preRelease[index], b.preRelease[index])
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/**
 * Whether a published release is newer than the running app. A Linux
 * AppImage reports its package version (0.14.0) for the release id it shipped
 * as (0.14.0-alpha.1), so against a running version with no pre-release only
 * the core counts: 0.14.0-alpha.2 is not news to a 0.14.0 build.
 */
export function isNewerRelease(published: string, running: string): boolean {
  const candidate = parseReleaseVersion(published)
  const current = parseReleaseVersion(running)
  if (!candidate || !current) {
    return false
  }
  if (current.preRelease.length === 0) {
    return compareReleaseVersions({ core: candidate.core, preRelease: [] }, current) > 0
  }
  return compareReleaseVersions(candidate, current) > 0
}

function sameReleaseLine(published: ReleaseVersion, running: ReleaseVersion): boolean {
  return published.core.every((part, index) => part === running.core[index])
}

export type LinuxVersionCheck =
  | { kind: 'newer'; version: string }
  | { kind: 'current' }
  /** The source failed, or does not list this Linux line: say nothing either way. */
  | { kind: 'unknown' }

/**
 * Reads the /api/changelog answer. 'newer' needs a published Linux entry newer
 * than the running build; 'current' needs the running build's own line to be
 * listed for Linux with nothing newer, which proves the changelog publishes
 * Linux releases at all.
 */
export function evaluateLinuxChangelog(raw: unknown, runningVersion: string): LinuxVersionCheck {
  const running = parseReleaseVersion(runningVersion)
  if (!running || typeof raw !== 'object' || raw === null) {
    return { kind: 'unknown' }
  }
  const entries = (raw as { entries?: unknown }).entries
  if (!Array.isArray(entries)) {
    return { kind: 'unknown' }
  }

  let newest: { version: string; parsed: ReleaseVersion } | null = null
  let listsRunningLine = false
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { version, platforms } = entry as { version?: unknown; platforms?: unknown }
    if (typeof version !== 'string' || !Array.isArray(platforms) || !platforms.includes('linux')) {
      continue
    }
    const parsed = parseReleaseVersion(version)
    if (!parsed) {
      continue
    }
    if (sameReleaseLine(parsed, running)) {
      listsRunningLine = true
    }
    if (isNewerRelease(version, runningVersion)) {
      if (!newest || compareReleaseVersions(parsed, newest.parsed) > 0) {
        newest = { version, parsed }
      }
    }
  }

  if (newest) {
    return { kind: 'newer', version: newest.version }
  }
  return listsRunningLine ? { kind: 'current' } : { kind: 'unknown' }
}

/**
 * The changelog URL, asking only for entries from the running line on
 * (`since` is exclusive and release-id shaped, so `<core>-alpha.0` keeps the
 * running line's own entries). The answer is still filtered here, so a server
 * that ignores `since` only costs bytes.
 */
export function linuxUpdateNoticeUrl(baseUrl: string, runningVersion: string): string {
  const running = parseReleaseVersion(runningVersion)
  if (!running) {
    return baseUrl
  }
  const url = new URL(baseUrl)
  url.searchParams.set('since', `${running.core.join('.')}-alpha.0`)
  return url.toString()
}

/**
 * Where the check goes, or null when it must not run. Packaged Linux builds
 * always ask videorc.com; a dev run checks only when pointed at a local
 * endpoint, so `pnpm dev` never calls production.
 */
export function linuxUpdateNoticeSource(
  env: Record<string, string | undefined>,
  isPackaged: boolean
): string | null {
  if (isPackaged) {
    return LINUX_UPDATE_NOTICE_URL
  }
  const override = env[LINUX_UPDATE_NOTICE_URL_ENV]?.trim()
  return override ? override : null
}

/** One check. Offline, a timeout, a 401/404 or a malformed answer are all 'unknown', quietly. */
export async function checkLinuxUpdateNotice({
  sourceUrl,
  runningVersion,
  fetchImpl,
  timeoutMs = LINUX_UPDATE_NOTICE_TIMEOUT_MS
}: {
  sourceUrl: string
  runningVersion: string
  fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  timeoutMs?: number
}): Promise<LinuxVersionCheck> {
  try {
    const response = await fetchImpl(linuxUpdateNoticeUrl(sourceUrl, runningVersion), {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      return { kind: 'unknown' }
    }
    return evaluateLinuxChangelog(await response.json(), runningVersion)
  } catch {
    return { kind: 'unknown' }
  }
}

/** The Settings status for a check's outcome. */
export function linuxUpdateNoticeStatus(
  check: LinuxVersionCheck,
  runningVersion: string
): UpdateStatus {
  switch (check.kind) {
    case 'newer':
      return { phase: 'download-available', version: check.version }
    case 'current':
      return { phase: 'not-available', currentVersion: runningVersion }
    case 'unknown':
      return { phase: 'unsupported', reason: 'linux-version-unknown' }
  }
}
