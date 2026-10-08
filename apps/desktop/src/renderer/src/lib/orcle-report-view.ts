import type {
  ClipMoment,
  ClipMomentSource,
  CohostAlertKind,
  CohostReportChat,
  CohostReportCommands,
  CohostReportPayload,
  CohostReportQuestion,
  CohostReportQuestions,
  CohostSessionReport,
  SessionSummary,
  StreamPlatform
} from './backend'
import { cohostAskersLabel } from './cohost-view'
import { dayLabel, durationMsLabel } from './format'
import { CHAT_PLATFORM_LABELS } from './live-chat-view'
import { formatClipMarkClock } from '../../../shared/clip-marks'

// The Golem tab's stream report (plan 119 S3): what Golem caught in one
// stream, from `cohost.report.get` / `cohost.report.latest`. Everything here
// is a pure derivation of that payload and the Library's session row, so the
// card and its tests cannot disagree about a count.

/** The website's line for the report, word for word (plan 119 S5). */
export const ORCLE_REPORT_DESCRIPTION =
  'Golem saves a short report on your computer: questions caught and missed, flags, promises, first-timers greeted, and the moments you marked by saying clip that.'

export const ORCLE_REPORT_EMPTY = 'The report appears here after your first stream with Golem.'
export const ORCLE_REPORT_OFF = 'Golem was off for this stream.'
export const ORCLE_REPORT_TURN_ON = 'Turn on Golem to also catch questions.'
export const ORCLE_REPORT_NEXT_STREAM = 'It joins your next stream.'
export const ORCLE_REPORT_UNTITLED = 'Untitled stream'

/** The empty Reports tab's heading (plan 150), over `ORCLE_REPORT_EMPTY`. */
export const ORCLE_REPORT_EMPTY_TITLE = 'No stream reports yet'

/**
 * The backend names an unnamed session after its start, "Session 2026-10-02
 * 14:55" (`session_title` in recording.rs). The report's picker already names
 * the stream by that time, so the heading repeats it only for a real title
 * (plan 150, D10).
 */
export function isAutoSessionTitle(title: string): boolean {
  return /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(title.trim())
}

/** Rows a list shows before "Show all". */
export const ORCLE_REPORT_LIST_CAP = 5
/** Streams the switcher offers, newest first. */
export const ORCLE_REPORT_SWITCHER_LIMIT = 20

const COUNT = new Intl.NumberFormat()

export function formatReportCount(value: number): string {
  return COUNT.format(Math.max(0, Math.round(value)))
}

export interface OrcleReportStat {
  id:
    | 'questions'
    | 'answered-on-air'
    | 'replied'
    | 'missed'
    | 'flags'
    | 'promises-kept'
    | 'promises-open'
    | 'first-timers'
    | 'on-screen'
  value: string
  /** The whole the value is out of ("of 3 first-timers"), shown muted. */
  of?: string
  label: string
}

export interface OrcleReportPlatform {
  platform: StreamPlatform
  messages: number
  /** "Twitch: 60 messages", for the icon's tooltip and screen readers. */
  label: string
}

export interface OrcleReportChatView {
  messages: number
  /** "84 chat messages", "No chat messages". */
  label: string
  /** Busiest first, one entry per platform. */
  platforms: OrcleReportPlatform[]
}

export interface OrcleReportQuestionRow {
  id: string
  text: string
  /** "Ada +2", empty when nobody was named. */
  askers: string
  /** Every name, for the tooltip. */
  askersTitle: string
  platforms: StreamPlatform[]
  high: boolean
  /** Time into the stream ("12:04"), or null when unknown. */
  at: string | null
}

export interface OrcleReportPromiseRow {
  key: string
  text: string
  at: string | null
}

export interface OrcleReportMomentRow {
  key: string
  kind: ClipMomentSource
  label: string
  excerpt: string
  /** "4:35–5:12" in recording time. */
  range: string
}

export interface OrcleReportAlertRow {
  key: string
  kind: CohostAlertKind
  label: string
  /** "3 viewers": the most who said it at once. */
  viewers: string
  at: string | null
}

export interface OrcleReportSessionOption {
  id: string
  title: string
  /** The session's start, as Library shows it. */
  date: string
}

/** One count of the report's "Commands" row (plan 140 S3). */
export interface OrcleReportCommandCount {
  id:
    | 'highlighted'
    | 'cleared'
    | 'removed'
    | 'hidden-locally'
    | 'cancelled'
    | 'expired'
    | 'failed'
    | 'not-found'
  value: string
  label: string
}

/** The report's "Commands" row: what voice commands did, counts only. */
export interface OrcleReportCommandsView {
  /** "6 commands", "1 command". */
  total: string
  /** The non-zero counts, in a fixed order. */
  counts: OrcleReportCommandCount[]
}

