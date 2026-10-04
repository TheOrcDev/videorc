import { createElement } from 'react'

import type { BackendClient } from '@/backendClient'
import type {
  CommentsModerationCommand,
  CommentsWindowState,
  ModerationOperation,
  VideorcApi
} from '@/lib/backend'
import {
  removalOutcomeToast,
  removalToastView,
  type RemovalAnswer,
  type RemovalOutcomeToast,
  type RemovalToastView
} from '@/lib/chat-removal-view'
import { toast } from '@/lib/toast'
import {
  COMMENTS_MODERATION_TIMING_CONTRACT,
  mergeModerationOperations,
  moderationOperationOpen,
  moderationOperationTerminal,
  relayedModerationOperations
} from '../../../shared/chat-moderation'

// Chat removals, Studio's half (plan 140, S6). A lazy chunk: the main
// window's eager bundle carries only the import and the event hand-off.
//
// - The ledger: the live session's `ModerationOperation`s, seeded from
//   `liveChat.moderationOperations.list` and kept current by the
//   `liveChat.moderationOperation` event. Every change is published into the
//   Stream Manager's snapshot (`CommentsViewSnapshot.moderationOperations`).
// - The relay: the Stream Manager's "Remove from chat" and its card answers
//   arrive as `comments-window:moderation-request`. A removal always goes to
//   the backend as `source: 'manual'`, whatever asked.
// - The toast: an open Orcle removal card is mirrored as a plain toast in the
//   main window while the Stream Manager is closed or hidden, and it leaves
//   when the operation ends. Nothing here ever removes on its own.

type ModerationClient = Pick<BackendClient, 'requestTyped'>

type RelayApi = Partial<
  Pick<
    VideorcApi,
    | 'onModerationRequest'
    | 'pushModerationResult'
    | 'getCommentsWindowState'
    | 'onCommentsWindowState'
  >
>

/** How the main window shows a removal card and its outcome (sonner by default). */
export interface RemovalToastSurface {
  show: (id: string, view: RemovalToastView, onAnswer: (answer: RemovalAnswer) => void) => void
  dismiss: (id: string) => void
  outcome: (id: string, outcome: RemovalOutcomeToast) => void
  error: (id: string, message: string) => void
}

export interface ChatModerationRelayOptions {
  client: ModerationClient
  /** The live chat session the Stream Manager shows, read when needed. */
  sessionId: () => string | null | undefined
  /** Puts the session's removals into the Stream Manager's snapshot. */
  publish: (operations: ModerationOperation[]) => void
  /** Seams for tests; the defaults are `window.videorc`, sonner and the clock. */
  api?: RelayApi
  surface?: RemovalToastSurface
  now?: () => number
  schedule?: (run: () => void) => void
}

export interface ChatModerationRelay {
  /** One `liveChat.moderationOperation` event. */
  feed: (operation: ModerationOperation) => void
  /** The live chat session changed (or ended). */
  session: (sessionId: string | null | undefined) => void
  dispose: () => void
}

// Loaded in the same chunk: answers to Orcle's voice command cards.
export { startCohostCommandRelay } from '@/lib/cohost-command-relay'

export const REMOVAL_TOAST_ID_PREFIX = 'chat-removal:'

/** The card's toast, and a separate one for what became of it: sonner may
 * still be animating the card out when the outcome arrives. */
export function removalToastId(operationId: string, part: 'card' | 'outcome' = 'card'): string {
  return `${REMOVAL_TOAST_ID_PREFIX}${operationId}${part === 'card' ? '' : ':outcome'}`
}

