import {
  CameraIcon,
  ChatIcon,
  ClipIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  FolderIcon,
  LockIcon,
  MarkerIcon,
  BuddyIcon,
  PlayIcon,
  RepairIcon,
  ResetIcon,
  SearchIcon,
  SuccessIcon,
  UploadIcon,
  VideoFileIcon,
  WaveformMutedIcon
} from '@/components/icons'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement
} from 'react'
import { toast } from '@/lib/toast'
import { toastUserError, userErrorMessage } from '@/lib/user-error'

import { KebabContextMenu } from '@/components/kebab-context-menu'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { OfflineAlert } from '@/components/lock-alert'
import { PageHeader } from '@/components/page'
import { PANE_OWNS_SCROLL, PaneStrip } from '@/components/pane'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import { useStudioCore, useStudioRecording, useStudioRecordingState } from '@/hooks/use-studio'
import type {
  CleanCutJob,
  CleanCutMode,
  FileAssessment,
  GateStatus,
  SessionSummary
} from '@/lib/backend'
import {
  finalizationFailed,
  finalizingBadgeLabel,
  isFinalizingSession
} from '@/lib/session-finalization'
import {
  dayLabel,
  durationMsLabel,
  formatBytes,
  isActiveRecordingState,
  plural
} from '@/lib/format'
import { openCleanCut } from '@/lib/clean-cut-events'
import {
  cleanCutModeLabel,
  cleanCutStatusView,
  isCleanCutEligible,
  type CleanCutSession
} from '@/lib/clean-cut-view'
import { revealInFileManagerLabel, shortcutLabel, trashName } from '@/lib/platform'
import { sessionStatusLabel, sessionStatusPulses, sessionStatusTone } from '@/lib/state-labels'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  CLEAN_CUT_HOLD_REASON,
  LIBRARY_FILTERS,
  LIBRARY_SORTS,
  NOISE_CLEANUP_HOLD_REASON,
  activeCleanCutJobsBySource,
  filterLibrarySessions,
  hasBuddyReport,
  isLiveSession,
  libraryCleanCutChip,
  libraryCleanCutReviews,
  libraryClearLabel,
  libraryDeleteNames,
  libraryKeyCommand,
  libraryListState,
  libraryPartialNotice,
  libraryPickModifier,
  libraryQualityChip,
  libraryRowAfterMove,
  librarySelectAllState,
  libraryStorageLabel,
  libraryTitle,
  pickLibraryRow,
  pruneLibrarySelection,
  revealsFinishedCleanup,
  sessionFormatLabel,
  sessionPosterUrl,
  sortLibrarySessions,
  toggleAllLibrarySelection,
  toggleLibrarySelection,
  type LibraryFilter,
  type LibraryPickModifier,
  type LibrarySelection,
  type LibrarySort
} from '@/lib/library-view'
import {
  activeNoiseCleanupSourceIds,
  deriveNoiseCleanupView,
  latestNoiseCleanupJobForSession,
  noiseCleanupCancellationNotice,
  withNoiseCleanupConnectionState,
  type NoiseCleanupAction,
  type NoiseCleanupView
} from '@/lib/noise-cleanup-view'
import { cn } from '@/lib/utils'
import { openVideorcWebLink, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { sessionIsLive } from '../../../../shared/capture-state'

const SessionMarkersDialog = lazy(async () => ({
  default: (await import('@/components/session-markers-dialog')).SessionMarkersDialog
}))

/** The table's columns: select, name, scene, duration, size, file, actions. */
const LIBRARY_COLUMNS =
  'grid grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_8rem] items-center gap-2 px-gutter min-[1280px]:grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_13rem]'

/** Why file actions wait while a recording or a livestream runs. */
const CAPTURE_HOLD_REASON = 'Available when you stop recording or end the livestream.'

/** A click that lands on one of the row's own controls is that control's, not the row's. */
function fromRowControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target instanceof Element ? event.target : null
  const control = target?.closest(
    'button, a, input, [role="checkbox"], [data-slot="disabled-reason"]'
  )
  return Boolean(control && event.currentTarget.contains(control))
}

