import type { CohostQuestion, CohostState } from './backend'
import { cohostErrorDetail, cohostErrorDetailText, cohostReasonLabel } from './cohost-view'

// Co-host presence (W2). One pure derivation of `cohost.state` that every
// surface renders: the Comments window header, the pane's segment header and
// the Studio session panel. Presence is UNCONDITIONAL — a null or off-shaped
// state is a state ("Co-host off"), never an absence.
//
// Color discipline (videorc-design): the live accent is earned ONLY by an
// engine that is actually listening; destructive red ONLY by a real error.
// Everything else is monochrome chrome.

export type CohostPresenceKind =
  | 'off'
  | 'starting'
  | 'listening'
  | 'reading'
  | 'thinking'
  | 'paused'
  | 'error'

export interface CohostPresenceView {
  kind: CohostPresenceKind
  /** The one-line label next to the dot. */
  label: string
  dotTone: 'muted' | 'live' | 'destructive'
  /** Heartbeat: the engine is doing something the user cannot see yet. */
  pulse: boolean
  /** Three-dot "typing" shimmer — the chat-app affordance for "working on it". */
  dots: boolean
  /** Tooltip body, one fact per line; empty when there is nothing honest to say. */
  tooltipLines: string[]
  /** Open questions the streamer has not answered or dismissed. */
  openCount: number
  /** New questions since the pane was collapsed; absent when there are none. */
  unreadBadge?: number
}

export interface CohostPresenceOptions {
  /**
   * The renderer asked the engine to start (entitled + consented + enabled with
   * a live chat session) but no listening state has arrived yet. Only the
   * caller knows this — the wire state still reads `off`.
   */
  starting?: boolean
  /** Unread question count from the pane's collapse reducer. */
  unread?: number
}

/** "12s ago", "4m ago", "2h ago" — compact enough for a dense tooltip line. */
export function cohostAgoLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/** "~7s" / "~2m" — the scheduler's earliest next pass, never a false promise. */
export function cohostNextPassLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const seconds = Math.round((at - nowMs) / 1000)
  if (seconds <= 0) return 'any moment'
  if (seconds < 60) return `~${seconds}s`
  return `~${Math.round(seconds / 60)}m`
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

function presenceKind(
  state: CohostState | null,
  options: CohostPresenceOptions
): CohostPresenceKind {
  if (!state || state.status === 'off') return options.starting ? 'starting' : 'off'
  if (state.status === 'error') return 'error'
  if (state.status === 'paused') return 'paused'
  // Listening. Thinking outranks reading: a tick is already carrying whatever
  // was pending, so "thinking…" is the truthful newer fact.
  if (state.tickInFlight === true) return 'thinking'
  if (nonNegative(state.pendingMessages) > 0) return 'reading'
  return 'listening'
}

function presenceLabel(
  kind: CohostPresenceKind,
  state: CohostState | null,
  openCount: number
): string {
  switch (kind) {
    case 'off':
      return 'Co-host off'
    case 'starting':
      return 'Co-host starting'
    case 'reading': {
      const pending = nonNegative(state?.pendingMessages)
      return `Co-host · reading ${pending} new…`
    }
    case 'thinking':
      return 'Co-host · thinking…'
    case 'listening':
      return openCount > 0 ? `Co-host · ${openCount} q` : 'Co-host listening'
    case 'paused': {
      const reason = cohostReasonLabel(state?.reason ?? null)
      return reason ? `Co-host paused · ${reason}` : 'Co-host paused'
    }
    case 'error':
      return 'Co-host error'
  }
}

