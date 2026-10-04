import {
  ArrowLeftIcon,
  ChatIcon,
  ClipIcon,
  MicrophoneIcon,
  PinIcon,
  SaveIcon,
  SpinnerIcon
} from '@/components/icons'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'

import type { CleanCutReviewTarget } from '@/components/clean-cut/clean-cut-card'
import {
  CleanCutTranscript,
  TONE_DOT,
  type CleanCutScrollRequest
} from '@/components/clean-cut/clean-cut-transcript'
import type { SessionPlayerHandle } from '@/components/media/session-player'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CleanCutClient } from '@/hooks/use-clean-cut'
import { useOrcleReport } from '@/hooks/use-orcle-report'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import type { ClipMomentSource, CleanCutEdl, CleanCutJob, CleanCutMode } from '@/lib/backend'
import {
  EMPTY_CLEAN_CUT_DRAFT,
  activeWordIndex,
  buildCleanCutParagraphs,
  cleanCutKindChips,
  cleanCutPins,
  cleanCutStats,
  cleanCutTranscriptItems,
  cutSkipRanges,
  draftChangeCount,
  effectiveRemovals,
  navigableRemovals,
  normalizeTranscriptWords,
  prerollMs,
  rebaseDraft,
  removalRowIndex,
  stepRemoval,
  toggleKindGroup,
  toggleRemoval,
  updateEdlPayload,
  type CleanCutDraft,
  type CleanCutKindChip,
  type CleanCutKindGroupId,
  type CleanCutPin
} from '@/lib/clean-cut-review'
import {
  cleanCutJobEditable,
  cleanCutModeLabel,
  cleanCutStatusView,
  formatCutClock,
  type CleanCutJobDetailWithKeeps,
  type CleanCutTranscript as CleanCutTranscriptData
} from '@/lib/clean-cut-view'
import { isActiveRecordingState } from '@/lib/format'
import { displayKeyGlyph } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { sessionIsLive } from '../../../../shared/capture-state'

const SessionPlayer = lazy(async () => ({
  default: (await import('@/components/media/session-player')).SessionPlayer
}))

const UNTITLED = 'Untitled recording'

interface ReviewData {
  job: CleanCutJob
  edl: CleanCutEdl
  /** Null when the transcript could not be read: the cuts still show as markers. */
  transcript: CleanCutTranscriptData | null
}

type ReviewLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** No cut list yet (or no job of this kind): the job's status, if any. */
  | { kind: 'waiting'; job: CleanCutJob | null }
  | { kind: 'ready'; data: ReviewData }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function pickDetail(
  jobs: readonly CleanCutJobDetailWithKeeps[],
  mode: CleanCutMode,
  jobId: string | null
): CleanCutJobDetailWithKeeps | null {
  return (
    (jobId ? jobs.find((detail) => detail.job.id === jobId) : undefined) ??
    jobs.find((detail) => detail.job.mode === mode) ??
    null
  )
}

const EMPTY_WORDS: CleanCutTranscriptData['words'] = []
const EMPTY_SEGMENTS: CleanCutTranscriptData['segments'] = []

/**
 * Clean cut review (plan 119 S14). The source recording plays on top
 * with the cut list as a virtual preview (removed spans are skipped), the
 * transcript below shows every cut, and edits stay a local draft until "Save
 * changes" sends one `cleanCut.updateEdl` and renders the cut again.
 * Keyboard-first: Space plays, ← → seek, ↑ ↓ walk the cuts, Enter keeps or
 * cuts one, ⌘S saves.
 */
