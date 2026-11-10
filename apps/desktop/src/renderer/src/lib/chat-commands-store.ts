// Plan 226: chat commands, kept outside React like the soundboard. The Studio
// provider hands each backend connection to the host (chat-commands-host.ts),
// which connects it here; Livestream → Setup → Chat commands reads and edits
// through `use-chat-commands`. A lazy chunk: the eager bundle only imports
// the host on connect.

import type { BackendClient } from '@/backendClient'
import type { ChatCommandReplyFailed, ChatCommandsState } from '../../../shared/chat-commands'

/** The part of the backend client chat commands use. */
export type ChatCommandsClient = Pick<BackendClient, 'requestTyped' | 'on'>

/** The most failures one live chat session keeps (one per chat and reason). */
export const CHAT_COMMAND_FAILURES_MAX = 20

/** The section's element id, so the Stream Manager's door can scroll to it. */
export const CHAT_COMMANDS_SECTION_ID = 'chat-commands'

export interface ChatCommandsSnapshot {
  /** Null until `chatCommands.list` first answers: never "No commands yet" before. */
  state: ChatCommandsState | null
  /** The list couldn't be read on this connection, and nothing has arrived since. */
  loadFailed: boolean
  /** Studio's backend connection is up. */
  online: boolean
  /** Replies that couldn't go out in the newest live chat session: one per chat and reason. */
  failures: readonly ChatCommandReplyFailed[]
  /** The Stream Manager asked for the section; it scrolls there once and says so. */
  revealPending: boolean
}

export interface ChatCommandsStore {
  getSnapshot: () => ChatCommandsSnapshot
  subscribe: (listener: () => void) => () => void
  /** Studio's backend client while it is connected. */
  client: () => ChatCommandsClient | null
  /** A connection came up: follow its events and read the list on it. */
  connect: (client: ChatCommandsClient) => void
  /** Reads the list again on the current connection (after a failed read). */
  reload: () => void
  /** Every mutation answers with the whole state; so does `chatCommands.changed`. */
  acceptState: (state: ChatCommandsState) => void
  acceptReplyFailed: (failure: ChatCommandReplyFailed) => void
  requestReveal: () => void
  revealHandled: () => void
}

const NO_FAILURES: readonly ChatCommandReplyFailed[] = []

/** One notice per chat and reason in a session; a new session starts over. */
export function nextChatCommandFailures(
  current: readonly ChatCommandReplyFailed[],
  failure: ChatCommandReplyFailed
): readonly ChatCommandReplyFailed[] {
  const sameSession = current.filter((entry) => entry.sessionId === failure.sessionId)
  if (
    sameSession.some(
      (entry) => entry.destinationId === failure.destinationId && entry.reason === failure.reason
    )
  ) {
    return current
  }
  return [...sameSession, failure].slice(-CHAT_COMMAND_FAILURES_MAX)
}

export function createChatCommandsStore(): ChatCommandsStore {
  const listeners = new Set<() => void>()
  let snapshot: ChatCommandsSnapshot = {
    state: null,
    loadFailed: false,
    online: false,
    failures: NO_FAILURES,
    revealPending: false
  }
  let current: ChatCommandsClient | null = null
  let detach: (() => void) | null = null
  // Bumped by every state that arrives, so a `chatCommands.list` answer older
  // than a `chatCommands.changed` never wins.
  let stateRevision = 0

  const publish = (next: Partial<ChatCommandsSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const acceptState = (state: ChatCommandsState): void => {
    stateRevision += 1
    publish({ state, loadFailed: false })
  }
  const acceptReplyFailed = (failure: ChatCommandReplyFailed): void => {
    const failures = nextChatCommandFailures(snapshot.failures, failure)
    if (failures !== snapshot.failures) publish({ failures })
  }
  const disconnect = (client: ChatCommandsClient): void => {
    if (current !== client) return
    current = null
    detach?.()
    detach = null
    publish({ online: false })
  }
  const read = (client: ChatCommandsClient): void => {
    const revision = stateRevision
    client.requestTyped('chatCommands.list').then(
      (state) => {
        if (current === client && revision === stateRevision) acceptState(state)
      },
      (error: unknown) => {
        console.warn('[chat-commands] list read failed:', error)
        if (current === client && revision === stateRevision) publish({ loadFailed: true })
      }
    )
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    client: () => current,
    connect: (client) => {
      if (current === client) return
      if (current) disconnect(current)
      current = client
      const offs = [
        client.on('chatCommands.changed', acceptState),
        client.on('chatCommands.replyFailed', acceptReplyFailed),
        client.on('connection.closed', () => disconnect(client))
      ]
      detach = () => offs.forEach((off) => off())
      publish({ online: true })
      read(client)
    },
    reload: () => {
      if (!current) return
      publish({ loadFailed: false })
      read(current)
    },
    acceptState,
    acceptReplyFailed,
    requestReveal: () => publish({ revealPending: true }),
    revealHandled: () => {
      if (snapshot.revealPending) publish({ revealPending: false })
    }
  }
}

/** The app's one store: the host connects it, the section reads it. */
export const chatCommandsStore = createChatCommandsStore()
