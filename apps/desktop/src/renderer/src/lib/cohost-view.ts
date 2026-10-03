import type {
  CohostAlert,
  CohostAlertKind,
  CohostErrorDetail,
  CohostFlag,
  CohostFlagAction,
  CohostFlagKind,
  CohostFlagTarget,
  CohostListening,
  CohostListeningState,
  CohostMoodScores,
  CohostPriority,
  CohostPromiseTrigger,
  CohostQuestion,
  CohostReason,
  CohostRecap,
  CohostState,
  StreamPlatform
} from './backend'
import { chatDraftMaxChars } from './chat-send'
import { cohostErrorDetail } from './cohost-state'
import type { EntitlementUiGate } from './entitlement-ui'

export {
  applyCohostState,
  COHOST_ERROR_TOAST_MESSAGES,
  cohostErrorDetail,
  cohostErrorToast,
  cohostErrorToastKey,
  cohostErrorToastMessage,
  cohostHighlightMessageId,
  type CohostErrorToast
} from './cohost-state'

// Live Chat Co-host — renderer view layer (plan S2). The BACKEND owns the tick
// scheduler, the open-question set, flags, mood and readiness; everything here
// is a pure derivation of the last `cohost.state` event so the pane, the
// destination chip and the detached Comments window cannot disagree.

/** What Orcle does with chat, the half of the consent every Orcle user gets. */
export const COHOST_CHAT_CONSENT_SENTENCE = 'Orcle reads live chat with Videorc cloud AI.'

/**
 * What Orcle sends (plan 060 D11, plan 068 D3). The consent surfaces that stand
 * alone (the pane notice, the status popover) repeat it verbatim. Turning
 * Orcle on also turns listening on (Orcle Live, plan 119), so the sentence
 * names both halves as what happens, not as an option.
 */
export const COHOST_CONSENT_SENTENCE = `${COHOST_CHAT_CONSENT_SENTENCE} While you're live it also hears you: your microphone audio goes to Videorc's cloud speech-to-text to be turned into text. Videorc servers don't keep it. The transcript is saved with your recording on this computer.`

/** The listening half, as the description of the listening switch under the
 * Orcle tab's Customize. */
export const COHOST_LISTEN_CONSENT_SENTENCE =
  "While you're live, your microphone audio goes to Videorc's cloud speech-to-text to be turned into text, even with live captions off. Videorc servers don't keep it. The transcript is saved with your recording on this computer."

export const EMPTY_COHOST_STATE: CohostState = {
  sessionId: null,
  status: 'off',
  reason: null,
  detail: null,
  questions: [],
  flags: [],
  mood: null,
  lastTickAt: null,
  tickSeq: 0,
  partial: false
}

const PRIORITY_RANK: Record<CohostPriority, number> = { high: 0, normal: 1, low: 2 }

/** Highest priority first, on-topic before off-topic within a priority (plan
 * 068 D7), then oldest first — the order a producer would read them out.
 * Stable on id so equal rows never swap between ticks. */
export function sortedCohostQuestions(questions: readonly CohostQuestion[]): CohostQuestion[] {
  return [...questions].sort((left, right) => {
    const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    if (priority !== 0) return priority
    const topic = Number(right.onTopic === true) - Number(left.onTopic === true)
    if (topic !== 0) return topic
    const seen = Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt)
    if (Number.isFinite(seen) && seen !== 0) return seen
    return left.id.localeCompare(right.id)
  })
}

/** Newest flag first: a producer reacts to what just happened. */
export function sortedCohostFlags(flags: readonly CohostFlag[]): CohostFlag[] {
  return [...flags].sort((left, right) => {
    const at = Date.parse(right.at) - Date.parse(left.at)
    if (Number.isFinite(at) && at !== 0) return at
    return left.messageId.localeCompare(right.messageId)
  })
}

// --- Status chip -----------------------------------------------------------

