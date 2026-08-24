import React, { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import ReactDOM from 'react-dom/client'
import { toast } from 'sonner'

import { CommentsReader } from '@/components/comments-reader'
import { AppErrorBoundary } from '@/components/error-boundary'
import type {
  CohostQuestion,
  CohostWindowState,
  CommentHighlightState,
  CommentsSendOperation,
  CommentsViewSnapshot,
  LiveChatMessage,
  ViewerSample
} from '@/lib/backend'
import { offCohostWindowState } from '@/lib/backend'
import {
  cohostHighlightMessageId,
  cohostNudgeDismissedFromStorage,
  COHOST_NUDGE_STORAGE_KEY
} from '@/lib/cohost-view'
import { Toaster } from '@/components/ui/sonner'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { chatSendFailures, pendingCommentsSendOperation, sendablePlatforms } from '@/lib/chat-send'
import type { ChatSendFailure } from '@/lib/chat-send'
import { commentHighlightExpiryDelay, expireCommentHighlightState } from '@/lib/comment-highlight'
import {
  commentsSendOperationTerminal,
  commentsSendTransportFailureCanReplace
} from '../../shared/comments-send-operation'
import { emptyLiveChatSnapshot } from '@/lib/live-chat-view'
import { applyCommentsSnapshotDelta } from '../../shared/comments-snapshot-delta'
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
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
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
      .then((state) => state && setAlwaysOnTop(state.alwaysOnTop))
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
    const offState = window.videorc?.onCommentsWindowState?.((state) =>
      setAlwaysOnTop(state.alwaysOnTop)
    )
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
      offState?.()
      offHighlight?.()
      offCohost?.()
    }
  }, [applySendOperation])
  const { snapshot } = view
  const sendTargets = sendablePlatforms(snapshot.providers)
  const live = view.mode.kind === 'live' && Boolean(snapshot.sessionId)

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
  const sendCohostAction =
    (kind: 'answered' | 'dismiss-question' | 'dismiss-flag') =>
    (targetId: string): void => {
      if (!snapshot.sessionId) return
      setCohostActionPending(true)
      void window.videorc
        ?.sendCohostAction?.({
          requestId: crypto.randomUUID(),
          sessionId: snapshot.sessionId,
          kind,
          targetId
        })
        .then((state) => setCohost((current) => ({ ...current, state })))
        .catch((error) =>
          setSendFailures([
            {
              destinationId: 'cohost-command',
              platform: 'custom',
              reason: error instanceof Error ? error.message : 'Co-host action failed.'
            }
          ])
        )
        .finally(() => setCohostActionPending(false))
    }

  // Turning the co-host on (and, from the consent CTA, granting cloud-AI
  // consent) is main-renderer owned; the relay reply carries the truth back so
  // the switch reflects what actually happened, not what was clicked.
  const setCohostEnabled = (enabled: boolean, grantConsent = false): void => {
    void window.videorc
      ?.sendCohostEnable?.({ requestId: crypto.randomUUID(), enabled, grantConsent })
      .then((state) => state && setCohost(state))
      .catch((error) =>
        toast.error(
          error instanceof Error ? error.message : 'Could not change the co-host setting.',
          { id: 'cohost-enable' }
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
        reason: cohost.entitlementReason ?? 'Live Co-host requires Videorc Premium.',
        ...(cohost.upgradeUrl ? { upgradeUrl: cohost.upgradeUrl } : {})
      }

  // The engine was asked to start but has not reported listening yet — the one
  // state the wire cannot express (it still reads `off`).
  const cohostStarting =
    live && cohost.enabled && cohost.entitled && cohost.consented && cohost.state.status === 'off'

  return (
    <>
      <CommentsReader
        viewerSample={view.mode.kind === 'live' ? viewerSample : null}
        snapshot={snapshot}
        viewMode={view.mode}
        alwaysOnTop={alwaysOnTop}
        highlightApplyingId={highlightApplyingId}
        highlightFailure={highlightFailure}
        highlightState={highlightState}
        sendFailures={sendFailures}
        sendOperation={sendOperation}
        sendPending={sendPending}
        sendTargets={sendTargets}
        cohostActionPending={cohostActionPending}
        cohostConsented={cohost.consented}
        cohostEnabled={cohost.enabled}
        cohostGate={cohostGate}
        cohostNudgeDismissedForever={cohostNudgeDismissed}
        cohostStarting={cohostStarting}
        cohostState={cohost.state}
        onCohostAnswered={(question) => sendCohostAction('answered')(question.id)}
        onCohostEnable={(enabled) => setCohostEnabled(enabled)}
        onCohostEnableConsent={() => setCohostEnabled(true, true)}
        onCohostNudgeDismiss={() => {
          setCohostNudgeDismissed(true)
          localStorage.setItem(COHOST_NUDGE_STORAGE_KEY, '1')
        }}
        onCohostDismissFlag={(flag) => sendCohostAction('dismiss-flag')(flag.messageId)}
        onCohostDismissQuestion={(question) => sendCohostAction('dismiss-question')(question.id)}
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
                        reason: error instanceof Error ? error.message : 'Could not clear Comments.'
                      }
                    ])
                  )
              }
            : undefined
        }
        onHighlight={live ? requestHighlight : undefined}
        onSend={(text, options) => {
          if (!snapshot.sessionId) return
          const operationId = crypto.randomUUID()
          sendPendingOperationIdRef.current = operationId
          setSendPending(true)
          setSendFailures([])
          applySendOperation(
            pendingCommentsSendOperation({
              id: operationId,
              sessionId: snapshot.sessionId,
              text,
              providers: snapshot.providers
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
                : {})
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
        onToggleAlwaysOnTop={() =>
          void window.videorc?.setCommentsWindowAlwaysOnTop?.(!alwaysOnTop)
        }
      />
      {/* The Comments window frames video and is dark-always; sonner needs its
          own host here because this is a separate React root. */}
      <Toaster offset={{ bottom: 16, right: 16 }} position="bottom-right" theme="dark" />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <CommentsWindowApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
