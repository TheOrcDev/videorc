import type { BackendConnection, RecordingStatus, SessionSummary } from '@/lib/backend'
import { formatBytes, isActiveRecordingState } from '@/lib/format'

// Library table view logic (Library rewrite L4): filtering, sorting, search,
// selection, poster URLs, and the storage footer — all pure and unit-tested;
// the tab component is a thin shell.

export type LibraryFilter = 'all' | 'recordings' | 'streams'
export type LibrarySort = 'newest' | 'oldest'

export const LIBRARY_FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All sessions' },
  { value: 'recordings', label: 'Recordings' },
  { value: 'streams', label: 'Streams' }
]

export function matchesLibraryFilter(session: SessionSummary, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'recordings':
      return session.mode.includes('recording') || session.mode === 'imported'
    case 'streams':
      return session.mode.includes('streaming')
  }
}

export function filterLibrarySessions(
  sessions: SessionSummary[],
  filter: LibraryFilter,
  query: string
): SessionSummary[] {
  const needle = query.trim().toLowerCase()
  return sessions.filter(
    (session) =>
      matchesLibraryFilter(session, filter) &&
      (needle.length === 0 || session.title.toLowerCase().includes(needle))
  )
}

export function sortLibrarySessions(
  sessions: SessionSummary[],
  sort: LibrarySort
): SessionSummary[] {
  const sorted = [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  return sort === 'oldest' ? sorted : sorted.reverse()
}

/** "tee" is the internal ffmpeg fan-out container for record+stream sessions —
 * show the user what the file actually is instead (F-019). */
export function sessionFormatLabel(session: SessionSummary): string | null {
  if (session.mp4Path) {
    return 'MP4'
  }
  if (!session.container) {
    return null
  }
  return session.container.toLowerCase() === 'tee'
    ? 'MKV + stream'
    : session.container.toUpperCase()
}

/** The session being captured RIGHT NOW. A 'running' row that does not match
 * the active recording is stale (backend died mid-session; it gets reconciled
 * to 'failed' only on the next backend start) and must not claim to be live. */
export function isLiveSession(
  session: Pick<SessionSummary, 'id' | 'status'>,
  recording: Pick<RecordingStatus, 'state' | 'sessionId'>
): boolean {
  return (
    session.status === 'running' &&
    recording.sessionId === session.id &&
    isActiveRecordingState(recording.state)
  )
}

/** Row status label while a session is live. */
export function liveSessionLabel(state: RecordingStatus['state']): string {
  if (state === 'streaming') {
    return 'Streaming'
  }
  if (state === 'stopping') {
    return 'Finishing'
  }
  return 'Recording'
}

/** Poster over the backend's token-authenticated HTTP server; null while the
 * backend connection is down. durationMs busts the cache when a repair or
 * export replaces the file's poster later. */
export function sessionPosterUrl(
  connection: Pick<BackendConnection, 'port' | 'token'> | null,
  session: Pick<SessionSummary, 'id' | 'durationMs'>
): string | null {
  if (!connection) {
    return null
  }
  const params = new URLSearchParams({ token: connection.token })
  if (typeof session.durationMs === 'number') {
    params.set('v', String(session.durationMs))
  }
  return `http://127.0.0.1:${connection.port}/sessions/${encodeURIComponent(session.id)}/poster?${params}`
}

export function toggleLibrarySelection(selected: string[], sessionId: string): string[] {
  return selected.includes(sessionId)
    ? selected.filter((id) => id !== sessionId)
    : [...selected, sessionId]
}

/** Header checkbox semantics: all visible selected → clear; otherwise select
 * all visible (selection is scoped to what the current filter shows). */
export function toggleAllLibrarySelection(selected: string[], visibleIds: string[]): string[] {
  const everyVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  return everyVisibleSelected ? [] : [...visibleIds]
}

/** Honest storage footer: our recordings' real total + the disk's real free
 * space — never an invented quota. */
export function libraryStorageLabel(input: {
  count: number
  totalBytes: number
  freeBytes: number | null
}): string {
  const noun = input.count === 1 ? 'session' : 'sessions'
  const used = `${formatBytes(input.totalBytes)} of recordings`
  const free = typeof input.freeBytes === 'number' ? ` · ${formatBytes(input.freeBytes)} free` : ''
  return `${input.count} ${noun} · ${used}${free}`
}
