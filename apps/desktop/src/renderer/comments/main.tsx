import React, { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import ReactDOM from 'react-dom/client'

import { CommentsReader } from '@/components/comments-reader'
import { AppErrorBoundary } from '@/components/error-boundary'
import type {
  CommentHighlightState,
  CommentsSendOperation,
  CommentsViewSnapshot,
  LiveChatMessage,
  ViewerSample
} from '@/lib/backend'
import { chatSendFailures, pendingCommentsSendOperation, sendablePlatforms } from '@/lib/chat-send'
import type { ChatSendFailure } from '@/lib/chat-send'
import { commentHighlightExpiryDelay, expireCommentHighlightState } from '@/lib/comment-highlight'
import {
  commentsSendOperationTerminal,
  commentsSendTransportFailureCanReplace
} from '../../shared/comments-send-operation'
import { emptyLiveChatSnapshot } from '@/lib/live-chat-view'
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
    return () => {
      offSnapshot?.()
      offViewers?.()
      offState?.()
      offHighlight?.()
    }
  }, [applySendOperation])
  const { snapshot } = view
  const sendTargets = sendablePlatforms(snapshot.providers)
  return (
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
      onHighlight={
        view.mode.kind === 'live' && snapshot.sessionId
          ? (message: LiveChatMessage) => {
              const intent = ++highlightIntentRef.current
              const command = {
                requestId: crypto.randomUUID(),
                sessionId: snapshot.sessionId!,
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
          : undefined
      }
      onSend={(text) => {
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
            text
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
      onToggleAlwaysOnTop={() => void window.videorc?.setCommentsWindowAlwaysOnTop?.(!alwaysOnTop)}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <CommentsWindowApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
