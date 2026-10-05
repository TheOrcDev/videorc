import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import ReactDOM from 'react-dom/client'
import { toast } from '@/lib/toast'

import { AppErrorBoundary } from '@/components/error-boundary'
import { StreamManager } from '@/components/stream-manager/stream-manager'
import { removeMessagesReconnectStarted } from '@/components/stream-manager/remove-messages-reconnect'
import { WindowFrame } from '@/components/window-frame'
import type {
  CohostActionKind,
  CohostQuestion,
  CohostState,
  CohostWindowState,
  CommentHighlightAnchor,
  CommentHighlightState,
  CommentsSendOperation,
  CommentsViewSnapshot,
  LiveChatMessage,
  ModerationOperation,
  ViewerSample
} from '@/lib/backend'
import {
  DEFAULT_COMMENT_HIGHLIGHT_ANCHOR,
  normalizeCommentHighlightAnchor,
  offCohostWindowState
} from '@/lib/backend'
import { applyCohostState } from '@/lib/cohost-state'
import type { CommandAnswer } from '@/components/stream-manager/command-cards'
import {
  cohostHighlightMessageId,
  cohostNudgeDismissedFromStorage,
  COHOST_NUDGE_STORAGE_KEY
} from '@/lib/cohost-view'
import { Toaster } from '@/components/ui/sonner'
import { createCommentsMarker } from '@/lib/marker-command'
import type { CreateMarkerParams, MarkerContext } from '../../shared/session-markers'
import { clipMarkedToast } from '../../shared/clip-marks'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { chatSendFailures, pendingCommentsSendOperation } from '@/lib/chat-send'
import type { ChatSendFailure } from '@/lib/chat-send'
import { commentHighlightExpiryDelay, expireCommentHighlightState } from '@/lib/comment-highlight'
import {
  commentsSendOperationTerminal,
  commentsSendTransportFailureCanReplace
} from '../../shared/comments-send-operation'
import { emptyLiveChatSnapshot } from '@/lib/live-chat-view'
import { removalOutcomeToast, type RemovalAnswer } from '@/lib/chat-removal-view'
import { mergeModerationOperations } from '../../shared/chat-moderation'
import {
  reconcileBrokerCommentsSnapshot,
  applyCommentsSnapshotDelta
} from '../../shared/comments-snapshot-delta'
import type { LiveDashboardState } from '../../shared/live-dashboard'
import '@/styles.css'

// Long-lived second window: drop React's dev perf-track measures, which buffer
// outside the V8 heap and leak over time (see videorc-react-dev-perf-track-leak).
if (import.meta.env.DEV && localStorage.getItem('videorc.reactPerfTrack') !== '1') {
  const nativeMeasure = performance.measure.bind(performance)
  performance.measure = (
    name: string,
    startOrOptions?: string | PerformanceMeasureOptions,
    endMark?: string
  ): PerformanceMeasure => {
    const detail =
      typeof startOrOptions === 'object' && startOrOptions !== null ? startOrOptions.detail : null
    if (detail && typeof detail === 'object' && 'devtools' in detail) {
      return undefined as unknown as PerformanceMeasure
    }
    return nativeMeasure(name, startOrOptions, endMark)
  }
}

