import { useCallback, useEffect, useRef, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostAvatarGeneratedEvent, CohostAvatarState, CohostPersona } from '@/lib/backend'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { GOLEM_GENERATE_NOT_AVAILABLE, type GolemAvatarStyle } from '@/lib/golem-persona-view'

/** One tile's generation state (plan 164 S-A4). */
export type GolemTileProgress =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'failed'; error: string }
  | { phase: 'done'; opaque: boolean }

export type GolemTileProgressMap = Record<CohostAvatarState, GolemTileProgress>

export interface GolemAvatarRequest {
  personaId: string
  state: CohostAvatarState
  prompt: string
  style: GolemAvatarStyle
}

export interface GolemAvatarResult {
  /** The stored relative path (`<personaId>/<state>.png`). */
  path: string
  /** The model returned no alpha; the tile says so (plan 164 S-A5). */
  opaque: boolean
}

/** The one call that reaches the backend; S-A6 wires it to `cohost.avatar.generate`. */
export type GolemAvatarRequester = (request: GolemAvatarRequest) => Promise<GolemAvatarResult>

const IDLE_PROGRESS: GolemTileProgressMap = {
  idle: { phase: 'idle' },
  talk: { phase: 'idle' },
  laugh: { phase: 'idle' },
  think: { phase: 'idle' }
}

/** Without a backend (tests, a disconnected socket) every request is
 * refused with the one hint the tiles show. */
export const unavailableGolemAvatarRequester: GolemAvatarRequester = async () => {
  throw new Error(GOLEM_GENERATE_NOT_AVAILABLE)
}

/** The accept call answers in well under this; the outcome rides an event. */
const ACCEPT_TIMEOUT_MS = 15_000
/** The route's own budget is 90 s and the backend waits 95 (S-A5, S-A6). */
const OUTCOME_TIMEOUT_MS = 100_000

/**
 * The backend call behind Generate (plan 164 S-A6): `cohost.avatar.generate`
 * is accepted at once and the outcome arrives as `cohost.avatar.generated`
 * for that request id. Like the stream report, the Golem tab opens its own
 * backend client while mounted, so generation adds nothing to the shell.
 * Null until the client is connected: the section then refuses with
 * "Not available yet" instead of hanging a tile.
 */
export function useGolemAvatarRequester(): GolemAvatarRequester | null {
  const { connection, wsStatus } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    next.connect().then(
      () => {
        if (!disposed) setClient(next)
      },
      () => undefined
    )
    return () => {
      disposed = true
      next.close()
      setClient(null)
    }
  }, [online])
  return useCallback<GolemAvatarRequester>(
    async (request) => {
      if (!client) throw new Error(GOLEM_GENERATE_NOT_AVAILABLE)
      return generateThroughClient(client, request)
    },
    [client]
  )
}

/** One request: subscribe first, accept, then wait for its own event. */
export async function generateThroughClient(
  client: Pick<BackendClient, 'requestTyped' | 'on'>,
  request: GolemAvatarRequest,
  outcomeTimeoutMs = OUTCOME_TIMEOUT_MS
): Promise<GolemAvatarResult> {
  let settle: ((event: CohostAvatarGeneratedEvent) => void) | null = null
  const events: CohostAvatarGeneratedEvent[] = []
  const off = client.on('cohost.avatar.generated', (event) => {
    if (settle) settle(event)
    else events.push(event)
  })
  try {
    const accepted = await client.requestTyped(
      'cohost.avatar.generate',
      { state: request.state, prompt: request.prompt, style: request.style },
      { timeoutMs: ACCEPT_TIMEOUT_MS }
    )
    const outcome = await new Promise<CohostAvatarGeneratedEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The model took too long. Try again.')),
        outcomeTimeoutMs
      )
      const take = (event: CohostAvatarGeneratedEvent): boolean => {
        if (event.requestId !== accepted.requestId) return false
        clearTimeout(timer)
        resolve(event)
        return true
      }
      if (!events.some(take)) settle = take
    })
    if (outcome.error) throw new Error(outcome.error.message)
    if (!outcome.path) throw new Error('The generated image was not saved.')
    return { path: outcome.path, opaque: outcome.opaque }
  } finally {
    off()
  }
}

/**
 * Generation progress per tile (plan 164 S-A4, S-A6). `generateAll` runs
 * idle first, then the other three as edits of it, in sequence, so the
 * character stays consistent (D21); a failed state leaves its slot as it
 * was and never blocks the rest. `onImage` lands each finished image on the
 * persona as it arrives.
 */
export function useGolemAvatar({
  request,
  onImage
}: {
  request: GolemAvatarRequester
  onImage: (state: CohostAvatarState, result: GolemAvatarResult) => Promise<void>
}): {
  progress: GolemTileProgressMap
  busy: boolean
  generateOne: (
    persona: CohostPersona,
    state: CohostAvatarState,
    prompt: string,
    style: GolemAvatarStyle
  ) => Promise<void>
  generateAll: (persona: CohostPersona, prompt: string, style: GolemAvatarStyle) => Promise<void>
} {
  const [progress, setProgress] = useState<GolemTileProgressMap>(IDLE_PROGRESS)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)

  const runOne = useCallback(
    async (
      persona: CohostPersona,
      state: CohostAvatarState,
      prompt: string,
      style: GolemAvatarStyle
    ): Promise<boolean> => {
      setProgress((current) => ({ ...current, [state]: { phase: 'generating' } }))
      try {
        const result = await request({ personaId: persona.id, state, prompt, style })
        await onImage(state, result)
        setProgress((current) => ({
          ...current,
          [state]: { phase: 'done', opaque: result.opaque }
        }))
        return true
      } catch (error) {
        setProgress((current) => ({
          ...current,
          [state]: {
            phase: 'failed',
            error: error instanceof Error ? error.message : 'Generation failed.'
          }
        }))
        return false
      }
    },
    [onImage, request]
  )

  const withBusy = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const generateOne = useCallback(
    (persona: CohostPersona, state: CohostAvatarState, prompt: string, style: GolemAvatarStyle) =>
      withBusy(async () => {
        await runOne(persona, state, prompt, style)
      }),
    [runOne, withBusy]
  )

  const generateAll = useCallback(
    (persona: CohostPersona, prompt: string, style: GolemAvatarStyle) =>
      withBusy(async () => {
        // Idle first: the other states are edits of it (D21). Without an
        // idle image there is nothing to keep consistent, so stop there.
        const idleOk = await runOne(persona, 'idle', prompt, style)
        if (!idleOk) return
        for (const state of COHOST_AVATAR_STATES) {
          if (state === 'idle') continue
          await runOne(persona, state, prompt, style)
        }
      }),
    [runOne, withBusy]
  )

  return { progress, busy, generateOne, generateAll }
}