export type OrcleReportView =
  | { kind: 'empty'; message: string }
  | {
      /** `orcle-off`: the stream left chat and moments, but no report. */
      kind: 'report' | 'orcle-off'
      sessionId: string
      title: string
      date: string | null
      duration: string | null
      chat: OrcleReportChatView
      /** Empty when Golem was off. */
      stats: OrcleReportStat[]
      /** Golem-off only: why nothing was caught, and what to do about it. */
      note: { title: string; hint: string } | null
      missed: OrcleReportQuestionRow[]
      promises: OrcleReportPromiseRow[]
      moments: OrcleReportMomentRow[]
      alerts: OrcleReportAlertRow[]
      /** Plan 140 S3: null when no voice command was counted (or Golem was off). */
      commands: OrcleReportCommandsView | null
    }

export interface OrcleReportViewInput {
  /** The backend's answer; null when no stream exists yet. */
  payload: CohostReportPayload | null
  /** The Library row of the payload's session, when the loaded list has it. */
  session: Pick<SessionSummary, 'id' | 'title' | 'startedAt' | 'durationMs'> | null
  /** Golem Live's stored switch, for what the Golem-off note asks for. */
  orcleOn: boolean
}

// --- Questions ---------------------------------------------------------------

export interface OrcleQuestionTally {
  caught: number
  answeredOnAir: number
  replied: number
  missed: number
}

/**
 * The question totals the card shows. While the log holds every question its
 * outcomes are the truth (a restore undoes an answer, a counter cannot);
 * past its 200-question cap the counters decide. Missed means still open at
 * the end: a question shown on stream was handled.
 */
export function questionTally(questions: CohostReportQuestions): OrcleQuestionTally {
  const items = questions.items ?? []
  const outcomes = (outcome: CohostReportQuestion['outcome']): number =>
    items.filter((item) => item.outcome === outcome).length
  if (items.length >= questions.total) {
    return {
      caught: items.length,
      answeredOnAir: outcomes('answered-on-air'),
      replied: outcomes('replied'),
      missed: outcomes('open')
    }
  }
  const closed =
    questions.answeredOnAir +
    questions.replied +
    questions.markedAnswered +
    questions.dismissed +
    questions.shownOnStream -
    questions.restored
  const unanswered = Math.min(questions.total, Math.max(0, questions.total - closed))
  return {
    caught: questions.total,
    answeredOnAir: questions.answeredOnAir,
    replied: questions.replied,
    missed: Math.max(outcomes('open'), unanswered)
  }
}

/** The questions still open at the end, first seen first. */
export function missedQuestions(questions: CohostReportQuestions): CohostReportQuestion[] {
  return (questions.items ?? []).filter((item) => item.outcome === 'open')
}

function uniquePlatforms(platforms: readonly StreamPlatform[] | undefined): StreamPlatform[] {
  return [...new Set(platforms ?? [])]
}

// --- Chat ----------------------------------------------------------------------

export function chatMessagesLabel(messages: number): string {
  if (messages <= 0) return 'No chat messages'
  return messages === 1 ? '1 chat message' : `${formatReportCount(messages)} chat messages`
}

/** One entry per platform (an older backend could repeat one), busiest first,
 * platforms without a message left out. */
export function reportPlatforms(chat: CohostReportChat): OrcleReportPlatform[] {
  const totals = new Map<StreamPlatform, number>()
  for (const entry of chat.byPlatform) {
    totals.set(entry.platform, (totals.get(entry.platform) ?? 0) + Math.max(0, entry.messages))
  }
  return [...totals]
    .filter(([, messages]) => messages > 0)
    .sort(([left, a], [right, b]) => b - a || left.localeCompare(right))
    .map(([platform, messages]) => ({
      platform,
      messages,
      label: `${CHAT_PLATFORM_LABELS[platform] ?? platform}: ${
        messages === 1 ? '1 message' : `${formatReportCount(messages)} messages`
      }`
    }))
}

// --- Moments -------------------------------------------------------------------

/** An older backend omits the source; that moment is a chat peak. */
export function momentKind(moment: Pick<ClipMoment, 'source'>): ClipMomentSource {
  return moment.source ?? 'chat'
}

export const ORCLE_MOMENT_VOICE_LABEL = "You said 'clip that'"
export const ORCLE_MOMENT_MANUAL_LABEL = 'Marked'

/** Marks say who placed them; a chat peak keeps the backend's reason. A voice
 * mark keeps its own phrase ("You said 'clip it'"). */
export function momentLabel(moment: Pick<ClipMoment, 'source' | 'reason'>): string {
  const reason = moment.reason.trim()
  switch (momentKind(moment)) {
    case 'voice':
      return reason || ORCLE_MOMENT_VOICE_LABEL
    case 'manual':
      return ORCLE_MOMENT_MANUAL_LABEL
    case 'chat':
      return reason || 'Chat got busy'
  }
}