// The window's data comes from the main renderer through the main-process relay
// (C3): seed from the cached snapshot, then follow live pushes; Clear routes back.
function CommentsWindowApp(): ReactElement {
  const [view, setView] = useState<CommentsViewSnapshot>(() => ({
    mode: { kind: 'live' },
    snapshot: emptyLiveChatSnapshot(new Date().toISOString())
  }))
  const [markerContext, setMarkerContext] = useState<MarkerContext | null>(null)
  const markerRetry = useRef<CreateMarkerParams | null>(null)
  const [markerRetryPending, setMarkerRetryPending] = useState(false)
  useEffect(() => {
    let disposed = false
    void window.videorc?.getMarkerContext?.().then((context) => {
      if (!disposed) setMarkerContext(context)
    })
    const off = window.videorc?.onMarkerContext?.(setMarkerContext)
    return () => {
      disposed = true
      off?.()
    }
  }, [])
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [highlightAnchor, setHighlightAnchor] = useState<CommentHighlightAnchor>(
    DEFAULT_COMMENT_HIGHLIGHT_ANCHOR
  )
  const [highlightState, setHighlightState] = useState<CommentHighlightState>({
    generation: 0,
    phase: 'idle'
  })
  const highlightIntentRef = useRef(0)
  const [highlightApplyingId, setHighlightApplyingId] = useState<string | null>(null)
  const [highlightFailure, setHighlightFailure] = useState<{
    messageId: string
    reason: string
  } | null>(null)
  useEffect(() => {
    if (!highlightFailure) return
    const timer = window.setTimeout(() => setHighlightFailure(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [highlightFailure])
  useEffect(() => {
    const delay = commentHighlightExpiryDelay(highlightState, Date.now())
    if (delay === null) return
    const generation = highlightState.generation
    const timer = window.setTimeout(
      () =>
        setHighlightState((current) =>
          expireCommentHighlightState(current, generation, Date.now())
        ),
      delay + 1
    )
    return () => window.clearTimeout(timer)
  }, [highlightState])
  const [sendPending, setSendPending] = useState(false)
  const [sendOperation, setSendOperation] = useState<CommentsSendOperation | null>(null)
  const sendOperationRef = useRef<CommentsSendOperation | null>(null)
  const sendPendingOperationIdRef = useRef<string | null>(null)
  const [sendFailures, setSendFailures] = useState<ChatSendFailure[]>([])
  const viewRef = useRef(view)
  const applySendOperation = useCallback((operation: CommentsSendOperation | null): void => {
    sendOperationRef.current = operation
    setSendOperation(operation)
    setSendFailures(chatSendFailures(operation))
  }, [])
  const [viewerSample, setViewerSample] = useState<ViewerSample | null>(null)
  // The Stream Manager's live data (plan 055, S7): relayed through main.
  const [dashboard, setDashboard] = useState<LiveDashboardState | null>(null)
  // Co-host: the MAIN renderer resolves Premium, consent and the engine state,
  // and relays ONE value. This window never re-derives gating. Presence is
  // unconditional: the window mounts on the off shape, never on null.
  const [cohost, setCohost] = useState<CohostWindowState>(offCohostWindowState)
  const [cohostActionPending, setCohostActionPending] = useState(false)
  const [cohostNudgeDismissed, setCohostNudgeDismissed] = useState(() =>
    cohostNudgeDismissedFromStorage(localStorage.getItem(COHOST_NUDGE_STORAGE_KEY))
  )
  useEffect(() => {
    const applyView = (next: CommentsViewSnapshot): void => {
      const previous = viewRef.current
      if (next.mode.kind === 'live' && previous.mode.kind === 'live')
        next = {
          ...next,
          snapshot: reconcileBrokerCommentsSnapshot(previous.snapshot, next.snapshot)
        }
      viewRef.current = next
      setView(next)
      const sameLiveSession =
        previous.mode.kind === 'live' &&
        next.mode.kind === 'live' &&
        previous.snapshot.sessionId === next.snapshot.sessionId
      const currentOperation = sendOperationRef.current
      const nextOperation =
        next.latestSendOperation?.sessionId === next.snapshot.sessionId
          ? next.latestSendOperation
          : undefined
      if (
        nextOperation &&
        !(currentOperation?.phase === 'sending' && currentOperation.id !== nextOperation.id)
      ) {
        applySendOperation(nextOperation)
        if (
          sendPendingOperationIdRef.current === nextOperation.id &&
          commentsSendOperationTerminal(nextOperation)
        ) {
          sendPendingOperationIdRef.current = null
          setSendPending(false)
        }
      } else if (!sameLiveSession) {
        applySendOperation(null)
        sendPendingOperationIdRef.current = null
        setSendPending(false)
      }
    }
    void window.videorc
      ?.getCommentsSnapshot?.()
      .then((initial) => initial && applyView(initial))
      .catch(() => {})
    void window.videorc
      ?.getCommentsWindowState?.()
      .then((state) => {
        if (!state) return
        setAlwaysOnTop(state.alwaysOnTop)
        setHighlightAnchor(normalizeCommentHighlightAnchor(state.highlightAnchor))
      })
      .catch(() => {})
    const offSnapshot = window.videorc?.onCommentsSnapshot?.((next) => applyView(next))
    const offDelta = window.videorc?.onCommentsDelta?.((delta) => {
      const current = viewRef.current
      if (current.mode.kind !== 'live') return
      const snapshot = applyCommentsSnapshotDelta(current.snapshot, delta)
      if (snapshot === current.snapshot) return
      applyView({ ...current, snapshot })
    })
    void window.videorc
      ?.getViewerSample?.()
      .then((sample) => setViewerSample(sample ?? null))
      .catch(() => {})
    const offViewers = window.videorc?.onViewerSample?.((sample) => setViewerSample(sample))
    void window.videorc
      ?.getDashboard?.()
      .then((state) => setDashboard(state ?? null))
      .catch(() => {})
    const offDashboard = window.videorc?.onDashboard?.((state) => setDashboard(state))
    const offState = window.videorc?.onCommentsWindowState?.((state) => {
      setAlwaysOnTop(state.alwaysOnTop)
      setHighlightAnchor(normalizeCommentHighlightAnchor(state.highlightAnchor))
    })
    // Which comment is on stream: seeded + followed via the main-process relay
    // (the main renderer owns the highlight lifecycle).
    void window.videorc
      ?.getCommentHighlightState?.()
      .then((state) => state && setHighlightState(state))
      .catch(() => {})
    const offHighlight = window.videorc?.onCommentHighlightState?.((state) => {
      setHighlightState(state)
      setHighlightApplyingId(null)
    })
    void window.videorc
      ?.getCohostWindowState?.()
      .then((state) => state && setCohost(state))
      .catch(() => {})
    const offCohost = window.videorc?.onCohostWindowState?.((state) => setCohost(state))
    return () => {
      offSnapshot?.()
      offDelta?.()
      offViewers?.()
      offDashboard?.()
      offState?.()
      offHighlight?.()
      offCohost?.()
    }
  }, [applySendOperation])
  const { snapshot } = view
  const live = view.mode.kind === 'live' && Boolean(snapshot.sessionId)

  // Chat removals (plan 140, S6). Studio relays the live session's operations
  // in the snapshot; replies to this window's own requests fold in on top, so
  // a row never waits for the next snapshot to say what happened.
  const [localRemovals, setLocalRemovals] = useState<ModerationOperation[]>([])
  const [removalRequestIds, setRemovalRequestIds] = useState<ReadonlySet<string>>(() => new Set())
  const [removalAnsweringIds, setRemovalAnsweringIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const relayedRemovals = view.mode.kind === 'live' ? view.moderationOperations : undefined
  const moderationOperations = useMemo(
    () =>
      live
        ? mergeModerationOperations(
            relayedRemovals ?? [],
            localRemovals.filter((operation) => operation.sessionId === snapshot.sessionId)
          )
        : [],
    [live, localRemovals, relayedRemovals, snapshot.sessionId]
  )
  const noteRemoval = (operation: ModerationOperation): void =>
    setLocalRemovals((current) => mergeModerationOperations(current, [operation]).slice(-100))
  const flagId = (setter: typeof setRemovalRequestIds, id: string, on: boolean): void =>
    setter((current) => {
      if (current.has(id) === on) return current
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // "Remove from chat" is the express consent: it runs at once, as manual.
  const removeFromChat = (message: LiveChatMessage): void => {
    const sessionId = snapshot.sessionId
    const moderate = window.videorc?.moderateFromCommentsWindow
    if (!sessionId || !moderate) return
    flagId(setRemovalRequestIds, message.id, true)
    void moderate({
      requestId: crypto.randomUUID(),
      sessionId,
      action: 'remove',
      operationId: crypto.randomUUID(),
      messageId: message.id
    })
      .then((operation) => {
        noteRemoval(operation)
        const outcome = removalOutcomeToast(operation, { includeSuccess: false })
        if (outcome) {
          ;(outcome.kind === 'error' ? toast.error : toast.warning)(outcome.text, {
            id: `chat-removal:${operation.operationId}`
          })
        }
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : 'Could not remove the message.', {
          id: `chat-removal:${message.id}`
        })
      )
      .finally(() => flagId(setRemovalRequestIds, message.id, false))
  }
  // An Orcle removal card's Remove or Cancel (Enter or Esc).
  const answerRemoval = (operation: ModerationOperation, answer: RemovalAnswer): void => {
    const sessionId = snapshot.sessionId
    const moderate = window.videorc?.moderateFromCommentsWindow
    if (!sessionId || !moderate || removalAnsweringIds.has(operation.operationId)) return
    flagId(setRemovalAnsweringIds, operation.operationId, true)
    void moderate({
      requestId: crypto.randomUUID(),
      sessionId,
      action: answer,
      operationId: operation.operationId
    })
      .then(noteRemoval)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : 'Could not answer the removal.', {
          id: `chat-removal:${operation.operationId}`
        })
      )
      .finally(() => flagId(setRemovalAnsweringIds, operation.operationId, false))
  }

  const requestHighlight = (message: LiveChatMessage): void => {
    if (!snapshot.sessionId) return
    const intent = ++highlightIntentRef.current
    const command = {
      requestId: crypto.randomUUID(),
      sessionId: snapshot.sessionId,
      messageId: message.id
    }
    setHighlightFailure(null)
    setHighlightApplyingId(message.id)
    void window.videorc
      ?.sendCommentHighlight?.(command)
      .then((state) => {
        if (highlightIntentRef.current !== intent) return
        setHighlightFailure(null)
        setHighlightState(state)
      })
      .catch((error) => {
        if (highlightIntentRef.current !== intent) return
        setHighlightFailure({
          messageId: message.id,
          reason: error instanceof Error ? error.message : 'Highlight failed.'
        })
      })
      .finally(() => {
        if (highlightIntentRef.current === intent) setHighlightApplyingId(null)
      })
  }

  // Co-host actions are correlated commands: the MAIN renderer owns the
  // backend socket and makes the real `cohost.*` RPC, exactly like send and
  // highlight.
  // Resolves with the relayed state (null when nothing was sent or the
  // action failed); the recap draft reads its text from it.
  const sendCohostAction =
    (kind: CohostActionKind) =>
    (targetId: string): Promise<CohostState | null> => {
      if (!snapshot.sessionId) return Promise.resolve(null)
      const send = window.videorc?.sendCohostAction
      if (!send) return Promise.resolve(null)
      setCohostActionPending(true)
      return send({
        requestId: crypto.randomUUID(),
        sessionId: snapshot.sessionId,
        kind,
        targetId
      })
        .then((state) => {
          setCohost((current) => ({ ...current, state }))
          return state
        })
        .catch((error) => {
          setSendFailures([
            {
              destinationId: 'cohost-command',
              platform: 'custom',
              reason: error instanceof Error ? error.message : 'Orcle action failed.'
            }
          ])
          return null
        })
        .finally(() => setCohostActionPending(false))
    }

  // Answers to Orcle's voice command cards (plan 140, S6 part B). The reply
  // merges like an event: the newer command (by `at`) wins.
  const [commandAnsweringId, setCommandAnsweringId] = useState<string | null>(null)
  const answerCommand = (commandId: string, answer: CommandAnswer): void => {
    const sessionId = snapshot.sessionId
    const send = window.videorc?.sendCohostCommand
    if (!sessionId || !send || commandAnsweringId === commandId) return
    setCommandAnsweringId(commandId)
    void send({ requestId: crypto.randomUUID(), sessionId, commandId, ...answer })
      .then((state) =>
        setCohost((current) => ({ ...current, state: applyCohostState(current.state, state) }))
      )
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : 'Could not answer Orcle.', {
          id: `cohost-command:${commandId}`
        })
      )
      .finally(() => setCommandAnsweringId((current) => (current === commandId ? null : current)))
  }

  // Orcle Live's one switch (plan 119), relayed: on means Orcle reads chat AND
  // hears you (`listen: true`), off only stops it joining. Every way on (the
  // status popover, the nudge, the consent CTA and the listening card) sends
  // the same command; the consent CTA also grants cloud-AI consent in the same
  // click. The settings are main-renderer owned, and the relay reply carries
  // the truth back so the switch reflects what happened, not what was clicked.
  const setOrcleLive = (on: boolean, grantConsent = false): void => {
    void window.videorc
      ?.sendCohostEnable?.({
        requestId: crypto.randomUUID(),
        enabled: on,
        grantConsent,
        ...(on ? { listen: true } : {})
      })
      .then((state) => state && setCohost(state))
      .catch((error) =>
        toast.error(
          error instanceof Error ? error.message : 'Could not change the Orcle setting.',
          {
            id: 'cohost-enable'
          }
        )
      )
  }

  const showQuestionOnStream = (question: CohostQuestion): void => {
    const messageId = cohostHighlightMessageId(question)
    if (!messageId) return
    const message = snapshot.messages.find((candidate) => candidate.id === messageId)
    if (!message) return
    requestHighlight(message)
  }

  // Fail-closed: the relay seed is off-shaped and un-entitled, so the gate is
  // always derivable — presence never depends on a push having arrived.
  const cohostGate: EntitlementUiGate = cohost.entitled
    ? { allowed: true }
    : {
        allowed: false,
        featureId: 'live-cohost',
        reason: cohost.entitlementReason ?? 'Orcle requires Videorc Premium.',
        ...(cohost.upgradeUrl ? { upgradeUrl: cohost.upgradeUrl } : {})
      }

  // The engine was asked to start but has not reported listening yet — the one
  // state the wire cannot express (it still reads `off`).
  const cohostStarting =
    live && cohost.enabled && cohost.entitled && cohost.consented && cohost.state.status === 'off'

  return (
    // Real glass: the OS material under the body's window coat, and the
    // frame's content coat on top (plan 050), like every other window.
    <WindowFrame>
      <StreamManager
        dashboard={view.mode.kind === 'live' ? dashboard : null}
        history={view.mode.kind === 'history' ? view.history : undefined}
        viewerSample={view.mode.kind === 'live' ? viewerSample : null}
        snapshot={snapshot}
        viewMode={view.mode}
        alwaysOnTop={alwaysOnTop}
        highlightAnchor={highlightAnchor}
        highlightApplyingId={highlightApplyingId}
        highlightFailure={highlightFailure}
        highlightState={highlightState}
        sendFailures={sendFailures}
        sendOperation={sendOperation}
        sendPending={sendPending}
        cohostActionPending={cohostActionPending}
        cohostConsented={cohost.consented}
        cohostEnabled={cohost.enabled}
        cohostGate={cohostGate}
        cohostListen={cohost.listen}
        cohostNudgeDismissedForever={cohostNudgeDismissed}
        cohostStarting={cohostStarting}
        cohostState={cohost.state}
        moderationOperations={moderationOperations}
        removalAnsweringIds={removalAnsweringIds}
        removalRequestIds={removalRequestIds}
        onAnswerRemoval={live ? answerRemoval : undefined}
        commandAnsweringId={commandAnsweringId}
        onAnswerCommand={live ? answerCommand : undefined}
        onRemoveFromChat={live ? removeFromChat : undefined}
        onCohostAnswered={(question) => void sendCohostAction('answered')(question.id)}
        onCohostRestoreQuestion={(question) => void sendCohostAction('restore')(question.id)}
        onCohostPromiseDone={(promise) => void sendCohostAction('promise-done')(promise.id)}
        onCohostPromiseDismiss={(promise) => void sendCohostAction('promise-dismiss')(promise.id)}
        onCohostRecapDismiss={() =>
          void sendCohostAction('recap-dismiss')(snapshot.sessionId ?? '')
        }
        onCohostRecapDraft={() => sendCohostAction('recap-draft')(snapshot.sessionId ?? '')}
        onCohostAuthorGreeted={(entry) => void sendCohostAction('author-greeted')(entry.authorKey)}
        onCohostEnable={(enabled) => setOrcleLive(enabled)}
        onCohostEnableConsent={() => setOrcleLive(true, true)}
        onCohostListenOn={() => setOrcleLive(true)}
        onCohostNudgeDismiss={() => {
          setCohostNudgeDismissed(true)
          localStorage.setItem(COHOST_NUDGE_STORAGE_KEY, '1')
        }}
        onCohostDismissFlag={(flag) => void sendCohostAction('dismiss-flag')(flag.messageId)}
        onCohostDismissQuestion={(question) =>
          void sendCohostAction('dismiss-question')(question.id)
        }
        onCohostShowOnStream={live ? showQuestionOnStream : undefined}
        onBackToLive={
          view.mode.kind === 'history'
            ? () => {
                void window.videorc?.setCommentsViewMode?.({ kind: 'live' })
              }
            : undefined
        }
        onClear={
          view.mode.kind === 'live' && snapshot.sessionId
            ? () => {
                setSendFailures([])
                void window.videorc
                  ?.clearComments?.({
                    requestId: crypto.randomUUID(),
                    sessionId: snapshot.sessionId!
                  })
                  .catch((error) =>
                    setSendFailures([
                      {
                        destinationId: 'comments-clear-command',
                        platform: 'custom',
                        reason:
                          error instanceof Error ? error.message : 'Could not clear the chat view.'
                      }
                    ])
                  )
              }
            : undefined
        }
        onHighlight={live ? requestHighlight : undefined}
        onMarkClip={
          live
            ? () => {
                void window.videorc
                  ?.markClipFromCommentsWindow?.({ requestId: crypto.randomUUID() })
                  .then((event) => {
                    const copy = clipMarkedToast(event)
                    ;(copy.kind === 'success' ? toast.success : toast.warning)(copy.title, {
                      id: 'clip-marked',
                      description: copy.description
                    })
                  })
                  .catch((error) =>
                    toast.error(
                      error instanceof Error ? error.message : 'Could not mark the clip.',
                      {
                        id: 'clip-marked'
                      }
                    )
                  )
              }
            : undefined
        }
        onOpenPreview={() => void window.videorc?.openPreviewWindow?.()}
        onShowFollowNames={() => {
          void window.videorc
            ?.showFollowNamesFromCommentsWindow?.({
              requestId: crypto.randomUUID(),
              platform: 'twitch'
            })
            .then(() =>
              toast.success('Allow the follow permission in your browser', {
                id: 'follow-names',
                description: 'New Twitch followers show by name once Twitch confirms.'
              })
            )
            .catch((error) =>
              toast.error(
                error instanceof Error ? error.message : 'Could not open the Twitch reconnect.',
                { id: 'follow-names' }
              )
            )
        }}
        onReconnectScopes={(platform) => {
          const started = removeMessagesReconnectStarted(platform)
          void window.videorc
            ?.reconnectScopesFromCommentsWindow?.({ requestId: crypto.randomUUID(), platform })
            .then(() =>
              toast.success(started.title, {
                id: 'reconnect-scopes',
                description: started.description
              })
            )
            .catch((error) =>
              toast.error(
                error instanceof Error ? error.message : 'Could not open the reconnect.',
                { id: 'reconnect-scopes' }
              )
            )
        }}
        markerContext={
          markerContext
            ? { ...markerContext, retryAvailable: markerRetryPending }
            : markerRetryPending
              ? { available: false, retryAvailable: true }
              : null
        }
        onMarker={async (label) => {
          const api = window.videorc
          if (!api) throw new Error('Stream Manager is disconnected.')
          const previous = markerRetry.current
          let params: CreateMarkerParams
          if (previous && previous.label === label) params = previous
          else {
            if (!markerContext?.sessionId || !markerContext.available)
              throw new Error('No active capture is available.')
            params = {
              operationId: crypto.randomUUID(),
              sessionId: markerContext.sessionId,
              ...(label ? { label } : {})
            }
          }
          markerRetry.current = params
          setMarkerRetryPending(true)
          const marker = await createCommentsMarker(api, params)
          markerRetry.current = null
          setMarkerRetryPending(false)
          return marker
        }}
        onUndoMarker={async (marker) => {
          if (!window.videorc) throw new Error('Stream Manager is disconnected.')
          await window.videorc.markerFromCommentsWindow({
            requestId: crypto.randomUUID(),
            action: 'delete',
            params: { sessionId: marker.sessionId, markerId: marker.id }
          })
        }}
        onSend={(text, options) => {
          if (!snapshot.sessionId) return
          const operationId = crypto.randomUUID()
          sendPendingOperationIdRef.current = operationId
          setSendPending(true)
          setSendFailures([])
          const picked = options?.destinationIds ? new Set(options.destinationIds) : null
          applySendOperation(
            pendingCommentsSendOperation({
              id: operationId,
              sessionId: snapshot.sessionId,
              text,
              providers: picked
                ? snapshot.providers.filter((provider) => picked.has(provider.id))
                : snapshot.providers
            })
          )
          void window.videorc
            ?.sendChatFromCommentsWindow?.({
              requestId: crypto.randomUUID(),
              operationId,
              sessionId: snapshot.sessionId,
              text,
              ...(options?.inReplyToQuestionId
                ? { inReplyToQuestionId: options.inReplyToQuestionId }
                : {}),
              ...(options?.destinationIds ? { destinationIds: options.destinationIds } : {})
            })
            .then((operation) => {
              if (sendPendingOperationIdRef.current !== operationId) return
              applySendOperation(operation)
              if (commentsSendOperationTerminal(operation)) {
                sendPendingOperationIdRef.current = null
                setSendPending(false)
              }
            })
            .catch((error) => {
              if (sendPendingOperationIdRef.current !== operationId) return
              if (!commentsSendTransportFailureCanReplace(sendOperationRef.current, operationId)) {
                sendPendingOperationIdRef.current = null
                setSendPending(false)
                return
              }
              sendPendingOperationIdRef.current = null
              setSendPending(false)
              applySendOperation(null)
              setSendFailures([
                {
                  destinationId: 'comments-command',
                  platform: 'custom',
                  reason: error instanceof Error ? error.message : 'Send failed.'
                }
              ])
            })
        }}
        onHighlightAnchorChange={(anchor) => {
          // Optimistic: main echoes the persisted value back on the state event.
          setHighlightAnchor(anchor)
          void window.videorc?.setCommentsWindowHighlightAnchor?.(anchor)
        }}
        onToggleAlwaysOnTop={() =>
          void window.videorc?.setCommentsWindowAlwaysOnTop?.(!alwaysOnTop)
        }
      />
      {/* sonner needs its own host here because this is a separate React root;
          with no theme provider it follows prefers-color-scheme, like the page. */}
      <Toaster offset={{ bottom: 16, right: 16 }} position="bottom-right" visibleToasts={3} />
    </WindowFrame>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <CommentsWindowApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
