import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { BackendClient } from '@/backendClient'
import type { SrtInputSetParams, SrtInputState } from '@/lib/backend'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import { userErrorMessage } from '@/lib/user-error'

// The SRT input (plan 255): the backend's setting and its camera's status as
// the Studio holds it, in a small context of its own, so the status reaches
// only the surfaces that show it (the Settings opt-in, the Sources camera
// row, Go Live). Without a provider the state is unknown and every surface
// hides it.

export type SrtInputResult = { ok: true } | { ok: false; message: string }

export interface SrtInputControls {
  /** null until the backend answers, or on a backend without it. */
  state: SrtInputState | null
  /** The state as it is now, for code that reads it after an await (an
   * agent's Go Live decides after its preflight). */
  stateRef: { readonly current: SrtInputState | null }
  connected: boolean
  set: (params: SrtInputSetParams) => Promise<SrtInputResult>
  renewPassphrase: () => Promise<SrtInputResult>
}

const NOT_IN_THIS_STUDIO = "The SRT input isn't available in this Studio."
const FIRST_READ_RETRY_MS = 1_000
const MAX_READ_RETRY_MS = 10_000

const UNKNOWN: SrtInputControls = Object.freeze({
  state: null,
  stateRef: Object.freeze({ current: null }),
  connected: false,
  set: async () => ({ ok: false as const, message: NOT_IN_THIS_STUDIO }),
  renewPassphrase: async () => ({ ok: false as const, message: NOT_IN_THIS_STUDIO })
})

export const SrtInputContext = createContext<SrtInputControls>(UNKNOWN)

export function useSrtInput(): SrtInputControls {
  return useContext(SrtInputContext)
}

export function useSrtInputController(
  client: BackendClient | null,
  connectionState: string
): SrtInputControls {
  const [state, setLatestState] = useState<SrtInputState | null>(null)
  const stateRef = useRef<SrtInputState | null>(null)
  const setState = useCallback((next: SrtInputState) => {
    stateRef.current = next
    setLatestState(next)
  }, [])
  const revision = useRef(0)
  const connected = Boolean(client) && connectionState === 'connected'

  useEffect(() => {
    if (!client || connectionState !== 'connected') return
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    // Every backend answers; a failed read is a passing fault. Until the
    // state is known, Go Live can't ask about the SRT Camera's signal, so
    // the read goes on until it lands.
    let known = false
    const expected = ++revision.current
    const read = (delayMs: number): void => {
      void client
        .requestTyped('srtInput.get')
        .then((value) => {
          known = true
          if (active && expected === revision.current) setState(value)
        })
        .catch((error) => {
          console.warn('[srt-input] status failed', error)
          if (!active || known) return
          retry = setTimeout(() => {
            if (!known) read(Math.min(delayMs * 2, MAX_READ_RETRY_MS))
          }, delayMs)
        })
    }
    read(FIRST_READ_RETRY_MS)
    const off = client.on('srtInput.changed', (value) => {
      known = true
      ++revision.current
      if (active) setState(value)
    })
    return () => {
      active = false
      clearTimeout(retry)
      off()
    }
  }, [client, connectionState, setState])

  const run = useCallback(
    async (
      request: (client: BackendClient) => Promise<SrtInputState>,
      action: string
    ): Promise<SrtInputResult> => {
      if (!client || connectionState !== 'connected') {
        return { ok: false, message: OFFLINE_LOCK_REASON }
      }
      const expected = ++revision.current
      try {
        const next = await request(client)
        if (expected === revision.current) setState(next)
        return { ok: true }
      } catch (error) {
        const copy = userErrorMessage(error, { action, object: 'the SRT input' })
        console.warn(`[srt-input] ${copy.title}:`, copy.raw || error)
        return { ok: false, message: copy.text }
      }
    },
    [client, connectionState, setState]
  )

  const set = useCallback(
    (params: SrtInputSetParams) =>
      run((backend) => backend.requestTyped('srtInput.set', params), 'change'),
    [run]
  )
  const renewPassphrase = useCallback(
    () => run((backend) => backend.requestTyped('srtInput.renewPassphrase'), 'renew'),
    [run]
  )

  return useMemo(
    () => ({ state, stateRef, connected, set, renewPassphrase }),
    [state, connected, set, renewPassphrase]
  )
}

/** One change at a time from a surface: its pending lock and its refusal. */
export interface SrtInputChange {
  pending: boolean
  problem: string | null
  /** Resolves once the change settles: true when it went through. */
  run: (task: () => Promise<SrtInputResult>, cameraListChanges: boolean) => Promise<boolean>
  /** Forgets the last refusal (a dialog that showed it closed). */
  reset: () => void
}

/**
 * Runs a change from the opt-in or the camera row. A change that adds,
 * removes or renames the camera entry has the camera list read again.
 */
export function useSrtInputChange(onCameraListChanged: () => unknown): SrtInputChange {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const run = async (
    task: () => Promise<SrtInputResult>,
    cameraListChanges: boolean
  ): Promise<boolean> => {
    setPending(true)
    setProblem(null)
    try {
      const result = await task()
      if (!result.ok) setProblem(result.message)
      else if (cameraListChanges) void onCameraListChanged()
      return result.ok
    } finally {
      setPending(false)
    }
  }
  return { pending, problem, run, reset: () => setProblem(null) }
}
