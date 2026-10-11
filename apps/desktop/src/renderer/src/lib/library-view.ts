import type {
  BackendConnection,
  CleanCutJob,
  CleanCutMode,
  GateStatus,
  RecordingStatus,
  SessionSummary
} from '@/lib/backend'
import { isCleanCutJobActive } from '@/lib/clean-cut-view'
import { formatBytes, isActiveRecordingState, plural } from '@/lib/format'
import { isCommandKey } from '@/lib/platform'
import { sessionModeRecorded, sessionModeStreamed } from '@/lib/session-modes'

// Library table view logic (Library rewrite L4; plan 174 S3.11): filtering,
// sorting, search, the desktop selection model, the partial-results notice,
// Clean cut holds, poster URLs, and the storage footer. All pure and
// unit-tested; the tab component is a thin shell.

export type LibraryFilter = 'all' | 'recordings' | 'streams'
export type LibrarySort = 'newest' | 'oldest'

/** Every Library item is a recording (the glossary); the filter says how it was made. */
export const LIBRARY_FILTERS: { value: LibraryFilter; label: string }[] = [
  { value: 'all', label: 'All recordings' },
  { value: 'recordings', label: 'Recorded' },
  { value: 'streams', label: 'Livestreamed' }
]

export const LIBRARY_SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' }
]

/** A recording's name, or the one placeholder for a recording with none. */
export function libraryTitle(session: Pick<SessionSummary, 'title'>): string {
  return session.title.trim() || 'Untitled recording'
}

/** Go Live records too: a `record+stream` session is in Recordings and in
 * Streams. */
export function matchesLibraryFilter(
  session: Pick<SessionSummary, 'mode'>,
  filter: LibraryFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'recordings':
      return sessionModeRecorded(session.mode)
    case 'streams':
      return sessionModeStreamed(session.mode)
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

/** A session that went out live has a Buddy report to open (plan 119 S3):
 * stored modes are `stream` and `record+stream`, older rows `streaming`. */
export function hasBuddyReport(session: Pick<SessionSummary, 'mode'>): boolean {
  return sessionModeStreamed(session.mode)
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
  const used = formatBytes(input.totalBytes)
  const free = typeof input.freeBytes === 'number' ? ` · ${formatBytes(input.freeBytes)} free` : ''
  return `${plural(input.count, 'recording')} · ${used}${free}`
}

// --- What the list shows (plan 174 S3.11, J2-8, E-17) ---------------------------

export type LibraryListState = 'rows' | 'loading' | 'offline' | 'empty'

/**
 * "No recordings yet" only once the first page has arrived (J2-8): before
 * that the list is loading, or Videorc is reconnecting.
 */
export function libraryListState(input: {
  count: number
  /** The first page arrived (its storage totals ride with it). */
  loaded: boolean
  online: boolean
}): LibraryListState {
  if (input.count > 0) return 'rows'
  if (!input.online) return 'offline'
  return input.loaded ? 'empty' : 'loading'
}

/**
 * Search, filter and the oldest-first sort only see the pages loaded so far
 * (E-17), so the list says so until the backend takes them: "Searched the 50
 * newest recordings." Null when nothing is narrowed or everything is loaded.
 */
export function libraryPartialNotice(input: {
  loadedCount: number
  hasMore: boolean
  filter: LibraryFilter
  query: string
  sort: LibrarySort
}): string | null {
  if (!input.hasMore) return null
  const scope = `the ${plural(input.loadedCount, 'newest recording', 'newest recordings')}`
  if (input.query.trim()) return `Searched ${scope}.`
  if (input.filter !== 'all') return `Filtered ${scope}.`
  if (input.sort === 'oldest') return `Sorted ${scope}.`
  return null
}

/** The no-results state's one button: it clears what hid the rows. */
export function libraryClearLabel(filter: LibraryFilter, query: string): string {
  const searching = query.trim().length > 0
  const filtering = filter !== 'all'
  if (searching && filtering) return 'Clear search and filter'
  return filtering ? 'Clear filter' : 'Clear search'
}

/**
 * A finished noise cleanup shows its copy only when that cannot undo the
 * streamer's own search or filter (E-19): an explicit "show this recording"
 * still clears them.
 */
export function revealsFinishedCleanup(filter: LibraryFilter, query: string): boolean {
  return filter === 'all' && query.trim().length === 0
}

// --- Desktop selection (E-16, E-18) --------------------------------------------

export type LibraryPickModifier = 'replace' | 'toggle' | 'range'

export interface LibrarySelection {
  selected: string[]
  /** Where a ⇧-click or ⇧-arrow range starts. */
  anchor: string | null
}

/** The modifier a click carries: ⇧ extends a range, ⌘ (Ctrl off macOS) toggles. */
export function libraryPickModifier(
  event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  platform?: string
): LibraryPickModifier {
  if (event.shiftKey) return 'range'
  return isCommandKey(event, platform) ? 'toggle' : 'replace'
}

/**
 * A click (or an arrow) on one row, desktop style: a plain pick selects only
 * that row, a toggle adds or removes it, a range selects from the anchor to
 * it over the rows in view. Rows that can't be selected (live, locked, busy)
 * are skipped, never added.
 */
export function pickLibraryRow(
  current: LibrarySelection,
  input: {
    id: string
    modifier: LibraryPickModifier
    orderedIds: readonly string[]
    selectable: ReadonlySet<string>
  }
): LibrarySelection {
  const { id, modifier, orderedIds, selectable } = input
  if (modifier === 'toggle') {
    if (!selectable.has(id)) return { selected: current.selected, anchor: id }
    return { selected: toggleLibrarySelection(current.selected, id), anchor: id }
  }
  if (modifier === 'range') {
    const anchor = current.anchor ?? id
    const from = orderedIds.indexOf(anchor)
    const to = orderedIds.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [start, end] = from <= to ? [from, to] : [to, from]
      return {
        selected: orderedIds.slice(start, end + 1).filter((rowId) => selectable.has(rowId)),
        anchor
      }
    }
  }
  return { selected: selectable.has(id) ? [id] : [], anchor: id }
}

