import type { PollStatus } from '@/lib/backend'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { UserFacingError, type UserErrorContext } from '@/lib/user-error'
import type { PollRelayAction } from '../../../shared/poll-relay'

// Plan 188: the poll actions every surface shares (the Stream Manager relay,
// ⌘K and the remotes) and the backend's refusals. Pure: no React, no backend
// client beyond the one passed in.

/**
 * The backend's refusals, verbatim (plan 188 seams). Each one is "can't now",
 * so it shows as a warning with this sentence, never as an error or the
 * generic next step (plan 174 S2.4).
 */
export const POLL_REFUSALS: readonly string[] = [
  'Go live to start a poll.',
  "No chat is connected, so there's nobody to vote.",
  'End the current poll first.',
  'Ask a question (up to 60 characters).',
  'Add 2 to 5 answers (up to 25 characters each).',
  'Each answer must be different.',
  'Pick a duration between 15 seconds and 1 hour, or No timer.'
]

/** Said by a remote or ⌘K when there is no poll to act on. */
export const NO_POLL_REASON = 'No poll is running.'

/** `polls.overlay.set` for a card that already hid: a normal race, never shown. */
export const POLL_CARD_NOT_SHOWING = "This poll's card isn't showing."

/** The refusal sentence a failed `polls.*` call carries, or null for any other failure. */
export function pollRefusal(error: unknown): string | null {
  const raw = ipcErrorMessage(error)
  return POLL_REFUSALS.find((sentence) => raw.includes(sentence)) ?? null
}

/**
 * A failed action as the error `toastUserError` reads: a refusal keeps its own
 * sentence, as a warning; anything else stays as it is, for the usual copy.
 */
export function pollActionError(error: unknown): unknown {
  const sentence = pollRefusal(error)
  return sentence ? new UserFacingError(sentence, 'warning') : error
}

/** The verb and object a failed action names: "Couldn't end the poll". */
export function pollActionContext(action: PollRelayAction['action']): UserErrorContext {
  switch (action) {
    case 'start':
      return { action: 'start', object: 'the poll' }
    case 'end':
      return { action: 'end', object: 'the poll' }
    case 'cancel':
      return { action: 'cancel', object: 'the poll' }
    case 'reshow':
      return { action: 'show', object: 'the poll result' }
  }
}

/** Whether a poll still takes votes: End and Cancel apply. */
export function pollIsRunning(poll: PollStatus | null | undefined): poll is PollStatus {
  return poll?.state === 'open' || poll?.state === 'counting'
}

type PollActionClient = { request<T>(method: string, params?: unknown): Promise<T> }

/**
 * One poll action on Studio's backend connection. Resolves the backend's
 * reply, or rejects with its error (a refusal's sentence as it is), so the
 * relay can carry the sentence back to the window that asked.
 */
export function runPollAction(
  client: PollActionClient,
  action: PollRelayAction
): Promise<PollStatus> {
  if (action.action === 'start') return client.request<PollStatus>('polls.start', action.params)
  return client.request<PollStatus>(`polls.${action.action}`, { pollId: action.pollId })
}

const STATE_RANK: Record<PollStatus['state'], number> = {
  open: 0,
  counting: 1,
  final: 2,
  cancelled: 2
}

/**
 * Studio's poll after an RPC reply. `polls.status` events are the truth and
 * arrive on the same socket, so a reply only moves the poll forward: a new
 * poll, or a later state of this one. An equal state keeps what the events
 * said (their tally may be newer than the reply's).
 */
export function pollAfterReply(current: PollStatus | null, reply: PollStatus): PollStatus | null {
  if (!current) return reply
  if (current.pollId !== reply.pollId) {
    // A start replaces whatever is here unless the events already moved to
    // a poll opened after it (an unreadable time counts as newer).
    return Date.parse(reply.openedAt) < Date.parse(current.openedAt) ? current : reply
  }
  return STATE_RANK[reply.state] > STATE_RANK[current.state] ? reply : current
}