export interface CohostChipView {
  label: string
  /** Only `listening` earns the live accent; every other state is monochrome. */
  tone: 'live' | 'muted'
  /**
   * What the failed tick actually said — "ai-gateway-error (HTTP 502): The
   * Orcle tick failed on every configured model." — for the chip's tooltip
   * or a secondary line. Null while listening, off, or when the engine paused
   * itself locally (signed out, Basic, consent).
   */
  detail: string | null
}

/**
 * One line a streamer can paste into a bug report: the server's envelope code,
 * the HTTP status when there was a response, and the server's own sentence.
 */
export function cohostErrorDetailText(detail: CohostErrorDetail | null | undefined): string | null {
  if (!detail) return null
  const code = detail.code.trim()
  if (!code) return null
  const head = detail.status !== null ? `${code} (HTTP ${detail.status})` : code
  const message = detail.message.trim()
  return message ? `${head}: ${message}` : head
}

const REASON_LABELS: Record<CohostReason, string> = {
  'premium-required': 'Premium',
  'consent-required': 'consent',
  'session-expired': 'session expired',
  'signed-out': 'signed out',
  'quota-exhausted': 'quota',
  'server-unconfigured': 'unavailable',
  network: 'offline',
  'gateway-error': 'AI error'
}

export function cohostReasonLabel(reason: CohostReason | null): string | null {
  return reason ? REASON_LABELS[reason] : null
}

/** Short, honest chip copy for the destination strip. */
export function cohostChipView(state: CohostState | null): CohostChipView | null {
  if (!state) return null
  const reason = cohostReasonLabel(state.reason)
  // The engine only sets `detail` on a failed tick, and clears it the moment
  // it listens again; a stale detail on a listening/off state is never shown.
  const detail =
    state.status === 'error' || state.status === 'paused'
      ? cohostErrorDetailText(cohostErrorDetail(state))
      : null
  switch (state.status) {
    case 'off':
      return { label: 'Orcle: off', tone: 'muted', detail: null }
    case 'listening': {
      const count = state.questions.length
      return {
        label: count > 0 ? `Orcle: listening · ${count} q` : 'Orcle: listening',
        tone: 'live',
        detail: null
      }
    }
    case 'paused':
      return {
        label: reason ? `Orcle: paused · ${reason}` : 'Orcle: paused',
        tone: 'muted',
        detail
      }
    case 'error':
      return {
        label: reason ? `Orcle: error · ${reason}` : 'Orcle: error',
        tone: 'muted',
        detail
      }
  }
}

// --- Pane mode -------------------------------------------------------------

export type CohostPaneMode =
  | { kind: 'upsell'; reason: string; upgradeUrl?: string }
  | { kind: 'consent'; reason: string }
  | { kind: 'disabled'; reason: string }
  | { kind: 'live' }

/**
 * The Orcle tab's key in running copy: ⌘9 on macOS, Ctrl+9 elsewhere. Read
 * from the user agent, as the Stream Manager reads its ⌘J, so this pure view
 * module stays free of lib/platform.ts.
 */
const ORCLE_TAB_KEY = /Macintosh/.test(globalThis.navigator?.userAgent ?? '') ? '⌘9' : 'Ctrl+9'

/**
 * Which single-line explanation (if any) replaces the pane. Premium is checked
 * first so a Basic user never sees a consent prompt for a feature they cannot
 * run; consent is renderer-owned, so it is checked before the engine's own
 * status.
 */
export function cohostPaneMode({
  gate,
  consented,
  enabled
}: {
  gate: EntitlementUiGate
  consented: boolean
  enabled: boolean
}): CohostPaneMode {
  if (!gate.allowed) {
    return {
      kind: 'upsell',
      reason: gate.reason,
      ...(gate.upgradeUrl ? { upgradeUrl: gate.upgradeUrl } : {})
    }
  }
  if (!consented) {
    return {
      kind: 'consent',
      reason: `${COHOST_CONSENT_SENTENCE} Turn on cloud AI to use it.`
    }
  }
  if (!enabled) {
    // The Comments window cannot switch the main window's tab: copy only.
    return {
      kind: 'disabled',
      reason: `Orcle is off. Turn it on in the Orcle tab (${ORCLE_TAB_KEY}).`
    }
  }
  return { kind: 'live' }
}