function presenceTooltip(
  kind: CohostPresenceKind,
  state: CohostState | null,
  openCount: number,
  nowMs: number
): string[] {
  const lines: string[] = []
  if (kind === 'off') {
    lines.push('Co-host is off. It reads live chat, groups questions and drafts replies.')
  }
  if (kind === 'starting') {
    lines.push('Co-host is starting — waiting for the first pass.')
  }

  const lastPass = cohostAgoLabel(state?.lastTickAt ?? null, nowMs)
  if (lastPass) lines.push(`last pass ${lastPass}`)

  const seen = nonNegative(state?.messagesSeen)
  if (seen > 0) lines.push(`${seen} ${plural(seen, 'message')} read`)

  const total = nonNegative(state?.questionsTotal)
  if (total > 0) {
    lines.push(`${total} ${plural(total, 'question')} found (${openCount} open)`)
  } else if (openCount > 0) {
    lines.push(`${openCount} ${plural(openCount, 'question')} open`)
  }

  const nextPass = cohostNextPassLabel(state?.nextTickAt ?? null, nowMs)
  if (nextPass) lines.push(`next pass in ${nextPass}`)

  if (state?.partial === true) lines.push('Chat outran one AI pass; the newest messages were used.')

  // The failed tick in the server's own words — the one thing a streamer can
  // paste into a bug report. Only ever shown on a state that actually failed.
  if (kind === 'error' || kind === 'paused') {
    const detail = cohostErrorDetailText(cohostErrorDetail(state))
    if (detail) lines.push(detail)
  }

  return lines
}

/**
 * The single presence derivation. `now` drives the relative tooltip copy, so a
 * caller that ticks a clock every second gets honest "last pass"/"next pass"
 * lines without the view layer owning any time logic.
 */
export function cohostPresenceView(
  state: CohostState | null,
  now: number,
  options: CohostPresenceOptions = {}
): CohostPresenceView {
  const kind = presenceKind(state, options)
  const openCount = state?.questions.length ?? 0
  const unread = nonNegative(options.unread)
  return {
    kind,
    label: presenceLabel(kind, state, openCount),
    dotTone:
      kind === 'error'
        ? 'destructive'
        : kind === 'listening' || kind === 'reading' || kind === 'thinking'
          ? 'live'
          : 'muted',
    pulse: kind === 'starting' || kind === 'thinking',
    dots: kind === 'reading' || kind === 'thinking',
    tooltipLines: presenceTooltip(kind, state, openCount, now),
    openCount,
    ...(unread > 0 ? { unreadBadge: unread } : {})
  }
}

/** The pane's empty-state copy: static "Listening —" upgrades to real work. */
export function cohostEmptyStateCopy(view: CohostPresenceView, state: CohostState | null): string {
  if (view.kind === 'reading') {
    const pending = nonNegative(state?.pendingMessages)
    return `Reading ${pending} new ${plural(pending, 'message')}…`
  }
  if (view.kind === 'thinking') return 'Thinking about the last batch…'
  if (view.kind === 'listening') return 'Listening — questions from chat will appear here.'
  if (view.kind === 'starting') return 'Starting — questions from chat will appear here.'
  return 'Questions from chat will appear here once co-host is listening again.'
}

/**
 * The one-shot delta flash after a tick landed: "grouped 2 questions". Shown
 * for ~2s in place of the count so the streamer SEES the pass do something,
 * even when the open count nets out unchanged.
 *
 * Requires a real newer tick — an action result (same `tickSeq`) or a state for
 * a different session never flashes.
 */
export function cohostGroupedDeltaFlash(
  previous: CohostState | null,
  next: CohostState
): string | null {
  if (!previous) return null
  if (previous.sessionId !== next.sessionId) return null
  if (next.tickSeq <= previous.tickSeq) return null
  const known = new Set(previous.questions.map((question) => question.id))
  const added = next.questions.filter((question) => !known.has(question.id)).length
  if (added <= 0) return null
  return `grouped ${added} ${plural(added, 'question')}`
}

/** Question ids in a stable shape for the unread reducer and the toast. */
export function cohostQuestionIds(state: CohostState | null): string[] {
  return (state?.questions ?? []).map((question: CohostQuestion) => question.id)
}
