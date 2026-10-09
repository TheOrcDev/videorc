import { useCallback, useEffect, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostReportPayload } from '@/lib/backend'

export interface BuddyReportState {
  /**
   * The backend's answer for the asked session (or the latest stream). The
   * previous answer stays while another session loads, so switching never
   * flashes the card empty; read the session from `payload.sessionId`.
   */
  payload: CohostReportPayload | null
  /** No answer yet for the current ask. */
  loading: boolean
  /** Why the current ask failed; null once one succeeds. */
  error: string | null
  /** Ask again (the error row's Try again). */
  reload: () => void
}

interface Answer {
  /** The asked session id; '' for the latest stream. */
  ask: string
  payload: CohostReportPayload | null
  error: string | null
}

export const BUDDY_REPORT_READ_ERROR = "Couldn't read this report."

/**
 * The Golem tab's stream report (plan 119 S3). Like Upcoming and the 7TV
 * switch, it opens its own backend client while the tab is mounted, so the
 * report adds nothing to the main window's startup bundle or its provider.
 * `sessionId` null asks `cohost.report.latest`; every `cohost.report.saved`
 * asks again, so a stream that just ended shows up without a click. The
 * client follows the studio's connection, so a backend restart reconnects it.
 */
export function useBuddyReport(sessionId: string | null): BuddyReportState {
  const { connection, wsStatus } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  const [connectFailed, setConnectFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [revision, setRevision] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const ask = sessionId ?? ''

  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    const offSaved = next.on('cohost.report.saved', () => {
      if (!disposed) setRevision((value) => value + 1)
    })
    next.connect().then(
      () => {
        if (disposed) return
        setConnectFailed(false)
        setClient(next)
      },
      () => {
        if (!disposed) setConnectFailed(true)
      }
    )
    return () => {
      disposed = true
      offSaved()
      next.close()
      setClient(null)
    }
  }, [online, attempt])

  useEffect(() => {
    if (!client) return
    let current = true
    const request =
      ask === ''
        ? client.requestTyped('cohost.report.latest')
        : client.requestTyped('cohost.report.get', { sessionId: ask })
    request.then(
      (payload) => {
        if (current) setAnswer({ ask, payload, error: null })
      },
      () => {
        // Keep what the card shows; the error row says this ask failed.
        if (current) {
          setAnswer((previous) => ({
            ask,
            payload: previous?.payload ?? null,
            error: BUDDY_REPORT_READ_ERROR
          }))
        }
      }
    )
    return () => {
      current = false
    }
  }, [ask, client, revision])

  const reload = useCallback(() => {
    if (connectFailed) setAttempt((value) => value + 1)
    else setRevision((value) => value + 1)
  }, [connectFailed])

  const settled = answer?.ask === ask ? answer : null
  return {
    payload: answer?.payload ?? null,
    loading: settled === null && !connectFailed,
    error: connectFailed ? BUDDY_REPORT_READ_ERROR : (settled?.error ?? null),
    reload
  }
}