// --- Keyboard selection ----------------------------------------------------

export interface CohostRow {
  /** Stable key across ticks; also the pane's `aria-activedescendant` suffix. */
  key: string
  kind: 'question' | 'flag'
  /** Question id, or the flagged message id. */
  id: string
}

export function cohostQuestionRowKey(questionId: string): string {
  return `q:${questionId}`
}

export function cohostFlagRowKey(messageId: string): string {
  return `f:${messageId}`
}

/** One flat, ordered list — questions then flags — so ↑/↓ walks the whole pane. */
export function cohostRows(state: CohostState | null): CohostRow[] {
  if (!state) return []
  return [
    ...sortedCohostQuestions(state.questions).map((question) => ({
      key: cohostQuestionRowKey(question.id),
      kind: 'question' as const,
      id: question.id
    })),
    ...sortedCohostFlags(state.flags).map((flag) => ({
      key: cohostFlagRowKey(flag.messageId),
      kind: 'flag' as const,
      id: flag.messageId
    }))
  ]
}

/** Keeps the selection on the same row across ticks; falls back to the top row
 * when the selected one was answered, dismissed or resolved away. */
export function resolveCohostSelection(
  rows: readonly CohostRow[],
  selectedKey: string | null
): string | null {
  if (rows.length === 0) return null
  if (selectedKey && rows.some((row) => row.key === selectedKey)) return selectedKey
  return rows[0].key
}

/** ↑/↓ movement. Clamped, not wrapping: a dense producer list should not jump
 * from the last flag back to the first question under a held key. */
export function moveCohostSelection(
  rows: readonly CohostRow[],
  selectedKey: string | null,
  delta: number
): string | null {
  if (rows.length === 0) return null
  const current = rows.findIndex((row) => row.key === resolveCohostSelection(rows, selectedKey))
  const next = Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
  return rows[next].key
}

export function cohostRowAt(
  rows: readonly CohostRow[],
  selectedKey: string | null
): CohostRow | null {
  const key = resolveCohostSelection(rows, selectedKey)
  return rows.find((row) => row.key === key) ?? null
}

// --- Reply drafts ----------------------------------------------------------

/** Trim to a hard character cap without cutting a word in half when a clean
 * break is close to the end. The streamer still edits before sending. */
export function trimDraftToCap(text: string, cap: number): string {
  const trimmed = text.trim()
  if (cap <= 0) return ''
  if (trimmed.length <= cap) return trimmed
  const sliced = trimmed.slice(0, cap)
  const lastSpace = sliced.lastIndexOf(' ')
  const wordSafe = lastSpace > cap * 0.6 ? sliced.slice(0, lastSpace) : sliced
  return wordSafe.trimEnd()
}

/** The editable draft that prefills the composer for a Reply action. */
export function draftForQuestion(
  question: Pick<CohostQuestion, 'suggestedReply'>,
  targets: readonly StreamPlatform[]
): string {
  return trimDraftToCap(question.suggestedReply, chatDraftMaxChars(targets))
}

// --- Row copy --------------------------------------------------------------

/** "Ada +3" — who is asking, without a wall of names. */
export function cohostAskersLabel(askers: readonly string[]): string {
  if (askers.length === 0) return ''
  const [first, ...rest] = askers
  return rest.length > 0 ? `${first} +${rest.length}` : first
}

