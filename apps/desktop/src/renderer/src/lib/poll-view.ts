import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_CHARS,
  POLL_QUESTION_MAX_CHARS,
  type LiveChatMessage,
  type LiveChatProviderState,
  type PollStartParams,
  type PollState,
  type PollStatus,
  type StreamPlatform
} from '@/lib/backend'
import { plural } from '@/lib/format'
import { formatTimecode } from '@/lib/format-time'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { pollOptionKey, pollTextLength } from '../../../shared/poll-commands'
import { classifyVote } from '../../../shared/poll-votes'

// The Stream Manager's poll (plan 188 S5): the Poll popover's three states,
// the form and its remembered draft, and which chat rows fold into the poll
// (D5). Pure, so the popover, the composer's `/poll` and the chat list read
// one model, and the tests pin its edges.

// --- Running or not -----------------------------------------------------------

/** The poll takes votes or counts its last ones: the Poll button's live dot. */
export function pollRunning(poll: Pick<PollStatus, 'state'> | null | undefined): boolean {
  return poll?.state === 'open' || poll?.state === 'counting'
}

export type PollPopoverMode = 'create' | 'live' | 'final'

/**
 * Which face the popover shows: the form with no poll (a cancelled one reads
 * as none), the tally while it runs, the result once final, and the form again
 * after "New poll…" (`composing`) until the next poll starts.
 */
export function pollPopoverMode(
  poll: Pick<PollStatus, 'state'> | null | undefined,
  composing: boolean
): PollPopoverMode {
  if (!poll || poll.state === 'cancelled') return 'create'
  if (pollRunning(poll)) return 'live'
  return composing ? 'create' : 'final'
}

// --- Starting one ---------------------------------------------------------------

/** The backend's refusals (plan 188 seams), word for word: one sentence each. */
export const POLL_NOT_LIVE = 'Go live to start a poll.'
export const POLL_NO_CHAT = "No chat is connected, so there's nobody to vote."
export const POLL_ALREADY_RUNNING = 'End the current poll first.'

/** A chat Videorc reads (or will once it connects): its viewers can vote. */
export function pollChatReadable(
  provider: Pick<LiveChatProviderState, 'state' | 'read'>
): boolean {
  if (['failed', 'ended', 'disabled', 'unsupported'].includes(provider.state)) return false
  return provider.read !== 'unavailable' && provider.read !== 'failed' && provider.read !== 'ended'
}

/**
 * Why a poll can't start right now, or null. The window asks before it sends,
 * so the popover and `/poll` say it in place; the backend still decides and
 * its refusal is the window's toast.
 */
export function pollStartBlockedReason({
  live,
  providers,
  poll
}: {
  /** On air: a livestream runs (the stats bar's ON AIR). */
  live: boolean
  providers: readonly Pick<LiveChatProviderState, 'state' | 'read'>[]
  poll: Pick<PollStatus, 'state'> | null | undefined
}): string | null {
  if (pollRunning(poll)) return POLL_ALREADY_RUNNING
  if (!live) return POLL_NOT_LIVE
  if (!providers.some(pollChatReadable)) return POLL_NO_CHAT
  return null
}

export type PollDuration = '60' | '120' | '300' | 'none'

/** D10: 1 min (the default), 2 min, 5 min, or No timer (ends on End now). */
export const POLL_DURATION_OPTIONS: readonly { value: PollDuration; label: string }[] = [
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
  { value: 'none', label: 'No timer' }
]

export function pollDurationSeconds(duration: PollDuration): number | null {
  return duration === 'none' ? null : Number(duration)
}

/** The form as typed, and what the window remembers of it. */
export interface PollDraft {
  question: string
  /** 2–5 rows, blank ones included. */
  options: string[]
  duration: PollDuration
  postInChat: boolean
}

export const DEFAULT_POLL_DRAFT: PollDraft = {
  question: '',
  options: ['', ''],
  duration: '60',
  postInChat: true
}

export const POLL_DRAFT_STORAGE_KEY = 'videorc.pollDraft'
/** A remembered field longer than this is someone else's data, not a draft. */
const STORED_TEXT_MAX = 200

function storedText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, STORED_TEXT_MAX) : ''
}

