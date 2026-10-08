import type {
  CohostCommand,
  CohostCommandAvailability,
  CohostCommandStatus,
  CohostCommandTarget,
  RemoveConfirmMode,
  StreamPlatform
} from './backend'
import { CHAT_PLATFORM_LABELS } from './live-chat-view'
import { secondsUntil } from './chat-removal-view'

// Golem voice commands, the renderer's view (plan 140, S6 part B). A pure
// derivation of `CohostState.command` (contract part B): the strip that says
// what Golem heard and did, the chooser when several comments fit, and the
// "show it anyway?" card for a comment Golem flagged. A removal's card is the
// moderation operation's (part A), never a second card here.

/** How long a finished command stays in the strip, counted from `command.at`. */
export const COMMAND_STRIP_VISIBLE_MS = 6_000
/** The strip's last stretch, when it fades. */
export const COMMAND_STRIP_FADE_MS = 1_000

const OPEN_STATUSES: ReadonlySet<CohostCommandStatus> = new Set(['ambiguous', 'confirm'])
const QUIET_STATUSES: ReadonlySet<CohostCommandStatus> = new Set([
  'not-found',
  'refused',
  'unavailable'
])

export interface CommandStripView {
  commandId: string
  /** "Heard: “orcle highlight the comment from coders x”". */
  heard: string
  message: string
  /** Not found, refused, unavailable: secondary text, never an alarm. */
  quiet: boolean
  /** In its last second: the strip fades out. */
  fading: boolean
}

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : null
}

/**
 * The command strip: what Golem heard, then what it did. An open command
 * (a chooser or a card) stays while it waits; a finished one fades
 * `COMMAND_STRIP_VISIBLE_MS` after it reached its status.
 */
export function commandStripView(
  command: CohostCommand | null | undefined,
  nowMs: number
): CommandStripView | null {
  if (!command) return null
  const heard = command.heard.trim()
  const message = command.message.trim()
  if (!heard && !message) return null
  const open = OPEN_STATUSES.has(command.status)
  const at = parseTime(command.at)
  let fading = false
  if (!open) {
    if (at === null) return null
    const age = nowMs - at
    // A skewed stamp on either side never pins the strip.
    if (Math.abs(age) >= COMMAND_STRIP_VISIBLE_MS) return null
    fading = age >= COMMAND_STRIP_VISIBLE_MS - COMMAND_STRIP_FADE_MS
  }
  return {
    commandId: command.id,
    heard: heard ? `Heard: “${heard}”` : '',
    message,
    quiet: QUIET_STATUSES.has(command.status),
    fading
  }
}

function timerLabel(expiresAt: string | undefined, nowMs: number): string | null {
  const left = secondsUntil(expiresAt, nowMs)
  if (left === null) return null
  return left > 0 ? `Expires in ${left}s` : 'Expiring…'
}

export interface CommandCandidateView {
  index: number
  /** The key that picks it: "1" to "3". */
  key: string
  authorName: string
  platform: StreamPlatform
  platformLabel: string
  excerpt: string
}

export interface CommandChooserView {
  commandId: string
  title: string
  candidates: CommandCandidateView[]
  timer: string | null
}

export const COMMAND_CHOOSER_TITLE = 'Which comment?'

/** The chooser for an ambiguous command: up to three comments, 1 to 3. */
export function commandChooserView(
  command: CohostCommand | null | undefined,
  nowMs: number
): CommandChooserView | null {
  if (!command || command.status !== 'ambiguous') return null
  const candidates = (command.candidates ?? []).slice(0, 3)
  if (candidates.length === 0) return null
  return {
    commandId: command.id,
    title: command.message.trim() || COMMAND_CHOOSER_TITLE,
    candidates: candidates.map((candidate, index) => ({
      index,
      key: String(index + 1),
      authorName: candidate.authorName,
      platform: candidate.platform,
      platformLabel: CHAT_PLATFORM_LABELS[candidate.platform],
      excerpt: candidate.excerpt.trim()
    })),
    timer: timerLabel(command.expiresAt, nowMs)
  }
}

export interface CommandConfirmView {
  commandId: string
  /** "Golem flagged this (harassment). Show it anyway?" */
  title: string
  target: (CohostCommandTarget & { platformLabel: string }) | null
  timer: string | null
  /** Answered, waiting on the backend: the buttons wait. */
  busy: boolean
}

/**
 * The card for a highlight of a comment Golem flagged. A removal in `confirm`
 * has its moderation card (part A), so it never gets this one; a removal card
 * without `operationId` is still opening and shows nothing yet.
 */
export function commandConfirmView(
  command: CohostCommand | null | undefined,
  nowMs: number,
  answering = false
): CommandConfirmView | null {
  if (!command || command.status !== 'confirm' || command.kind !== 'highlight') return null
  if (command.operationId) return null
  const target = command.target
    ? { ...command.target, platformLabel: CHAT_PLATFORM_LABELS[command.target.platform] }
    : null
  return {
    commandId: command.id,
    title: command.message.trim(),
    target,
    timer: timerLabel(command.expiresAt, nowMs),
    busy: answering || !command.expiresAt
  }
}

/** What waits for the streamer: a chooser or a card, or nothing. */
export function openCommandCardId(
  command: CohostCommand | null | undefined,
  nowMs: number
): string | null {
  return commandChooserView(command, nowMs) || commandConfirmView(command, nowMs)
    ? (command?.id ?? null)
    : null
}

// --- The Golem tab's settings and kill switches -------------------------------

export const VOICE_COMMANDS_PAUSED = 'Voice commands are paused by Videorc.'
export const REMOVING_MESSAGES_PAUSED = 'Removing messages is paused by Videorc.'

/** The kill-switch lines (contract part D), in the order a streamer reads them. */
export function commandAvailabilityLines(
  availability: CohostCommandAvailability | null | undefined
): string[] {
  if (!availability) return []
  return [
    ...(availability.voiceCommands === 'paused' ? [VOICE_COMMANDS_PAUSED] : []),
    ...(availability.remove === 'paused' ? [REMOVING_MESSAGES_PAUSED] : [])
  ]
}

export const WAKE_WORD_LABEL = 'Commands need “Golem” first'
export const WAKE_WORD_DESCRIPTION =
  'Off: “remove it from our chat” and “highlight the comment from coders X” also work without the name.'

export const REMOVE_CONFIRM_LABELS: Record<RemoveConfirmMode, string> = {
  confirm: 'Confirm first',
  countdown: '5-second countdown'
}

export const REMOVE_CONFIRM_DESCRIPTIONS: Record<RemoveConfirmMode, string> = {
  confirm: 'A card asks first. Say “yes” or press Enter.',
  countdown: 'Removes after 5 seconds unless you say “no” or press Esc.'
}

export const YOUTUBE_ALWAYS_CONFIRMS = 'YouTube always asks you to confirm.'

/** The numbers line, in the mode's own terms. */
export function removalLimitsLine(mode: RemoveConfirmMode | null | undefined): string {
  return mode === 'countdown'
    ? 'A removal runs after 5 seconds unless you cancel; on YouTube it waits 20 seconds for your answer. At most 10 removals a minute.'
    : 'A removal waits 20 seconds for your answer, then nothing is removed. At most 10 removals a minute.'
}
