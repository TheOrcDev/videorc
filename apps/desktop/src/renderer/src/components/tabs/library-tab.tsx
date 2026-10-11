import {
  CameraIcon,
  ChatIcon,
  ClipIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  FolderIcon,
  LockIcon,
  BuddyIcon,
  PlayIcon,
  RepairIcon,
  ResetIcon,
  SearchIcon,
  SortIcon,
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
  type ReactElement
} from 'react'
import { toast } from '@/lib/toast'

import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { PageHeader } from '@/components/page'
import { PANE_OWNS_SCROLL, PaneStrip } from '@/components/pane'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
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
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import { useStudioCore, useStudioRecording, useStudioRecordingState } from '@/hooks/use-studio'
import type { FileAssessment, GateStatus, SessionSummary } from '@/lib/backend'
import {
  finalizationFailed,
  finalizingBadgeLabel,
  isFinalizingSession
} from '@/lib/session-finalization'
import { dayLabel, durationMsLabel, formatBytes, isActiveRecordingState } from '@/lib/format'
import { cleanCutModeLabel, isCleanCutEligible, type CleanCutSession } from '@/lib/clean-cut-view'
import { revealInFileManagerLabel, trashName } from '@/lib/platform'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  LIBRARY_FILTERS,
  filterLibrarySessions,
  hasBuddyReport,
  isLiveSession,
  libraryStorageLabel,
  liveSessionLabel,
  sessionFormatLabel,
  sessionPosterUrl,
  sortLibrarySessions,
  toggleAllLibrarySelection,
  toggleLibrarySelection,
  type LibraryFilter,
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

const SessionMarkersDialog = lazy(async () => ({
  default: (await import('@/components/session-markers-dialog')).SessionMarkersDialog
}))

