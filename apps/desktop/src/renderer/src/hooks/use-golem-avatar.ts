import { useCallback, useRef, useState } from 'react'

import type { CohostAvatarState, CohostPersona } from '@/lib/backend'
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

/** Until S-A6, every request is refused with the one hint the tiles show. */
export const unavailableGolemAvatarRequester: GolemAvatarRequester = async () => {
  throw new Error(GOLEM_GENERATE_NOT_AVAILABLE)
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
