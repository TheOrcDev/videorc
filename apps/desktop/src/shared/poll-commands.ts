import {
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_CHARS,
  POLL_QUESTION_MAX_CHARS,
  type PollStatus
} from './backend'
import type { ComposerCompletion } from './banner-commands'

// Plan 188 S5: `/poll` in the Stream Manager composer. Like `/banner` it is a
// local command and never reaches a chat: `/poll` opens the Poll popover,
// `/poll Question? A | B` starts a poll at once, `/poll end` and
// `/poll cancel` act on the running one. Pure, so the composer, its tests and
// the docs agree on one grammar.

/** What `/poll` asks the Stream Manager to do. */
export type PollComposerAction =
  | { action: 'open' }
  | { action: 'start'; question: string; options: string[] }
  | { action: 'end' }
  | { action: 'cancel' }

/** The usage line for anything `/poll` can't read. */
export const POLL_COMMAND_USAGE = 'Use /poll Question? Option | Option (2–5 options).'
/** The backend's own refusals (plan 188 seams), word for word. */
export const POLL_QUESTION_REFUSAL = 'Ask a question (up to 60 characters).'
export const POLL_OPTIONS_REFUSAL = 'Add 2 to 5 answers (up to 25 characters each).'
export const POLL_DUPLICATE_REFUSAL = 'Each answer must be different.'

/** Characters as the backend counts them: Unicode code points, trimmed. */
export function pollTextLength(text: string): number {
  return [...text.trim()].length
}

/** Case and outer spaces don't make two answers different. */
export function pollOptionKey(option: string): string {
  return option.trim().toLocaleLowerCase()
}

/**
 * The words after `/poll`: nothing opens the popover, `end` and `cancel` act
 * on the running poll, and anything else must read as a question up to and
 * including its first `?`, then 2–5 answers split on `|`.
 */
export function classifyPollCommand(
  query: string
): { kind: 'poll'; poll: PollComposerAction } | { kind: 'error'; message: string } {
  const typed = query.trim()
  if (!typed) return { kind: 'poll', poll: { action: 'open' } }
  const word = typed.toLowerCase()
  if (word === 'end') return { kind: 'poll', poll: { action: 'end' } }
  if (word === 'cancel') return { kind: 'poll', poll: { action: 'cancel' } }
  const mark = typed.indexOf('?')
  if (mark < 0) return { kind: 'error', message: POLL_COMMAND_USAGE }
  const question = typed.slice(0, mark + 1).trim()
  const options = typed
    .slice(mark + 1)
    .split('|')
    .map((option) => option.trim())
    .filter(Boolean)
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return { kind: 'error', message: POLL_COMMAND_USAGE }
  }
  // "?" alone is no question.
  if (pollTextLength(question) < 2 || pollTextLength(question) > POLL_QUESTION_MAX_CHARS) {
    return { kind: 'error', message: POLL_QUESTION_REFUSAL }
  }
  if (options.some((option) => pollTextLength(option) > POLL_OPTION_MAX_CHARS)) {
    return { kind: 'error', message: POLL_OPTIONS_REFUSAL }
  }
  if (new Set(options.map(pollOptionKey)).size !== options.length) {
    return { kind: 'error', message: POLL_DUPLICATE_REFUSAL }
  }
  return { kind: 'poll', poll: { action: 'start', question, options } }
}

const POLL_COMMAND = /^\/poll\s+([\s\S]*)$/i

/**
 * The completions under `/poll ` (plan 188 S5): `/poll end` while the poll
 * takes votes, `/poll cancel` while it runs, once a letter of either is typed,
 * so `/poll` and Enter still opens the popover. Null when the draft isn't
 * `/poll` with words after it; an empty list when nothing fits (a question
 * being written gets none).
 */
export function pollCompletions(
  draft: string,
  poll: Pick<PollStatus, 'state'> | null | undefined
): ComposerCompletion[] | null {
  const command = POLL_COMMAND.exec(draft.trimStart())
  if (!command) return null
  const typed = command[1].trim().toLowerCase()
  if (!typed || /[\s?|]/.test(typed)) return []
  const completions: ComposerCompletion[] = []
  if (poll?.state === 'open' && 'end'.startsWith(typed)) {
    completions.push({ value: '/poll end', hint: ' · End the poll now' })
  }
  if ((poll?.state === 'open' || poll?.state === 'counting') && 'cancel'.startsWith(typed)) {
    completions.push({ value: '/poll cancel', hint: ' · Cancel the poll' })
  }
  return completions
}