/** Compact age for a dense row: "now", "4m", "2h", "1d". */
export function cohostAgeLabel(iso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export const COHOST_FLAG_KIND_LABELS: Record<CohostFlagKind, string> = {
  toxicity: 'Toxicity',
  spam: 'Spam',
  'self-promo': 'Self-promo',
  'personal-info': 'Personal info',
  hate: 'Hate',
  harassment: 'Harassment',
  threat: 'Threat',
  sexual: 'Sexual',
  scam: 'Scam',
  'self-harm': 'Self-harm',
  spoiler: 'Spoiler',
  impersonation: 'Impersonation',
  rule: 'Chat rule',
  // The server's vocabulary grows faster than the desktop ships: a kind this
  // build does not know is still a flag worth a look.
  unknown: 'Flagged'
}

/** Never undefined, whatever string the wire carried. */
export function cohostFlagKindLabel(kind: CohostFlagKind): string {
  return COHOST_FLAG_KIND_LABELS[kind] ?? COHOST_FLAG_KIND_LABELS.unknown
}

const COHOST_FLAG_TARGET_LABELS: Record<CohostFlagTarget, string> = {
  streamer: 'at you',
  viewer: 'at a viewer',
  group: 'at a group'
}

/** "Harassment · at you", "Chat rule · No spoilers", "Flagged". */
export function cohostFlagChipLabel(flag: Pick<CohostFlag, 'kind' | 'target' | 'rule'>): string {
  const parts = [cohostFlagKindLabel(flag.kind)]
  if (flag.kind === 'rule' && flag.rule) parts.push(flag.rule)
  const target = flag.target ? COHOST_FLAG_TARGET_LABELS[flag.target] : undefined
  if (target) parts.push(target)
  return parts.join(' · ')
}

const COHOST_FLAG_ACTION_LABELS: Record<CohostFlagAction, string> = {
  hide: 'Suggests hide',
  timeout: 'Suggests timeout',
  ban: 'Suggests ban'
}

/** A suggestion LABEL only — the co-host never moderates, and neither does
 * this chip. Null when the server suggested nothing. */
export function cohostFlagActionLabel(flag: Pick<CohostFlag, 'action'>): string | null {
  return flag.action ? (COHOST_FLAG_ACTION_LABELS[flag.action] ?? null) : null
}

/** Tooltip: the server's reason, plus anything else that also scored high. */
export function cohostFlagDetail(flag: Pick<CohostFlag, 'reason' | 'alsoKinds'>): string {
  const also = (flag.alsoKinds ?? []).map(cohostFlagKindLabel)
  const lines = [flag.reason.trim(), also.length > 0 ? `Also: ${also.join(', ')}` : '']
  return lines.filter(Boolean).join('\n')
}

// --- Flag sensitivity (renderer-only filter) --------------------------------

/**
 * How sure the co-host must be before a flag is SHOWN. A pure view filter over
 * `confidence` — it never reaches the backend or the model, so moving it is
 * instant and costs nothing. Flags without a confidence (wire v1) always show.
 */
export type CohostSensitivity = 'relaxed' | 'balanced' | 'strict'

export const COHOST_SENSITIVITIES: readonly CohostSensitivity[] = ['relaxed', 'balanced', 'strict']
export const DEFAULT_COHOST_SENSITIVITY: CohostSensitivity = 'balanced'
export const COHOST_SENSITIVITY_STORAGE_KEY = 'videorc.cohostSensitivity'

export const COHOST_SENSITIVITY_LABELS: Record<CohostSensitivity, string> = {
  relaxed: 'Relaxed',
  balanced: 'Balanced',
  strict: 'Strict'
}

/** Minimum confidence shown per step. Strict shows everything the server sent. */
export const COHOST_SENSITIVITY_MIN_CONFIDENCE: Record<CohostSensitivity, number> = {
  relaxed: 0.85,
  balanced: 0.6,
  strict: 0
}

export function cohostSensitivityFromStorage(raw: string | null | undefined): CohostSensitivity {
  return COHOST_SENSITIVITIES.find((step) => step === raw) ?? DEFAULT_COHOST_SENSITIVITY
}

export function cohostFlagVisible(
  flag: Pick<CohostFlag, 'confidence'>,
  sensitivity: CohostSensitivity
): boolean {
  if (flag.confidence === undefined) return true
  return flag.confidence >= COHOST_SENSITIVITY_MIN_CONFIDENCE[sensitivity]
}

/** The state every surface renders: same object when nothing was filtered, so
 * memoised derivations downstream keep their identity. */
export function cohostStateForSensitivity<T extends CohostState | null>(
  state: T,
  sensitivity: CohostSensitivity
): T {
  if (!state) return state
  const flags = state.flags.filter((flag) => cohostFlagVisible(flag, sensitivity))
  return flags.length === state.flags.length ? state : { ...state, flags }
}

// --- Attention alerts ----------------------------------------------------------

/** Mirrors the backend's expiry so a chip cannot outlive its reports when no
 * further `cohost.state` event arrives. */
export const COHOST_ALERT_EXPIRY_MS = 120_000

const COHOST_ALERT_KIND_LABELS: Record<CohostAlertKind, string> = {
  audio: 'no audio',
  video: 'video problem',
  'stream-health': 'stream is lagging',
  game: 'game problem',
  other: 'something is wrong'
}

/** Alerts worth a chip right now: corroborated by the backend and not expired. */
export function activeCohostAlerts(
  state: CohostState | null,
  nowMs: number = Date.now()
): CohostAlert[] {
  if (!state || state.status === 'off') return []
  return (state.alerts ?? []).filter((alert) => {
    if (!alert.active) return false
    const seen = Date.parse(alert.lastSeenAt)
    return !Number.isFinite(seen) || nowMs - seen < COHOST_ALERT_EXPIRY_MS
  })
}

/** "Chat says: no audio · 3 viewers" */
export function cohostAlertLabel(alert: Pick<CohostAlert, 'kind' | 'viewers'>): string {
  const what = COHOST_ALERT_KIND_LABELS[alert.kind] ?? COHOST_ALERT_KIND_LABELS.other
  return `Chat says: ${what} · ${alert.viewers} ${alert.viewers === 1 ? 'viewer' : 'viewers'}`
}

/** "Hype 20% · Tension 70% · Confusion 10%" — the mood label's tooltip. */
export function cohostMoodScoresLabel(scores: CohostMoodScores | null | undefined): string | null {
  if (!scores) return null
  const percent = (value: number): string => `${Math.round(value * 100)}%`
  return `Hype ${percent(scores.hype)} · Tension ${percent(scores.tension)} · Confusion ${percent(scores.confusion)}`
}

export const COHOST_PRIORITY_LABELS: Record<CohostPriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low'
}

