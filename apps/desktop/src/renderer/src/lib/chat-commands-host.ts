// Plan 226: chat commands' work in the main window, whatever page is in
// front. The Studio provider loads this chunk when its backend connection
// comes up and hands the connection over; the store reads the list on it and
// follows its events. The host keeps the Stream Manager's copy (the enabled
// commands and the replies that couldn't go out), posts the streamer's `!go`
// from its composer, and opens the section when its ⋯ menu asks.

import type { CommentsCommandResolution } from '@/lib/backend'
import { userErrorMessage } from '@/lib/user-error'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import {
  chatCommandsSummary,
  type ChatCommandPostResult,
  type ChatCommandRelayCommand,
  type ChatCommandReplyFailed,
  type ChatCommandsSummary
} from '../../../shared/chat-commands'
import type { ChatCommandsClient, ChatCommandsStore } from './chat-commands-store'
import { chatCommandsStore } from './chat-commands-store'

type HostApi = {
  pushCommentsChatCommands?: (summary: ChatCommandsSummary | null) => Promise<boolean>
  pushChatCommandFailures?: (failures: ChatCommandReplyFailed[]) => Promise<boolean>
  onChatCommandRequest?: (callback: (command: ChatCommandRelayCommand) => void) => () => void
  pushChatCommandResult?: (
    resolution: CommentsCommandResolution<ChatCommandPostResult>
  ) => Promise<boolean>
  onOpenChatCommands?: (callback: () => void) => () => void
}

export interface ChatCommandsHostDeps {
  api: HostApi | undefined
  /** Opens Livestream → Setup, where the section is. */
  openSetup: () => void
}

const browserDeps = (): ChatCommandsHostDeps => ({
  api: window.videorc,
  openSetup: () => openWorkspaceTab('live', 'setup')
})

/** The words the composer shows when a `!go` post couldn't run at all. */
export function chatCommandPostError(error: unknown, name: string): string {
  return userErrorMessage(error, { action: 'post', object: `the !${name} reply` }).text
}

/** Starts the host; the returned function stops it. */
export function startChatCommandsHost(
  store: ChatCommandsStore,
  deps: ChatCommandsHostDeps = browserDeps()
): () => void {
  let pushedSummary: string | undefined
  let pushedFailures: string | undefined
  const sync = (): void => {
    const snapshot = store.getSnapshot()
    const summary = snapshot.state ? chatCommandsSummary(snapshot.state) : null
    const summaryBody = JSON.stringify(summary)
    if (summaryBody !== pushedSummary) {
      pushedSummary = summaryBody
      void deps.api?.pushCommentsChatCommands?.(summary)?.catch(() => undefined)
    }
    const failuresBody = JSON.stringify(snapshot.failures)
    if (failuresBody !== pushedFailures) {
      pushedFailures = failuresBody
      void deps.api?.pushChatCommandFailures?.([...snapshot.failures])?.catch(() => undefined)
    }
  }
  const off = store.subscribe(sync)
  sync()
  // The streamer's `!go` in the Stream Manager: the reply to every chat that
  // takes posts (D9); the counts, or why not, go back to the window.
  const offRequest = deps.api?.onChatCommandRequest?.(({ requestId, sessionId, name }) => {
    const client = store.client()
    void (
      client
        ? client.requestTyped('chatCommands.post', { sessionId, name })
        : Promise.reject(new Error("Videorc's engine isn't connected."))
    ).then(
      (value) => deps.api?.pushChatCommandResult?.({ requestId, ok: true, value }),
      (error: unknown) =>
        deps.api?.pushChatCommandResult?.({
          requestId,
          ok: false,
          error: chatCommandPostError(error, name)
        })
    )
  })
  // ⋯ Chat commands…: main has shown this window; the section scrolls itself
  // into view once it is on screen.
  const offOpen = deps.api?.onOpenChatCommands?.(() => {
    store.requestReveal()
    deps.openSetup()
  })
  return () => {
    off()
    offRequest?.()
    offOpen?.()
  }
}

const started = new WeakSet<ChatCommandsStore>()

/** A backend connection came up: chat commands read and follow it. */
export function attachChatCommands(
  client: ChatCommandsClient,
  store: ChatCommandsStore = chatCommandsStore,
  deps?: ChatCommandsHostDeps
): void {
  if (!started.has(store)) {
    started.add(store)
    startChatCommandsHost(store, deps)
  }
  store.connect(client)
}
