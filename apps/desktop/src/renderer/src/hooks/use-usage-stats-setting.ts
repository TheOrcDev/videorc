import { useCallback, useEffect, useRef, useState } from 'react'

import { BackendClient } from '@/backendClient'
import type { UsageStatsState } from '@/lib/backend'

export interface UsageStatsSettingState {
  /** `null` until the backend answers. */
  state: UsageStatsState | null
  /** Set when the setting could not be read or saved. */
  error: string | null
  setEnabled: (on: boolean) => void
}

/**
 * Settings → General → Privacy → "Share anonymous usage stats". The switch
 * lives in the backend (it gates what the backend sends), so the row opens
 * its own backend client while the panel is mounted, as the chat rows do.
 * Off takes effect before `usageStats.set` answers.
 */
export function useUsageStatsSetting(): UsageStatsSettingState {
  const client = useRef<BackendClient | null>(null)
  const [state, setState] = useState<UsageStatsState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let active: BackendClient | null = null
    void window.videorc
      .getBackendConnection()
      .then(async (connection) => {
        if (!connection) throw new Error('No connection to Videorc yet.')
        if (disposed) return
        active = new BackendClient(connection)
        await active.connect()
        if (disposed) {
          active.close()
          return
        }
        client.current = active
        const current = await active.request<UsageStatsState>('usageStats.get')
        if (!disposed) setState(current)
      })
      .catch(() => {
        if (!disposed) setError("Couldn't read the privacy settings. Reopen Settings to try again.")
      })
    return () => {
      disposed = true
      active?.close()
      client.current = null
    }
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    const active = client.current
    if (!active) return
    setError(null)
    setState((current) => current && { ...current, enabled })
    active
      .request<UsageStatsState>('usageStats.set', { enabled })
      .then(setState)
      .catch(() => {
        setError("Couldn't save the privacy settings. Try again.")
        void active
          .request<UsageStatsState>('usageStats.get')
          .then(setState)
          .catch(() => undefined)
      })
  }, [])

  return { state, error, setEnabled }
}
