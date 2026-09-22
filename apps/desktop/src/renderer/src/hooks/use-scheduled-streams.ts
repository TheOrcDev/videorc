import { useCallback, useEffect, useRef, useState } from 'react'
import { BackendClient } from '@/backendClient'
import type { ScheduledStreamCapabilities, ScheduledStreamEvent } from '@/lib/backend'
import { runScheduledOperation } from '@/lib/scheduled-streams'

export function useScheduledStreams() {
  const client = useRef<BackendClient | null>(null)
  const [events, setEvents] = useState<ScheduledStreamEvent[]>([])
  const [capabilities, setCapabilities] = useState<ScheduledStreamCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
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
            'Some events could not refresh. Showing the last confirmed state; check channel connection and retry.'
          )
        }
      }
      setEvents(await client.current.request<ScheduledStreamEvent[]>('scheduledStreams.list', {}))
    }
  }, [])
  useEffect(() => {
    let disposed = false
    let active: BackendClient | null = null
    void window.videorc
      .getBackendConnection()
      .then(async (connection) => {
        if (!connection || disposed)
          throw new Error('Backend is offline. Reopen Upcoming after reconnecting.')
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
        if (!disposed) setError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    const resume = () => {
      void reload(true).catch(() => setError('Offline. Showing the last loaded events.'))
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
      if (!client.current) throw new Error('Backend is offline.')
      return client.current.request<T>(`scheduledStreams.${method}`, params)
    },
    []
  )
  const mutate = useCallback(
    async (action: string, params: Record<string, unknown>) => {
      if (!client.current) throw new Error('Backend is offline.')
      const eventId = String(params.eventId)
      pending.current.set(eventId, (pending.current.get(eventId) ?? 0) + 1)
      setPendingIds([...pending.current.keys()])
      setError(null)
      try {
        return await runScheduledOperation(client.current, action, params)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
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
  return { events, capabilities, error, loading, busy, pendingIds, reload, request, mutate }
}
