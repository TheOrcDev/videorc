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
  MagnifyingGlass,
  Play,
  Sparkle,
  VideoCamera,
  Wrench
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
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
import { cn } from '@/lib/utils'

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
    sessionStorageTotals,
    settings,
    importRecording,
    deleteSessions,
    renameSession
  } = useStudio()
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
  const visibleIds = useMemo(() => visible.map((session) => session.id), [visible])
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))

  // Free space is an Electron-side directory fact (same source as Settings).
  useEffect(() => {
    const directory = settings.outputDirectory?.trim()
    if (!directory || !window.videorc?.checkDirectory) {
      setFreeBytes(null)
      return
    }
    let cancelled = false
    void window.videorc
      .checkDirectory(directory)
      .then((facts) => {
        if (!cancelled) {
          setFreeBytes(facts.freeBytes)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [settings.outputDirectory, sessions.length])

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
            {LIBRARY_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
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
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_8rem] items-center gap-2 border-b px-3 py-2 text-[12.5px] font-medium text-subtle">
            <Checkbox
              aria-label="Select all visible recordings"
              checked={allVisibleSelected}
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
                  session={session}
                  onDelete={() => setDeleting([session])}
                  onOpenInAi={() => onOpenInAi(session.id)}
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
          {sessionStorageTotals ? (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              {libraryStorageLabel({
                count: sessionStorageTotals.count,
                totalBytes: sessionStorageTotals.totalBytes,
                freeBytes
              })}
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
              disabled={deletePending}
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
  onToggleSelected,
  onOpenInAi,
  onRename,
  onDelete
}: {
  session: SessionSummary
  selected: boolean
  onToggleSelected: () => void
  onOpenInAi: () => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
  const { recording } = useStudio()
  const filePath = session.mp4Path ?? session.outputPath ?? null
  const format = sessionFormatLabel(session)
  // A live row shows the capture's ticking elapsed time; the session row only
  // gets duration_ms at finalize.
  const live = isLiveSession(session, recording)
  const durationMs = live ? recording.durationMs : session.durationMs
  return (
    <div
      className={cn(
        'grid grid-cols-[2rem_minmax(0,1fr)_8rem_5.5rem_5.5rem_4.5rem_8rem] items-center gap-2 border-b border-border/60 px-3 py-2 transition-colors last:border-b-0 hover:bg-accent/50',
        selected && 'bg-accent/60'
      )}
      data-videorc-library-row={session.id}
    >
      <Checkbox
        aria-label={`Select ${session.title || 'session'}`}
        checked={selected}
        onCheckedChange={onToggleSelected}
      />
      <div className="flex min-w-0 items-center gap-3">
        <SessionPoster session={session} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{session.title || 'Untitled session'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {dayLabel(session.startedAt)}
            {!filePath && !live ? ' · no local file' : ''}
          </p>
        </div>
      </div>
      <div className="min-w-0">
        {session.sceneLabel ? (
          <Badge className="max-w-full" variant="outline">
            <span className="truncate">{session.sceneLabel}</span>
          </Badge>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {typeof durationMs === 'number' ? durationMsLabel(durationMs) : '—'}
      </span>
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
        onRename={onRename}
      />
    </div>
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
  const { connection, ensureSessionPoster, recording } = useStudio()
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
  onRename,
  onDelete
}: {
  filePath: string | null
  session: SessionSummary
  onOpenInAi: () => void
  onRename: () => void
  onDelete: () => void
}): ReactElement {
  const {
    assessRecording,
    repairRecording,
    restoreRecording,
    recording,
    wsStatus,
    remuxSession,
    openSessionCommentsWindow,
    duplicateSession
  } = useStudio()
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

  const playFile = async (): Promise<void> => {
    if (!filePath || !window.videorc?.openPath) {
      return
    }
    const problem = await window.videorc.openPath(filePath)
    if (problem) {
      toast.error(problem)
    }
  }

  const runCheck = async (): Promise<void> => {
    if (!filePath) return
    setPhase('checking')
    try {
      const next = await assessRecording(filePath)
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
      const next: GateStatus = await repairRecording(filePath)
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
      const restored = await restoreRecording(filePath)
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

  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        aria-label="Play recording"
        className="size-8"
        disabled={!filePath || live}
        size="icon"
        title={live ? 'Available when the session ends' : 'Play in the default player'}
        variant="ghost"
        onClick={() => void playFile()}
      >
        <Play className="size-4" weight="fill" />
      </Button>
      <Button
        aria-label="Open in Publish"
        className="size-8"
        size="icon"
        title="Open in Publish (AI)"
        variant="ghost"
        onClick={onOpenInAi}
      >
        <Sparkle className="size-4" weight="fill" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Session actions"
            className="size-8"
            disabled={disconnected}
            size="icon"
            variant="ghost"
          >
            {busy ? (
              <CircleNotch className="size-4 animate-spin" />
            ) : (
              <DotsThree className="size-4" weight="bold" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
            onClick={() => filePath && void window.videorc?.revealPath?.(filePath)}
          >
            <FolderOpen />
            Show in Finder
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canExportMp4 || busy}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onClick={onRename}>
            <PencilSimple />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!filePath || busy || duplicating || live}
            onClick={() => void runDuplicate()}
          >
            <Copy />
            {duplicating ? 'Duplicating…' : 'Duplicate'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!filePath || busy || captureProtected}
            onClick={() => void runCheck()}
          >
            <CheckCircle />
            {phase === 'checking' ? 'Checking…' : 'Check quality'}
          </DropdownMenuItem>
          {canRepair ? (
            <DropdownMenuItem disabled={busy || captureProtected} onClick={() => void runRepair()}>
              <Wrench />
              {phase === 'repairing' ? 'Repairing…' : 'Repair & fix'}
            </DropdownMenuItem>
          ) : null}
          {hasBackup || persistedRepaired ? (
            <DropdownMenuItem disabled={busy || captureProtected} onClick={() => void runRestore()}>
              <ArrowCounterClockwise />
              Restore original
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy || captureProtected}
            variant="destructive"
            onClick={onDelete}
          >
            <Trash />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
