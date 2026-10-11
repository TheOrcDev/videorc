// In-app "What's new": pulls the published changelog from videorc-web
// (/api/changelog, fed by videorc changelog/ on each release) and decides
// when the post-update dialog should appear.

import { toast } from '@/lib/toast'
import { openVideorcWebLink, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

export const WHATS_NEW_STORAGE_KEY = 'videorc.whatsNewLastSeenVersion'

export const CHANGELOG_PLATFORMS = ['macos', 'windows', 'linux'] as const

export type ChangelogPlatform = (typeof CHANGELOG_PLATFORMS)[number]

export interface ChangelogEntry {
  version: string
  date: string
  channel: string
  platforms: ChangelogPlatform[]
  title: string
  summary: string
  highlights: string[]
}

// What the startup check should do given the running app version and the
// persisted last-seen version. 'initialize' = first run with this feature:
// remember the current version silently (never greet existing state with a
// backlog of releases); 'check' = we updated since last seen, ask the API.
export function resolveWhatsNewAction({
  version,
  lastSeen
}: {
  version: string | undefined
  lastSeen: string | null
}): 'idle' | 'initialize' | 'check' {
  if (!version) {
    return 'idle'
  }
  if (lastSeen === null) {
    return 'initialize'
  }
  return lastSeen === version ? 'idle' : 'check'
}

// null = the fetch failed (retry next launch); [] = a good answer with nothing
// new (safe to mark the current version as seen).
export async function fetchChangelogEntries({
  platform,
  since,
  fetchImpl = fetch
}: {
  platform: ChangelogPlatform
  since?: string
  fetchImpl?: typeof fetch
}): Promise<ChangelogEntry[] | null> {
  try {
    const url = since
      ? `${VIDEORC_WEB_LINKS.changelogApi}?since=${encodeURIComponent(since)}`
      : VIDEORC_WEB_LINKS.changelogApi
    const response = await fetchImpl(url)
    if (!response.ok) {
      return null
    }
    return filterChangelogEntriesByPlatform(parseChangelogEntries(await response.json()), platform)
  } catch {
    return null
  }
}

// Keeps only entries that match the published contract; one malformed entry
// must not break the dialog for the rest.
export function parseChangelogEntries(raw: unknown): ChangelogEntry[] {
  if (typeof raw !== 'object' || raw === null) {
    return []
  }
  const entries = (raw as { entries?: unknown }).entries
  if (!Array.isArray(entries)) {
    return []
  }
  return entries.flatMap((entry) => {
    const parsed = parseChangelogEntry(entry)
    return parsed ? [parsed] : []
  })
}

function parseChangelogEntry(candidate: unknown): ChangelogEntry | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null
  }
  const entry = candidate as Record<string, unknown>
  const platforms = parseChangelogPlatforms(entry.platforms)
  const valid =
    typeof entry.version === 'string' &&
    entry.version.length > 0 &&
    typeof entry.date === 'string' &&
    typeof entry.channel === 'string' &&
    platforms !== null &&
    typeof entry.title === 'string' &&
    entry.title.length > 0 &&
    typeof entry.summary === 'string' &&
    entry.summary.length > 0 &&
    Array.isArray(entry.highlights) &&
    entry.highlights.length > 0 &&
    entry.highlights.every((item) => typeof item === 'string' && item.length > 0)

  if (!valid) {
    return null
  }

  return {
    version: entry.version as string,
    date: entry.date as string,
    channel: entry.channel as string,
    platforms,
    title: entry.title as string,
    summary: entry.summary as string,
    highlights: entry.highlights as string[]
  }
}

function parseChangelogPlatforms(candidate: unknown): ChangelogPlatform[] | null {
  // Changelog schema v1 predates platform metadata. Every release in that
  // history was macOS-only, so keep it visible there without leaking it to
  // the Windows feed.
  if (candidate === undefined) {
    return ['macos']
  }
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return null
  }

  const platforms = candidate.filter(
    (item): item is ChangelogPlatform =>
      typeof item === 'string' &&
      CHANGELOG_PLATFORMS.some((knownPlatform) => knownPlatform === item)
  )
  if (platforms.length !== candidate.length || new Set(platforms).size !== candidate.length) {
    return null
  }
  return platforms
}

