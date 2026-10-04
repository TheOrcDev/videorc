import type {
  AiCapabilities,
  CleanCutEdlSummary,
  CleanCutJob,
  CleanCutJobDetail,
  CleanCutMode,
  SessionSummary
} from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import { VIDEORC_PREMIUM_URL } from './videorc-web-links'
import { formatClipMarkClock } from '../../../shared/clip-marks'

// Clean cut in the Orcle tab (plan 119 S14, S15, S19): "Stop recording, and
// the edited version is already there." Everything here is a pure derivation
// of the job snapshots, the Library rows and the capability block, so the
// card, the review, the ready toast and their tests cannot disagree.

// --- Shapes from the S13 interface ----------------------------------------------
// TODO(S13 merge): the backend half (S13) adds these to the shared protocol in
// parallel. Once feat/119-orcle-tab carries it, switch to the shared types:
// - CleanCutTranscript*        → shared/backend.ts, `cleanCut.transcript` in the
//   RPC contract; use-clean-cut.ts moves from request<T>() to requestTyped().
// - `cleanCut.render`          → the RPC contract; same move in use-clean-cut.ts.
// - CleanCutCondensedKeep      → `CleanCutJobDetail.condensedKeeps`.
// - CleanCutSessionFields      → `SessionListItem.cleanCutOfSessionId` / `cleanCutMode`.
// - cleanCutCapabilities()     → reads `AiCapabilities.cleanCut` and
//   `features.cleanCutEnabled` loosely; keep the reader (older servers omit
//   the block) but type it once the shared type has the fields.

/** One word of `transcript.words.json`; times are recording time. */
export interface CleanCutTranscriptWord {
  text: string
  startMs: number
  endMs: number
  filler?: true
}

/** A sentence from the cut-list builder (`edl.rs`). */
export interface CleanCutTranscriptSegment {
  id: string
  startMs: number
  endMs: number
}

/** `cleanCut.transcript {jobId}`. */
export interface CleanCutTranscript {
  jobId: string
  language: string | null
  words: CleanCutTranscriptWord[]
  segments: CleanCutTranscriptSegment[]
}

/** A kept part of a condensed cut, with its title (`cleanCut.get`). */
export interface CleanCutCondensedKeep {
  startMs: number
  endMs: number
  title: string
}

export type CleanCutJobDetailWithKeeps = CleanCutJobDetail & {
  condensedKeeps?: CleanCutCondensedKeep[]
}

export interface CleanCutGetResultWithKeeps {
  sessionId: string
  jobs: CleanCutJobDetailWithKeeps[]
}

/** The Library row fields a clean-cut derivative carries. */
export interface CleanCutSessionFields {
  cleanCutOfSessionId?: string
  cleanCutMode?: CleanCutMode
}

export type CleanCutSession = SessionSummary & CleanCutSessionFields

