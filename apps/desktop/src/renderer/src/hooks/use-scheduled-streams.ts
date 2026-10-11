import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendClient } from '@/backendClient'
import type { ScheduledStreamCapabilities, ScheduledStreamEvent } from '@/lib/backend'
import { formatRelativeTime } from '@/lib/format-time'
import { runScheduledOperation } from '@/lib/scheduled-streams'
import { userErrorMessage } from '@/lib/user-error'

/**
 * A window focus asks YouTube and X again at most this often (plan 174
 * S3.5b, D-34): every provider refresh re-reads each saved event, which
 * spends YouTube quota. Between them a focus re-reads the local list only.
 */
export const FOCUS_PROVIDER_REFRESH_MS = 5 * 60_000

/** Whether a focus at `nowMs` may ask the platforms again. */
export function focusRefreshesProviders(lastProviderRefreshMs: number, nowMs: number): boolean {
  return nowMs - lastProviderRefreshMs >= FOCUS_PROVIDER_REFRESH_MS
}

/** "Last checked 5m ago", "Last checked just now", or null before any check. */
export function lastCheckedLabel(iso: string | null, nowMs: number): string | null {
  if (!iso) return null
  const relative = formatRelativeTime(iso, nowMs)
  if (!relative) return null
  if (relative === 'now') return 'Last checked just now'
  return /^\d+[mhd]$/.test(relative) ? `Last checked ${relative} ago` : `Last checked ${relative}`
}

const ACTION_VERBS: Record<string, string> = {
  cancel: 'cancel',
  schedule: 'schedule',
  duplicate: 'duplicate',
  refresh: 'refresh',
  recover: 'recover'
}

export function useScheduledStreams() {
  const client = useRef<BackendClient | null>(null)
  const [events, setEvents] = useState<ScheduledStreamEvent[]>([])
  const [capabilities, setCapabilities] = useState<ScheduledStreamCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const lastProviderRefresh = useRef(0)
  const pending = useRef(new Map<string, number>())
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const busy = pendingIds.length > 0
  const reload = useCallback(async (refreshProvider = false) => {
    if (!client.current) return
    const [events, capabilities] = await Promise.all([
      client.current.request<ScheduledStreamEvent[]>('scheduledStreams.list', {}),
      client.current.request<ScheduledStreamCapabilities>('scheduledStreams.capabilities', {})
    ])
    setEvents(events)
    setCapabilities(capabilities)
    if (refreshProvider && capabilities.available) {
      lastProviderRefresh.current = Date.now()
      for (const event of events
        .filter(
          (event) =>
            event.providerEventId &&
            event.operationState !== 'pending' &&
            event.lifecycle !== 'canceled'
        )
        .slice(0, 100)) {
        try {
          await runScheduledOperation(client.current, 'refresh', {
            eventId: event.id,
            expectedRevision: event.revision
          })
        } catch {
          setError(
            "Some events couldn't refresh. Showing what was last confirmed. Check the account in Livestream → Setup, then refresh."
          )
        }
      }
      setEvents(await client.current.request<ScheduledStreamEvent[]>('scheduledStreams.list', {}))
      setLastCheckedAt(new Date().toISOString())
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let active: BackendClient | null = null
    void window.videorc
      .getBackendConnection()
      .then(async (connection) => {
        if (!connection || disposed)
          throw new Error('Videorc is reconnecting. Reopen Upcoming in a moment.')
        active = new BackendClient(connection)
        await active.connect()
        if (disposed) {
          active.close()
          return
        }
        client.current = active
        active.on('scheduledStreams.changed', () => {
          void reload().catch(() => undefined)
        })
        await reload(true)
      })
      .catch((error: unknown) => {
        if (!disposed)
          setError(userErrorMessage(error, { action: 'load', object: 'upcoming streams' }).text)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    const resume = () => {
      const providers = focusRefreshesProviders(lastProviderRefresh.current, Date.now())
      void reload(providers).catch(() =>
        setError('Videorc is reconnecting. Showing the events loaded last.')
      )
    }
    window.addEventListener('focus', resume)
    return () => {
      disposed = true
      active?.close()
      client.current = null
      window.removeEventListener('focus', resume)
    }
  }, [reload])
  const request = useCallback(
    async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (!client.current) throw new Error('Videorc is reconnecting.')
      return client.current.request<T>(`scheduledStreams.${method}`, params)
    },
    []
  )
  const mutate = useCallback(
    async (action: string, params: Record<string, unknown>) => {
      if (!client.current) throw new Error('Videorc is reconnecting.')
      const eventId = String(params.eventId)
      pending.current.set(eventId, (pending.current.get(eventId) ?? 0) + 1)
      setPendingIds([...pending.current.keys()])
      setError(null)
      try {
        return await runScheduledOperation(client.current, action, params)
      } catch (error) {
        setError(
          userErrorMessage(error, { action: ACTION_VERBS[action] ?? 'update', object: 'the event' })
            .text
        )
        throw error
      } finally {
        await reload().catch(() => undefined)
        const count = (pending.current.get(eventId) ?? 1) - 1
        if (count) pending.current.set(eventId, count)
        else pending.current.delete(eventId)
        setPendingIds([...pending.current.keys()])
      }
    },
    [reload]
  )
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const smokeWindow = window as Window & { __videorcSmokeScheduledStreams?: unknown }
    smokeWindow.__videorcSmokeScheduledStreams = {
      request,
      mutate,
      reload,
      state: () => ({ events, capabilities, busy, loading, error })
    }
    return () => {
      delete smokeWindow.__videorcSmokeScheduledStreams
    }
  }, [events, capabilities, busy, loading, error, request, mutate, reload])
  return {
    events,
    capabilities,
    error,
    loading,
    busy,
    pendingIds,
    lastCheckedAt,
    reload,
    request,
    mutate
  }
}
