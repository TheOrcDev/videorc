import {
  ArrowCounterClockwise,
  ArrowsDownUp,
  Copy,
  PencilSimple,
  Trash,
  UploadSimple,
  ChatCircle,
  CheckCircle,
  CircleNotch,
  DotsThree,
  FileVideo,
  FolderOpen,
  LockSimple,
  MagnifyingGlass,
  Play,
  Sparkle,
  VideoCamera,
  WaveformSlash,
  Wrench
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore, useStudioRecording, useStudioRecordingState } from '@/hooks/use-studio'
import type { FileAssessment, GateStatus, SessionSummary } from '@/lib/backend'
import { dayLabel, durationMsLabel, formatBytes, isActiveRecordingState } from '@/lib/format'
import {
  LIBRARY_FILTERS,
  filterLibrarySessions,
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

// The Library as a recordings manager (Library rewrite L4): a table of every
// session — poster, name, scene, quality, duration, size, format, actions —
// with filter/sort/search on top and an honest storage footer below. All list
// logic is pure (lib/library-view); this component is the shell.
export function LibraryTab({
  onOpenInAi
}: {
  onOpenInAi: (sessionId: string) => void
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
          ? 'Recording moved to Trash.'
          : `${deleting.length} recordings moved to Trash.`
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        description="Every recording and stream becomes a local session. Files stay on disk; AI work happens in Publish."
        title="Library"
        action={
          <Button size="sm" onClick={() => setActive('studio')}>
            <VideoCamera data-icon="inline-start" weight="fill" />
            New Recording
          </Button>
        }
      />

      {/* Toolbar: filter · sort · search. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as LibraryFilter)}>
          <SelectTrigger className="h-8 w-40" size="sm">
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
            sort === 'newest'
              ? 'Newest first — click for oldest'
              : 'Oldest first — click for newest'
          }
          variant="outline"
          onClick={() => setSort((current) => (current === 'newest' ? 'oldest' : 'newest'))}
        >
          <ArrowsDownUp data-icon="inline-start" />
          {sort === 'newest' ? 'Newest' : 'Oldest'}
        </Button>
        <div className="relative min-w-48 flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search recordings"
            className="h-8 pl-8"
            placeholder="Search recordings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button disabled={importing} size="sm" variant="outline" onClick={() => void runImport()}>
          <UploadSimple data-icon="inline-start" />
          {importing ? 'Importing…' : 'Import'}
        </Button>
      </div>

      {/* Selection bar: the checkbox column's one bulk action. */}
      {selected.length > 0 ? (
        <div className="flex items-center gap-3 rounded-row border bg-muted/20 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">{selected.length} selected</span>
          <Button
            disabled={captureProtected || selectedCleanupActive}
            size="sm"
            variant="destructive"
            onClick={() => setDeleting(sessions.filter((session) => selected.includes(session.id)))}
          >
            <Trash data-icon="inline-start" />
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
        <Empty className="rounded-panel border py-16">
          <EmptyMedia variant="icon">
            <FileVideo weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No sessions yet</EmptyTitle>
          <EmptyDescription>
            Record or stream from the Studio tab to populate the library.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border">
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
                  onOpenInAi={() => onOpenInAi(session.id)}
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
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
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

      {/* Delete confirm: files go to the system Trash first — Trash is the undo. */}
      <Dialog
        open={deleting.length > 0}
        onOpenChange={(open) => !open && !deletePending && setDeleting([])}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {deleting.length === 1
                ? 'Delete this recording?'
                : `Delete ${deleting.length} recordings?`}
            </DialogTitle>
            <DialogDescription>
              {deleting.length === 1
                ? 'The recording and its file move to the system Trash.'
                : `${deleting.length} recordings and their files move to the system Trash.`}{' '}
              You can restore them from the Trash.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={deletePending}
              type="button"
              variant="ghost"
              onClick={() => setDeleting([])}
            >
              Cancel
            </Button>
            <Button
              disabled={deletePending || captureProtected}
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
              {deletePending ? 'Deleting…' : 'Move to Trash'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  onOpenInAi,
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
  onOpenInAi: () => void
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
          </p>
        </div>
      </div>
      <div className="min-w-0">
        {session.processingKind === 'noise-cleanup' ? (
          <Badge variant="outline">Noise cleaned</Badge>
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
          {typeof session.durationMs === 'number' ? durationMsLabel(session.durationMs) : '—'}
        </span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(session.fileSizeBytes)}
      </span>
      <div>
        {live ? (
          <StatusDot pulse label={liveSessionLabel(recording.state)} tone="error" />
        ) : format ? (
          <Badge variant={session.mp4Path ? 'success' : 'outline'}>{format}</Badge>
        ) : null}
      </div>
      <RowActions
        filePath={filePath}
        session={session}
        onDelete={onDelete}
        onOpenInAi={onOpenInAi}
        onRevealSession={onRevealSession}
        onRename={onRename}
      />
    </div>
  )
}

function LiveSessionDuration(): ReactElement {
  const { recording } = useStudioRecording()
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {typeof recording.durationMs === 'number' ? durationMsLabel(recording.durationMs) : '—'}
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
  session: Pick<SessionSummary, 'id' | 'durationMs' | 'status'>
}): ReactElement {
  const { connection, ensureSessionPoster } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const running = session.status === 'running'
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
        <FileVideo className="size-4 text-muted-foreground/50" weight="duotone" />
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
  onOpenInAi,
  onRevealSession,
  onRename,
  onDelete
}: {
  filePath: string | null
  session: SessionSummary
  onOpenInAi: () => void
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
  const canExportMp4 = Boolean(
    session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path
  )
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
  const fileActionsBusy = busy || cleanupView.conflictsWithFileActions
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
        toast.warning('Kept the original — it could not reach 100%.')
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
        <Play weight="fill" />
      </Button>
      <NoiseCleanupDirectAction
        sessionId={session.id}
        title={session.title || 'Untitled session'}
        view={cleanupView}
        onAction={(action) => void runNoiseCleanupAction(action)}
      />
      <Button
        aria-label="Open in Publish"
        size="icon-sm"
        title="Open in Publish (AI)"
        variant="ghost"
        onClick={onOpenInAi}
      >
        <Sparkle weight="fill" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Session actions"
            disabled={disconnected}
            size="icon-sm"
            variant="ghost"
          >
            {busy || cleanupView.busy ? (
              <CircleNotch className="animate-spin" />
            ) : (
              <DotsThree weight="bold" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!filePath || live} onClick={() => void playFile()}>
              <Play />
              Play
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenInAi}>
              <Sparkle />
              Open in Publish
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!filePath}
              onClick={() => filePath && void window.videorc?.revealSession?.(session.id)}
            >
              <FolderOpen />
              Show in Finder
            </DropdownMenuItem>
            {cleanupView.menuLabel ? (
              <DropdownMenuItem
                disabled={!cleanupMenuAction}
                onClick={() => cleanupMenuAction && void runNoiseCleanupAction(cleanupMenuAction)}
              >
                {cleanupView.premiumLocked ? <LockSimple /> : <WaveformSlash />}
                {cleanupView.menuLabel}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={!canExportMp4 || fileActionsBusy}
              onClick={() => void remuxSession(session.id)}
            >
              <FileVideo />
              Export MP4
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canOpenComments || busy || disconnected}
              onClick={() =>
                void openSessionCommentsWindow(session.id, session.title, session.startedAt)
              }
            >
              <ChatCircle />
              Open Comments
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={busy} onClick={onRename}>
              <PencilSimple />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!filePath || fileActionsBusy || duplicating || live}
              onClick={() => void runDuplicate()}
            >
              <Copy />
              {duplicating ? 'Duplicating…' : 'Duplicate'}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={!filePath || fileActionsBusy || captureProtected}
              onClick={() => void runCheck()}
            >
              <CheckCircle />
              {phase === 'checking' ? 'Checking…' : 'Check quality'}
            </DropdownMenuItem>
            {canRepair ? (
              <DropdownMenuItem
                disabled={fileActionsBusy || captureProtected}
                onClick={() => void runRepair()}
              >
                <Wrench />
                {phase === 'repairing' ? 'Repairing…' : 'Repair & fix'}
              </DropdownMenuItem>
            ) : null}
            {hasBackup || persistedRepaired ? (
              <DropdownMenuItem
                disabled={fileActionsBusy || captureProtected}
                onClick={() => void runRestore()}
              >
                <ArrowCounterClockwise />
                Restore original
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={fileActionsBusy || captureProtected}
              variant="destructive"
              onClick={onDelete}
            >
              <Trash />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
        <LockSimple data-icon="inline-start" />
      ) : view.busy ? (
        <CircleNotch className="animate-spin" data-icon="inline-start" />
      ) : (
        <WaveformSlash data-icon="inline-start" />
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