/** The `cleanCut` block of `ai.capabilities.get` (contract part B). */
export interface CleanCutCapabilities {
  supported: boolean
  available: boolean
  /** Open string: `disabled`, `blocked`, `premium-required`,
   * `provider-unconfigured`, `quota-exhausted`, or newer codes. */
  reasonCode: string | null
  monthlySecondsLimit: number | null
  remainingSeconds: number | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The Clean cut block, read loosely: a server that omits it does not offer
 * Clean cut, and a partial block never throws. */
export function cleanCutCapabilities(
  capabilities: AiCapabilities | null | undefined
): CleanCutCapabilities | null {
  if (!capabilities) return null
  const block = (capabilities as unknown as Record<string, unknown>).cleanCut
  if (!block || typeof block !== 'object') return null
  const fields = block as Record<string, unknown>
  return {
    supported: fields.supported === true,
    available: fields.available === true,
    reasonCode: typeof fields.reasonCode === 'string' ? fields.reasonCode : null,
    monthlySecondsLimit: finiteOrNull(fields.monthlySecondsLimit),
    remainingSeconds: finiteOrNull(fields.remainingSeconds)
  }
}

// --- Copy -----------------------------------------------------------------------

export const CLEAN_CUT_TITLE = 'Clean cut'

/** The website's words (plan 119 S5), so the app and the site sell one thing. */
export const CLEAN_CUT_DESCRIPTION =
  'Stop recording, and the edited version is already there. Silences, ums, and retakes removed, within a monthly allowance.'

export const CLEAN_CUT_AUTO_LABEL = 'Make a clean cut of every recording'

export const CLEAN_CUT_SIGNED_OUT_REASON = 'Sign in to use Clean cut, part of Videorc Premium.'

export const CLEAN_CUT_CONSENT_OFF_REASON =
  "Cloud AI is off, so Clean cut can't run. Allow it under Customize."

export const CLEAN_CUT_NO_RECORDINGS =
  'Record something, and its clean cut shows up here when you stop.'

export const CONDENSED_TOO_SHORT = 'Condensed is for recordings of 25 minutes or more.'

// --- Rules ----------------------------------------------------------------------

/** Decision 11: shorter recordings are not cut. */
export const CLEAN_CUT_MIN_SOURCE_MS = 10_000
/** S19: Condensed is offered from 25 minutes. */
export const CONDENSED_MIN_SOURCE_MS = 25 * 60_000
/** S19: the target lengths, in minutes. */
export const CONDENSED_TARGET_MINUTES = [10, 15, 20, 30] as const
export const CONDENSED_DEFAULT_TARGET_MINUTES = 15
/** Recordings the picker offers, newest first. */
export const CLEAN_CUT_PICKER_LIMIT = 20

const CLEAN_CUT_SOURCE_MODES: ReadonlySet<string> = new Set(['record', 'record+stream'])

export type CleanCutEligibility = { eligible: true } | { eligible: false; reason: string }

type EligibilityRow = Pick<
  CleanCutSession,
  | 'status'
  | 'mode'
  | 'mp4Path'
  | 'durationMs'
  | 'derivedFromSessionId'
  | 'processingKind'
  | 'finalizationState'
  | 'cleanCutOfSessionId'
>

/**
 * Decision 11, mirrored from the backend's `resolve_source`: a finished
 * Videorc recording (mode `record` or `record+stream`) with its MP4, at least
 * ten seconds long, neither imported nor derived. The backend checks again;
 * this only keeps the UI from offering what it would refuse.
 */
export function cleanCutEligibility(session: EligibilityRow): CleanCutEligibility {
  const refuse = (reason: string): CleanCutEligibility => ({ eligible: false, reason })
  if (session.status !== 'completed' || session.finalizationState === 'finalizing') {
    return refuse('Clean cut is available once the recording has finished.')
  }
  if (session.mode === 'imported') return refuse('Imported videos are not supported yet.')
  if (session.derivedFromSessionId || session.processingKind || session.cleanCutOfSessionId) {
    return refuse("A cleaned or cut copy can't be cut again.")
  }
  if (!CLEAN_CUT_SOURCE_MODES.has(session.mode)) {
    return refuse('Only recordings can be cut. This session was streamed without recording.')
  }
  if (typeof session.durationMs !== 'number' || session.durationMs < CLEAN_CUT_MIN_SOURCE_MS) {
    return refuse("Recordings shorter than 10 seconds can't be cut.")
  }
  if (!session.mp4Path || !session.mp4Path.toLowerCase().endsWith('.mp4')) {
    return refuse("The recording's MP4 file is missing.")
  }
  return { eligible: true }
}

export function isCleanCutEligible(session: EligibilityRow): boolean {
  return cleanCutEligibility(session).eligible
}

/** Condensed needs an eligible recording of at least 25 minutes. */
export function condensedEligibility(session: EligibilityRow): CleanCutEligibility {
  const eligibility = cleanCutEligibility(session)
  if (!eligibility.eligible) return eligibility
  return (session.durationMs ?? 0) >= CONDENSED_MIN_SOURCE_MS
    ? { eligible: true }
    : { eligible: false, reason: CONDENSED_TOO_SHORT }
}

/** The recordings the card offers: eligible ones, newest first. */
export function recentCleanCutRecordings<
  T extends EligibilityRow & Pick<SessionSummary, 'startedAt'>
>(sessions: readonly T[], limit: number = CLEAN_CUT_PICKER_LIMIT): T[] {
  return sessions
    .filter(isCleanCutEligible)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit)
}