export function CleanCutReview({
  client,
  target,
  onClose,
  onOpenLibrarySession
}: {
  client: CleanCutClient
  target: CleanCutReviewTarget
  onClose: () => void
  onOpenLibrarySession: (sessionId: string) => void
}): ReactElement {
  const { sessions, runtimeInfo } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const mode = target.mode
  const jobId = target.jobId
  const [load, setLoad] = useState<ReviewLoad>({ kind: 'loading' })
  const [reloads, setReloads] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const [draft, setDraft] = useState<CleanCutDraft>(EMPTY_CLEAN_CUT_DRAFT)
  const [draftJob, setDraftJob] = useState<string | null>(null)
  const [preview, setPreview] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [positionMs, setPositionMs] = useState(0)
  const [scrollRequest, setScrollRequest] = useState<CleanCutScrollRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const playerRef = useRef<SessionPlayerHandle>(null)

  const { connected, get, transcript: readTranscript, subscribe } = client

  useEffect(() => {
    if (!connected) return
    let current = true
    setLoad((previous) => (previous.kind === 'ready' ? previous : { kind: 'loading' }))
    void (async () => {
      try {
        const result = await get(target.sessionId)
        const detail = pickDetail(result.jobs, mode, jobId)
        if (!current) return
        if (!detail?.edl) {
          setLoad({ kind: 'waiting', job: detail?.job ?? null })
          return
        }
        let transcript: CleanCutTranscriptData | null = null
        try {
          transcript = await readTranscript(detail.job.id)
        } catch {
          transcript = null
        }
        if (!current) return
        setLoad({
          kind: 'ready',
          data: {
            job: detail.job,
            edl: detail.edl,
            transcript
          }
        })
      } catch (error) {
        if (current) setLoad({ kind: 'error', message: errorMessage(error) })
      }
    })()
    return () => {
      current = false
    }
  }, [connected, get, jobId, mode, readTranscript, reloads, target.sessionId])

  // Live job snapshots: render progress, and the cut list arriving while we wait.
  useEffect(
    () =>
      subscribe((job) => {
        const current = loadRef.current
        if (current.kind === 'ready' && current.data.job.id === job.id) {
          setLoad({ kind: 'ready', data: { ...current.data, job } })
          return
        }
        if (
          current.kind === 'waiting' &&
          job.sourceSessionId === target.sessionId &&
          job.mode === mode
        ) {
          if (job.edlSummary) setReloads((value) => value + 1)
          else setLoad({ kind: 'waiting', job })
        }
      }),
    [mode, subscribe, target.sessionId]
  )

  const data = load.kind === 'ready' ? load.data : null
  // A different job starts with a clean draft.
  if (data && data.job.id !== draftJob) {
    setDraftJob(data.job.id)
    setDraft(EMPTY_CLEAN_CUT_DRAFT)
    setSelectedId(null)
  }

  const saved = data?.edl.removals ?? null
  const words = useMemo(
    () => normalizeTranscriptWords(data?.transcript?.words ?? EMPTY_WORDS),
    [data?.transcript]
  )
  const segments = data?.transcript?.segments ?? EMPTY_SEGMENTS
  const effective = useMemo(() => (saved ? effectiveRemovals(saved, draft) : []), [draft, saved])
  const removalsById = useMemo(
    () => new Map(effective.map((removal) => [removal.id, removal])),
    [effective]
  )
  const report = useOrcleReport(target.sessionId)
  const pins = useMemo(() => cleanCutPins(report.payload?.moments), [report.payload])
  const durationMs = data?.edl.durationMs ?? 0
  const paragraphs = useMemo(
    () => (saved ? buildCleanCutParagraphs({ words, segments, removals: saved, pins }) : []),
    [pins, saved, segments, words]
  )
  const items = useMemo(() => cleanCutTranscriptItems(paragraphs), [paragraphs])
  const rows = useMemo(() => removalRowIndex(items), [items])
  const order = useMemo(() => navigableRemovals(effective, rows), [effective, rows])
  const chips = useMemo(() => cleanCutKindChips(effective), [effective])
  const skipRanges = useMemo(
    () => (preview ? cutSkipRanges(effective) : undefined),
    [effective, preview]
  )
  const changes = draftChangeCount(draft)
  const stats = data
    ? cleanCutStats({
        durationMs,
        saved: data.edl.removals,
        effective,
        savedKeptMs: data.edl.stats.keptMs
      })
    : null
  const activeWord = activeWordIndex(words, positionMs)

  const source = sessions.find((session) => session.id === target.sessionId) ?? null
  const title = source?.title.trim() || UNTITLED
  const playable =
    !source || (source.status === 'completed' && source.finalizationState !== 'finalizing')
  const captureActive = isActiveRecordingState(recording.state)
  const job = data?.job ?? (load.kind === 'waiting' ? load.job : null)
  const status = cleanCutStatusView(job, { captureActive, streaming: sessionIsLive(recording) })
  const editable = data ? cleanCutJobEditable(data.job) : false
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)

  const select = useCallback(
    (id: string | null, seek: boolean): void => {
      setSelectedId(id)
      if (!id) return
      const row = rows.get(id)
      if (row !== undefined) setScrollRequest({ row, nonce: Date.now() })
      const removal = removalsById.get(id)
      if (seek && removal) playerRef.current?.seekTo(prerollMs(removal))
    },
    [removalsById, rows]
  )

  const toggle = useCallback(
    (id: string): void => {
      if (!saved) return
      setDraft((current) => toggleRemoval(current, saved, id))
      setSelectedId(id)
      setNotice(null)
    },
    [saved]
  )

  const toggleGroup = (groupId: CleanCutKindGroupId): void => {
    if (!saved) return
    setDraft((current) => toggleKindGroup(current, saved, groupId))
    setNotice(null)
  }

  const seek = useCallback((ms: number): void => playerRef.current?.seekTo(ms), [])

  const save = async (): Promise<void> => {
    if (!data || changes === 0 || saving) return
    if (!editable) {
      setNotice('You can save when this cut finishes.')
      return
    }
    setSaving(true)
    setNotice(null)
    const jobIdToSave = data.job.id
    try {
      const detail = await client.updateEdl(
        updateEdlPayload(jobIdToSave, data.job.edlRevision, draft)
      )
      setLoad((current) =>
        current.kind === 'ready'
          ? {
              kind: 'ready',
              data: { ...current.data, job: detail.job, edl: detail.edl ?? current.data.edl }
            }
          : current
      )
      setDraft(EMPTY_CLEAN_CUT_DRAFT)
      try {
        const rendered = await client.render(jobIdToSave)
        setLoad((current) =>
          current.kind === 'ready' && current.data.job.id === rendered.id
            ? { kind: 'ready', data: { ...current.data, job: rendered } }
            : current
        )
      } catch (error) {
        setNotice(`Your changes are saved, but the cut didn't start: ${errorMessage(error)}`)
      }
    } catch (error) {
      if (errorCode(error) === 'edl-revision-conflict') {
        await reloadAfterConflict(jobIdToSave)
      } else {
        setNotice(errorMessage(error))
      }
    } finally {
      setSaving(false)
    }
  }

  /** The cut list changed under us: load the newest and carry the draft onto it. */
  const reloadAfterConflict = async (conflictJobId: string): Promise<void> => {
    try {
      const result = await client.get(target.sessionId)
      const fresh = pickDetail(result.jobs, mode, conflictJobId)
      if (!fresh?.edl) {
        setNotice('The cut list changed. Reload the review to see it.')
        return
      }
      const edl = fresh.edl
      setLoad((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', data: { ...current.data, job: fresh.job, edl } }
          : current
      )
      setDraft((current) => rebaseDraft(current, edl.removals))
      setNotice(
        'The cut list changed while you edited. Your changes are on the newest one; save again.'
      )
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const close = (): void => {
    if (changes > 0) setLeaving(true)
    else onClose()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) return
    const element = event.target instanceof HTMLElement ? event.target : null
    if (element?.closest('input, textarea, select, [contenteditable="true"]')) return
    const key = event.key
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const onControl = Boolean(
      element?.closest('button, [role="tab"], [role="slider"], [role="radio"]')
    )
    switch (key) {
      case ' ':
        if (onControl) return
        event.preventDefault()
        playerRef.current?.togglePlayback()
        return
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onControl) return
        event.preventDefault()
        playerRef.current?.seekBy(key === 'ArrowLeft' ? -5_000 : 5_000)
        return
      case 'ArrowUp':
      case 'ArrowDown':
        if (onControl) return
        event.preventDefault()
        select(stepRemoval(order, selectedId, key === 'ArrowDown' ? 1 : -1, positionMs), true)
        return
      case 'Enter':
        if (onControl || !selectedId) return
        event.preventDefault()
        toggle(selectedId)
        return
      default:
        return
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      data-slot="clean-cut-review"
      data-mode={mode}
      onKeyDown={handleKeyDown}
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-gutter py-1.5">
        <Button size="sm" type="button" variant="ghost" onClick={close}>
          <ArrowLeftIcon data-icon="inline-start" />
          Orcle
        </Button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate text-[13px] font-semibold text-foreground" title={title}>
            {title}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">{cleanCutModeLabel(mode)}</span>
        </div>
        {stats ? (
          <p
            className="flex shrink-0 items-baseline gap-2 tabular-nums"
            data-slot="clean-cut-stats"
          >
            <span className="text-[15px] leading-5 font-semibold text-foreground">
              {formatCutClock(stats.durationMs)} → {formatCutClock(stats.keptMs)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatCutClock(stats.savedMs)} shorter
              {` · ${stats.cuts} cuts`}
            </span>
          </p>
        ) : null}
      </header>

      {load.kind === 'ready' && data ? (
        // Two panes from the lg breakpoint (the player beside the transcript);
        // below it the player sits beside its controls, above the transcript.
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex shrink-0 gap-4 border-b border-border p-gutter lg:min-h-0 lg:flex-col lg:gap-3 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <div className="w-[min(22rem,50%)] shrink-0 lg:w-full">
              {playable ? (
                <Suspense fallback={<PlayerPlaceholder label="Loading the player" />}>
                  <SessionPlayer
                    handleRef={playerRef}
                    sessionId={target.sessionId}
                    skipRanges={skipRanges}
                    onTimeUpdate={setPositionMs}
                  />
                </Suspense>
              ) : (
                <PlayerPlaceholder label="Playback opens as soon as the recording is finished." />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <Tabs
                value={preview ? 'cut' : 'original'}
                onValueChange={(value) => setPreview(value === 'cut')}
              >
                <TabsList aria-label="What plays">
                  <TabsTrigger value="cut">Preview the cut</TabsTrigger>
                  <TabsTrigger value="original">Original</TabsTrigger>
                </TabsList>
              </Tabs>
              <Moments pins={pins} onSeek={seek} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-gutter py-2">
              <KindChips chips={chips} onToggle={toggleGroup} />
              <p className="text-[11px] text-subtle">
                ↑ ↓ move between cuts · Enter keeps or cuts one · Space plays · click a word to jump
                there
              </p>
            </div>
            {data.transcript ? null : (
              <Alert className="mx-gutter mt-2 w-auto" variant="warning">
                <AlertTitle className="font-normal">
                  The transcript couldn&apos;t be read, so only the cuts show.
                </AlertTitle>
                <AlertAction>
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() => setReloads((value) => value + 1)}
                  >
                    Try again
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {items.length === 0 ? (
              <Empty className="flex-1 gap-1 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-sm">No speech found</EmptyTitle>
                  <EmptyDescription className="text-xs">
                    Only the start and the end can be trimmed.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <CleanCutTranscript
                activeWord={activeWord}
                className="flex-1"
                items={items}
                removals={removalsById}
                scrollRequest={scrollRequest}
                selectedId={selectedId}
                onSeek={seek}
                onToggleRemoval={toggle}
              />
            )}
          </div>
        </div>
      ) : (
        <ReviewPlaceholder
          load={load}
          statusLabel={status.label}
          onRetry={() => setReloads((value) => value + 1)}
        />
      )}

      <footer
        className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-gutter py-1.5"
        data-slot="clean-cut-review-footer"
      >
        <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          {status.busy ? <SpinnerIcon aria-hidden className="size-3.5 animate-spin" /> : null}
          <span
            className="truncate"
            data-slot="clean-cut-review-status"
            title={notice ?? undefined}
          >
            {notice ??
              (changes > 0
                ? `${changes} unsaved ${changes === 1 ? 'change' : 'changes'}`
                : status.kind === 'ready'
                  ? 'Saved. The cut copy is in your Library.'
                  : status.label)}
          </span>
        </p>
        {status.kind === 'ready' && changes === 0 && data?.job.outputSessionId ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() =>
              data.job.outputSessionId && onOpenLibrarySession(data.job.outputSessionId)
            }
          >
            Open in Library
          </Button>
        ) : null}
        {changes > 0 ? (
          <Button
            disabled={saving}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY_CLEAN_CUT_DRAFT)
              setNotice(null)
            }}
          >
            Discard
          </Button>
        ) : null}
        <Button
          disabled={changes === 0 || saving || !editable}
          size="sm"
          title={!editable && changes > 0 ? 'You can save when this cut finishes.' : undefined}
          type="button"
          onClick={() => void save()}
        >
          {saving ? (
            <SpinnerIcon className="animate-spin" data-icon="inline-start" />
          ) : (
            <SaveIcon data-icon="inline-start" />
          )}
          Save changes
          <Kbd className="ml-0.5">{modKey}S</Kbd>
        </Button>
      </footer>

      <Dialog open={leaving} onOpenChange={setLeaving}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              Your {changes === 1 ? 'change' : `${changes} changes`} to this cut will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setLeaving(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setLeaving(false)
                onClose()
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PlayerPlaceholder({ label }: { label: string }): ReactElement {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-row border border-border bg-video-ground">
      <span className="text-xs text-video-ground-muted">{label}</span>
    </div>
  )
}

function ReviewPlaceholder({
  load,
  statusLabel,
  onRetry
}: {
  load: ReviewLoad
  statusLabel: string
  onRetry: () => void
}): ReactElement {
  if (load.kind === 'error') {
    return (
      <div className="flex-1 p-gutter">
        <Alert role="status" variant="warning">
          <AlertTitle className="font-normal">{load.message}</AlertTitle>
          <AlertAction>
            <Button size="xs" type="button" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      </div>
    )
  }
  const waiting = load.kind === 'waiting'
  return (
    <Empty className="flex-1 gap-1 p-6" data-slot="clean-cut-review-waiting">
      <EmptyHeader>
        <EmptyTitle className="text-sm">
          {load.kind === 'loading'
            ? 'Loading the cut'
            : waiting && load.job
              ? statusLabel
              : 'No cut yet'}
        </EmptyTitle>
        <EmptyDescription className="text-xs">
          {load.kind === 'loading'
            ? 'Reading the cut list and the transcript.'
            : waiting && load.job
              ? 'The review opens when the cut list is ready.'
              : 'Make one from the Orcle tab.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** One chip per kind of cut: its count, and a click keeps or cuts them all. */
function KindChips({
  chips,
  onToggle
}: {
  chips: readonly CleanCutKindChip[]
  onToggle: (groupId: CleanCutKindGroupId) => void
}): ReactElement {
  const pressed = chips.filter((chip) => chip.state === 'on').map((chip) => chip.group.id)
  return (
    <ToggleGroup
      aria-label="Kinds of cuts"
      className="flex-wrap"
      data-slot="clean-cut-chips"
      size="sm"
      spacing={1}
      type="multiple"
      value={pressed}
      onValueChange={(values) => {
        const changed = chips.find(
          (chip) => values.includes(chip.group.id) !== pressed.includes(chip.group.id)
        )
        if (changed) onToggle(changed.group.id)
      }}
    >
      {chips.map((chip) => (
        <ToggleGroupItem
          key={chip.group.id}
          className="h-6 gap-1.5 px-1.5 text-xs"
          data-chip={chip.group.id}
          data-state-kind={chip.state}
          disabled={chip.state === 'empty'}
          title={
            chip.state === 'empty'
              ? `No ${chip.group.label.toLowerCase()} found`
              : chip.state === 'on'
                ? `Keep all ${chip.total}`
                : `Cut all ${chip.total}`
          }
          value={chip.group.id}
        >
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full glass-dot', TONE_DOT[chip.group.tone])}
          />
          {chip.group.label}
          <span className="text-muted-foreground tabular-nums">
            {chip.state === 'mixed' ? `${chip.cut}/${chip.total}` : chip.total}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const MOMENT_ICONS: Record<ClipMomentSource, typeof PinIcon> = {
  voice: MicrophoneIcon,
  manual: ClipIcon,
  chat: ChatIcon
}

/** The stream report's moments: a click puts the playhead there. */
function Moments({
  pins,
  onSeek
}: {
  pins: readonly CleanCutPin[]
  onSeek: (ms: number) => void
}): ReactElement | null {
  if (pins.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="clean-cut-moments">
      <span className="px-1 text-[11px] font-semibold text-subtle">
        Moments <span className="font-normal tabular-nums">· {pins.length}</span>
      </span>
      <div className="flex flex-wrap gap-1">
        {pins.map((pin) => {
          const Glyph = MOMENT_ICONS[pin.kind] ?? PinIcon
          return (
            <Button
              key={pin.key}
              className="max-w-full"
              size="xs"
              title={pin.excerpt || pin.label}
              type="button"
              variant="ghost"
              onClick={() => onSeek(pin.startMs)}
            >
              <Glyph data-icon="inline-start" />
              <span className="tabular-nums">{formatCutClock(pin.startMs)}</span>
              <span className="truncate">{pin.label}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