// The Library as a recordings manager (Library rewrite L4; plan 174 S3.11): a
// desktop table of every recording (poster, name, scene, duration, size,
// file, actions) with filter, sort and search on top and an honest storage
// footer below. Rows move with ↑/↓, select on click (⇧ and ⌘ extend), play
// on double-click, rename on Return, ask to delete on ⌘⌫, and right-click
// opens the same menu as ⋯. All list logic is pure (lib/library-view); this
// component is the shell.
export function LibraryTab({
  onOpenBuddyReport,
  onOpenCleanCut,
  focusSessionId = null
}: {
  /** "Buddy report": the Buddy tab, opened on this session's report. */
  onOpenBuddyReport: (sessionId: string) => void
  /** "Make a clean cut…": Buddy → Clean cut, on this recording (plan 174 S3.13). */
  onOpenCleanCut: (sessionId: string) => void
  /** Clean cut's "Open in Library": the row to show and focus. */
  focusSessionId?: string | null
}): ReactElement {
  const {
    sessions,
    sessionsNextCursor,
    sessionsLoadingMore,
    loadMoreSessions,
    sessionStorageTotals,
    settings,
    importRecording,
    deleteSessions,
    renameSession,
    noiseCleanupJobs,
    cleanCutJobs,
    wsStatus
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const captureProtected = isActiveRecordingState(recording.state)
  const online = wsStatus === 'connected'
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<LibrarySelection>({ selected: [], anchor: null })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  // The dialog reads the live row by id (E-11): playability follows the
  // recording while the dialog is open; the snapshot only covers a row that
  // left the loaded pages.
  const [markerSession, setMarkerSession] = useState<SessionSummary | null>(null)
  const [renaming, setRenaming] = useState<SessionSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // A rename failure belongs under the field it is about, not in a toast
  // behind the open dialog (plan 174 S2.4, E-22).
  const [renameError, setRenameError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary[]>([])
  const [deletePending, setDeletePending] = useState(false)
  const [revealedSessionId, setRevealedSessionId] = useState<string | null>(null)
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>())
  const previousCleanupStatusesRef = useRef(new Map<string, string>())

  // An explicit "show this recording" (Clean cut's Open in Library, Show
  // source recording) clears the search and the filter so the row is there.
  const focusLibrarySession = useCallback((sessionId: string): void => {
    setFilter('all')
    setQuery('')
    setActiveId(sessionId)
    setRevealedSessionId(sessionId)
  }, [])
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null)
  if (focusSessionId && focusSessionId !== appliedFocus) {
    setAppliedFocus(focusSessionId)
    focusLibrarySession(focusSessionId)
  }

  const runImport = async (): Promise<void> => {
    setImporting(true)
    try {
      // The new row is the confirmation: Library shows and focuses it.
      const imported = await importRecording()
      if (imported) focusLibrarySession(imported)
    } catch (error) {
      toastUserError(error, { action: 'import', object: 'the recording' }, { id: 'library-import' })
    } finally {
      setImporting(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    setDeletePending(true)
    try {
      await deleteSessions(deleting)
      toast.success(
        deleting.length === 1
          ? `Recording moved to the ${trashName()}`
          : `${deleting.length} recordings moved to the ${trashName()}`
      )
      setSelection((current) => ({
        ...current,
        selected: current.selected.filter((id) => !deleting.some((s) => s.id === id))
      }))
      setDeleting([])
    } catch (error) {
      toastUserError(error, {
        action: 'move',
        object: `${deleting.length === 1 ? 'the recording' : 'the recordings'} to the ${trashName()}`
      })
      setDeleting([])
    } finally {
      setDeletePending(false)
    }
  }

  const submitRename = async (): Promise<void> => {
    if (!renaming) return
    const title = renameDraft.trim()
    if (!title) return
    try {
      setRenameError(null)
      await renameSession(renaming.id, title)
      setRenaming(null)
    } catch (error) {
      const copy = userErrorMessage(error, { action: 'rename', object: 'the recording' })
      console.warn('[library] rename failed:', copy.raw)
      setRenameError(copy.kind === 'known' ? copy.description : copy.text)
    }
  }

  const visible = useMemo(
    () => sortLibrarySessions(filterLibrarySessions(sessions, filter, query), sort),
    [sessions, filter, query, sort]
  )
  const activeCleanupSourceIds = useMemo(
    () => activeNoiseCleanupSourceIds(noiseCleanupJobs),
    [noiseCleanupJobs]
  )
  const activeCleanCuts = useMemo(() => activeCleanCutJobsBySource(cleanCutJobs), [cleanCutJobs])
  const cleanCutReviews = useMemo(
    () => libraryCleanCutReviews({ jobs: cleanCutJobs, sessions }),
    [cleanCutJobs, sessions]
  )
  const orderedIds = useMemo(() => visible.map((session) => session.id), [visible])
  const inView = useMemo(() => new Set(orderedIds), [orderedIds])
  // A row Clean cut or noise cleanup is working on, or the one being
  // captured, can't be picked for a bulk delete.
  const rowLocked = (session: SessionSummary): boolean =>
    captureProtected ||
    isLiveSession(session, recording) ||
    activeCleanupSourceIds.has(session.id) ||
    activeCleanCuts.has(session.id)
  const selectableIds = visible.filter((session) => !rowLocked(session)).map(({ id }) => id)
  const selectable = new Set(selectableIds)
  // Selection never reaches a row the filter or the search hides (E-18).
  const selected = pruneLibrarySelection(selection.selected, inView)
  const selectedSessions = visible.filter((session) => selected.includes(session.id))
  const selectAllState = librarySelectAllState(selected, selectableIds)
  const bulkHoldReason = captureProtected
    ? CAPTURE_HOLD_REASON
    : selectedSessions.some((session) => activeCleanCuts.has(session.id))
      ? CLEAN_CUT_HOLD_REASON
      : selectedSessions.some((session) => activeCleanupSourceIds.has(session.id))
        ? NOISE_CLEANUP_HOLD_REASON
        : null
  const activeRowId = activeId !== null && inView.has(activeId) ? activeId : (orderedIds[0] ?? null)
  const listState = libraryListState({
    count: sessions.length,
    loaded: sessionStorageTotals !== null,
    online
  })
  const partialNotice = libraryPartialNotice({
    loadedCount: sessions.length,
    hasMore: sessionsNextCursor !== null,
    filter,
    query,
    sort
  })

  /** Changing what is in view drops the selected rows it hides (E-18). */
  const changeView = (next: { filter?: LibraryFilter; query?: string }): void => {
    const nextFilter = next.filter ?? filter
    const nextQuery = next.query ?? query
    if (next.filter !== undefined) setFilter(nextFilter)
    if (next.query !== undefined) setQuery(nextQuery)
    const nextInView = new Set(
      filterLibrarySessions(sessions, nextFilter, nextQuery).map(({ id }) => id)
    )
    setSelection((current) => ({
      ...current,
      selected: pruneLibrarySelection(current.selected, nextInView)
    }))
  }

  const pick = (id: string, modifier: LibraryPickModifier): void =>
    setSelection((current) =>
      pickLibraryRow(
        { selected: pruneLibrarySelection(current.selected, inView), anchor: current.anchor },
        { id, modifier, orderedIds, selectable }
      )
    )

  const focusRow = (id: string): void => {
    setActiveId(id)
    const row = rowElementsRef.current.get(id)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }

  // Keys on a focused row that move or select (E-16). Rename and delete are
  // the row's own (LibraryRow), so they respect its disabled items.
  const handleRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target?.dataset.videorcLibraryRow) return
    const command = libraryKeyCommand(event)
    if (!command) return
    switch (command.kind) {
      case 'move': {
        const next = libraryRowAfterMove(orderedIds, activeRowId, command.move)
        if (!next) return
        event.preventDefault()
        pick(next, command.extend ? 'range' : 'replace')
        focusRow(next)
        return
      }
      case 'toggle':
        if (!activeRowId) return
        event.preventDefault()
        pick(activeRowId, 'toggle')
        return
      case 'select-all':
        event.preventDefault()
        setSelection((current) => ({ ...current, selected: selectableIds }))
        return
      case 'clear':
        if (selected.length === 0) return
        event.preventDefault()
        setSelection({ selected: [], anchor: null })
        return
      default:
        return
    }
  }

  // ⌘⌫ on a row: the selection when the row is part of it, else the row.
  const deleteFromKeys = (session: SessionSummary, rowCanDelete: boolean): void => {
    if (selected.includes(session.id) && selected.length > 1) {
      if (!bulkHoldReason) setDeleting(selectedSessions)
      return
    }
    if (rowCanDelete) setDeleting([session])
  }

  // A noise cleanup that finished out of view shows its copy, unless that
  // would undo the streamer's own search or filter (E-19).
  useEffect(() => {
    for (const job of noiseCleanupJobs) {
      const previous = previousCleanupStatusesRef.current.get(job.id)
      previousCleanupStatusesRef.current.set(job.id, job.status)
      if (
        previous &&
        previous !== 'completed' &&
        job.status === 'completed' &&
        job.outputSessionId &&
        revealsFinishedCleanup(filter, query)
      ) {
        setActiveId(job.outputSessionId)
        setRevealedSessionId(job.outputSessionId)
      }
    }
  }, [filter, noiseCleanupJobs, query])

  useEffect(() => {
    if (!revealedSessionId) {
      return
    }
    const row = rowElementsRef.current.get(revealedSessionId)
    if (!row) {
      return
    }
    row.scrollIntoView({ block: 'nearest' })
    row.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setRevealedSessionId(null), 3000)
    return () => window.clearTimeout(timer)
  }, [revealedSessionId, visible])

  // "Load all": one page after another until the last (E-17).
  useEffect(() => {
    if (!loadingAll) return
    if (!sessionsNextCursor || !online) {
      setLoadingAll(false)
      return
    }
    if (sessionsLoadingMore) return
    loadMoreSessions().catch(() => setLoadingAll(false))
  }, [loadMoreSessions, loadingAll, online, sessionsLoadingMore, sessionsNextCursor])

  // Free space is an Electron-side directory fact (same source as Settings).
  useEffect(() => {
    const directoryHandle = settings.outputDirectoryHandle
    if (!directoryHandle || !window.videorc?.checkDirectory) {
      setFreeBytes(null)
      return
    }
    let cancelled = false
    void window.videorc
      .checkDirectory(directoryHandle)
      .then((facts) => {
        if (!cancelled) {
          setFreeBytes(facts.freeBytes)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [settings.outputDirectoryHandle, sessions.length])

  const liveMarkerSession = markerSession
    ? (sessions.find((session) => session.id === markerSession.id) ?? markerSession)
    : null
  const deleteNames = libraryDeleteNames(deleting)

  return (
    // Library owns its scroll: the header and the filter bar stay pinned and
    // only the table scrolls (plan 174 S1.6b).
    <div {...PANE_OWNS_SCROLL} className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        description="Every recording and livestream you make. Files stay on disk."
        title="Library"
      />

      {/* Filter bar: filter · sort · search. */}
      <PaneStrip className="flex flex-wrap items-center gap-2">
        <Select
          value={filter}
          onValueChange={(value) => changeView({ filter: value as LibraryFilter })}
        >
          <SelectTrigger aria-label="Filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {LIBRARY_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as LibrarySort)}>
          <SelectTrigger aria-label="Sort" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {LIBRARY_SORTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search recordings"
            className="pl-8"
            placeholder="Search recordings…"
            value={query}
            onChange={(event) => changeView({ query: event.target.value })}
          />
        </div>
        <Button disabled={importing} variant="outline" onClick={() => void runImport()}>
          <UploadIcon data-icon="inline-start" />
          {importing ? 'Importing…' : 'Import…'}
        </Button>
        <Button variant="outline" onClick={() => openWorkspaceTab('studio')}>
          <CameraIcon data-icon="inline-start" weight="fill" />
          Open Studio
        </Button>
      </PaneStrip>

      {/* Selection bar: the checkbox column's one bulk action. */}
      {selected.length > 0 ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-gutter py-1.5 text-sm">
          <span className="text-muted-foreground">{selected.length} selected</span>
          <Button
            disabled={bulkHoldReason !== null}
            variant="destructive"
            onClick={() => setDeleting(selectedSessions)}
          >
            <DeleteIcon data-icon="inline-start" />
            Delete
          </Button>
          <Button variant="ghost" onClick={() => setSelection({ selected: [], anchor: null })}>
            Clear selection
          </Button>
          {bulkHoldReason ? (
            <span className="text-meta text-muted-foreground">{bulkHoldReason}</span>
          ) : null}
        </div>
      ) : null}

      {!online && listState !== 'offline' ? (
        <div className="shrink-0 px-gutter pt-2">
          <OfflineAlert />
        </div>
      ) : null}
      {partialNotice ? (
        <div className="shrink-0 px-gutter pt-2">
          <Alert data-testid="library-partial-notice" variant="quiet">
            <AlertTitle>{partialNotice}</AlertTitle>
            <AlertAction>
              <Button
                disabled={loadingAll || sessionsLoadingMore || !online}
                size="xs"
                variant="outline"
                onClick={() => setLoadingAll(true)}
              >
                {loadingAll ? 'Loading…' : 'Load all'}
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}

      {listState === 'loading' ? (
        <Empty className="py-16">
          <EmptyDescription className="flex items-center gap-2">
            <Spinner aria-hidden />
            Loading recordings…
          </EmptyDescription>
        </Empty>
      ) : listState === 'offline' ? (
        <div className="px-gutter py-4">
          <OfflineAlert />
        </div>
      ) : listState === 'empty' ? (
        <Empty className="py-16">
          <EmptyTitle>No recordings yet</EmptyTitle>
          <EmptyDescription>Record or go live from Studio, and it shows up here.</EmptyDescription>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {visible.length === 0 ? (
            <Empty className="py-10">
              <EmptyTitle>No recordings match</EmptyTitle>
              <EmptyContent>
                <Button variant="outline" onClick={() => changeView({ filter: 'all', query: '' })}>
                  {libraryClearLabel(filter, query)}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div
              aria-label="Recordings"
              aria-multiselectable="true"
              className="flex min-h-0 flex-1 flex-col"
              role="grid"
            >
              <div role="rowgroup">
                <div
                  className={cn(
                    LIBRARY_COLUMNS,
                    'border-b border-border py-2 text-meta font-medium text-muted-foreground'
                  )}
                  role="row"
                >
                  <div role="columnheader">
                    <Checkbox
                      aria-label="Select all recordings in view"
                      checked={selectAllState}
                      disabled={selectableIds.length === 0}
                      onCheckedChange={() =>
                        setSelection((current) => ({
                          ...current,
                          selected: toggleAllLibrarySelection(
                            pruneLibrarySelection(current.selected, inView),
                            selectableIds
                          )
                        }))
                      }
                    />
                  </div>
                  <div role="columnheader">Name</div>
                  <div role="columnheader">Scene</div>
                  <div role="columnheader">Duration</div>
                  <div role="columnheader">Size</div>
                  <div role="columnheader">File</div>
                  <div className="text-right" role="columnheader">
                    Actions
                  </div>
                </div>
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto"
                role="rowgroup"
                onKeyDown={handleRowsKeyDown}
              >
                {visible.map((session) => (
                  <LibraryRow
                    key={session.id}
                    active={activeRowId === session.id}
                    cleanCutJob={activeCleanCuts.get(session.id) ?? null}
                    cleanCutReview={cleanCutReviews.get(session.id) ?? null}
                    revealed={revealedSessionId === session.id}
                    selected={selected.includes(session.id)}
                    selectionDisabled={rowLocked(session)}
                    session={session}
                    registerRow={(element) => {
                      if (element) rowElementsRef.current.set(session.id, element)
                      else rowElementsRef.current.delete(session.id)
                    }}
                    onActivate={() => setActiveId(session.id)}
                    onDelete={() => setDeleting([session])}
                    onDeleteKey={(rowCanDelete) => deleteFromKeys(session, rowCanDelete)}
                    onOpenBuddyReport={() => onOpenBuddyReport(session.id)}
                    onOpenCleanCut={() => onOpenCleanCut(session.id)}
                    onOpenMarkers={() => setMarkerSession(session)}
                    onPick={(modifier) => pick(session.id, modifier)}
                    onRename={() => {
                      setRenaming(session)
                      setRenameDraft(session.title)
                      setRenameError(null)
                    }}
                    onRevealSession={focusLibrarySession}
                    onToggleSelected={() =>
                      setSelection((current) => ({
                        selected: toggleLibrarySelection(
                          pruneLibrarySelection(current.selected, inView),
                          session.id
                        ),
                        anchor: session.id
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          )}
          {/* Honest storage footer: real totals + real free space, no quota bar. */}
          {sessionStorageTotals || sessionsNextCursor ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-gutter py-2 text-meta text-muted-foreground">
              <span>
                {sessionStorageTotals
                  ? libraryStorageLabel({
                      count: sessionStorageTotals.count,
                      totalBytes: sessionStorageTotals.totalBytes,
                      freeBytes
                    })
                  : `${plural(sessions.length, 'recording')} loaded`}
              </span>
              {sessionsNextCursor ? (
                <Button
                  disabled={sessionsLoadingMore}
                  size="xs"
                  variant="ghost"
                  onClick={() => void loadMoreSessions()}
                >
                  {sessionsLoadingMore ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {liveMarkerSession ? (
        <Suspense fallback={null}>
          <SessionMarkersDialog
            session={liveMarkerSession}
            onClose={() => setMarkerSession(null)}
          />
        </Suspense>
      ) : null}
      {/* Rename dialog */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Rename recording</DialogTitle>
            <DialogDescription>The file on disk keeps its name.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
          >
            <Input
              autoFocus
              aria-label="Recording name"
              aria-invalid={renameError ? true : undefined}
              aria-describedby={renameError ? 'library-rename-error' : undefined}
              maxLength={120}
              value={renameDraft}
              onChange={(event) => {
                setRenameDraft(event.target.value)
                setRenameError(null)
              }}
            />
            {renameError ? (
              <FieldError id="library-rename-error" className="mt-2">
                {renameError}
              </FieldError>
            ) : null}
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button disabled={renameDraft.trim().length === 0} type="submit">
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm (plan 174 E-2): only the video file can come back,
          from the OS trash; the Library entry and everything attached to it
          cannot, and the copy says so. A bulk delete names what it deletes,
          up to five titles (E-18). */}
      <ConfirmDialog
        cancelDisabled={deletePending}
        confirmDisabled={deletePending || captureProtected}
        confirmLabel={deletePending ? 'Deleting…' : `Move to ${trashName()}`}
        description={
          deleting.length === 1
            ? `The video file goes to the ${trashName()}. Its Library entry, markers, Buddy report and chat history are deleted and can't be restored.`
            : `The video files go to the ${trashName()}. Their Library entries, markers, Buddy reports and chat history are deleted and can't be restored.`
        }
        open={deleting.length > 0}
        testId="library-delete"
        title={
          deleting.length === 1
            ? `Move this recording to the ${trashName()}?`
            : `Move ${deleting.length} recordings to the ${trashName()}?`
        }
        onCancel={() => {
          if (!deletePending) setDeleting([])
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleting.length > 1 ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="library-delete-names">
            {deleteNames.names.map((name, index) => (
              <li key={`${index}-${name}`} className="truncate">
                {name}
              </li>
            ))}
            {deleteNames.more > 0 ? (
              <li className="text-muted-foreground">and {deleteNames.more} more</li>
            ) : null}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

function LibraryRow({
  session,
  selected,
  active,
  revealed,
  selectionDisabled,
  cleanCutJob,
  cleanCutReview,
  registerRow,
  onPick,
  onActivate,
  onToggleSelected,
  onDeleteKey,
  onOpenCleanCut,
  onOpenBuddyReport,
  onOpenMarkers,
  onRevealSession,
  onRename,
  onDelete
}: {
  session: SessionSummary
  selected: boolean
  /** The row that holds the list's one tab stop (roving focus). */
  active: boolean
  /** Shown on request ("Open in Library"), for a moment. */
  revealed: boolean
  selectionDisabled: boolean
  /** The Clean cut job working on this recording, if one is. */
  cleanCutJob: CleanCutJob | null
  /** The mode of a finished cut to review, if one exists. */
  cleanCutReview: CleanCutMode | null
  registerRow: (element: HTMLDivElement | null) => void
  onPick: (modifier: LibraryPickModifier) => void
  onActivate: () => void
  onToggleSelected: () => void
  /** ⌘⌫ on the row; says whether the row's own Delete is available. */
  onDeleteKey: (rowCanDelete: boolean) => void
  onOpenCleanCut: () => void
  onOpenBuddyReport: () => void
  onOpenMarkers: () => void
  onRevealSession: (sessionId: string) => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
  const { recording } = useStudioRecordingState()
  const filePath = session.mp4Path ?? session.outputPath ?? null
  const format = sessionFormatLabel(session)
  const title = libraryTitle(session)
  // A live row shows the capture's ticking elapsed time; the session row only
  // gets duration_ms at finalize.
  const live = isLiveSession(session, recording)
  // Background MP4 export (instant-record P2): Idle arrives while the export
  // still runs; the row says so instead of claiming an MKV.
  const finalizing = isFinalizingSession(session)
  const exportFailed = finalizationFailed(session)
  // A Clean cut copy (plan 119 S14): `cleanCutOfSessionId` names its source.
  const cleanCutMode = (session as CleanCutSession).cleanCutOfSessionId
    ? ((session as CleanCutSession).cleanCutMode ?? 'clean')
    : null
  const actions = useSessionMenu({
    session,
    filePath,
    cleanCutJob,
    cleanCutReview,
    onDelete,
    onOpenBuddyReport,
    onOpenCleanCut,
    onOpenMarkers,
    onRename,
    onRevealSession
  })
  const cleanCutChip = cleanCutJob ? libraryCleanCutChip(cleanCutJob) : null
  const quality = libraryQualityChip(session.qualityStatus as GateStatus | null | undefined)
  // Inner controls leave the tab order unless this row holds the focus: one
  // tab stop for the list, then the active row's own controls (E-16).
  const controlTabIndex = active ? undefined : -1

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    const command = libraryKeyCommand(event)
    if (command?.kind === 'rename') {
      event.preventDefault()
      if (actions.canRename) onRename()
    } else if (command?.kind === 'delete') {
      event.preventDefault()
      onDeleteKey(actions.canDelete)
    }
  }

  return (
    <KebabContextMenu items={actions.items}>
      <div
        ref={registerRow}
        aria-selected={selected}
        className={cn(
          LIBRARY_COLUMNS,
          'border-b border-border py-2 outline-hidden last:border-b-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:bg-accent data-revealed:bg-accent'
        )}
        data-revealed={revealed || undefined}
        data-videorc-library-row={session.id}
        role="row"
        tabIndex={active ? 0 : -1}
        onClick={(event) => {
          if (fromRowControl(event)) return
          onPick(libraryPickModifier(event))
        }}
        onDoubleClick={(event) => {
          if (fromRowControl(event)) return
          if (actions.canPlay) void actions.play()
        }}
        onFocus={onActivate}
        onKeyDown={handleKeyDown}
      >
        <div role="gridcell">
          <Checkbox
            aria-label={`Select ${title}`}
            checked={selected}
            disabled={selectionDisabled}
            tabIndex={-1}
            onCheckedChange={onToggleSelected}
          />
        </div>
        <div className="flex min-w-0 items-center gap-3" role="gridcell">
          <SessionPoster session={session} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium">{title}</p>
              {cleanCutJob && cleanCutChip ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge data-library-clean-cut={cleanCutJob.state} variant="outline">
                      {cleanCutChip.working ? (
                        <Spinner aria-hidden data-icon="inline-start" />
                      ) : null}
                      {cleanCutChip.label}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Clean cut:{' '}
                    {
                      cleanCutStatusView(cleanCutJob, {
                        captureActive: isActiveRecordingState(recording.state),
                        streaming: sessionIsLive(recording)
                      }).label
                    }
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {quality ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge data-library-quality="" variant="warning">
                      {quality.label}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{quality.detail}</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <p className="truncate text-meta text-muted-foreground">
              {dayLabel(session.startedAt)}
              {!filePath && !live ? ' · no local file' : ''}
              {session.processingKind === 'noise-cleanup' && session.sourceTitle
                ? ` · cleaned from ${session.sourceTitle}`
                : ''}
              {cleanCutMode && session.sourceTitle ? ` · cut from ${session.sourceTitle}` : ''}
            </p>
          </div>
        </div>
        <div className="min-w-0" role="gridcell">
          {session.processingKind === 'noise-cleanup' ? (
            <Badge variant="outline">Noise cleaned</Badge>
          ) : cleanCutMode ? (
            <Badge data-clean-cut={cleanCutMode} variant="outline">
              {cleanCutModeLabel(cleanCutMode)}
            </Badge>
          ) : session.sceneLabel ? (
            <Badge className="max-w-full" variant="outline">
              <span className="truncate">{session.sceneLabel}</span>
            </Badge>
          ) : null}
        </div>
        <div role="gridcell">
          {live ? (
            <LiveSessionDuration />
          ) : (
            <span className="text-meta text-muted-foreground tabular-nums">
              {durationMsLabel(session.durationMs)}
            </span>
          )}
        </div>
        <div role="gridcell">
          <span className="text-meta text-muted-foreground tabular-nums">
            {formatBytes(session.fileSizeBytes)}
          </span>
        </div>
        <div role="gridcell">
          {live ? (
            <StatusDot
              label={sessionStatusLabel(recording)}
              pulse={sessionStatusPulses(recording)}
              tone={sessionStatusTone(recording)}
            />
          ) : finalizing ? (
            <Badge variant="outline">
              <Spinner data-icon="inline-start" />
              {finalizingBadgeLabel(session)}
            </Badge>
          ) : exportFailed ? (
            // Why the export failed, on hover and on focus (plan 174 S1.10, E-23).
            <InfoTooltip content={session.finalizationError} tabIndex={active ? 0 : -1}>
              <Badge variant="destructive">MP4 failed</Badge>
            </InfoTooltip>
          ) : format ? (
            // The container is a fact, not a status: a tag (E-21).
            <Badge variant="outline">{format}</Badge>
          ) : null}
        </div>
        <div role="gridcell">
          <RowActions actions={actions} session={session} tabIndex={controlTabIndex} />
        </div>
      </div>
    </KebabContextMenu>
  )
}

/** Ticks from the session's start: running statuses carry no duration. */
function LiveSessionDuration(): ReactElement {
  const { recording } = useStudioRecording()
  const elapsedMs = useSessionElapsedMs(recording.startedAt) ?? recording.durationMs
  return (
    <span className="text-meta text-muted-foreground tabular-nums">
      {durationMsLabel(elapsedMs)}
    </span>
  )
}

/** Poster with one lazy backfill attempt: older sessions have no poster yet;
 * a 404 triggers a single sessions.poster round-trip (idle-aware backend).
 * Running sessions never request the poster — extraction waits for capture
 * idle, so the request is guaranteed to 404. */
export function SessionPoster({
  session
}: {
  session: Pick<SessionSummary, 'id' | 'durationMs' | 'status' | 'finalizationState'>
}): ReactElement {
  const { connection, ensureSessionPoster } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // Posters are extracted after finalization; while the MP4 is still exporting
  // the request would 404, so treat a finalizing row like a running one.
  const running = session.status === 'running' || isFinalizingSession(session)
  const url = running ? null : sessionPosterUrl(connection, session)
  const source = url && attempt > 0 ? `${url}&attempt=${attempt}` : url
  return (
    <span className="grid h-10 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded-row border bg-muted/30">
      {isLiveSession(session, recording) ? (
        <StatusDot pulse={sessionStatusPulses(recording)} tone={sessionStatusTone(recording)} />
      ) : source && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          src={source}
          onError={() => {
            if (attempt === 0) {
              void ensureSessionPoster(session.id).then((available) => {
                if (available) {
                  setAttempt(1)
                } else {
                  setFailed(true)
                }
              })
            } else {
              setFailed(true)
            }
          }}
        />
      ) : (
        <VideoFileIcon className="size-4 text-muted-foreground" weight="duotone" />
      )}
    </span>
  )
}

type RepairPhase = 'idle' | 'checking' | 'assessed' | 'repairing' | 'done'

type SessionMenu = ReturnType<typeof useSessionMenu>

// The row's trailing action cluster: Play, the noise cleanup action and ⋯.
// Everything file-shaped (reveal, export, quality check, repair, restore)
// lives in the menu, the same items as the row's right-click menu — the
// Library remains the single home of session artifacts (ux-ia slice 3).
function RowActions({
  actions,
  session,
  tabIndex
}: {
  actions: SessionMenu
  session: SessionSummary
  /** -1 while the row is not the list's active row. */
  tabIndex: number | undefined
}): ReactElement {
  const playReason = actions.playDisabledReason
  return (
    <div className="flex items-center justify-end gap-0.5">
      {playReason ? (
        <DisabledReason reason={playReason} tabIndex={tabIndex}>
          <Button
            aria-label="Play recording"
            disabled
            size="icon"
            tabIndex={tabIndex}
            variant="ghost"
          >
            <PlayIcon weight="fill" />
          </Button>
        </DisabledReason>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Play recording"
              size="icon"
              tabIndex={tabIndex}
              variant="ghost"
              onClick={() => void actions.play()}
            >
              <PlayIcon weight="fill" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Play in the default player</TooltipContent>
        </Tooltip>
      )}
      <NoiseCleanupDirectAction
        sessionId={session.id}
        tabIndex={tabIndex}
        title={libraryTitle(session)}
        view={actions.cleanupView}
        onAction={(action) => void actions.runNoiseCleanupAction(action)}
      />
      <KebabMenu
        busy={actions.busy || actions.cleanupView.busy}
        disabled={actions.disconnected}
        items={actions.items}
        label="Session actions"
        tabIndex={tabIndex}
      />
    </div>
  )
}

// One list of row actions for the ⋯ menu and the right-click menu (plan 174
// S3.11, E-16), with the state the actions share: the repair phase, the
// noise cleanup view and the Clean cut hold.
function useSessionMenu({
  session,
  filePath,
  cleanCutJob,
  cleanCutReview,
  onOpenCleanCut,
  onOpenBuddyReport,
  onOpenMarkers,
  onRevealSession,
  onRename,
  onDelete
}: {
  session: SessionSummary
  filePath: string | null
  cleanCutJob: CleanCutJob | null
  cleanCutReview: CleanCutMode | null
  onOpenCleanCut: () => void
  onOpenBuddyReport: () => void
  onOpenMarkers: () => void
  onRevealSession: (sessionId: string) => void
  onRename: () => void
  onDelete: () => void
}) {
  const {
    assessRecording,
    repairRecording,
    restoreRecording,
    wsStatus,
    remuxSession,
    openSessionCommentsWindow,
    duplicateSession,
    entitlements,
    noiseCleanupJobs,
    startNoiseCleanup,
    cancelNoiseCleanup
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const [duplicating, setDuplicating] = useState(false)

  const runDuplicate = async (): Promise<void> => {
    setDuplicating(true)
    try {
      // The copy's row is the confirmation (plan 174 S2.4, J2-11).
      const copy = await duplicateSession(session.id)
      if (copy) onRevealSession(copy)
    } catch (error) {
      toastUserError(error, { action: 'duplicate', object: 'the recording' })
    } finally {
      setDuplicating(false)
    }
  }
  const [phase, setPhase] = useState<RepairPhase>('idle')
  const [assessment, setAssessment] = useState<FileAssessment | null>(null)
  const [hasBackup, setHasBackup] = useState(false)

  const busy = phase === 'checking' || phase === 'repairing'
  const disconnected = wsStatus !== 'connected'
  const captureProtected = isActiveRecordingState(recording.state)
  // The live row's file is still being written: playing or duplicating a
  // partial container yields garbage, so those wait for finalize.
  const live = isLiveSession(session, recording)
  const canRepair = assessment?.repairable ?? false
  const persistedRepaired = session.qualityStatus?.status === 'repaired'
  // Background finalization (instant-record P2): the file is still being
  // produced, so play/duplicate/export wait; a failed export gets a retry.
  const finalizing = isFinalizingSession(session)
  const canExportMp4 =
    Boolean(
      session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path
    ) && !finalizing
  const canOpenComments = session.commentCount > 0
  const cleanupJob = latestNoiseCleanupJobForSession(noiseCleanupJobs, session.id)
  const cleanupView = withNoiseCleanupConnectionState(
    deriveNoiseCleanupView({
      session,
      entitlements,
      job: cleanupJob,
      captureActive: captureProtected
    }),
    wsStatus === 'connected'
  )
  // The backend refuses delete, duplicate, export and repair while Clean cut
  // or noise cleanup works on the recording (E-4): the menu holds them first
  // and says why.
  const fileActionsBusy =
    busy || cleanupView.conflictsWithFileActions || finalizing || cleanCutJob !== null
  const holdReason =
    cleanCutJob !== null
      ? CLEAN_CUT_HOLD_REASON
      : cleanupView.conflictsWithFileActions
        ? NOISE_CLEANUP_HOLD_REASON
        : captureProtected
          ? CAPTURE_HOLD_REASON
          : null
  const cleanupMenuAction = cleanupView.menuAction
  const canPlay = Boolean(filePath) && !live
  const canRename = !busy
  const canDelete = !fileActionsBusy && !captureProtected

  const playFile = async (): Promise<void> => {
    if (!filePath || !window.videorc?.openSession) {
      return
    }
    const problem = await window.videorc.openSession(session.id)
    if (problem) {
      const runtime = await import('@/lib/session-runtime-recovery')
      runtime.showPlaybackProblem(session.id, problem)
    }
  }

  const runCheck = async (): Promise<void> => {
    if (!filePath) return
    setPhase('checking')
    try {
      const next = await assessRecording(session.id)
      setAssessment(next)
      setHasBackup(next.hasBackup)
      setPhase('assessed')
      // FX4: the kebab menu closes on click, so without a toast the check
      // completed invisibly (repair already reports this way).
      if (next.issues.length === 0) {
        toast.success('No problems found', { id: `quality-check:${session.id}` })
      } else {
        const first = next.reasons[0] ?? next.issues[0]?.kind
        toast.warning(`${plural(next.issues.length, 'quality issue')} found`, {
          description: next.repairable
            ? `${first ? `${first} ` : ''}Repair is available from this menu.`
            : first
        })
      }
    } catch (error) {
      toastUserError(
        error,
        { action: 'check', object: 'the recording' },
        {
          id: `quality-check:${session.id}`,
          action: { label: 'Retry', onClick: () => void runCheck() }
        }
      )
      setPhase('idle')
    }
  }

  const runRepair = async (): Promise<void> => {
    if (!filePath) return
    setPhase('repairing')
    try {
      const next: GateStatus = await repairRecording(session.id)
      setPhase('done')
      if (next.status === 'repaired') {
        setHasBackup(true)
        toast.success(
          next.interpolated ? 'Repaired with interpolated frames' : 'Recording repaired'
        )
      } else if (next.status === 'ready') {
        toast.success('No problems found', { id: `quality-check:${session.id}` })
      } else if (next.status === 'not-hundred-percent') {
        toast.warning("Couldn't fully repair the recording", {
          description: 'The original is unchanged.'
        })
      } else {
        toast.error("Couldn't check the recording", {
          id: `quality-check:${session.id}`,
          description: 'Try again. If it keeps happening, export a support bundle from Health.',
          action: { label: 'Retry', onClick: () => void runCheck() }
        })
      }
    } catch (error) {
      toastUserError(error, { action: 'repair', object: 'the recording' })
      setPhase('assessed')
    }
  }

  const runRestore = async (): Promise<void> => {
    if (!filePath) return
    try {
      const restored = await restoreRecording(session.id)
      if (restored) {
        toast.success('Restored the original recording from backup')
        setHasBackup(false)
        setAssessment(null)
        setPhase('idle')
      } else {
        toast.info('No backup found for this recording')
      }
    } catch (error) {
      toastUserError(error, { action: 'restore', object: 'the original' })
    }
  }

  const runNoiseCleanupAction = async (action: NoiseCleanupAction): Promise<void> => {
    if (action === 'upgrade') {
      openVideorcWebLink(VIDEORC_WEB_LINKS.premium)
      return
    }
    if (action === 'open-output') {
      if (cleanupJob?.outputSessionId) {
        onRevealSession(cleanupJob.outputSessionId)
      }
      return
    }
    if (action === 'show-source') {
      if (session.derivedFromSessionId) {
        onRevealSession(session.derivedFromSessionId)
      }
      return
    }

    try {
      if (action === 'cancel') {
        if (!cleanupJob) return
        const nextJob = await cancelNoiseCleanup(cleanupJob.id)
        const notice = noiseCleanupCancellationNotice(nextJob)
        toast.info(notice.title, { description: notice.description })
        return
      }
      // The row shows the job's progress: that is the confirmation (J2-11).
      await startNoiseCleanup(session.id)
    } catch (error) {
      toastUserError(
        error,
        { action: action === 'cancel' ? 'cancel' : 'start', object: 'noise cleanup' },
        {
          id: `noise-cleanup:${session.id}`,
          action: { label: 'Retry', onClick: () => void runNoiseCleanupAction(action) }
        }
      )
    }
  }

  // One anatomy for every ⋯ menu (plan 174 S1.6b, E-PAT): open and share,
  // then edit, then repair, and Delete on its own at the end.
  const sessionMenu: KebabMenuItem[] = [
    {
      id: 'play',
      group: 'open',
      icon: PlayIcon,
      label: 'Play',
      disabled: !filePath || live,
      onSelect: () => void playFile()
    },
    ...(hasBuddyReport(session)
      ? [
          // The report is saved when the stream ends (plan 119 S3).
          {
            id: 'buddy-report',
            group: 'open',
            icon: BuddyIcon,
            label: 'Buddy report',
            disabled: live,
            onSelect: onOpenBuddyReport
          }
        ]
      : []),
    ...(isCleanCutEligible(session)
      ? [
          // Buddy → Clean cut, on this recording (plan 174 S3.13, D6); its
          // review goes back to this row.
          {
            id: 'clean-cut',
            group: 'open',
            icon: ClipIcon,
            label: 'Make a clean cut…',
            onSelect: onOpenCleanCut
          }
        ]
      : []),
    ...(cleanCutReview
      ? [
          // A finished cut of this recording opens in its review (E-4).
          {
            id: 'review-clean-cut',
            group: 'open',
            icon: ClipIcon,
            label: 'Review clean cut',
            onSelect: () =>
              openCleanCut({
                sessionId: session.id,
                mode: cleanCutReview,
                review: true,
                origin: 'library'
              })
          }
        ]
      : []),
    { id: 'markers', group: 'open', icon: MarkerIcon, label: 'Markers', onSelect: onOpenMarkers },
    {
      id: 'reveal',
      group: 'open',
      icon: FolderIcon,
      label: finalizing ? 'Show original · MP4 is saving' : revealInFileManagerLabel(),
      disabled: !filePath,
      onSelect: () => {
        if (filePath) void window.videorc?.revealSession?.(session.id)
      }
    },
    ...(cleanupView.menuLabel
      ? [
          {
            id: 'noise-cleanup',
            group: 'open',
            icon: cleanupView.premiumLocked ? LockIcon : WaveformMutedIcon,
            label: cleanupView.menuLabel,
            disabled: !cleanupMenuAction,
            onSelect: () => {
              if (cleanupMenuAction) void runNoiseCleanupAction(cleanupMenuAction)
            }
          }
        ]
      : []),
    {
      id: 'export-mp4',
      group: 'open',
      icon: VideoFileIcon,
      label: finalizationFailed(session) ? 'Retry MP4 export' : 'Export MP4',
      disabled: !canExportMp4 || fileActionsBusy,
      disabledReason: canExportMp4 ? holdReason : null,
      onSelect: () => void remuxSession(session.id)
    },
    {
      id: 'stream-manager',
      group: 'open',
      icon: ChatIcon,
      label: 'Open in Stream Manager',
      disabled: !canOpenComments || busy || disconnected,
      onSelect: () => void openSessionCommentsWindow(session.id, session.title, session.startedAt)
    },
    {
      id: 'rename',
      group: 'edit',
      icon: EditIcon,
      label: 'Rename…',
      shortcut: shortcutLabel('Enter'),
      disabled: !canRename,
      onSelect: onRename
    },
    {
      id: 'duplicate',
      group: 'edit',
      icon: CopyIcon,
      label: duplicating ? 'Duplicating…' : 'Duplicate',
      disabled: !filePath || fileActionsBusy || duplicating || live,
      disabledReason: filePath && !live && !duplicating ? holdReason : null,
      onSelect: () => void runDuplicate()
    },
    {
      id: 'check',
      group: 'repair',
      icon: SuccessIcon,
      label: phase === 'checking' ? 'Checking…' : 'Check quality',
      disabled: !filePath || fileActionsBusy || captureProtected,
      disabledReason: filePath ? holdReason : null,
      onSelect: () => void runCheck()
    },
    ...(canRepair
      ? [
          {
            id: 'repair',
            group: 'repair',
            icon: RepairIcon,
            label: phase === 'repairing' ? 'Repairing…' : 'Repair & fix',
            disabled: fileActionsBusy || captureProtected,
            disabledReason: holdReason,
            onSelect: () => void runRepair()
          }
        ]
      : []),
    ...(hasBackup || persistedRepaired
      ? [
          {
            id: 'restore',
            group: 'repair',
            icon: ResetIcon,
            label: 'Restore original',
            disabled: fileActionsBusy || captureProtected,
            disabledReason: holdReason,
            onSelect: () => void runRestore()
          }
        ]
      : []),
    {
      id: 'delete',
      destructive: true,
      icon: DeleteIcon,
      label: 'Delete',
      shortcut: shortcutLabel('CmdOrCtrl+Backspace'),
      disabled: !canDelete,
      disabledReason: holdReason,
      onSelect: onDelete
    }
  ]

  return {
    items: sessionMenu,
    busy,
    disconnected,
    cleanupView,
    canPlay,
    canRename,
    canDelete,
    playDisabledReason: live
      ? 'Available when the recording ends.'
      : !filePath
        ? 'No file to play yet.'
        : null,
    play: playFile,
    runNoiseCleanupAction
  }
}

export function NoiseCleanupDirectAction({
  sessionId,
  title,
  view,
  tabIndex,
  onAction
}: {
  sessionId: string
  title: string
  view: NoiseCleanupView
  /** -1 while its Library row is not the list's active row. */
  tabIndex?: number
  onAction: (action: NoiseCleanupAction) => void
}): ReactElement | null {
  if (!view.directLabel) {
    return null
  }

  const help = view.disabledReason ?? view.detail
  const descriptionId = `noise-cleanup-${safeDomId(sessionId)}-description`
  const ariaLabel =
    view.directAction === 'open-output'
      ? `Open cleaned copy for ${title}`
      : `Clean up noise in ${title}`
  const button = (
    <Button
      aria-busy={view.busy || undefined}
      aria-describedby={help && view.directAction ? descriptionId : undefined}
      aria-label={ariaLabel}
      className="min-[1280px]:w-auto min-[1280px]:px-2"
      disabled={!view.directAction}
      size="icon"
      tabIndex={tabIndex}
      variant="ghost"
      onClick={() => view.directAction && onAction(view.directAction)}
    >
      {view.premiumLocked ? (
        <LockIcon data-icon="inline-start" />
      ) : view.busy ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <WaveformMutedIcon data-icon="inline-start" />
      )}
      <span className="hidden min-[1280px]:inline">{view.directLabel}</span>
    </Button>
  )
  const status = view.statusAnnouncement ? (
    <span aria-live="polite" className="sr-only">
      {view.statusAnnouncement}
    </span>
  ) : null

  if (!help) {
    return (
      <>
        {button}
        {status}
      </>
    )
  }

  if (view.directAction) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{help}</TooltipContent>
        </Tooltip>
        <span hidden id={descriptionId}>
          {help}
        </span>
        {status}
      </>
    )
  }

  return (
    <>
      <DisabledReason id={descriptionId} label={ariaLabel} reason={help} tabIndex={tabIndex}>
        {button}
      </DisabledReason>
      {status}
    </>
  )
}

function safeDomId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'recording'
  )
}
