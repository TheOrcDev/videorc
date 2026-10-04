import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  AiCapabilities,
  CleanCutJob,
  CleanCutJobDetail,
  CleanCutStartParams,
  CleanCutUpdateEdlParams
} from '@/lib/backend'
import {
  cleanCutCapabilities,
  upsertCleanCutJob,
  type CleanCutCapabilities,
  type CleanCutGetResultWithKeeps,
  type CleanCutTranscript
} from '@/lib/clean-cut-view'

export const CLEAN_CUT_OFFLINE_MESSAGE = 'Videorc is reconnecting. Try again in a moment.'

export interface CleanCutClient {
  /** The tab's own backend connection is up. */
  connected: boolean
  /** `cleanCut.list` plus every `cleanCut.status` since. */
  jobs: readonly CleanCutJob[]
  jobsLoaded: boolean
  /** A fresh read of the capability block (minutes left), or the studio's. */
  capabilities: CleanCutCapabilities | null
  start: (params: CleanCutStartParams) => Promise<CleanCutJob>
  cancel: (jobId: string) => Promise<CleanCutJob>
  /** Render the current cut list again (S13). */
  render: (jobId: string) => Promise<CleanCutJob>
  get: (sessionId: string) => Promise<CleanCutGetResultWithKeeps>
  updateEdl: (params: CleanCutUpdateEdlParams) => Promise<CleanCutJobDetail>
  /** The job's words and sentences (S13). */
  transcript: (jobId: string) => Promise<CleanCutTranscript>
  /** Every `cleanCut.status` snapshot as it arrives. */
  subscribe: (listener: (job: CleanCutJob) => void) => () => void
}

/**
 * Clean cut in the Orcle tab (plan 119 S14). Like the stream report, it opens
 * its own backend client while the tab is mounted, so Clean cut adds nothing
 * to the main window's startup bundle or its provider. The client follows
 * the studio's connection, so a backend restart reconnects it.
 */
export function useCleanCut(): CleanCutClient {
  const { connection, wsStatus, account, aiCapabilities } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const signedIn = account?.status === 'signed-in'
  const [client, setClient] = useState<BackendClient | null>(null)
  const [jobs, setJobs] = useState<CleanCutJob[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)
  const [fresh, setFresh] = useState<{ value: CleanCutCapabilities | null } | null>(null)
  const [capabilityReads, setCapabilityReads] = useState(0)
  const listenersRef = useRef(new Set<(job: CleanCutJob) => void>())

  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    const offStatus = next.on('cleanCut.status', (job) => {
      if (disposed) return
      setJobs((current) => upsertCleanCutJob(current, job))
      for (const listener of listenersRef.current) listener(job)
      // Minutes were spent: read the allowance again.
      if (job.state === 'completed' || job.state === 'failed') {
        setCapabilityReads((value) => value + 1)
      }
    })
    next.connect().then(
      () => {
        if (disposed) return
        setClient(next)
        next.requestTyped('cleanCut.list').then(
          (list) => {
            if (disposed) return
            setJobs((current) =>
              list.reduce((merged, job) => upsertCleanCutJob(merged, job), current)
            )
            setJobsLoaded(true)
          },
          () => {
            if (!disposed) setJobsLoaded(true)
          }
        )
      },
      () => undefined
    )
    return () => {
      disposed = true
      offStatus()
      next.close()
      setClient(null)
    }
  }, [online])

  useEffect(() => {
    if (!client || !signedIn) return
    let current = true
    client.request<AiCapabilities>('ai.capabilities.get').then(
      (value) => {
        if (current) setFresh({ value: cleanCutCapabilities(value) })
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [client, signedIn, capabilityReads])

  const requireClient = useCallback((): BackendClient => {
    if (!client) throw new Error(CLEAN_CUT_OFFLINE_MESSAGE)
    return client
  }, [client])

  const remember = useCallback((job: CleanCutJob): CleanCutJob => {
    setJobs((current) => upsertCleanCutJob(current, job))
    return job
  }, [])

  const start = useCallback(
    async (params: CleanCutStartParams) =>
      remember(await requireClient().requestTyped('cleanCut.start', params)),
    [remember, requireClient]
  )
  const cancel = useCallback(
    async (jobId: string) =>
      remember(await requireClient().requestTyped('cleanCut.cancel', { jobId })),
    [remember, requireClient]
  )
  const render = useCallback(
    async (jobId: string) =>
      remember(await requireClient().requestTyped('cleanCut.render', { jobId })),
    [remember, requireClient]
  )
  const get = useCallback(
    async (sessionId: string): Promise<CleanCutGetResultWithKeeps> =>
      requireClient().requestTyped('cleanCut.get', { sessionId }),
    [requireClient]
  )
  const updateEdl = useCallback(
    async (params: CleanCutUpdateEdlParams) => {
      const detail = await requireClient().requestTyped('cleanCut.updateEdl', params)
      remember(detail.job)
      return detail
    },
    [remember, requireClient]
  )
  const transcript = useCallback(
    async (jobId: string): Promise<CleanCutTranscript> =>
      requireClient().requestTyped('cleanCut.transcript', { jobId }),
    [requireClient]
  )
  const subscribe = useCallback((listener: (job: CleanCutJob) => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const capabilities = useMemo(
    () => (!signedIn ? null : fresh ? fresh.value : cleanCutCapabilities(aiCapabilities)),
    [aiCapabilities, fresh, signedIn]
  )

  return useMemo(
    () => ({
      connected: client !== null,
      jobs,
      jobsLoaded,
      capabilities,
      start,
      cancel,
      render,
      get,
      updateEdl,
      transcript,
      subscribe
    }),
    [
      capabilities,
      cancel,
      client,
      get,
      jobs,
      jobsLoaded,
      render,
      start,
      subscribe,
      transcript,
      updateEdl
    ]
  )
}
