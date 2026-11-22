// Plan 250: the notification center's rules, all pure. What pops up, what the
// number counts, how two reports on one subject merge, flapping, and how long
// the list keeps things. The store applies them; the tables in
// `policy.test.ts` are the plan's tables.

import { NOTIFICATION_KINDS } from '@/lib/notifications/kinds'
import type {
  NotificationAction,
  NotificationCount,
  NotificationEntry,
  NotificationTone
} from '@/lib/notifications/types'

/** Cleared and back inside this window is the same episode. */
export const FLAP_WINDOW_MS = 60_000
/** A subject pops up again only after this long of being fine. */
export const REALERT_AFTER_MS = 5 * 60_000
export const MAX_ENTRIES = 50
export const URGENT_POP_UP_MS = 15_000
export const POP_UP_MS = 8_000
export const PRESS_ANSWER_POP_UP_MS = 4_000
/** A recovery that replaces a toast still showing. */
export const RECOVERY_POP_UP_MS = 4_000
/**
 * The first minute of a run (a launch, or a reload that rebuilds the list):
 * what Videorc finds on its own waits behind the bell. The owner, 2026-11-22:
 * "the first thing you see is a bunch of toasts".
 */
export const LAUNCH_QUIET_MS = 60_000

const TONE_RANK: Record<NotificationTone, number> = { done: 0, news: 1, warning: 2, urgent: 3 }

export function toneRank(tone: NotificationTone): number {
  return TONE_RANK[tone]
}

export function worseTone(a: NotificationTone, b: NotificationTone): NotificationTone {
  return TONE_RANK[b] > TONE_RANK[a] ? b : a
}

export interface NotificationReport {
  source: string
  tone: NotificationTone
  title: string
  detail?: string
  actions: NotificationAction[]
  /** The watchdog's report: it has the live clock and the one-press fix. */
  lead: boolean
  at: number
  onClear?: () => void
}

export interface MergedReports {
  tone: NotificationTone
  title: string
  detail?: string
  actions: NotificationAction[]
}

/**
 * Two systems reporting one subject make one entry. The worse tone wins. The
 * leading report gives the words and the first buttons; the others only keep
 * the entry open, and fill a free button slot.
 */
export function mergeReports(reports: readonly NotificationReport[]): MergedReports | null {
  if (reports.length === 0) return null
  const ordered = [...reports].sort(
    (a, b) =>
      Number(b.lead) - Number(a.lead) || TONE_RANK[b.tone] - TONE_RANK[a.tone] || b.at - a.at
  )
  const head = ordered[0]
  const actions: NotificationAction[] = []
  for (const report of ordered) {
    for (const action of report.actions) {
      if (actions.length >= 2) break
      if (actions.some((taken) => taken.label === action.label)) continue
      actions.push(action)
    }
  }
  return {
    tone: ordered.reduce<NotificationTone>((tone, report) => worseTone(tone, report.tone), 'done'),
    title: head.title,
    detail: head.detail,
    actions
  }
}

/**
 * What just happened to the entry.
 * - `opened`: a new entry, or finished work arriving.
 * - `escalated`: an open entry got worse (warning to urgent).
 * - `updated`: new words on an open entry.
 * - `flapped`: cleared and back within 60 s: the same episode.
 * - `returned`: back after longer than that: a new episode.
 * - `repeated`: an event happened again.
 */
export type NotificationChange =
  | 'opened'
  | 'escalated'
  | 'updated'
  | 'flapped'
  | 'returned'
  | 'repeated'

export interface PopUpQuestion {
  change: NotificationChange
  tone: NotificationTone
  answersAPress?: boolean
  /** News told once outside a session: it pops up like an answer, but never at launch. */
  announcement?: boolean
  /** Inside the first minute of this run (`LAUNCH_QUIET_MS`). */
  launching?: boolean
  /** The streamer has pressed something in this run: a click, a key, a shortcut. */
  pressed?: boolean
  popUpMs?: number
  hasDetail: boolean
  /** A recording or a livestream runs. */
  live: boolean
  /** "Quiet while recording or live" is on. */
  quiet: boolean
  listOpen: boolean
  now: number
  /** The last time this subject popped up, and how bad it was then. */
  lastPop?: { at: number; tone: NotificationTone }
  /** `returned`: how long the subject had been fine. */
  fineForMs?: number
}