export const COHOST_MOOD_LABELS: Record<NonNullable<CohostState['mood']>, string> = {
  hype: 'Chat is hyped',
  calm: 'Chat is calm',
  tense: 'Chat is tense',
  mixed: 'Chat is mixed'
}

// --- Collapsed-pane salience (presence W2) ---------------------------------

/**
 * Unread questions while the pane is collapsed. The seen set is re-baselined
 * every time the pane is OPEN, so expanding always clears the badge and
 * collapsing starts counting from what the streamer actually looked at.
 */
export interface CohostUnreadState {
  /** Question ids the streamer has had on screen. */
  seenIds: readonly string[]
  count: number
}

export const EMPTY_COHOST_UNREAD: CohostUnreadState = { seenIds: [], count: 0 }

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Pure reducer. Returns the SAME object when nothing changed, so the segment
 * header does not re-render on every unrelated tick. */
export function reduceCohostUnread(
  current: CohostUnreadState,
  next: { questionIds: readonly string[]; open: boolean }
): CohostUnreadState {
  if (next.open) {
    if (current.count === 0 && sameIds(current.seenIds, next.questionIds)) return current
    return { seenIds: [...next.questionIds], count: 0 }
  }
  const seen = new Set(current.seenIds)
  const count = next.questionIds.filter((id) => !seen.has(id)).length
  return count === current.count ? current : { ...current, count }
}