export type LibraryRowMove = 'next' | 'previous' | 'first' | 'last'

/** The row an arrow, Home or End lands on; null when there are none. */
export function libraryRowAfterMove(
  orderedIds: readonly string[],
  activeId: string | null,
  move: LibraryRowMove
): string | null {
  if (orderedIds.length === 0) return null
  if (move === 'first') return orderedIds[0]
  if (move === 'last') return orderedIds[orderedIds.length - 1]
  const index = activeId === null ? -1 : orderedIds.indexOf(activeId)
  if (index === -1) return orderedIds[0]
  const next = move === 'next' ? index + 1 : index - 1
  return orderedIds[Math.min(orderedIds.length - 1, Math.max(0, next))]
}

export type LibraryKeyCommand =
  | { kind: 'move'; move: LibraryRowMove; extend: boolean }
  | { kind: 'toggle' }
  | { kind: 'select-all' }
  | { kind: 'clear' }
  | { kind: 'rename' }
  | { kind: 'delete' }

/**
 * The keys a focused Library row answers (E-16): ↑/↓, Home and End move
 * (⇧ extends the selection), Space toggles the row, ⌘A selects every row in
 * view, Escape clears, Return renames and ⌘⌫ (or Delete) asks to delete.
 */
export function libraryKeyCommand(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  platform?: string
): LibraryKeyCommand | null {
  const command = isCommandKey(event, platform)
  if (event.altKey) return null
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'Home':
    case 'End': {
      if (command) return null
      const move: Record<string, LibraryRowMove> = {
        ArrowDown: 'next',
        ArrowUp: 'previous',
        Home: 'first',
        End: 'last'
      }
      return { kind: 'move', move: move[event.key], extend: event.shiftKey }
    }
    case ' ':
      return command || event.shiftKey ? null : { kind: 'toggle' }
    case 'Escape':
      return { kind: 'clear' }
    case 'Enter':
      return command || event.shiftKey ? null : { kind: 'rename' }
    case 'Backspace':
      return command && !event.shiftKey ? { kind: 'delete' } : null
    case 'Delete':
      return event.shiftKey ? null : { kind: 'delete' }
    default:
      return command && !event.shiftKey && event.key.toLowerCase() === 'a'
        ? { kind: 'select-all' }
        : null
  }
}

/** Selected rows that are still in view (E-18): a hidden row is never acted on. */
export function pruneLibrarySelection(
  selected: readonly string[],
  inView: ReadonlySet<string>
): string[] {
  return selected.filter((id) => inView.has(id))
}