/** Seconds for `cleanCut.start`; the contract allows 120..3600. */
export function condensedTargetSeconds(minutes: number): number {
  return Math.min(3_600, Math.max(120, Math.round(minutes * 60)))
}

// --- Jobs -----------------------------------------------------------------------

const ACTIVE_STATES: ReadonlySet<CleanCutJob['state']> = new Set([
  'queued',
  'transcribing',
  'analyzing',
  'ready',
  'rendering',
  'validating'
])

/** A worker owns the job (or is about to). */
export function isCleanCutJobActive(job: Pick<CleanCutJob, 'state'>): boolean {
  return ACTIVE_STATES.has(job.state)
}

/** `cleanCut.updateEdl` and `cleanCut.render` accept these (S13 interface). */
export function cleanCutJobEditable(job: Pick<CleanCutJob, 'state'>): boolean {
  return job.state === 'ready' || job.state === 'completed' || job.state === 'failed'
}

/** One entry per job id; a snapshot older than the one held is ignored. */
export function upsertCleanCutJob(jobs: readonly CleanCutJob[], job: CleanCutJob): CleanCutJob[] {
  const index = jobs.findIndex((entry) => entry.id === job.id)
  if (index === -1) return [job, ...jobs]
  if (jobs[index].updatedAt.localeCompare(job.updatedAt) > 0) return [...jobs]
  const next = [...jobs]
  next[index] = job
  return next
}

/** The newest job for one recording and mode. */
export function latestCleanCutJob(
  jobs: readonly CleanCutJob[],
  sessionId: string,
  mode: CleanCutMode
): CleanCutJob | null {
  let latest: CleanCutJob | null = null
  for (const job of jobs) {
    if (job.sourceSessionId !== sessionId || job.mode !== mode) continue
    if (!latest || job.createdAt.localeCompare(latest.createdAt) > 0) latest = job
  }
  return latest
}

// --- Time -----------------------------------------------------------------------

/** "42:10", "1:02:10": recording time, as the clip marks show it. */
export function formatCutClock(ms: number): string {
  return formatClipMarkClock(Math.max(0, ms) / 1000)
}

type Durations = Pick<CleanCutEdlSummary, 'durationMs' | 'keptMs'>

/** "42:10 → 31:05". */
export function cleanCutDurationsLabel(summary: Durations): string {
  return `${formatCutClock(summary.durationMs)} → ${formatCutClock(summary.keptMs)}`
}

/** The time a cut saves, as the difference of the two clocks shown, so
 * 42:10 → 31:05 always reads 11:05, never 11:04 from leftover milliseconds. */
export function cleanCutSavedMs(durationMs: number, keptMs: number): number {
  return Math.max(0, Math.floor(durationMs / 1000) - Math.floor(keptMs / 1000)) * 1000
}

/** "11:05 shorter". */
export function cleanCutSavedLabel(summary: Durations): string {
  return `${formatCutClock(cleanCutSavedMs(summary.durationMs, summary.keptMs))} shorter`
}

const COUNT = new Intl.NumberFormat()

/** "1,083 min left this month"; null when the allowance is unlimited or unknown. */
export function cleanCutMinutesLeftLabel(capabilities: CleanCutCapabilities | null): string | null {
  const remaining = capabilities?.remainingSeconds
  if (typeof remaining !== 'number') return null
  if (remaining <= 0) return 'No minutes left this month'
  return `${COUNT.format(Math.floor(remaining / 60))} min left this month`
}

// --- Status ---------------------------------------------------------------------

export type CleanCutStatusKind =
  | 'none'
  | 'waiting'
  | 'queued'
  | 'transcribing'
  | 'analyzing'
  | 'cutting'
  | 'checking'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface CleanCutStatusView {
  kind: CleanCutStatusKind
  /** "Transcribing 40%", "Ready", "Failed". */
  label: string
  /** "42:10 → 31:05 · 11:05 shorter", the failure in plain words, or null. */
  detail: string | null
  /** A worker owns the job: Cancel is offered, Make is not. */
  busy: boolean
  /** 0..100 while a step reports progress. */
  percent: number | null
  /** The cut list exists, so the review can open. */
  canReview: boolean
  /** What Retry does: render the cut list again, or start over (resumes the
   * transcript). Null when there is nothing to retry. */
  retry: 'render' | 'start' | null
}

