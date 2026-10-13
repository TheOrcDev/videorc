import {
  ArrowLeftIcon,
  ChatIcon,
  ClipIcon,
  MicrophoneIcon,
  PinIcon,
  ResetIcon,
  SaveIcon
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

import {
  CleanCutTranscript,
  TONE_DOT,
  type CleanCutScrollRequest
} from '@/components/clean-cut/clean-cut-transcript'
import type { SessionPlayerHandle } from '@/components/media/session-player'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PaneStrip } from '@/components/pane'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@/components/ui/empty'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type { CleanCutClient } from '@/hooks/use-clean-cut'
import { useBuddyReport } from '@/hooks/use-buddy-report'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import type { ClipMomentSource, CleanCutEdl, CleanCutJob, CleanCutMode } from '@/lib/backend'
import {
  readCleanCutDraft,
  writeCleanCutDraft,
  type CleanCutReviewTarget
} from '@/lib/clean-cut-drafts'
import {
  EMPTY_CLEAN_CUT_DRAFT,
  activeWordIndex,
  buildCleanCutParagraphs,
  cleanCutKindChips,
  cleanCutPins,
  cleanCutStats,
  cleanCutTranscriptItems,
  condensedBlocks,
  cutSkipRanges,
  draftChangeCount,
  effectiveRemovals,
  navigableRemovals,
  normalizeTranscriptWords,
  prerollMs,
  rebaseDraft,
  addDraftManual,
  draftManualRemovals,
  EMPTY_CLEAN_CUT_HISTORY,
  formatCutLength,
  recordCleanCutEdit,
  redoCleanCutEdit,
  selectionCutRange,
  undoCleanCutEdit,
  wordRows,
  removalAnnouncement,
  removalRowIndex,
  stepRemoval,
  toggleCondensedBlock,
  toggleKindGroup,
  toggleRemoval,
  updateEdlPayload,
  type CleanCutDraft,
  type CleanCutHistory,
  type CleanCutKindChip,
  type CleanCutKindGroupId,
  type CleanCutPin,
  type CondensedBlock
} from '@/lib/clean-cut-review'
import {
  cleanCutErrorReason,
  cleanCutJobEditable,
  cleanCutModeLabel,
  cleanCutSavedMs,
  cleanCutStatusView,
  formatCutClock,
  latestCleanCutJob,
  type CleanCutCondensedKeep,
  type CleanCutJobDetailWithKeeps,
  type CleanCutTranscript as CleanCutTranscriptData
} from '@/lib/clean-cut-view'
import { plural } from '@/lib/format'
import { isCommandKey } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { sessionIsLive, sessionOwnsTransport } from '../../../../shared/capture-state'

const SessionPlayer = lazy(async () => ({
  default: (await import('@/components/media/session-player')).SessionPlayer
}))

const UNTITLED = 'Untitled recording'

const CLEAN_CUT_MODE_OPTIONS: SegmentedControlOption<CleanCutMode>[] = [
  { value: 'clean', label: 'Clean' },
  { value: 'condensed', label: 'Condensed' }
]

const WHAT_PLAYS_OPTIONS: SegmentedControlOption<'cut' | 'original'>[] = [
  { value: 'cut', label: 'Preview the cut' },
  { value: 'original', label: 'Original' }
]

interface ReviewData {
  job: CleanCutJob
  edl: CleanCutEdl
  keeps: CleanCutCondensedKeep[] | null
  /** Null when the transcript could not be read: the cuts still show as markers. */
  transcript: CleanCutTranscriptData | null
}

type ReviewLoad =
  | { kind: 'loading' }
  /** The cut list couldn't be read: why, in plain words. */
  | { kind: 'error'; message: string }
  /** No cut list yet (or no job of this kind): the job's status, if any. */
  | { kind: 'waiting'; job: CleanCutJob | null }
  | { kind: 'ready'; data: ReviewData }

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
const NO_WORDS: readonly number[] = []