// The Library as a recordings manager (Library rewrite L4): a table of every
// session — poster, name, scene, quality, duration, size, format, actions —
// with filter/sort/search on top and an honest storage footer below. All list
// logic is pure (lib/library-view); this component is the shell.
export function LibraryTab({
  onOpenBuddyReport,
  onOpenCleanCut,
  focusSessionId = null
}: {
  /** "Buddy report": the Buddy tab, opened on this session's report. */
  onOpenBuddyReport: (sessionId: string) => void
  /** "Clean cut": the Buddy tab's Clean cut, on this recording (plan 119 S14). */
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
    noiseCleanupJobs
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const captureProtected = isActiveRecordingState(recording.state)
  const { setActive } = useWorkspaceNav()
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [markerSession, setMarkerSession] = useState<SessionSummary | null>(null)
  const [renaming, setRenaming] = useState<SessionSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleting, setDeleting] = useState<SessionSummary[]>([])
  const [deletePending, setDeletePending] = useState(false)
  const [recentlyCreatedSessionId, setRecentlyCreatedSessionId] = useState<string | null>(null)
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>())
  const previousCleanupStatusesRef = useRef(new Map<string, string>())

  const focusLibrarySession = useCallback((sessionId: string): void => {
    setFilter('all')
    setQuery('')
    setRecentlyCreatedSessionId(sessionId)
  }, [])
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null)
  if (focusSessionId && focusSessionId !== appliedFocus) {
    setAppliedFocus(focusSessionId)
    focusLibrarySession(focusSessionId)
  }

  const runImport = async (): Promise<void> => {
    setImporting(true)
    try {
      await importRecording()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed.')
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
          ? `Recording moved to the ${trashName()}.`
          : `${deleting.length} recordings moved to the ${trashName()}.`
      )
      setSelected((current) => current.filter((id) => !deleting.some((s) => s.id === id)))
      setDeleting([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed.')
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
      await renameSession(renaming.id, title)
      setRenaming(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Rename failed.')
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
  const visibleIds = useMemo(
    () =>
      visible
        .filter((session) => !activeCleanupSourceIds.has(session.id))
        .map((session) => session.id),
    [activeCleanupSourceIds, visible]
  )
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  const selectedCleanupActive = selected.some((id) => activeCleanupSourceIds.has(id))

  useEffect(() => {
    for (const job of noiseCleanupJobs) {
      const previous = previousCleanupStatusesRef.current.get(job.id)
      previousCleanupStatusesRef.current.set(job.id, job.status)
      if (
        previous &&
        previous !== 'completed' &&
        job.status === 'completed' &&
        job.outputSessionId
      ) {
        focusLibrarySession(job.outputSessionId)
      }
    }
  }, [focusLibrarySession, noiseCleanupJobs])

  useEffect(() => {
    if (!recentlyCreatedSessionId) {
      return
    }
    const row = rowElementsRef.current.get(recentlyCreatedSessionId)
    if (!row) {
      return
    }
    row.scrollIntoView({ block: 'nearest' })
    row.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setRecentlyCreatedSessionId(null), 3000)
    return () => window.clearTimeout(timer)
  }, [recentlyCreatedSessionId, visible])

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

  return (
    // Library owns its scroll: the header and the filter bar stay pinned and
    // only the table scrolls (plan 174 S1.6b).
    <div {...PANE_OWNS_SCROLL} className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        description="Every recording and stream becomes a local session. Files stay on disk."
        title="Library"
      />

      {/* Filter bar: filter · sort · search. */}
      <PaneStrip className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as LibraryFilter)}>
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
        <Button
          size="sm"
          title={
            sort === 'newest' ? 'Newest first. Click for oldest' : 'Oldest first. Click for newest'
          }
          variant="outline"
          onClick={() => setSort((current) => (current === 'newest' ? 'oldest' : 'newest'))}
        >
          <SortIcon data-icon="inline-start" />
          {sort === 'newest' ? 'Newest' : 'Oldest'}
        </Button>
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search recordings"
            className="pl-8"
            placeholder="Search recordings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button disabled={importing} size="sm" variant="outline" onClick={() => void runImport()}>
          <UploadIcon data-icon="inline-start" />
          {importing ? 'Importing…' : 'Import'}
        </Button>
        <Button size="sm" onClick={() => setActive('studio')}>
          <CameraIcon data-icon="inline-start" weight="fill" />
          New Recording
        </Button>
      </PaneStrip>

      {/* Selection bar: the checkbox column's one bulk action. */}
      {selected.length > 0 ? (
        <div className="flex items-center gap-3 border-b border-border bg-accent/50 px-gutter py-1.5 text-sm">
          <span className="text-muted-foreground">{selected.length} selected</span>
          <Button
            disabled={captureProtected || selectedCleanupActive}
            size="sm"
            variant="destructive"
            onClick={() => setDeleting(sessions.filter((session) => selected.includes(session.id)))}
          >
            <DeleteIcon data-icon="inline-start" />
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear selection
          </Button>
          {selectedCleanupActive ? (
            <span className="text-xs text-muted-foreground">
              Cancel or finish Noise Cleanup before deleting its source.
            </span>
          ) : null}
        </div>
      ) : null}

      {sessions.length === 0 ? (
        <Empty className="py-16">
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Record or stream from the Studio tab to populate the library.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Header row */}
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_8rem] items-center gap-2 border-b px-3 py-2 text-[12.5px] font-medium text-subtle min-[1280px]:grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_13rem]">
            <Checkbox
              aria-label="Select all available visible recordings"
              checked={allVisibleSelected}
              disabled={captureProtected || visibleIds.length === 0}
              onCheckedChange={() =>
                setSelected((current) => toggleAllLibrarySelection(current, visibleIds))
              }
            />
            <span>Name</span>
            <span>Session</span>
            <span>Duration</span>
            <span>Size</span>
            <span />
            <span className="text-right">Actions</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                No recordings match this filter.
              </p>
            ) : (
              visible.map((session) => (
                <LibraryRow
                  key={session.id}
                  selected={selected.includes(session.id)}
                  selectionDisabled={
                    captureProtected ||
                    isLiveSession(session, recording) ||
                    activeCleanupSourceIds.has(session.id)
                  }
                  session={session}
                  recentlyCreated={recentlyCreatedSessionId === session.id}
                  registerRow={(element) => {
                    if (element) rowElementsRef.current.set(session.id, element)
                    else rowElementsRef.current.delete(session.id)
                  }}
                  onDelete={() => setDeleting([session])}
                  onOpenCleanCut={() => onOpenCleanCut(session.id)}
                  onOpenBuddyReport={() => onOpenBuddyReport(session.id)}
                  onOpenMarkers={() => setMarkerSession(session)}
                  onRevealSession={focusLibrarySession}
                  onRename={() => {
                    setRenaming(session)
                    setRenameDraft(session.title)
                  }}
                  onToggleSelected={() =>
                    setSelected((current) => toggleLibrarySelection(current, session.id))
                  }
                />
              ))
            )}
          </div>
          {/* Honest storage footer: real totals + real free space, no quota bar. */}
          {sessionStorageTotals || sessionsNextCursor ? (
            <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
              <span>
                {sessionStorageTotals
                  ? libraryStorageLabel({
                      count: sessionStorageTotals.count,
                      totalBytes: sessionStorageTotals.totalBytes,
                      freeBytes
                    })
                  : `${sessions.length} sessions loaded`}
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

      {/* Rename dialog */}
      {markerSession ? (
        <Suspense fallback={null}>
          <SessionMarkersDialog session={markerSession} onClose={() => setMarkerSession(null)} />
        </Suspense>
      ) : null}
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
              maxLength={120}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
            />
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
          cannot, and the copy says so. */}
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
      />
    </div>
  )
}