export interface CleanCutCaptureContext {
  /** A recording or a stream is running: heavy work waits for it. */
  captureActive: boolean
  /** It is on air (record+stream or stream). */
  streaming: boolean
}

function percentOf(progress: number): number {
  return Math.min(99, Math.max(0, Math.round(progress * 100)))
}

function waitingLabel(capture: CleanCutCaptureContext): string {
  return capture.streaming ? 'Waiting until you stop streaming' : 'Waiting until you stop recording'
}

/** The card row and the review footer for one job (or none yet). */
export function cleanCutStatusView(
  job: CleanCutJob | null,
  capture: CleanCutCaptureContext
): CleanCutStatusView {
  const base = { detail: null, busy: false, percent: null, canReview: false, retry: null }
  if (!job) return { ...base, kind: 'none', label: 'Not cut yet' }
  const hasCutList = Boolean(job.edlSummary)
  const working = { ...base, busy: true, canReview: hasCutList }
  switch (job.state) {
    case 'queued':
      if (capture.captureActive)
        return { ...working, kind: 'waiting', label: waitingLabel(capture) }
      return {
        ...working,
        kind: 'queued',
        label: job.step === 'render' ? 'Waiting to cut' : 'Waiting to start'
      }
    case 'transcribing': {
      const percent = percentOf(job.progress)
      return { ...working, kind: 'transcribing', label: `Transcribing ${percent}%`, percent }
    }
    case 'analyzing':
      return {
        ...working,
        kind: 'analyzing',
        label:
          job.step === 'cut-list'
            ? 'Building the cut list'
            : job.mode === 'condensed'
              ? 'Picking the best parts'
              : 'Finding retakes'
      }
    case 'ready':
      // The cut list is built; the render waits for the maintenance slot.
      if (capture.captureActive)
        return { ...working, kind: 'waiting', label: waitingLabel(capture) }
      return { ...working, kind: 'queued', label: 'Waiting to cut' }
    case 'rendering': {
      const percent = percentOf(job.progress)
      return { ...working, kind: 'cutting', label: `Cutting ${percent}%`, percent }
    }
    case 'validating':
      return { ...working, kind: 'checking', label: 'Checking the cut' }
    case 'completed':
      return {
        ...base,
        kind: 'ready',
        label: 'Ready',
        detail: job.edlSummary
          ? `${cleanCutDurationsLabel(job.edlSummary)} · ${cleanCutSavedLabel(job.edlSummary)}`
          : null,
        canReview: hasCutList
      }
    case 'failed':
      return {
        ...base,
        kind: 'failed',
        label: 'Failed',
        detail: cleanCutFailureCopy(job.errorCode, job.errorMessage),
        canReview: hasCutList,
        retry: hasCutList ? 'render' : 'start'
      }
    case 'cancelled':
      return { ...base, kind: 'cancelled', label: 'Cancelled', retry: 'start' }
  }
}

const FAILURE_COPY: Readonly<Record<string, string>> = {
  'clean-cut-monthly-quota-exhausted':
    "This month's Clean cut minutes ran out. Retry next month; nothing done so far is lost.",
  'clean-cut-daily-quota-exhausted': 'You made the most clean cuts for today. Retry tomorrow.',
  'clean-cut-disabled': "Clean cut is paused on Videorc's side. Retry later.",
  'clean-cut-provider-unconfigured': "Clean cut isn't set up on Videorc's side yet. Retry later.",
  'premium-required': 'Clean cut needs Videorc Premium.',
  'signed-out': 'Sign in to Videorc, then retry.',
  network: "Videorc couldn't be reached. Retry when you're online.",
  'source-changed': 'The recording changed while it was being cut. Retry to start over.',
  'insufficient-space': 'There is not enough free disk space for the cut copy.',
  'render-invalid': "The cut didn't pass its checks, so it wasn't saved. Retry to cut again.",
  'ffmpeg-unsupported': "This computer's video encoder couldn't make the cut.",
  'file-missing': 'The recording file is missing.',
  'no-speech': 'No speech found, so there is nothing to cut.',
  'no-audio': 'This recording has no audio to transcribe.'
}

