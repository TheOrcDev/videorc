import { useCallback, useEffect, useRef, useState } from 'react'

import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { UsageStatsState } from '@/lib/backend'

export interface UsageStatsSettingState {
  /** `null` until the backend answers. */
  state: UsageStatsState | null
  /** Set when the setting could not be read or saved. */
  error: string | null
  setEnabled: (on: boolean) => void
}

const RECONNECTING = 'Videorc is reconnecting. Try again in a moment.'

/**
 * Settings → General → Privacy → "Share anonymous usage stats". The switch
 * lives in the backend (it gates what the backend sends), so the row uses the
 * app's shared backend client, which the Studio provider replaces on every
 * reconnect: a save after the engine recovered goes to the live connection,
 * and the row reads the setting again on it. Off takes effect before
 * `usageStats.set` answers.
 */
export function useUsageStatsSetting(): UsageStatsSettingState {
  const { client } = useStudioDiagnostics()
  const [state, setState] = useState<UsageStatsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The newest client and value, for a save to use rather than a closed one.
  const clientRef = useRef(client)
  const stateRef = useRef(state)
  clientRef.current = client
  stateRef.current = state

  useEffect(() => {
    if (!client) return undefined
    let disposed = false
    client
      .request<UsageStatsState>('usageStats.get')
      .then((current) => {
        if (disposed) return
        setState(current)
        setError(null)
      })
      .catch(() => {
        if (!disposed) setError("Couldn't read the privacy settings. Reopen Settings to try again.")
      })
    return () => {
      disposed = true
    }
  }, [client])

  // Only the latest flip may write state: an older answer (or its rollback)
  // must not undo a newer optimistic choice.
  const latestRequest = useRef(0)
  const setEnabled = useCallback((enabled: boolean) => {
    const active = clientRef.current
    if (!active) {
      setError(RECONNECTING)
      return
    }
    const before = stateRef.current
    const request = ++latestRequest.current
    const isLatest = (): boolean => request === latestRequest.current
    setError(null)
    setState((current) => current && { ...current, enabled })
    active
      .request<UsageStatsState>('usageStats.set', { enabled })
      .then((next) => {
        if (isLatest()) setState(next)
      })
      .catch(() => {
        if (!isLatest()) return
        setError("Couldn't save the privacy settings. Try again.")
        // Show what is stored. When it cannot be read either, show what was
        // there before the flip: the switch must not claim a choice that did
        // not save.
        const reconcile = clientRef.current ?? active
        reconcile
          .request<UsageStatsState>('usageStats.get')
          .then((next) => {
            if (isLatest()) setState(next)
          })
          .catch(() => {
            if (isLatest() && before) setState(before)
          })
      })
  }, [])

  return { state, error, setEnabled }
}
