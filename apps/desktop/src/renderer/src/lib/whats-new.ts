// In-app "What's new": pulls the published changelog from videorc-web
// (/api/changelog, fed by videorc changelog/ on each release) and decides
// when the post-update dialog should appear.

import { VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

export const WHATS_NEW_STORAGE_KEY = 'videorc.whatsNewLastSeenVersion'

export interface ChangelogEntry {
  version: string
  date: string
  channel: string
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
  since,
  fetchImpl = fetch
}: {
  since?: string
  fetchImpl?: typeof fetch
} = {}): Promise<ChangelogEntry[] | null> {
  try {
    const url = since
      ? `${VIDEORC_WEB_LINKS.changelogApi}?since=${encodeURIComponent(since)}`
      : VIDEORC_WEB_LINKS.changelogApi
    const response = await fetchImpl(url)
    if (!response.ok) {
      return null
    }
    return parseChangelogEntries(await response.json())
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
  return entries.filter(isChangelogEntry).map((entry) => ({
    version: entry.version,
    date: entry.date,
    channel: entry.channel,
    title: entry.title,
    summary: entry.summary,
    highlights: entry.highlights
  }))
}

function isChangelogEntry(candidate: unknown): candidate is ChangelogEntry {
  if (typeof candidate !== 'object' || candidate === null) {
    return false
  }
  const entry = candidate as Record<string, unknown>
  return (
    typeof entry.version === 'string' &&
    entry.version.length > 0 &&
    typeof entry.date === 'string' &&
    typeof entry.channel === 'string' &&
    typeof entry.title === 'string' &&
    entry.title.length > 0 &&
    typeof entry.summary === 'string' &&
    entry.summary.length > 0 &&
    Array.isArray(entry.highlights) &&
    entry.highlights.length > 0 &&
    entry.highlights.every((item) => typeof item === 'string' && item.length > 0)
  )
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