/** How long the entry pops up as a toast, or null for the bell only. */
export function popUpDecision(question: PopUpQuestion): number | null {
  if (question.listOpen) return null
  if (question.change === 'updated' || question.change === 'flapped') return null
  // At launch nothing Videorc checked on its own pops up: devices, accounts,
  // updates, quotas, memory, a recovered take, the engine starting. Only the
  // answer to a press, or an urgent problem in a recording or livestream the
  // streamer started, speaks.
  if (question.launching) {
    if (!question.pressed) return null
    if (question.answersAPress) return pressAnswerMs(question)
    return question.tone === 'urgent' && question.live ? URGENT_POP_UP_MS : null
  }
  if (question.answersAPress || question.announcement) {
    return pressAnswerMs(question)
  }
  if (question.tone === 'news') return null
  const { lastPop } = question
  if (
    lastPop &&
    (question.change === 'returned' || question.change === 'repeated') &&
    TONE_RANK[question.tone] <= TONE_RANK[lastPop.tone]
  ) {
    const fineFor =
      question.change === 'returned'
        ? (question.fineForMs ?? 0)
        : Math.max(0, question.now - lastPop.at)
    if (fineFor < REALERT_AFTER_MS) return null
  }
  // A problem that swings between warning and urgent already popped up as
  // urgent: getting that bad again inside the window is not news.
  if (
    lastPop &&
    question.change === 'escalated' &&
    TONE_RANK[question.tone] <= TONE_RANK[lastPop.tone] &&
    question.now - lastPop.at < REALERT_AFTER_MS
  ) {
    return null
  }
  if (question.tone === 'urgent') return URGENT_POP_UP_MS
  if (question.live && question.quiet) return null
  return POP_UP_MS
}

function pressAnswerMs(question: Pick<PopUpQuestion, 'popUpMs' | 'hasDetail'>): number {
  return question.popUpMs ?? (question.hasDetail ? POP_UP_MS : PRESS_ANSWER_POP_UP_MS)
}

/** Still true: an open problem, or work in progress. The list's "Now" group. */
export function isNow(entry: Pick<NotificationEntry, 'state'>): boolean {
  return entry.state === 'open' || entry.state === 'running'
}

/**
 * The number is what waits for you: unread urgent and warning entries, and
 * unread finished work. News never counts, except an announcement: it waits
 * behind the bell at launch, so the number is how it is seen. A warning that
 * cleared on its own stops counting; an urgent problem that cleared counts
 * until it is seen.
 */
export function countsAsUnread(
  entry: Pick<NotificationEntry, 'read' | 'state' | 'tone' | 'peakTone'> &
    Partial<Pick<NotificationEntry, 'kind'>>
): boolean {
  if (entry.read) return false
  switch (entry.state) {
    case 'open':
      return entry.tone === 'urgent' || entry.tone === 'warning'
    case 'resolved':
      return entry.peakTone === 'urgent'
    case 'happened':
      return (
        entry.tone !== 'news' ||
        (entry.kind !== undefined && NOTIFICATION_KINDS[entry.kind].announcement === true)
      )
    case 'running':
      return false
    case 'done':
    case 'failed':
      return true
  }
}

/** The bell: the number, and the tone of the worst problem still open. */
export function notificationCount(entries: readonly NotificationEntry[]): NotificationCount {
  let unread = 0
  let urgent = 0
  let warning = false
  for (const entry of entries) {
    if (countsAsUnread(entry)) unread += 1
    // A problem that happened once (the stream stopped) tints the bell until
    // it has been seen; a condition tints it for as long as it is open.
    const stillWrong =
      entry.state === 'open' ||
      ((entry.state === 'happened' || entry.state === 'failed') && !entry.read)
    if (!stillWrong) continue
    if (entry.tone === 'urgent') urgent += 1
    else if (entry.tone === 'warning') warning = true
  }
  return { unread, urgent, tone: urgent > 0 ? 'urgent' : warning ? 'warning' : null }
}

/** "Now" first (urgent, then warnings, then the rest, then work), then newest first. */
export function sortEntries(entries: readonly NotificationEntry[]): NotificationEntry[] {
  const group = (entry: NotificationEntry): number =>
    entry.state === 'open' ? 3 - TONE_RANK[entry.tone] : entry.state === 'running' ? 4 : 5
  return [...entries].sort(
    (a, b) => group(a) - group(b) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)
  )
}

/**
 * The keys to drop so the list keeps its newest 50. Open problems and work
 * in progress are never dropped; the oldest of the rest go first.
 */
export function entriesToDrop(
  entries: readonly NotificationEntry[],
  max: number = MAX_ENTRIES
): string[] {
  const over = entries.length - max
  if (over <= 0) return []
  return entries
    .filter((entry) => !isNow(entry))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, over)
    .map((entry) => entry.key)
}

/** "38 s", "2 min", "1 h 5 min": how long a problem lasted. */
export function spanWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** A repeat says so in the detail and never adds a second row. */
export function repeatWords(occurrences: number): string | undefined {
  if (occurrences < 2) return undefined
  return occurrences === 2 ? 'Twice.' : `${occurrences} times.`
}

export function cameBackWords(comebacks: number): string | undefined {
  if (comebacks < 1) return undefined
  return comebacks === 1 ? 'Came back once.' : `Came back ${comebacks} times.`
}

/** Sentences joined with one space, skipping the missing ones. */
export function joinSentences(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length > 0 ? present.join(' ') : undefined
}

export type SessionEndReason = 'livestream' | 'recording'

export function sessionEndedWords(reason: SessionEndReason): string {
  return reason === 'livestream' ? 'Ended with the livestream.' : 'Ended with the recording.'
}
