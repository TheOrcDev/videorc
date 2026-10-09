import type {
  LiveChatMessage,
  ModerationOperation,
  ModerationPhase,
  StreamPlatform
} from './backend'
import { CHAT_PLATFORM_LABELS } from './live-chat-view'
import {
  chatMessageRemovable,
  localRemovalKind,
  moderationOperationTerminal
} from '../../../shared/chat-moderation'

// Chat removal, the renderer's view (plan 140, S6). Everything here is a pure
// derivation of the chat row and the backend's `ModerationOperation`, so the
// row chip, Buddy's removal card, its result line and the main-window toast
// cannot disagree. The backend owns every timer (`confirmBy`, `executeAt`);
// the views only count down to them.

export const REMOVE_FROM_CHAT_LABEL = 'Remove from chat'

// --- The row ---------------------------------------------------------------

export type RemovalStatusKind = 'removing' | 'removed' | 'hidden' | 'failed' | 'unknown'

export const REMOVAL_STATUS_LABELS: Record<RemovalStatusKind, string> = {
  removing: 'Removing…',
  removed: 'Removed',
  hidden: 'Hidden in Videorc',
  failed: 'Not removed',
  unknown: 'Unconfirmed'
}

/** A hidden row's tooltip when the operation that hid it is no longer held. */
export const HIDDEN_IN_VIDEORC_DETAIL = 'Viewers may still see it.'

export interface RemovalStatusView {
  kind: RemovalStatusKind
  label: string
  /** The operation's plain outcome sentence, for the tooltip. */
  detail: string | null
}

function status(kind: RemovalStatusKind, detail: string | null = null): RemovalStatusView {
  return { kind, label: REMOVAL_STATUS_LABELS[kind], detail }
}

/**
 * The row's removal chip. The tombstone is the truth for a finished removal
 * (`Removed by you` or `Hidden in Videorc`); the newest operation for the
 * message says what is in flight or what went wrong. `requesting` is a
 * "Remove from chat" the window sent that no operation answered yet.
 * Null when there is nothing to say: no removal, an open card (the card is
 * the surface), a cancelled or expired one, or a provider's own deletion.
 */
export function removalStatusView(
  message: Pick<LiveChatMessage, 'isDeleted' | 'rawProviderType'>,
  operation?: ModerationOperation | null,
  requesting = false
): RemovalStatusView | null {
  const outcome = operation?.outcome?.trim() || null
  switch (localRemovalKind(message)) {
    case 'removed':
      return status('removed', operation?.phase === 'removed' ? outcome : null)
    case 'hidden':
      return status(
        'hidden',
        (operation?.phase === 'hidden-locally' ? outcome : null) ?? HIDDEN_IN_VIDEORC_DETAIL
      )
    case null:
      break
  }
  switch (operation?.phase) {
    case 'executing':
      return status('removing')
    case 'removed':
      return status('removed', outcome)
    case 'hidden-locally':
      return status('hidden', outcome ?? HIDDEN_IN_VIDEORC_DETAIL)
    case 'failed':
      return status('failed', outcome)
    case 'delivery-unknown':
      return status('unknown', outcome)
    default:
      return requesting ? status('removing') : null
  }
}

/**
 * Whether the row offers "Remove from chat": a removable message with no
 * removal in flight or waiting on a card. A failed, unconfirmed, cancelled or
 * expired removal can be asked for again.
 */
export function removeFromChatAvailable(
  message: Pick<LiveChatMessage, 'eventType' | 'isDeleted' | 'authorRoles' | 'rawProviderType'>,
  operation?: ModerationOperation | null,
  requesting = false
): boolean {
  if (requesting || !chatMessageRemovable(message)) return false
  return !operation || moderationOperationTerminal(operation)
}

// --- Buddy's removal card --------------------------------------------------

export const REMOVAL_CARD_TITLE = 'Remove from chat?'
export const REMOVAL_CARD_REMOVING = 'Removing…'
export const YOUTUBE_CONFIRM_NOTE = 'YouTube asks you to confirm.'