/** A failed job in plain words: known codes get our copy, anything else
 * keeps the server's message. */
export function cleanCutFailureCopy(code: string | undefined, message: string | undefined): string {
  const known = code ? FAILURE_COPY[code] : undefined
  if (known) return known
  const text = message?.trim()
  return text || 'Clean cut stopped before it finished.'
}

const UNAVAILABLE_COPY: Readonly<Record<string, string>> = {
  disabled: "Clean cut is paused on Videorc's side. Try again later.",
  blocked: 'Cloud AI is not available for this account.',
  'premium-required': 'Clean cut is part of Videorc Premium.',
  'provider-unconfigured': "Clean cut isn't set up on Videorc's side yet. Try again later.",
  'quota-exhausted': "This month's Clean cut minutes are used up."
}

/** Why the capability block says no, in plain words. */
export function cleanCutUnavailableReason(reasonCode: string | null): string {
  if (reasonCode && UNAVAILABLE_COPY[reasonCode]) return UNAVAILABLE_COPY[reasonCode]
  return reasonCode
    ? `Clean cut isn't available right now (${reasonCode}).`
    : "Clean cut isn't available right now."
}

/** What unlocks Clean cut for this account, and its one plain line. */
export interface CleanCutUnlock {
  action: { kind: 'sign-in' } | { kind: 'view-premium'; url: string } | null
  reason: string
}

/**
 * The account first (sign in, then Premium), then the server's capability
 * block. Unknown capabilities block nothing: the backend checks them again
 * when a job starts.
 */
export function cleanCutUnlock({
  signedIn,
  gate,
  capabilities
}: {
  signedIn: boolean
  /** The cloud-AI Premium gate (`cloudAiUploadGate`). */
  gate: EntitlementUiGate
  capabilities: CleanCutCapabilities | null
}): CleanCutUnlock | null {
  if (!signedIn) return { action: { kind: 'sign-in' }, reason: CLEAN_CUT_SIGNED_OUT_REASON }
  if (!gate.allowed) {
    return {
      action: gate.upgradeUrl ? { kind: 'view-premium', url: gate.upgradeUrl } : null,
      reason: gate.reason
    }
  }
  if (!capabilities || capabilities.available) return null
  if (capabilities.reasonCode === 'premium-required') {
    return {
      action: { kind: 'view-premium', url: VIDEORC_PREMIUM_URL },
      reason: cleanCutUnavailableReason(capabilities.reasonCode)
    }
  }
  if (!capabilities.supported && !capabilities.reasonCode) {
    return { action: null, reason: "Clean cut isn't available yet." }
  }
  return { action: null, reason: cleanCutUnavailableReason(capabilities.reasonCode) }
}

export type CleanCutAutoStatusKind = 'off' | 'on' | 'attention'

export interface CleanCutAutoStatus {
  kind: CleanCutAutoStatusKind
  label: string
  reason: string | null
}

/** The status line under "Make a clean cut of every recording". */
export function cleanCutAutoStatus({
  on,
  unlock,
  consented,
  captureActive
}: {
  on: boolean
  unlock: CleanCutUnlock | null
  consented: boolean
  captureActive: boolean
}): CleanCutAutoStatus {
  if (!on) return { kind: 'off', label: 'Off', reason: null }
  if (unlock) return { kind: 'attention', label: 'Needs attention', reason: unlock.reason }
  if (!consented) {
    return { kind: 'attention', label: 'Needs attention', reason: CLEAN_CUT_CONSENT_OFF_REASON }
  }
  return {
    kind: 'on',
    label: captureActive
      ? 'On, cuts this recording when you stop'
      : 'On, cuts every recording when you stop',
    reason: null
  }
}

/** The ready toast's title: "Your clean cut is ready (42:10 → 31:05)". */
export function cleanCutReadyTitle(job: Pick<CleanCutJob, 'mode' | 'edlSummary'>): string {
  const what = job.mode === 'condensed' ? 'Your condensed cut is ready' : 'Your clean cut is ready'
  return job.edlSummary ? `${what} (${cleanCutDurationsLabel(job.edlSummary)})` : what
}

export function cleanCutModeLabel(mode: CleanCutMode): string {
  return mode === 'condensed' ? 'Condensed' : 'Clean cut'
}