/** "4:35–5:12", recording time; one clock when the range is empty. */
export function formatMomentRange(startMs: number, endMs: number): string {
  const start = formatClipMarkClock(startMs / 1000)
  return endMs > startMs ? `${start}–${formatClipMarkClock(endMs / 1000)}` : start
}

/** The streamer's marks first, then chat peaks, each in recording order. */
export function reportMoments(moments: readonly ClipMoment[]): OrcleReportMomentRow[] {
  const rank = (moment: ClipMoment): number => (momentKind(moment) === 'chat' ? 1 : 0)
  return [...moments]
    .sort((left, right) => rank(left) - rank(right) || left.startMs - right.startMs)
    .map((moment, index) => ({
      key: `${index}-${momentKind(moment)}-${moment.startMs}`,
      kind: momentKind(moment),
      label: momentLabel(moment),
      excerpt: moment.excerpt.trim(),
      range: formatMomentRange(moment.startMs, moment.endMs)
    }))
}

// --- Alerts --------------------------------------------------------------------

const ALERT_LABELS: Record<CohostAlertKind, string> = {
  audio: 'Chat said: no audio',
  video: 'Chat said: video problem',
  'stream-health': 'Chat said: stream is lagging',
  game: 'Chat said: game problem',
  other: 'Chat said: something was wrong'
}

export function reportAlertLabel(kind: CohostAlertKind): string {
  return ALERT_LABELS[kind] ?? ALERT_LABELS.other
}

// --- Time ----------------------------------------------------------------------

/** How far into the stream `at` was ("12:04"); null when either time is unreadable. */
export function streamOffsetLabel(at: string, startedAt: string | null): string | null {
  if (!startedAt) return null
  const atMs = Date.parse(at)
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(atMs) || !Number.isFinite(startMs)) return null
  return formatClipMarkClock(Math.max(0, atMs - startMs) / 1000)
}

function reportSpanMs(report: CohostSessionReport | null): number | undefined {
  if (!report) return undefined
  const span = Date.parse(report.endedAt) - Date.parse(report.startedAt)
  return Number.isFinite(span) && span > 0 ? span : undefined
}

// --- Stats ---------------------------------------------------------------------

function reportStats(report: CohostSessionReport): OrcleReportStat[] {
  const tally = questionTally(report.questions)
  const greetings = report.greetings
  return [
    { id: 'questions', value: formatReportCount(tally.caught), label: 'Questions caught' },
    {
      id: 'answered-on-air',
      value: formatReportCount(tally.answeredOnAir),
      label: 'Answered on air'
    },
    { id: 'replied', value: formatReportCount(tally.replied), label: 'Replied' },
    { id: 'missed', value: formatReportCount(tally.missed), label: 'Missed' },
    { id: 'flags', value: formatReportCount(report.flags.raised), label: 'Flags' },
    { id: 'promises-kept', value: formatReportCount(report.promises.kept), label: 'Promises kept' },
    {
      id: 'promises-open',
      value: formatReportCount(report.promises.open?.length ?? 0),
      label: 'Promises open'
    },
    {
      id: 'first-timers',
      value: formatReportCount(greetings.firstTimersGreeted),
      of: formatReportCount(greetings.firstTimers),
      label: 'First-timers greeted'
    },
    { id: 'on-screen', value: formatReportCount(report.shownOnStream), label: 'On screen' }
  ]
}

// --- Voice commands (plan 140 S3) -------------------------------------------------

const COMMAND_COUNT_LABELS: ReadonlyArray<
  [OrcleReportCommandCount['id'], keyof CohostReportCommands, string]
> = [
  ['highlighted', 'highlighted', 'Highlighted'],
  ['cleared', 'cleared', 'Cleared'],
  ['removed', 'removed', 'Removed'],
  ['hidden-locally', 'hiddenLocally', 'Hidden in Videorc'],
  ['cancelled', 'cancelled', 'Cancelled'],
  ['expired', 'expired', 'No answer'],
  ['failed', 'failed', 'Failed'],
  ['not-found', 'notFound', 'Not found']
]

/** The "Commands" row: the non-zero counts in a fixed order, null when none. */
export function reportCommands(
  commands: CohostReportCommands | undefined
): OrcleReportCommandsView | null {
  if (!commands) return null
  const counts = COMMAND_COUNT_LABELS.map(([id, key, label]) => ({
    id,
    count: Math.max(0, Math.round(commands[key])),
    label
  })).filter((entry) => entry.count > 0)
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  if (total === 0) return null
  return {
    total: total === 1 ? '1 command' : `${formatReportCount(total)} commands`,
    counts: counts.map(({ id, count, label }) => ({ id, value: formatReportCount(count), label }))
  }
}