/** Whole seconds until `iso` (never below 0), or null without a valid time. */
export function secondsUntil(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.ceil((at - nowMs) / 1000))
}

export type RemovalAnswer = 'confirm' | 'cancel'

export interface RemovalCardView {
  operationId: string
  platform: StreamPlatform
  platformLabel: string
  authorName: string
  excerpt: string
  reason: string | null
  /** `countdown` removes unless cancelled; `confirm` waits for a yes. */
  mode: 'confirm' | 'countdown'
  title: string
  /** Confirm mode: "Expires in 18s". */
  timer: string | null
  /** "YouTube asks you to confirm." on every YouTube card. */
  note: string | null
  /** Running, or an answer is on its way: the buttons wait. */
  busy: boolean
  /** The button that comes first: Remove when confirming, Cancel when counting down. */
  primary: RemovalAnswer
  confirmLabel: string
}

/**
 * The card for one Buddy voice removal: while it waits for an answer, and
 * while it runs once answered. Manual removals never have a card; the menu
 * click was the consent. YouTube is always confirm-first.
 */
export function removalCardView(
  operation: ModerationOperation,
  nowMs: number,
  answering = false
): RemovalCardView | null {
  if (operation.source !== 'orcle-voice') return null
  if (operation.phase !== 'pending-confirm' && operation.phase !== 'executing') return null
  const countdown = operation.confirmMode === 'countdown' && !operation.requiresExplicitConfirm
  const base = {
    operationId: operation.operationId,
    platform: operation.platform,
    platformLabel: CHAT_PLATFORM_LABELS[operation.platform],
    authorName: operation.authorName,
    excerpt: operation.excerpt.trim(),
    reason: operation.reason?.trim() || null,
    note: operation.platform === 'youtube' ? YOUTUBE_CONFIRM_NOTE : null
  }
  if (operation.phase === 'executing') {
    return {
      ...base,
      mode: countdown ? 'countdown' : 'confirm',
      title: REMOVAL_CARD_REMOVING,
      timer: null,
      busy: true,
      primary: countdown ? 'cancel' : 'confirm',
      confirmLabel: countdown ? 'Remove now' : 'Remove'
    }
  }
  if (countdown) {
    const left = secondsUntil(operation.executeAt, nowMs)
    return {
      ...base,
      mode: 'countdown',
      title: left ? `Removing in ${left}s` : REMOVAL_CARD_REMOVING,
      timer: null,
      busy: answering,
      primary: 'cancel',
      confirmLabel: 'Remove now'
    }
  }
  const left = secondsUntil(operation.confirmBy, nowMs)
  return {
    ...base,
    mode: 'confirm',
    title: REMOVAL_CARD_TITLE,
    timer: left === null ? null : left > 0 ? `Expires in ${left}s` : 'Expiring…',
    busy: answering,
    primary: 'confirm',
    confirmLabel: 'Remove'
  }
}

/** How long a finished card leaves its one-line result behind. */
export const REMOVAL_RESULT_VISIBLE_MS = 6_000

const REMOVAL_RESULT_FALLBACK: Partial<Record<ModerationPhase, string>> = {
  cancelled: 'Cancelled. Nothing was removed.',
  expired: 'No answer. Nothing was removed.',
  removed: 'Removed.',
  'hidden-locally': 'Hidden in Videorc. Viewers may still see it.',
  failed: 'Not removed.',
  'delivery-unknown': 'Check chat to see whether it was removed.'
}

export interface RemovalResultView {
  operationId: string
  platform: StreamPlatform
  authorName: string
  text: string
}

/** The brief line a finished Buddy removal leaves where its card was. */
export function removalResultView(
  operation: ModerationOperation,
  nowMs: number
): RemovalResultView | null {
  if (operation.source !== 'orcle-voice' || !moderationOperationTerminal(operation)) return null
  const endedAt = Date.parse(operation.updatedAt)
  // Recent on either side of now: a skewed stamp never pins the line.
  if (!Number.isFinite(endedAt) || Math.abs(nowMs - endedAt) >= REMOVAL_RESULT_VISIBLE_MS) {
    return null
  }
  const text = operation.outcome?.trim() || REMOVAL_RESULT_FALLBACK[operation.phase]
  if (!text) return null
  return {
    operationId: operation.operationId,
    platform: operation.platform,
    authorName: operation.authorName,
    text
  }
}