// --- Quiet keyed question toast --------------------------------------------

/** One keyed toast slot: a newer question REPLACES the older one in place. */
export const COHOST_QUESTION_TOAST_ID = 'cohost-question'
/** At most one question toast a minute — mid-stream, a popup is an interruption. */
export const COHOST_QUESTION_TOAST_THROTTLE_MS = 60_000

const COHOST_QUESTION_TOAST_TEXT_CAP = 64

/** "Orcle: 5 people asking: What keyboard is that? · ⌘J" (Ctrl+J on Windows). */
export function cohostQuestionToastMessage(question: CohostQuestion, shortcut = '⌘J'): string {
  const askers = question.askers.length
  const who =
    askers > 1
      ? `${askers} people asking`
      : askers === 1
        ? `${question.askers[0]} is asking`
        : 'a new question'
  const text = trimDraftToCap(question.text, COHOST_QUESTION_TOAST_TEXT_CAP)
  return text ? `Orcle: ${who}: ${text} · ${shortcut}` : `Orcle: ${who} · ${shortcut}`
}

export interface CohostQuestionToast {
  message: string
  /** When the toast was raised, for the caller's throttle bookkeeping. */
  atMs: number
}

/**
 * Toast discipline: the pane already shows every question, so a toast is only
 * news when the pane is COLLAPSED and a genuinely new HIGH-priority question
 * arrived — throttled to one a minute and keyed so it never stacks.
 */
export function cohostQuestionToast({
  previous,
  next,
  paneOpen,
  lastToastAtMs,
  nowMs,
  shortcut
}: {
  previous: CohostState | null
  next: CohostState
  paneOpen: boolean
  lastToastAtMs: number | null
  nowMs: number
  /** The key that focuses Orcle, as this platform writes it. */
  shortcut?: string
}): CohostQuestionToast | null {
  if (paneOpen) return null
  if (next.status !== 'listening') return null
  if (lastToastAtMs !== null && nowMs - lastToastAtMs < COHOST_QUESTION_TOAST_THROTTLE_MS) {
    return null
  }
  const known = new Set(
    previous && previous.sessionId === next.sessionId
      ? previous.questions.map((question) => question.id)
      : []
  )
  const candidate = sortedCohostQuestions(next.questions).find(
    (question) => question.priority === 'high' && !known.has(question.id)
  )
  if (!candidate) return null
  return { message: cohostQuestionToastMessage(candidate, shortcut), atMs: nowMs }
}

// --- Promises and recaps (plan 068 D8) --------------------------------------

/** One keyed toast slot for promise reminders: the backend fires each promise
 * once, so a newer reminder replaces the older one in place. */
export const COHOST_PROMISE_TOAST_ID = 'cohost-promise'

const COHOST_PROMISE_TOAST_TEXT_CAP = 80

/** "at 100 viewers", "in 10 min"; null for a promise with no trigger (it
 * reminds after 20 minutes on its own). */
export function cohostPromiseTriggerLabel(trigger: CohostPromiseTrigger): string | null {
  if (typeof trigger.value !== 'number' || !Number.isFinite(trigger.value)) return null
  const value = Math.max(0, Math.round(trigger.value))
  if (trigger.kind === 'viewers') return `at ${value.toLocaleString()} viewers`
  if (trigger.kind === 'minutes') return `in ${value} min`
  return null
}

/** "Orcle: you promised: a giveaway at 100 viewers". */
export function cohostPromiseReminderMessage(text: string): string {
  const trimmed = trimDraftToCap(text, COHOST_PROMISE_TOAST_TEXT_CAP)
  return trimmed ? `You promised: ${trimmed}` : 'You made a promise on stream.'
}

/**
 * A reminder is news exactly once: when the state carries a reminder the
 * previous state (of the same session) did not. Dismissing or finishing the
 * promise clears it on the backend, so the same id never toasts twice.
 */