// --- The card ------------------------------------------------------------------

export function orcleReportView({
  payload,
  session,
  orcleOn
}: OrcleReportViewInput): OrcleReportView {
  if (!payload) return { kind: 'empty', message: ORCLE_REPORT_EMPTY }
  const report = payload.report
  const startedAt = session?.startedAt ?? report?.startedAt ?? null
  const durationMs = session?.durationMs ?? reportSpanMs(report)
  const platforms = reportPlatforms(payload.chat)
  const chat: OrcleReportChatView = {
    messages: payload.chat.messages,
    label: chatMessagesLabel(payload.chat.messages),
    platforms
  }
  const base = {
    sessionId: payload.sessionId,
    title: report?.streamTitle?.trim() || session?.title.trim() || ORCLE_REPORT_UNTITLED,
    date: startedAt ? dayLabel(startedAt) : null,
    duration: typeof durationMs === 'number' ? durationMsLabel(durationMs) : null,
    chat,
    moments: reportMoments(payload.moments)
  }
  if (!report) {
    return {
      ...base,
      kind: 'orcle-off',
      stats: [],
      note: {
        title: ORCLE_REPORT_OFF,
        hint: orcleOn ? ORCLE_REPORT_NEXT_STREAM : ORCLE_REPORT_TURN_ON
      },
      missed: [],
      promises: [],
      alerts: [],
      commands: null
    }
  }
  return {
    ...base,
    kind: 'report',
    stats: reportStats(report),
    note: null,
    missed: missedQuestions(report.questions).map((question) => ({
      id: question.id,
      text: question.text,
      askers: cohostAskersLabel(question.askers ?? []),
      askersTitle: (question.askers ?? []).join(', '),
      platforms: uniquePlatforms(question.platforms),
      high: question.priority === 'high',
      at: streamOffsetLabel(question.firstSeenAt, startedAt)
    })),
    promises: (report.promises.open ?? []).map((promise, index) => ({
      key: `${index}-${promise.firstSeenAt}`,
      text: promise.text,
      at: streamOffsetLabel(promise.firstSeenAt, startedAt)
    })),
    alerts: (report.alerts ?? []).map((alert, index) => ({
      key: `${index}-${alert.kind}`,
      kind: alert.kind,
      label: reportAlertLabel(alert.kind),
      viewers:
        alert.peakViewers === 1 ? '1 viewer' : `${formatReportCount(alert.peakViewers)} viewers`,
      at: streamOffsetLabel(alert.firstSeenAt, startedAt)
    })),
    commands: reportCommands(report.commands)
  }
}

// --- Lists and the switcher -----------------------------------------------------

/** The first `cap` rows unless expanded, and how many stay behind "Show all". */
export function capReportList<T>(
  items: readonly T[],
  expanded: boolean,
  cap: number = ORCLE_REPORT_LIST_CAP
): { visible: readonly T[]; hidden: number } {
  if (expanded || items.length <= cap) return { visible: items, hidden: 0 }
  return { visible: items.slice(0, cap), hidden: items.length - cap }
}

type SwitchableSession = Pick<SessionSummary, 'id' | 'title' | 'startedAt' | 'mode' | 'status'>

/** A stream that ended: it went out live (`stream`, `record+stream`, or an
 * older row's `streaming`) and is not the one running now, whose report is
 * only saved when it stops. */
export function isReportableStream(session: Pick<SessionSummary, 'mode' | 'status'>): boolean {
  return session.mode.includes('stream') && session.status !== 'running'
}

function recentStreams(sessions: readonly SwitchableSession[]): SwitchableSession[] {
  return sessions
    .filter(isReportableStream)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, ORCLE_REPORT_SWITCHER_LIMIT)
}

/** The stream "Last stream" means: the newest one that ended. Null while the
 * loaded Library holds none (the card then asks `cohost.report.latest`). */
export function newestStreamedSessionId(sessions: readonly SwitchableSession[]): string | null {
  return recentStreams(sessions)[0]?.id ?? null
}

/** What the switcher lists: recent streams, newest first, plus the shown one
 * when the loaded Library page does not reach it. */
export function reportSessionOptions(
  sessions: readonly SwitchableSession[],
  shown: OrcleReportSessionOption | null
): OrcleReportSessionOption[] {
  const options = recentStreams(sessions).map((session) => ({
    id: session.id,
    title: session.title.trim() || ORCLE_REPORT_UNTITLED,
    date: dayLabel(session.startedAt)
  }))
  if (shown && !options.some((option) => option.id === shown.id)) options.push(shown)
  return options
}

/** Picking the newest stream follows "Last stream" again (null), so the next
 * stream that ends takes its place; any other pick holds that session. */
export function reportSessionChoice(sessionId: string, newestId: string | null): string | null {
  return sessionId === newestId ? null : sessionId
}