function LibraryRow({
  session,
  selected,
  recentlyCreated,
  selectionDisabled,
  registerRow,
  onToggleSelected,
  onOpenCleanCut,
  onOpenBuddyReport,
  onOpenMarkers,
  onRevealSession,
  onRename,
  onDelete
}: {
  session: SessionSummary
  selected: boolean
  recentlyCreated: boolean
  selectionDisabled: boolean
  registerRow: (element: HTMLDivElement | null) => void
  onToggleSelected: () => void
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
  return (
    <div
      ref={registerRow}
      aria-label={`${session.title || 'Untitled session'} recording row`}
      className={cn(
        'grid grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_8rem] items-center gap-2 border-b border-border/60 px-3 py-2 transition-colors last:border-b-0 hover:bg-accent/50 min-[1280px]:grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_13rem]',
        selected && 'bg-accent/60',
        recentlyCreated && 'bg-accent/60 ring-1 ring-ring/40'
      )}
      data-videorc-library-row={session.id}
      role="group"
      tabIndex={-1}
    >
      <Checkbox
        aria-label={`Select ${session.title || 'session'}`}
        checked={selected}
        disabled={selectionDisabled}
        onCheckedChange={onToggleSelected}
      />
      <div className="flex min-w-0 items-center gap-3">
        <SessionPoster session={session} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{session.title || 'Untitled session'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {dayLabel(session.startedAt)}
            {!filePath && !live ? ' · no local file' : ''}
            {session.processingKind === 'noise-cleanup' && session.sourceTitle
              ? ` · cleaned from ${session.sourceTitle}`
              : ''}
            {cleanCutMode && session.sourceTitle ? ` · cut from ${session.sourceTitle}` : ''}
          </p>
        </div>
      </div>
      <div className="min-w-0">
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
      {live ? (
        <LiveSessionDuration />
      ) : (
        <span className="text-xs text-muted-foreground tabular-nums">
          {typeof session.durationMs === 'number' ? durationMsLabel(session.durationMs) : '-'}
        </span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(session.fileSizeBytes)}
      </span>
      <div>
        {live ? (
          <StatusDot pulse label={liveSessionLabel(recording)} tone="error" />
        ) : finalizing ? (
          <Badge variant="outline">
            <Spinner data-icon="inline-start" />
            {finalizingBadgeLabel(session)}
          </Badge>
        ) : exportFailed ? (
          <Badge title={session.finalizationError} variant="destructive">
            MP4 failed
          </Badge>
        ) : format ? (
          <Badge variant={session.mp4Path ? 'success' : 'outline'}>{format}</Badge>
        ) : null}
      </div>
      <RowActions
        filePath={filePath}
        session={session}
        onDelete={onDelete}
        onOpenCleanCut={onOpenCleanCut}
        onOpenBuddyReport={onOpenBuddyReport}
        onOpenMarkers={onOpenMarkers}
        onRevealSession={onRevealSession}
        onRename={onRename}
      />
    </div>
  )
}

/** Ticks from the session's start: running statuses carry no duration. */
function LiveSessionDuration(): ReactElement {
  const { recording } = useStudioRecording()
  const elapsedMs = useSessionElapsedMs(recording.startedAt) ?? recording.durationMs
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {typeof elapsedMs === 'number' ? durationMsLabel(elapsedMs) : '-'}
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
        <StatusDot pulse tone="error" />
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
        <VideoFileIcon className="size-4 text-muted-foreground/50" weight="duotone" />
      )}
    </span>
  )
}

type RepairPhase = 'idle' | 'checking' | 'assessed' | 'repairing' | 'done'