export function changelogPlatformForRuntime(
  runtimePlatform: string | undefined
): ChangelogPlatform | null {
  if (runtimePlatform === 'darwin') {
    return 'macos'
  }
  if (runtimePlatform === 'win32') {
    return 'windows'
  }
  if (runtimePlatform === 'linux') {
    return 'linux'
  }
  return null
}

export function filterChangelogEntriesByPlatform(
  entries: ChangelogEntry[],
  platform: ChangelogPlatform
): ChangelogEntry[] {
  return entries.filter((entry) => entry.platforms.includes(platform))
}

export interface WhatsNewResult {
  /** The newest release since the last seen one. */
  entry: ChangelogEntry
  /** The releases between the last seen one and `entry`, newest first (plan 174 A-19). */
  skippedVersions: string[]
}

type LastSeenStore = Pick<Storage, 'getItem' | 'setItem'>

/** The last seen version advances on a good answer or a dismissal, never on a failed fetch. */
export function markWhatsNewSeen(version: string, store: LastSeenStore = localStorage): void {
  store.setItem(WHATS_NEW_STORAGE_KEY, version)
}

/**
 * The post-update check (the hook's work, loaded on demand: plan 174
 * S3.21): nothing to show on an unchanged version; the first run with the
 * feature initializes silently; otherwise the entries published since the
 * last seen version, newest first, or null when the fetch failed (it retries
 * on the next launch).
 */
export async function checkWhatsNew({
  version,
  runtimePlatform,
  store = localStorage,
  fetchImpl
}: {
  version: string
  runtimePlatform: string | undefined
  store?: LastSeenStore
  fetchImpl?: typeof fetch
}): Promise<WhatsNewResult | null> {
  const lastSeen = store.getItem(WHATS_NEW_STORAGE_KEY)
  const action = resolveWhatsNewAction({ version, lastSeen })
  if (action === 'idle') {
    return null
  }
  if (action === 'initialize') {
    markWhatsNewSeen(version, store)
    return null
  }
  const platform = changelogPlatformForRuntime(runtimePlatform)
  if (!platform) {
    return null
  }
  const entries = await fetchChangelogEntries({ platform, since: lastSeen ?? undefined, fetchImpl })
  if (entries === null) {
    return null
  }
  if (entries.length === 0) {
    markWhatsNewSeen(version, store)
    return null
  }
  return { entry: entries[0], skippedVersions: entries.slice(1).map((entry) => entry.version) }
}

/** No notes in the app, so the way out is the website (plan 174 S2.4). */
function showReleaseNotesUnavailable(): void {
  toast.info("Release notes aren't available in Videorc right now", {
    id: 'whats-new-unavailable',
    action: {
      label: 'Open changelog',
      onClick: () => openVideorcWebLink(VIDEORC_WEB_LINKS.changelog)
    }
  })
}

/** The latest release for Settings → About, whatever was seen; a toast says when there is none. */
export async function latestWhatsNew(
  runtimePlatform: string | undefined
): Promise<WhatsNewResult | null> {
  const platform = changelogPlatformForRuntime(runtimePlatform)
  const entries = platform ? await fetchChangelogEntries({ platform }) : null
  if (!entries || entries.length === 0) {
    showReleaseNotesUnavailable()
    return null
  }
  return { entry: entries[0], skippedVersions: [] }
}

// "0.9.2-beta.1" -> "0.9.2 Beta 1", for the dialog title.
export function formatChangelogVersion(version: string): string {
  const [core = '', preRelease] = version.split('-')
  if (!preRelease) {
    return core
  }
  const [tag = '', number] = preRelease.split('.')
  const capitalized = tag.charAt(0).toUpperCase() + tag.slice(1)
  return number ? `${core} ${capitalized} ${number}` : `${core} ${capitalized}`
}