export function cohostPromiseReminderToast({
  previous,
  next
}: {
  previous: CohostState | null
  next: CohostState
}): string | null {
  const reminder = next.promiseReminder
  if (!reminder) return null
  const before =
    previous && previous.sessionId === next.sessionId ? previous.promiseReminder : undefined
  if (before && before.promiseId === reminder.promiseId && before.at === reminder.at) return null
  return cohostPromiseReminderMessage(reminder.text)
}

// --- Chat you haven't acknowledged (plan 068 D9) -----------------------------

/** One keyed toast slot for dead-air nudges: a newer one replaces it in place. */
export const COHOST_DEAD_AIR_TOAST_ID = 'cohost-dead-air'

/**
 * The dead-air nudge to toast, or null. Private and keyed: each key toasts
 * once (`lastKey` is the last one toasted); the backend spaces them at least
 * two minutes apart and drops each from the state after 30 seconds.
 */
export function cohostDeadAirToast(
  state: CohostState | null,
  lastKey: string | null
): { key: string; text: string } | null {
  const nudge = state?.deadAirNudge
  if (!nudge || nudge.key === lastKey || !nudge.text.trim()) return null
  return { key: nudge.key, text: nudge.text }
}

/** The recap while it is current: the backend drops it after five minutes,
 * and this keeps a quiet chat honest between state events. */
export function activeCohostRecap(state: CohostState | null, nowMs: number): CohostRecap | null {
  const recap = state?.recap
  if (!recap) return null
  const expires = Date.parse(recap.expiresAt)
  if (Number.isFinite(expires) && expires <= nowMs) return null
  return recap
}

// --- Off-but-useful nudge ---------------------------------------------------

/** Persisted "don't offer this again" flag — one renderer-local boolean, the
 * same mechanism as the audio mixer's monitor-when-idle preference. */
export const COHOST_NUDGE_STORAGE_KEY = 'videorc.cohostNudgeDismissed'

export function cohostNudgeDismissedFromStorage(raw: string | null | undefined): boolean {
  return raw === '1' || raw === 'true'
}

export interface CohostNudgeInput {
  /** The live chat session id, or null when no session is running. */
  sessionId: string | null
  /** Premium gate result — never nudge someone toward a locked feature. */
  gateAllowed: boolean
  consented: boolean
  enabled: boolean
  /** Persisted across launches. */
  dismissedForever: boolean
  /** Session the row was dismissed for in this run (max once per session). */
  dismissedSessionId: string | null
}

/**
 * The row only appears for the ONE audience it helps: live right now, allowed
 * to run co-host, already consented to cloud AI — and simply has it off.
 */
export function cohostNudgeVisible({
  sessionId,
  gateAllowed,
  consented,
  enabled,
  dismissedForever,
  dismissedSessionId
}: CohostNudgeInput): boolean {
  if (!sessionId) return false
  if (enabled || !gateAllowed || !consented) return false
  if (dismissedForever) return false
  return dismissedSessionId !== sessionId
}

// --- Listening (plan 068) ----------------------------------------------------

/** One compact label and one plain sentence for whether Orcle hears the
 * streamer. `off` has no view: an unused feature shows nothing. */
export interface CohostListeningView {
  state: Exclude<CohostListeningState, 'off'>
  /** "Listening", "Starting to listen", "Not listening: no microphone selected". */
  label: string
  /** The tooltip sentence: the backend's own words while blocked. */
  detail: string
}

/** Why listening is blocked, as the streamer would say it. Codes the desktop
 * does not know read "Not listening" with the backend's sentence on hover. */