// The row's trailing action cluster: Play + kebab. Everything file-shaped
// (reveal, export, quality check, repair, restore) lives in the menu — the
// Library remains the single home of session artifacts (ux-ia slice 3).
function RowActions({
  filePath,
  session,
  onOpenCleanCut,
  onOpenBuddyReport,
  onOpenMarkers,
  onRevealSession,
  onRename,
  onDelete
}: {
  filePath: string | null
  session: SessionSummary
  onOpenCleanCut: () => void
  onOpenBuddyReport: () => void
  onOpenMarkers: () => void
  onRevealSession: (sessionId: string) => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
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
      await duplicateSession(session.id)
      toast.success('Recording duplicated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Duplicate failed.')
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
  const fileActionsBusy = busy || cleanupView.conflictsWithFileActions || finalizing
  const cleanupMenuAction = cleanupView.menuAction

  const playFile = async (): Promise<void> => {
    if (!filePath || !window.videorc?.openSession) {
      return
    }
    const problem = await window.videorc.openSession(session.id)
    if (problem) {
      toast.error(problem)
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
        toast.success('Passes every quality gate.')
      } else {
        const first = next.reasons[0] ?? next.issues[0]?.kind
        toast.warning(
          `${next.issues.length} quality issue${next.issues.length === 1 ? '' : 's'} found.`,
          {
            description: next.repairable
              ? `${first ? `${first} ` : ''}Repair is available from this menu.`
              : first
          }
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Quality check failed.')
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
          next.interpolated ? 'Repaired with interpolated frames.' : 'Recording repaired.'
        )
      } else if (next.status === 'ready') {
        toast.success('Recording already passes every quality gate.')
      } else if (next.status === 'not-hundred-percent') {
        toast.warning('Kept the original. It could not reach 100%.')
      } else {
        toast.error('The quality check could not run.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Repair failed.')
      setPhase('assessed')
    }
  }

  const runRestore = async (): Promise<void> => {
    if (!filePath) return
    try {
      const restored = await restoreRecording(session.id)
      if (restored) {
        toast.success('Restored the original recording from backup.')
        setHasBackup(false)
        setAssessment(null)
        setPhase('idle')
      } else {
        toast.info('No backup was found for this recording.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Restore failed.')
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
      await startNoiseCleanup(session.id)
      toast.success('Noise cleanup queued.', {
        description: 'Videorc will create a separate cleaned copy on this device.'
      })
    } catch (error) {
      toast.error(action === 'cancel' ? 'Could not cancel cleanup.' : 'Noise cleanup failed.', {
        description: error instanceof Error ? error.message : String(error)
      })
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
          // The Buddy tab's Clean cut, on this recording (plan 119 S14).
          {
            id: 'clean-cut',
            group: 'open',
            icon: ClipIcon,
            label: 'Clean cut',
            onSelect: onOpenCleanCut
          }
        ]
      : []),
    { id: 'markers', group: 'open', icon: ClipIcon, label: 'Markers', onSelect: onOpenMarkers },
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
      label: 'Rename',
      disabled: busy,
      onSelect: onRename
    },
    {
      id: 'duplicate',
      group: 'edit',
      icon: CopyIcon,
      label: duplicating ? 'Duplicating…' : 'Duplicate',
      disabled: !filePath || fileActionsBusy || duplicating || live,
      onSelect: () => void runDuplicate()
    },
    {
      id: 'check',
      group: 'repair',
      icon: SuccessIcon,
      label: phase === 'checking' ? 'Checking…' : 'Check quality',
      disabled: !filePath || fileActionsBusy || captureProtected,
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
            onSelect: () => void runRestore()
          }
        ]
      : []),
    {
      id: 'delete',
      destructive: true,
      icon: DeleteIcon,
      label: 'Delete',
      disabled: fileActionsBusy || captureProtected,
      onSelect: onDelete
    }
  ]

  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        aria-label="Play recording"
        disabled={!filePath || live}
        size="icon-sm"
        title={live ? 'Available when the session ends' : 'Play in the default player'}
        variant="ghost"
        onClick={() => void playFile()}
      >
        <PlayIcon weight="fill" />
      </Button>
      <NoiseCleanupDirectAction
        sessionId={session.id}
        title={session.title || 'Untitled session'}
        view={cleanupView}
        onAction={(action) => void runNoiseCleanupAction(action)}
      />
      <KebabMenu
        busy={busy || cleanupView.busy}
        disabled={disconnected}
        items={sessionMenu}
        label="Session actions"
      />
    </div>
  )
}

export function NoiseCleanupDirectAction({
  sessionId,
  title,
  view,
  onAction
}: {
  sessionId: string
  title: string
  view: NoiseCleanupView
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
      aria-describedby={help ? descriptionId : undefined}
      aria-label={ariaLabel}
      className="min-[1280px]:w-auto min-[1280px]:px-2"
      disabled={!view.directAction}
      size="icon-sm"
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
          <TooltipContent id={descriptionId}>{help}</TooltipContent>
        </Tooltip>
        {status}
      </>
    )
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-describedby={descriptionId}
            aria-label={ariaLabel}
            className="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            tabIndex={0}
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent id={descriptionId}>{help}</TooltipContent>
      </Tooltip>
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