/** The header checkbox: every selectable row in view, some of them, or none. */
export function librarySelectAllState(
  selected: readonly string[],
  selectableIds: readonly string[]
): boolean | 'indeterminate' {
  const count = selectableIds.filter((id) => selected.includes(id)).length
  if (count === 0) return false
  return count === selectableIds.length ? true : 'indeterminate'
}

/** The bulk delete names up to this many recordings, then counts the rest. */
export const LIBRARY_DELETE_NAMED_MAX = 5

/** The recordings a bulk delete names (E-18): up to five titles and "and N more". */
export function libraryDeleteNames(sessions: readonly Pick<SessionSummary, 'title'>[]): {
  names: string[]
  more: number
} {
  const names = sessions.slice(0, LIBRARY_DELETE_NAMED_MAX).map(libraryTitle)
  return { names, more: Math.max(0, sessions.length - names.length) }
}

// --- Quality (the E-OD owner item: problem states only) -------------------------

/**
 * The quality chip, quiet when fine: a recording that passed or was repaired
 * shows nothing, one that didn't reach 100% or couldn't be checked says so.
 */
export function libraryQualityChip(
  status: GateStatus | null | undefined
): { label: string; detail: string } | null {
  switch (status?.status) {
    case 'not-hundred-percent':
      return {
        label: 'Quality issues',
        detail: "Some of it isn't 100%. Choose Check quality in its menu for the details."
      }
    case 'failed':
      return {
        label: 'Not checked',
        detail: "The last quality check couldn't finish. Choose Check quality to run it again."
      }
    default:
      return null
  }
}

// --- Clean cut (E-4) ------------------------------------------------------------

/** Why a recording's file actions wait while Clean cut works on it. */
export const CLEAN_CUT_HOLD_REASON = 'Cancel or finish Clean cut first.'
/** Why a recording's file actions wait while noise cleanup works on it. */
export const NOISE_CLEANUP_HOLD_REASON = 'Cancel or finish noise cleanup first.'

/**
 * The newest job working on each source recording (a worker owns it, or is
 * about to). The backend refuses delete, duplicate, export and repair on
 * these, so the Library holds them first.
 */
export function activeCleanCutJobsBySource(
  jobs: readonly CleanCutJob[]
): ReadonlyMap<string, CleanCutJob> {
  const bySource = new Map<string, CleanCutJob>()
  for (const job of jobs) {
    if (!isCleanCutJobActive(job)) continue
    const held = bySource.get(job.sourceSessionId)
    if (!held || job.createdAt.localeCompare(held.createdAt) > 0)
      bySource.set(job.sourceSessionId, job)
  }
  return bySource
}

/** The chip on a recording Clean cut is working on: "Cut queued", "Cutting 40%". */
export function libraryCleanCutChip(job: Pick<CleanCutJob, 'state' | 'progress'>): {
  label: string
  working: boolean
} {
  if (job.state === 'queued' && !(job.progress > 0)) return { label: 'Cut queued', working: false }
  const percent = Math.min(99, Math.max(0, Math.round((job.progress || 0) * 100)))
  return { label: `Cutting ${percent}%`, working: true }
}

/**
 * "Review clean cut" once a cut of a recording exists (E-4), by source
 * recording: the newest finished job's mode, else the mode of its newest cut
 * copy in the Library. One pass, so the rows don't each scan the list.
 */
export function libraryCleanCutReviews(input: {
  jobs: readonly CleanCutJob[]
  sessions: readonly Pick<SessionSummary, 'cleanCutOfSessionId' | 'cleanCutMode' | 'startedAt'>[]
}): ReadonlyMap<string, CleanCutMode> {
  const finished = new Map<string, CleanCutJob>()
  for (const job of input.jobs) {
    if (job.state !== 'completed') continue
    const held = finished.get(job.sourceSessionId)
    if (!held || job.updatedAt.localeCompare(held.updatedAt) > 0) {
      finished.set(job.sourceSessionId, job)
    }
  }
  const copies = new Map<string, Pick<SessionSummary, 'cleanCutMode' | 'startedAt'>>()
  for (const session of input.sessions) {
    const source = session.cleanCutOfSessionId
    if (!source) continue
    const held = copies.get(source)
    if (!held || session.startedAt.localeCompare(held.startedAt) > 0) copies.set(source, session)
  }
  const reviews = new Map<string, CleanCutMode>()
  for (const [source, copy] of copies) reviews.set(source, copy.cleanCutMode ?? 'clean')
  for (const [source, job] of finished) reviews.set(source, job.mode)
  return reviews
}