const COHOST_LISTEN_BLOCKED_REASONS: ReadonlyMap<string, string> = new Map([
  ['no-capture', 'not live'],
  ['no-microphone', 'no microphone selected'],
  ['signed-out', 'sign in'],
  ['unauthorized', 'sign in'],
  ['signing-out', 'signing out'],
  ['shutting-down', 'Videorc is closing'],
  ['service-unavailable', "can't reach Videorc"],
  ['consent-required', 'turn on cloud AI'],
  ['cloud-ai-premium-required', 'needs Premium'],
  ['listen-monthly-quota-exhausted', 'monthly listening time used up'],
  ['captions-monthly-quota-exhausted', 'monthly caption time used up'],
  ['listen-disabled', 'unavailable right now']
])

export const COHOST_LISTEN_QUOTA_REASON = 'listen-monthly-quota-exhausted'

/** "98 h 20 min", "12 min", "under a minute"; null when unknown. */
export function cohostListenTimeLabel(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return 'under a minute'
  const totalMinutes = Math.floor(seconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`
}

/**
 * The monthly listening allowance in one line, for Settings and the tooltip.
 * The server reports it only on a chunk it metered as listening, so it is
 * null most of the time, and a used-up month says so plainly.
 */
export function cohostListenAllowanceLabel(
  listening: CohostListening | null | undefined
): string | null {
  if (!listening) return null
  if (listening.state === 'blocked' && listening.reasonCode === COHOST_LISTEN_QUOTA_REASON) {
    return 'Your listening time for this month is used up.'
  }
  if (listening.remainingSeconds === 0) return 'No listening time left this month.'
  const time = cohostListenTimeLabel(listening.remainingSeconds)
  if (!time) return null
  return `${time.charAt(0).toUpperCase()}${time.slice(1)} of listening left this month.`
}

export function cohostListeningView(
  listening: CohostListening | null | undefined
): CohostListeningView | null {
  switch (listening?.state) {
    case 'starting':
      return {
        state: 'starting',
        label: 'Starting to listen',
        detail: 'Orcle is starting to hear your microphone.'
      }
    case 'on': {
      const allowance = cohostListenAllowanceLabel(listening)
      const heard = 'Orcle hears your microphone as text.'
      return {
        state: 'on',
        label: 'Listening',
        detail: allowance ? `${heard} ${allowance}` : heard
      }
    }
    case 'blocked': {
      const reason = listening.reasonCode
        ? COHOST_LISTEN_BLOCKED_REASONS.get(listening.reasonCode)
        : undefined
      return {
        state: 'blocked',
        label: reason ? `Not listening: ${reason}` : 'Not listening',
        detail: listening.message?.trim() || "Orcle can't hear you right now."
      }
    }
    default:
      return null
  }
}

// --- Listening prompt (plan 068 D3) -------------------------------------------

/** Persisted once the streamer answers the one-time card either way. */
export const COHOST_LISTEN_PROMPT_STORAGE_KEY = 'videorc.orcleListenPromptDismissed'

/**
 * The one-time "Orcle can hear you" card: only for someone who runs Orcle,
 * has listening off, and has not answered it. `listen` unknown (a relay that
 * predates the setting) never shows it.
 */
export function cohostListenPromptVisible({
  enabled,
  listen,
  dismissed
}: {
  enabled: boolean
  listen: boolean | undefined
  dismissed: boolean
}): boolean {
  return enabled && listen === false && !dismissed
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readCohostListenPromptDismissed(
  storage: Pick<Storage, 'getItem'> | null = localStorageOrNull()
): boolean {
  try {
    return cohostNudgeDismissedFromStorage(storage?.getItem(COHOST_LISTEN_PROMPT_STORAGE_KEY))
  } catch {
    return false
  }
}

/** Best effort: blocked storage keeps the answer for this window's life only. */
export function persistCohostListenPromptDismissed(
  storage: Pick<Storage, 'setItem'> | null = localStorageOrNull()
): void {
  try {
    storage?.setItem(COHOST_LISTEN_PROMPT_STORAGE_KEY, '1')
  } catch {
    // Private window or blocked site data: nothing to persist into.
  }
}