/** The Stream Manager can show the card itself: open and on screen. */
export function commentsWindowShowsRemovalCards(
  state: Pick<CommentsWindowState, 'open' | 'visible'> | null | undefined
): boolean {
  return Boolean(state?.open && state.visible)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function sonnerSurface(): RemovalToastSurface {
  return {
    show: (id, view, onAnswer) => {
      // A viewer's words are user content, not provider text: they render as
      // React text, never through the toast text guard, which would swallow
      // a message with braces in it.
      toast(createElement('span', { 'data-slot': 'removal-toast-title' }, view.title), {
        id,
        description: createElement('span', { 'data-slot': 'removal-toast-text' }, view.description),
        duration: Number.POSITIVE_INFINITY,
        // Answer or let it end: the backend expires or runs it within 20 s.
        dismissible: false,
        closeButton: false,
        action: { label: view.action.label, onClick: () => onAnswer(view.action.answer) },
        cancel: { label: view.secondary.label, onClick: () => onAnswer(view.secondary.answer) }
      })
    },
    dismiss: (id) => {
      toast.dismiss(id)
    },
    outcome: (id, outcome) => {
      const show = outcome.kind === 'message' ? toast : toast[outcome.kind]
      show(outcome.text, { id })
    },
    error: (id, message) => {
      toast.error(message, { id })
    }
  }
}

export function startChatModerationRelay(options: ChatModerationRelayOptions): ChatModerationRelay {
  const { client } = options
  const api: RelayApi = options.api ?? globalThis.window?.videorc ?? {}
  const surface = options.surface ?? sonnerSurface()
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((run: () => void) => void setTimeout(run, 0))
  const timing = COMMENTS_MODERATION_TIMING_CONTRACT

  let disposed = false
  let currentSession: string | null = null
  let operations: ModerationOperation[] = []
  let seedGeneration = 0
  let publishQueued = false
  let windowShowsCards = false
  /** Open cards mirrored as a toast right now. */
  const toasted = new Set<string>()
  /** Cards the streamer answered from the toast: never shown again. */
  const answered = new Set<string>()
  let ticker: ReturnType<typeof setInterval> | null = null

  const publish = (): void => {
    if (publishQueued || disposed) return
    publishQueued = true
    schedule(() => {
      publishQueued = false
      if (!disposed) options.publish(relayedModerationOperations(operations, currentSession))
    })
  }

  const stopTicker = (): void => {
    if (ticker !== null) clearInterval(ticker)
    ticker = null
  }

  const syncToasts = (): void => {
    if (disposed) return
    const nowMs = now()
    let counting = false
    for (const operation of operations) {
      const { operationId } = operation
      const id = removalToastId(operationId)
      const open = moderationOperationOpen(operation)
      if (open && !windowShowsCards && !answered.has(operationId)) {
        const view = removalToastView(operation, nowMs)
        if (!view) continue
        surface.show(id, view, (answer) => answerFromToast(operationId, answer))
        toasted.add(operationId)
        counting = true
        continue
      }
      if (!toasted.has(operationId)) continue
      if (moderationOperationTerminal(operation)) {
        // It ended out of view: say how, unless the streamer cancelled it.
        toasted.delete(operationId)
        surface.dismiss(id)
        const outcome = removalOutcomeToast(operation, { includeSuccess: true })
        if (outcome) surface.outcome(removalToastId(operationId, 'outcome'), outcome)
      } else if (open && windowShowsCards) {
        // The Stream Manager came up: its card takes over, result included.
        toasted.delete(operationId)
        surface.dismiss(id)
      }
      // Answered here and still waiting on the backend: keep it, so its
      // outcome speaks once it ends.
    }
    if (counting && ticker === null) ticker = setInterval(syncToasts, 1_000)
    if (!counting) stopTicker()
  }

  const accept = (incoming: readonly ModerationOperation[]): void => {
    const own = incoming.filter((operation) => operation.sessionId === currentSession)
    if (own.length === 0) return
    operations = relayedModerationOperations(
      mergeModerationOperations(operations, own),
      currentSession
    )
    publish()
    syncToasts()
  }

  const answerRequest = (
    operationId: string,
    answer: RemovalAnswer
  ): Promise<ModerationOperation> =>
    answer === 'confirm'
      ? client.requestTyped(
          'liveChat.moderation.confirm',
          { operationId },
          { timeoutMs: timing.backendRequestMs }
        )
      : client.requestTyped(
          'liveChat.moderation.cancel',
          { operationId },
          { timeoutMs: timing.backendRequestMs }
        )

  function answerFromToast(operationId: string, answer: RemovalAnswer): void {
    answered.add(operationId)
    void answerRequest(operationId, answer)
      .then((operation) => accept([operation]))
      .catch((error: unknown) =>
        surface.error(
          removalToastId(operationId, 'outcome'),
          errorMessage(error, 'Could not answer the removal.')
        )
      )
  }

  const syncSession = (sessionId: string | null | undefined): void => {
    const next = sessionId ?? null
    if (next === currentSession) return
    currentSession = next
    operations = []
    for (const operationId of toasted) surface.dismiss(removalToastId(operationId))
    toasted.clear()
    answered.clear()
    stopTicker()
    publish()
    if (!next) return
    const generation = ++seedGeneration
    void client
      .requestTyped('liveChat.moderationOperations.list', { sessionId: next })
      .then((listed) => {
        if (!disposed && generation === seedGeneration && currentSession === next) accept(listed)
      })
      .catch(() => undefined)
  }

  /** The Stream Manager's command, run against the backend. A lost reply is
   * not a lost removal: the ledger answers for it. */
  const run = async (command: CommentsModerationCommand): Promise<ModerationOperation> => {
    syncSession(options.sessionId())
    if (command.sessionId !== currentSession) {
      throw new Error('That chat view is no longer the active livestream.')
    }
    try {
      if (command.action === 'remove') {
        return await client.requestTyped(
          'liveChat.moderation.request',
          { operationId: command.operationId, messageId: command.messageId, source: 'manual' },
          { timeoutMs: timing.backendRequestMs }
        )
      }
      return await answerRequest(command.operationId, command.action)
    } catch (error) {
      const reconciled = await client
        .requestTyped(
          'liveChat.moderationOperations.list',
          { sessionId: command.sessionId },
          { timeoutMs: timing.reconciliationMs }
        )
        .then((listed) => listed.find((operation) => operation.operationId === command.operationId))
        .catch(() => undefined)
      // A refused answer leaves the card where it was: say why. Anything
      // that did move (it ran, expired, or was answered elsewhere) is the
      // truthful reply.
      if (reconciled && (command.action === 'remove' || !moderationOperationOpen(reconciled))) {
        return reconciled
      }
      throw error
    }
  }

  const offRequest = api.onModerationRequest?.((command) => {
    void run(command)
      .then(async (operation) => {
        accept([operation])
        await api.pushModerationResult?.({
          requestId: command.requestId,
          ok: true,
          value: operation
        })
      })
      .catch(async (error: unknown) => {
        await api.pushModerationResult?.({
          requestId: command.requestId,
          ok: false,
          error: errorMessage(error, 'Could not remove the message.')
        })
      })
      .catch(() => undefined)
  })

  const noteWindow = (state: CommentsWindowState | null | undefined): void => {
    const next = commentsWindowShowsRemovalCards(state)
    if (next === windowShowsCards) return
    windowShowsCards = next
    syncToasts()
  }
  void api
    .getCommentsWindowState?.()
    .then(noteWindow)
    .catch(() => undefined)
  const offWindow = api.onCommentsWindowState?.(noteWindow)

  syncSession(options.sessionId())

  return {
    feed: (operation) => {
      if (disposed) return
      syncSession(options.sessionId())
      accept([operation])
    },
    session: (sessionId) => {
      if (!disposed) syncSession(sessionId)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stopTicker()
      offRequest?.()
      offWindow?.()
      for (const operationId of toasted) surface.dismiss(removalToastId(operationId))
      toasted.clear()
    }
  }
}