function sameWords(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
const EMPTY_SEGMENTS: CleanCutTranscriptData['segments'] = []

/**
 * Clean cut review (plan 119 S14, S19). The source recording plays on top
 * with the cut list as a virtual preview (removed spans are skipped), the
 * transcript below shows every cut, and edits stay a draft until "Save
 * changes" sends one `cleanCut.updateEdl` and renders the cut again.
 * Keyboard-first: Space plays, ← → seek, ↑ ↓ walk the cuts, Enter keeps or
 * cuts one, ⌘S saves.
 *
 * Plan 174 S3.13: the draft is kept per job (`lib/clean-cut-drafts.ts`), so
 * leaving the tab, the page or the window never loses it; only the back
 * button drops it, after the leave guard asks. The back button returns where
 * the review was opened: the Library row, or the Clean cut list.
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
  const [mode, setMode] = useState<CleanCutMode>(target.mode)
  const [jobId, setJobId] = useState<string | null>(target.jobId)
  const [load, setLoad] = useState<ReviewLoad>({ kind: 'loading' })
  const [reloads, setReloads] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const [draft, setDraft] = useState<CleanCutDraft>(EMPTY_CLEAN_CUT_DRAFT)
  const [draftJob, setDraftJob] = useState<string | null>(null)
  // What a screen reader hears after a key or a click (E-15).
  const [announcement, setAnnouncement] = useState('')
  // E-14: undo and redo over the draft, the words selected in the
  // transcript, and the transcript following the playhead.
  const [history, setHistory] = useState<CleanCutHistory>(EMPTY_CLEAN_CUT_HISTORY)
  const [selectedWords, setSelectedWords] = useState<readonly number[]>(NO_WORDS)
  const [follow, setFollow] = useState(true)
  const followedRowRef = useRef<number | null>(null)
  const [preview, setPreview] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [positionMs, setPositionMs] = useState(0)
  const [scrollRequest, setScrollRequest] = useState<CleanCutScrollRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const playerRef = useRef<SessionPlayerHandle>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The review opens ready for the keys.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

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
            keeps: detail.condensedKeeps ?? null,
            transcript
          }
        })
      } catch (error) {
        if (current) setLoad({ kind: 'error', message: cleanCutErrorReason(error) })
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
  // A job opens on its kept draft (E-5), carried onto the saved list as it
  // stands now: a change the list already has leaves the draft.
  if (data && data.job.id !== draftJob) {
    setDraftJob(data.job.id)
    setDraft(rebaseDraft(readCleanCutDraft(data.job.id), data.edl.removals))
    setHistory(EMPTY_CLEAN_CUT_HISTORY)
    setSelectedId(null)
  }
  // Every change is kept at once, so no way out of the review loses it.
  useEffect(() => {
    if (draftJob) writeCleanCutDraft(draftJob, draft)
  }, [draft, draftJob])

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
  const report = useBuddyReport(target.sessionId)
  const pins = useMemo(() => cleanCutPins(report.payload?.moments), [report.payload])
  const condensedMode = data?.job.mode === 'condensed'
  const durationMs = data?.edl.durationMs ?? 0
  const keeps = data?.keeps ?? null
  // Part boundaries come from the saved list, so the layout never re-runs on a toggle.
  const savedBlocks = useMemo(
    () =>
      condensedMode && saved
        ? condensedBlocks({ durationMs, keeps, effective: saved, words })
        : null,
    [condensedMode, durationMs, keeps, saved, words]
  )
  // A cut made from a selection is struck like the saved ones (Clean only:
  // Condensed lays out from the saved parts, so a toggle never re-runs it).
  const addManual = draft.addManual
  const layoutRemovals = useMemo(
    () =>
      saved && !condensedMode && addManual.length > 0
        ? [...saved, ...draftManualRemovals({ ...EMPTY_CLEAN_CUT_DRAFT, addManual })]
        : saved,
    [addManual, condensedMode, saved]
  )
  const paragraphs = useMemo(
    () =>
      layoutRemovals
        ? buildCleanCutParagraphs({
            words,
            segments,
            removals: layoutRemovals,
            pins,
            breaksMs: savedBlocks?.map((block) => block.startMs) ?? [],
            skipKinds: condensedMode ? ['condensed'] : []
          })
        : [],
    [condensedMode, layoutRemovals, pins, savedBlocks, segments, words]
  )
  const blocks = useMemo(
    () => (condensedMode ? condensedBlocks({ durationMs, keeps, effective, words }) : null),
    [condensedMode, durationMs, effective, keeps, words]
  )
  const items = useMemo(() => cleanCutTranscriptItems(paragraphs, blocks), [blocks, paragraphs])
  const rows = useMemo(() => removalRowIndex(items), [items])
  const rowsByWord = useMemo(() => wordRows(items), [items])
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
  // Plan 181: the default ring is not a capture that Clean cut must wait for.
  const captureActive = sessionOwnsTransport(recording)
  const job = data?.job ?? (load.kind === 'waiting' ? load.job : null)
  const status = cleanCutStatusView(job, { captureActive, streaming: sessionIsLive(recording) })
  const editable = data ? cleanCutJobEditable(data.job) : false
  // E-24: a failure says why, not just "Failed".
  const failed = status.kind === 'failed'
  const failureLine = failed
    ? `${cutTitle(job?.mode ?? mode)} failed. ${status.detail ?? ''}`.trim()
    : ''
  const otherModeJob = latestCleanCutJob(
    client.jobs,
    target.sessionId,
    mode === 'clean' ? 'condensed' : 'clean'
  )
  const platform = runtimeInfo?.platform

  const select = useCallback(
    (id: string | null, seek: boolean): void => {
      setSelectedId(id)
      if (!id) return
      const row = rows.get(id)
      if (row !== undefined) setScrollRequest({ row, nonce: Date.now() })
      const removal = removalsById.get(id)
      if (seek && removal) playerRef.current?.seekTo(prerollMs(removal))
      if (removal) {
        setAnnouncement(
          removalAnnouncement(
            removal,
            order.findIndex((entry) => entry.id === id) + 1,
            order.length
          )
        )
      }
    },
    [order, removalsById, rows]
  )

  /** Every change to the draft: undoable, and it clears a stale notice. */
  const edit = (next: CleanCutDraft): void => {
    if (next === draft) return
    setHistory((current) => recordCleanCutEdit(current, draft))
    setDraft(next)
    setNotice(null)
  }

  const undo = (): void => {
    const step = undoCleanCutEdit(history, draft)
    if (!step) return
    setHistory(step.history)
    setDraft(step.draft)
    setNotice(null)
    setAnnouncement('Undid the last change.')
  }

  const redo = (): void => {
    const step = redoCleanCutEdit(history, draft)
    if (!step) return
    setHistory(step.history)
    setDraft(step.draft)
    setNotice(null)
    setAnnouncement('Redid the change.')
  }

  // "Cut selection": the words selected in the transcript become one cut.
  const selectionRange = condensedMode ? null : selectionCutRange(words, selectedWords)
  const cutSelection = (): void => {
    if (!selectionRange || !saved) return
    edit(addDraftManual(draft, selectionRange))
    window.getSelection?.()?.removeAllRanges()
    setSelectedWords(NO_WORDS)
    setAnnouncement(
      `Cut ${formatCutLength(selectionRange.endMs - selectionRange.startMs)}. Undo brings it back.`
    )
  }
  const onSelectWords = useCallback((indexes: readonly number[]): void => {
    setSelectedWords((current) => (sameWords(current, indexes) ? current : indexes))
  }, [])

  // Following: the row under the playhead scrolls into view as it plays.
  const onTimeUpdate = (ms: number): void => {
    setPositionMs(ms)
    if (!follow) return
    const row = rowsByWord.get(activeWordIndex(words, ms))
    if (row === undefined || row === followedRowRef.current) return
    followedRowRef.current = row
    setScrollRequest({ row, nonce: Date.now() })
  }

  const toggle = useCallback(
    (id: string): void => {
      if (!saved) return
      const next = toggleRemoval(draft, saved, id)
      if (next !== draft) {
        setHistory((current) => recordCleanCutEdit(current, draft))
        setDraft(next)
      }
      setSelectedId(id)
      setNotice(null)
      const removal = effectiveRemovals(saved, next).find((entry) => entry.id === id)
      if (removal) {
        setAnnouncement(
          removalAnnouncement(
            removal,
            order.findIndex((entry) => entry.id === id) + 1,
            order.length
          )
        )
      }
    },
    [draft, order, saved]
  )

  const toggleGroup = (groupId: CleanCutKindGroupId): void => {
    if (!saved) return
    edit(toggleKindGroup(draft, saved, groupId))
  }

  const toggleBlock = (block: CondensedBlock): void => {
    if (!saved) return
    edit(toggleCondensedBlock(draft, saved, block))
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
      setHistory(EMPTY_CLEAN_CUT_HISTORY)
      try {
        const rendered = await client.render(jobIdToSave)
        setLoad((current) =>
          current.kind === 'ready' && current.data.job.id === rendered.id
            ? { kind: 'ready', data: { ...current.data, job: rendered } }
            : current
        )
      } catch (error) {
        setNotice(`Your changes are saved, but the cut didn't start. ${cleanCutErrorReason(error)}`)
      }
    } catch (error) {
      if (errorCode(error) === 'edl-revision-conflict') {
        await reloadAfterConflict(jobIdToSave)
      } else {
        setNotice(`Couldn't save your changes. ${cleanCutErrorReason(error)}`)
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
      setHistory(EMPTY_CLEAN_CUT_HISTORY)
      setNotice(
        'The cut list changed while you edited. Your changes are on the newest one; save again.'
      )
    } catch (error) {
      setNotice(`Couldn't load the newest cut list. ${cleanCutErrorReason(error)}`)
    }
  }

  // E-24: a failed render is retried from here; a cut with no list yet goes
  // back to Clean cut, where Make asks for what it needs.
  const [retrying, setRetrying] = useState(false)
  const retryRender = async (failed: CleanCutJob): Promise<void> => {
    setRetrying(true)
    setNotice(null)
    try {
      const rendered = await client.render(failed.id)
      setLoad((current) =>
        current.kind === 'ready' && current.data.job.id === rendered.id
          ? { kind: 'ready', data: { ...current.data, job: rendered } }
          : current
      )
    } catch (error) {
      setNotice(`Couldn't cut again. ${cleanCutErrorReason(error)}`)
    } finally {
      setRetrying(false)
    }
  }

  // Back where the review was opened (E-12): the Library row, or the list.
  const fromLibrary = target.origin === 'library'
  const backLabel = fromLibrary ? 'Back to Library' : 'Back to Clean cut'
  const leave = (): void => {
    onClose()
    if (fromLibrary) onOpenLibrarySession(target.sessionId)
  }
  const close = (): void => {
    if (changes > 0) setLeaving(true)
    else leave()
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
    // ⌘Z / ⇧⌘Z (Ctrl elsewhere) undo and redo the draft; never behind the
    // leave guard.
    if (key.toLowerCase() === 'z' && !event.altKey && isCommandKey(event, platform)) {
      if (leaving) return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if ((key === 'Backspace' || key === 'Delete') && selectionRange && !leaving) {
      event.preventDefault()
      cutSelection()
      return
    }
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
    // Focusable without a tab stop: a click on plain transcript text lands
    // here, so the keys keep working wherever the pointer went.
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col outline-none"
      data-slot="clean-cut-review"
      data-mode={mode}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-gutter py-1.5">
        <Button data-testid="clean-cut-review-back" type="button" variant="ghost" onClick={close}>
          <ArrowLeftIcon data-icon="inline-start" />
          {backLabel}
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
              {formatCutClock(cleanCutSavedMs(stats.durationMs, stats.keptMs))} shorter
              {condensedMode && blocks
                ? ` · ${blocks.filter((block) => !block.removed).length} parts`
                : ` · ${stats.cuts} cuts`}
            </span>
          </p>
        ) : null}
        <SegmentedControl
          aria-label="Kind of cut"
          options={CLEAN_CUT_MODE_OPTIONS.map((option) => ({
            ...option,
            disabled: mode !== option.value && (changes > 0 || !otherModeJob)
          }))}
          value={mode}
          onValueChange={(next) => {
            setMode(next)
            setJobId(null)
          }}
        />
      </header>

      {load.kind === 'ready' && data ? (
        // Two panes from the lg breakpoint (the player beside the transcript);
        // below it the player sits beside its controls, above the transcript.
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex shrink-0 gap-4 border-b border-border p-gutter lg:min-h-0 lg:flex-col lg:gap-3 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <div className="w-[min(22rem,50%)] shrink-0 lg:w-full">
              {playable ? (
                <Suspense fallback={<PlayerPlaceholder label="Loading the player…" />}>
                  <SessionPlayer
                    handleRef={playerRef}
                    sessionId={target.sessionId}
                    skipRanges={skipRanges}
                    onTimeUpdate={onTimeUpdate}
                  />
                </Suspense>
              ) : (
                <PlayerPlaceholder label="Playback opens as soon as the recording is finished." />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <SegmentedControl
                aria-label="What plays"
                className="self-start"
                options={WHAT_PLAYS_OPTIONS}
                value={preview ? 'cut' : 'original'}
                onValueChange={(value) => setPreview(value === 'cut')}
              />
              <Moments pins={pins} onSeek={seek} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <PaneStrip className="flex flex-col gap-1.5">
              <KindChips chips={chips} onToggle={toggleGroup} />
              <div
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
                data-slot="clean-cut-edit-bar"
              >
                {condensedMode ? null : (
                  <DisabledReason
                    reason={selectionRange ? null : 'Select words in the transcript first.'}
                  >
                    {/* The press keeps the text selection it cuts. */}
                    <Button
                      data-testid="clean-cut-cut-selection"
                      disabled={!selectionRange}
                      size="xs"
                      type="button"
                      variant="outline"
                      onClick={cutSelection}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <ClipIcon data-icon="inline-start" />
                      Cut selection
                      <ShortcutKeys
                        accelerator="Backspace"
                        className="ml-0.5"
                        platform={platform}
                      />
                    </Button>
                  </DisabledReason>
                )}
                <DisabledReason reason={history.past.length === 0 ? 'Nothing to undo yet.' : null}>
                  <Button
                    disabled={history.past.length === 0}
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={undo}
                  >
                    Undo
                    <ShortcutKeys
                      accelerator="CmdOrCtrl+Z"
                      className="ml-0.5"
                      platform={platform}
                    />
                  </Button>
                </DisabledReason>
                <DisabledReason reason={history.future.length === 0 ? 'Nothing to redo.' : null}>
                  <Button
                    disabled={history.future.length === 0}
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={redo}
                  >
                    Redo
                    <ShortcutKeys
                      accelerator="CmdOrCtrl+Shift+Z"
                      className="ml-0.5"
                      platform={platform}
                    />
                  </Button>
                </DisabledReason>
                <div className="ml-auto flex items-center gap-2">
                  <Switch
                    checked={follow}
                    id="clean-cut-follow"
                    size="sm"
                    onCheckedChange={(on) => {
                      setFollow(on)
                      followedRowRef.current = null
                    }}
                  />
                  <label className="text-xs text-muted-foreground" htmlFor="clean-cut-follow">
                    Follow playback
                  </label>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                ↑ ↓ move between cuts · Enter keeps or cuts one · Space plays · click a word to jump
                there · select words to cut them
              </p>
            </PaneStrip>
            {data.transcript ? null : (
              <Alert className="mx-gutter mt-2 w-auto" variant="warning">
                <AlertTitle>
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
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No speech found</EmptyTitle>
                  <EmptyDescription>Only the start and the end can be trimmed.</EmptyDescription>
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
                onSelectWords={onSelectWords}
                onToggleBlock={toggleBlock}
                onToggleRemoval={toggle}
              />
            )}
          </div>
        </div>
      ) : (
        <ReviewPlaceholder
          load={load}
          statusLabel={status.label}
          onBackToList={onClose}
          onRetry={() => setReloads((value) => value + 1)}
        />
      )}

      <footer
        className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-gutter py-1.5"
        data-slot="clean-cut-review-footer"
      >
        <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          {status.busy ? <Spinner aria-hidden className="size-3.5" /> : null}
          <span className="min-w-0" data-slot="clean-cut-review-status">
            {notice ??
              (changes > 0
                ? plural(changes, 'unsaved change')
                : status.kind === 'ready'
                  ? 'Saved. The cut copy is in your Library.'
                  : failed
                    ? failureLine
                    : status.label)}
          </span>
        </p>
        {/* The footer's news, read out once it changes (E-15). */}
        <p
          aria-live="polite"
          className="sr-only"
          data-slot="clean-cut-review-announcer"
          role="status"
        >
          {announcement}
        </p>
        <p aria-live="polite" className="sr-only" role="status">
          {notice ?? (failed ? failureLine : status.kind === 'ready' ? 'Saved.' : '')}
        </p>
        {failed && changes === 0 && status.retry === 'render' && job ? (
          <Button
            data-testid="clean-cut-review-retry"
            disabled={retrying || !connected}
            type="button"
            variant="outline"
            onClick={() => void retryRender(job)}
          >
            {retrying ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ResetIcon data-icon="inline-start" />
            )}
            Retry
          </Button>
        ) : null}
        {status.kind === 'ready' && changes === 0 && data?.job.outputSessionId ? (
          <Button
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
            type="button"
            variant="ghost"
            onClick={() => edit(EMPTY_CLEAN_CUT_DRAFT)}
          >
            Discard
          </Button>
        ) : null}
        <DisabledReason
          reason={!editable && changes > 0 ? 'You can save when this cut finishes.' : null}
        >
          <Button
            disabled={changes === 0 || saving || !editable}
            type="button"
            onClick={() => void save()}
          >
            {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            Save changes
            <ShortcutKeys accelerator="CmdOrCtrl+S" className="ml-0.5" platform={platform} />
          </Button>
        </DisabledReason>
      </footer>

      <ConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        description={`Your ${changes === 1 ? 'change' : `${changes} changes`} to this cut will be lost.`}
        open={leaving}
        testId="clean-cut-leave"
        title="Leave without saving?"
        onCancel={() => setLeaving(false)}
        onConfirm={() => {
          setLeaving(false)
          if (draftJob) writeCleanCutDraft(draftJob, EMPTY_CLEAN_CUT_DRAFT)
          leave()
        }}
      />
    </div>
  )
}

function cutTitle(mode: CleanCutMode): string {
  return mode === 'condensed' ? 'The condensed cut' : 'The clean cut'
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
  onRetry,
  onBackToList
}: {
  load: ReviewLoad
  statusLabel: string
  onRetry: () => void
  onBackToList: () => void
}): ReactElement {
  if (load.kind === 'error') {
    return (
      <div className="flex-1 p-gutter">
        <Alert variant="warning">
          <AlertTitle>Couldn&apos;t open the cut</AlertTitle>
          <AlertDescription>{load.message}</AlertDescription>
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
    <Empty data-testid="clean-cut-review-waiting">
      <EmptyHeader>
        <EmptyTitle>
          {load.kind === 'loading'
            ? 'Loading the cut…'
            : waiting && load.job
              ? statusLabel
              : 'No cut yet'}
        </EmptyTitle>
        <EmptyDescription>
          {load.kind === 'loading'
            ? 'Reading the cut list and the transcript.'
            : waiting && load.job
              ? 'The review opens when the cut list is ready.'
              : 'Make one from the list of recordings in Clean cut.'}
        </EmptyDescription>
      </EmptyHeader>
      {load.kind === 'waiting' && !load.job ? (
        <EmptyContent>
          <Button type="button" variant="outline" onClick={onBackToList}>
            Open Clean cut
          </Button>
        </EmptyContent>
      ) : null}
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
      data-testid="clean-cut-chips"
      size="xs"
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
      {chips.map((chip) => {
        const item = (
          <ToggleGroupItem
            className="gap-1.5"
            data-chip={chip.group.id}
            data-state-kind={chip.state}
            disabled={chip.state === 'empty'}
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
        )
        if (chip.state === 'empty') {
          return (
            <DisabledReason
              key={chip.group.id}
              reason={`No ${chip.group.label.toLowerCase()} found.`}
            >
              {item}
            </DisabledReason>
          )
        }
        // What a click does, on hover and on focus (plan 174 S1.10). The chip
        // sits in a span trigger: the toggle's own data-state must stay on/off.
        return (
          <Tooltip key={chip.group.id}>
            <TooltipTrigger asChild>
              <span className="inline-flex">{item}</span>
            </TooltipTrigger>
            <TooltipContent>
              {chip.state === 'on' ? `Keep all ${chip.total}` : `Cut all ${chip.total}`}
            </TooltipContent>
          </Tooltip>
        )
      })}
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
            <Tooltip key={pin.key}>
              <TooltipTrigger asChild>
                <Button
                  className="max-w-full"
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() => onSeek(pin.startMs)}
                >
                  <Glyph data-icon="inline-start" />
                  <span className="tabular-nums">{formatCutClock(pin.startMs)}</span>
                  <span className="truncate">{pin.label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{pin.excerpt || pin.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
