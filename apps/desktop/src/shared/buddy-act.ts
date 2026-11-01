// Plan 209 S19 and S20: Buddy uses the agent tools. A sentence Buddy's local
// grammar does not know goes to Buddy's planner on videorc.com (contract
// part F), which answers with tool calls from Buddy's subset of the catalog;
// the backend checks every call against the catalog and the subset, runs
// them through the agent tool path as "Buddy" and says what happened.
//
// By voice that is the backend's own path (the wake word, then D14's spoken
// yes before going live or ending what runs). Typed, it is `/buddy <words>`
// in the Stream Manager's composer: no wake word and no spoken yes (typing is
// deliberate). The window relays the words to the Studio, which owns the
// backend socket and the Cloud AI consent, and the Studio makes the
// `cohost.act` call. Pure and schema-free, like sound-commands: the IPC
// schemas live in `electron-ipc-contract`, the RPC ones in
// `backend-rpc-contract`.

import type { CommentsCommandResolution } from './backend'

export const BUDDY_COMMAND = '/buddy'
/** The composer's completion hint (S20). */
export const BUDDY_COMMAND_HINT = ' · Ask Buddy to do something'
/** Contract part F: the planner reads at most this much. */
export const BUDDY_SENTENCE_MAX_CHARS = 500
/** A typed request waits this long for its answer: the planner (3.5 s), then
 * up to three calls, one of which may be going live (60 s). */
export const BUDDY_ACT_RESULT_TIMEOUT_MS = 90_000

/** What a free user reads: the sentence the voice commands use. */
export const BUDDY_PREMIUM_REQUIRED = 'Buddy requires Videorc Premium.'
export const BUDDY_EMPTY_SENTENCE = 'Say what Buddy should do, like /buddy switch to BRB.'
export const BUDDY_TOO_LONG = "That's too long for Buddy. Keep it under 500 characters."
export const BUDDY_ASKING = 'Asking Buddy…'
export const BUDDY_NO_ANSWER = "Buddy didn't answer in time."
export const BUDDY_UNREACHABLE = "The Stream Manager can't reach Videorc right now."

/** `cohost.act` and its `cohost.act.result`: `working` means accepted; the
 * result follows as the event with the same `actId`. */
export type CohostActStatus = 'working' | 'done' | 'refused' | 'unavailable' | 'not-found'

export interface CohostActParams {
  /** The caller's id for this request; the result event carries it. */
  actId: string
  sentence: string
  /** The Studio's Cloud AI consent, as for `cohost.start`. */
  consentToProcessChat: boolean
}

export interface CohostActAnswer {
  actId: string
  status: CohostActStatus
  message: string
}

/** `/buddy <words>` from the composer, relayed to the Studio. */
export interface BuddyActRelayCommand {
  requestId: string
  sentence: string
}

export type BuddyComposerCommand =
  | { kind: 'buddy'; sentence: string }
  | { kind: 'error'; message: string }

/** The words after `/buddy`, or why they can't go: none, or too many. */
export function classifyBuddyCommand(words: string): BuddyComposerCommand {
  const sentence = words.replace(/\s+/g, ' ').trim()
  if (!sentence) return { kind: 'error', message: BUDDY_EMPTY_SENTENCE }
  if ([...sentence].length > BUDDY_SENTENCE_MAX_CHARS) {
    return { kind: 'error', message: BUDDY_TOO_LONG }
  }
  return { kind: 'buddy', sentence }
}

/** True when the answer is final (not `working`). */
export function isFinalActAnswer(answer: CohostActAnswer): boolean {
  return answer.status !== 'working'
}

declare module './backend' {
  interface VideorcApi {
    /** `/buddy <words>` in the Stream Manager (plan 209 S20): relayed to the
     * MAIN renderer, which owns the backend socket and the Cloud AI consent.
     * Resolves to the final answer (what Buddy did, or why not). */
    buddyActFromCommentsWindow: (command: BuddyActRelayCommand) => Promise<CohostActAnswer>
    onBuddyActRequest: (callback: (command: BuddyActRelayCommand) => void) => () => void
    pushBuddyActResult: (resolution: CommentsCommandResolution<CohostActAnswer>) => Promise<boolean>
  }
}