export interface RemovalPaneView {
  /** Oldest first: the topmost card is the one Enter and Esc answer. */
  cards: RemovalCardView[]
  /** Newest first, at most three. */
  results: RemovalResultView[]
  /** Something to show: the pane ticks every second while true. */
  active: boolean
}

const EMPTY_ANSWERING: ReadonlySet<string> = new Set()

export function removalPaneView(
  operations: readonly ModerationOperation[],
  nowMs: number,
  answering: ReadonlySet<string> = EMPTY_ANSWERING
): RemovalPaneView {
  const byAge = [...operations].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.operationId.localeCompare(right.operationId)
  )
  const cards = byAge.flatMap((operation) => {
    const card = removalCardView(operation, nowMs, answering.has(operation.operationId))
    return card ? [card] : []
  })
  const results = byAge
    .flatMap((operation) => {
      const result = removalResultView(operation, nowMs)
      return result ? [result] : []
    })
    .reverse()
    .slice(0, 3)
  return { cards, results, active: cards.length > 0 || results.length > 0 }
}

// --- The main window's toast -------------------------------------------------

export interface RemovalToastView {
  title: string
  description: string
  /** sonner's highlighted action button. */
  action: { label: string; answer: RemovalAnswer }
  /** sonner's second (cancel-slot) button. */
  secondary: { label: string; answer: RemovalAnswer }
}

/**
 * The toast that mirrors an open removal card while the Stream Manager is
 * closed: who, which platform, the words, and the same two answers.
 */
export function removalToastView(
  operation: ModerationOperation,
  nowMs: number
): RemovalToastView | null {
  const card = removalCardView(operation, nowMs)
  if (!card || operation.phase !== 'pending-confirm') return null
  const words = card.excerpt ? `${card.platformLabel}: “${card.excerpt}”` : card.platformLabel
  const description = [
    words,
    card.reason ? `Reason: ${card.reason}.` : null,
    card.note,
    card.timer ? `${card.timer}.` : null
  ]
    .filter(Boolean)
    .join(' ')
  if (card.mode === 'countdown') {
    const left = secondsUntil(operation.executeAt, nowMs)
    return {
      title: left
        ? `Removing ${card.authorName}'s message in ${left}s`
        : `Removing ${card.authorName}'s message`,
      description,
      action: { label: 'Cancel', answer: 'cancel' },
      secondary: { label: 'Remove now', answer: 'confirm' }
    }
  }
  return {
    title: `Remove ${card.authorName}'s message?`,
    description,
    action: { label: 'Remove', answer: 'confirm' },
    secondary: { label: 'Cancel', answer: 'cancel' }
  }
}

export interface RemovalOutcomeToast {
  kind: 'success' | 'warning' | 'error' | 'message'
  text: string
}

/**
 * What a finished removal says as a toast. Hidden, unconfirmed and failed
 * always speak: viewers may still see the message. A cancel is never news,
 * the streamer said it. `includeSuccess` adds the plain outcomes (removed,
 * expired) for the main window, where nothing else shows them; the Stream
 * Manager's row already says "Removed".
 */
export function removalOutcomeToast(
  operation: ModerationOperation,
  { includeSuccess }: { includeSuccess: boolean }
): RemovalOutcomeToast | null {
  const text = operation.outcome?.trim() || REMOVAL_RESULT_FALLBACK[operation.phase]
  if (!text) return null
  switch (operation.phase) {
    case 'removed':
      return includeSuccess ? { kind: 'success', text } : null
    case 'hidden-locally':
    case 'delivery-unknown':
      return { kind: 'warning', text }
    case 'failed':
      return { kind: 'error', text }
    case 'expired':
      return includeSuccess ? { kind: 'message', text } : null
    default:
      return null
  }
}