/**
 * The last poll's question, answers, duration and Post in chat, from this
 * window's `localStorage`. A convenience only: anything unreadable is the
 * default draft, and storage that throws is no storage.
 */
export function loadPollDraft(storage: Pick<Storage, 'getItem'> | undefined): PollDraft {
  try {
    const raw = storage?.getItem(POLL_DRAFT_STORAGE_KEY)
    if (!raw) return DEFAULT_POLL_DRAFT
    const stored = JSON.parse(raw) as Partial<Record<keyof PollDraft, unknown>> | null
    if (!stored || typeof stored !== 'object') return DEFAULT_POLL_DRAFT
    const options = Array.isArray(stored.options)
      ? stored.options.slice(0, POLL_MAX_OPTIONS).map(storedText)
      : []
    while (options.length < POLL_MIN_OPTIONS) options.push('')
    const duration = POLL_DURATION_OPTIONS.some((option) => option.value === stored.duration)
      ? (stored.duration as PollDuration)
      : DEFAULT_POLL_DRAFT.duration
    return {
      question: storedText(stored.question),
      options,
      duration,
      postInChat: typeof stored.postInChat === 'boolean' ? stored.postInChat : true
    }
  } catch {
    return DEFAULT_POLL_DRAFT
  }
}

export function savePollDraft(storage: Pick<Storage, 'setItem'> | undefined, draft: PollDraft): void {
  try {
    storage?.setItem(POLL_DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // A draft that can't be remembered still starts its poll.
  }
}

/** What the form says before Start poll can run. */
export interface PollDraftCheck {
  /** The question's own error, under it. */
  questionError: string | null
  /** One per option row. */
  optionErrors: (string | null)[]
  /** Nothing is wrong yet, something is still missing: Start poll's reason. */
  missing: string | null
  /** Ready to send: trimmed, blank rows left out. Null while anything is off. */
  params: PollStartParams | null
}

/**
 * The form's checks (D10): a question up to 60 characters, 2–5 answers up to
 * 25 each, all different. Blank option rows are left out, so a row added and
 * left empty never blocks the start.
 */
export function checkPollDraft(draft: PollDraft): PollDraftCheck {
  const question = draft.question.trim()
  const questionError =
    pollTextLength(question) > POLL_QUESTION_MAX_CHARS
      ? `Up to ${POLL_QUESTION_MAX_CHARS} characters.`
      : null
  const firstRow = new Map<string, number>()
  const optionErrors = draft.options.map((option, index) => {
    if (pollTextLength(option) > POLL_OPTION_MAX_CHARS) {
      return `Up to ${POLL_OPTION_MAX_CHARS} characters.`
    }
    const key = pollOptionKey(option)
    if (!key) return null
    const first = firstRow.get(key)
    if (first !== undefined) return `Same as option ${first + 1}.`
    firstRow.set(key, index)
    return null
  })
  const options = draft.options.map((option) => option.trim()).filter(Boolean)
  const missing = !question
    ? 'Ask a question first.'
    : options.length < POLL_MIN_OPTIONS
      ? `Add at least ${POLL_MIN_OPTIONS} options.`
      : null
  const wrong = questionError !== null || optionErrors.some((error) => error !== null)
  return {
    questionError,
    optionErrors,
    missing,
    params:
      wrong || missing
        ? null
        : {
            question,
            options: options.slice(0, POLL_MAX_OPTIONS),
            durationSeconds: pollDurationSeconds(draft.duration),
            postInChat: draft.postInChat
          }
  }
}

/** Start poll's one reason when it is off: the session first, then the form. */
export function pollStartReason(blocked: string | null, check: PollDraftCheck): string | null {
  if (blocked) return blocked
  if (check.missing) return check.missing
  return check.params ? null : 'Fix the marked fields first.'
}

/**
 * `/poll Question? A | B`: the typed poll with the remembered duration and
 * Post in chat (plan 188 S5).
 */
export function pollStartFromCommand(
  command: { question: string; options: string[] },
  remembered: PollDraft
): PollStartParams {
  return {
    question: command.question,
    options: command.options,
    durationSeconds: pollDurationSeconds(remembered.duration),
    postInChat: remembered.postInChat
  }
}

// --- The tally ------------------------------------------------------------------

export interface PollOptionView {
  /** What viewers type: "1" to "5". */
  key: string
  label: string
  votes: number
  /** 0–100, rounded; 0 with no votes, never NaN. */
  percent: number
  percentLabel: string
  /** Leading while it runs, the winner once final (ties lead together). */
  leading: boolean
}

export interface PollPlatformView {
  platform: StreamPlatform
  label: string
  votes: number
}

export interface PollTallyView {
  pollId: string
  state: PollState
  question: string
  options: PollOptionView[]
  /** "84 votes". */
  totalLabel: string
  /** "0:42 left", "No timer", "Counting last votes…"; null once final. */
  timeLabel: string | null
  platforms: PollPlatformView[]
  /** Final only: "Tabs wins", "Tie: Tabs and Spaces", "No votes". */
  headline: string | null
  /** Quiet lines, only while true. */
  diagnostics: string[]
  canEnd: boolean
  canCancel: boolean
  canReshow: boolean
  /** Why Show result again is off. */
  reshowReason: string | null
}

export const POLL_COUNTING_LABEL = 'Counting last votes…'
export const POLL_CARD_UNAVAILABLE =
  "The poll card can't show on this stream (4K 60 fps). Votes still count."
export const POLL_VERTICAL_CANT_VOTE = "Vertical viewers can't vote yet."

function listInWords(items: readonly string[]): string {
  return new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(items)
}

/** Whole seconds left, rounded up, never below zero: "0:42 left". */
export function pollTimeLeftLabel(closesAt: string, nowMs: number): string | null {
  const closes = Date.parse(closesAt)
  if (!Number.isFinite(closes)) return null
  const seconds = Math.max(0, Math.ceil((closes - nowMs) / 1000))
  return `${formatTimecode(seconds * 1000)} left`
}

/**
 * The popover's tally (live and final). `auxiliaryLeg` is whether this
 * session has a vertical (or split) leg; the window can't tell yet, so
 * "Vertical viewers can't vote yet" shows only when a caller knows.
 */
export function pollTallyView(
  poll: PollStatus,
  nowMs: number,
  { auxiliaryLeg }: { auxiliaryLeg?: boolean } = {}
): PollTallyView {
  const total = poll.options.reduce((sum, option) => sum + Math.max(0, option.votes), 0)
  const leading = new Set(total > 0 ? poll.winners : [])
  const options = poll.options.map((option, index) => {
    const votes = Math.max(0, option.votes)
    const percent = total > 0 ? Math.round((votes / total) * 100) : 0
    return {
      key: String(index + 1),
      label: option.label,
      votes,
      percent,
      percentLabel: `${percent}%`,
      leading: leading.has(index)
    }
  })
  const running = pollRunning(poll)
  const timeLabel =
    poll.state === 'counting'
      ? POLL_COUNTING_LABEL
      : poll.state === 'open'
        ? poll.closesAt
          ? pollTimeLeftLabel(poll.closesAt, nowMs)
          : 'No timer'
        : null
  const winners = options.filter((option) => option.leading).map((option) => option.label)
  const headline =
    poll.state !== 'final'
      ? null
      : winners.length === 0
        ? 'No votes'
        : winners.length === 1
          ? `${winners[0]} wins`
          : `Tie: ${listInWords(winners)}`
  const diagnostics: string[] = []
  if (running) {
    for (const platform of poll.pausedPlatforms) {
      const label = CHAT_PLATFORM_LABELS[platform]
      diagnostics.push(`${label} chat is paused, so ${label} votes aren't counting.`)
    }
    if (auxiliaryLeg === true && !poll.cardLegs.auxiliary) {
      diagnostics.push(POLL_VERTICAL_CANT_VOTE)
    }
    if (!poll.cardAvailable) diagnostics.push(POLL_CARD_UNAVAILABLE)
  }
  const failed = [
    ...new Set([
      ...(poll.startPost?.failedPlatforms ?? []),
      ...(poll.resultPost?.failedPlatforms ?? [])
    ])
  ]
  if (failed.length > 0) {
    diagnostics.push(
      `Couldn't post to ${listInWords(failed.map((platform) => CHAT_PLATFORM_LABELS[platform]))} chat.`
    )
  }
  const reshowReason =
    poll.state !== 'final'
      ? null
      : !poll.cardAvailable
        ? "The poll card can't show on this stream (4K 60 fps)."
        : poll.card === 'shown'
          ? 'The result is on stream now.'
          : null
  return {
    pollId: poll.pollId,
    state: poll.state,
    question: poll.question,
    options,
    totalLabel: plural(total, 'vote'),
    timeLabel,
    platforms: poll.byPlatform
      .filter((entry) => entry.votes > 0)
      .map((entry) => ({
        platform: entry.platform,
        label: CHAT_PLATFORM_LABELS[entry.platform],
        votes: entry.votes
      })),
    headline,
    diagnostics,
    canEnd: poll.state === 'open',
    canCancel: running,
    canReshow: poll.state === 'final' && reshowReason === null,
    reshowReason
  }
}

// --- Folding votes out of the chat list (D5) -----------------------------------

/** `polls.rs` OPEN_SKEW: a vote stamped up to 10 s before the poll opened still counts. */
export const POLL_OPEN_SKEW_MS = 10_000
/** Polls remembered per window for folding; older ones' votes come back. */
const FOLD_WINDOWS_KEPT = 20

/** The time a poll took votes in, for folding. */
export interface PollFoldWindow {
  pollId: string
  sessionId: string
  fromMs: number
  /** `acceptUntil` (or `endedAt`); null while it has no end. */
  untilMs: number | null
  optionCount: number
}

function parsedMs(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function pollFoldWindow(poll: PollStatus): PollFoldWindow | null {
  const opened = parsedMs(poll.openedAt)
  if (opened === null) return null
  return {
    pollId: poll.pollId,
    sessionId: poll.sessionId,
    fromMs: opened - POLL_OPEN_SKEW_MS,
    untilMs: parsedMs(poll.acceptUntil) ?? parsedMs(poll.endedAt),
    optionCount: poll.options.length
  }
}

/**
 * The polls this window has seen, newest last: a poll's latest window
 * replaces its older one, so its end arrives, and a poll that is replaced
 * keeps folding its votes (the rule is time-based and stable, D5).
 */
export function rememberPollWindows(
  windows: readonly PollFoldWindow[],
  poll: PollStatus | null | undefined
): readonly PollFoldWindow[] {
  const window = poll ? pollFoldWindow(poll) : null
  if (!window) return windows
  const kept = windows.filter((candidate) => candidate.pollId !== window.pollId)
  return [...kept, window].slice(-FOLD_WINDOWS_KEPT)
}

type FoldableMessage = Pick<
  LiveChatMessage,
  'sessionId' | 'eventType' | 'authorRoles' | 'messageText' | 'publishedAt' | 'receivedAt'
>

/**
 * D5: a message folds into the poll when the poll's window covers its
 * platform time (`openedAt − 10 s ≤ publishedAt ≤ acceptUntil`, or no end
 * yet), it is a plain message (paid ones always show), it isn't the
 * streamer's own, and its whole text is a vote for one of the poll's options.
 */
export function pollFoldsMessage(message: FoldableMessage, window: PollFoldWindow): boolean {
  if (message.eventType !== 'message') return false
  if (message.sessionId && message.sessionId !== window.sessionId) return false
  if (message.authorRoles.includes('owner')) return false
  if (classifyVote(message.messageText, window.optionCount) === null) return false
  // The platform's time, like the backend: arrival only when it has none.
  const at = parsedMs(message.publishedAt) ?? parsedMs(message.receivedAt)
  if (at === null || at < window.fromMs) return false
  return window.untilMs === null || at <= window.untilMs
}

const NO_FOLDED: ReadonlySet<string> = new Set()

/** The ids the chat list leaves out: votes inside any remembered poll's window. */
export function foldedPollVoteIds(
  messages: readonly (FoldableMessage & Pick<LiveChatMessage, 'id'>)[],
  windows: readonly PollFoldWindow[]
): ReadonlySet<string> {
  if (windows.length === 0) return NO_FOLDED
  const folded = new Set<string>()
  for (const message of messages) {
    if (windows.some((window) => pollFoldsMessage(message, window))) folded.add(message.id)
  }
  return folded.size > 0 ? folded : NO_FOLDED
}
