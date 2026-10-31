'use client'

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

export type AudioContextStatus = AudioContextState | 'unsupported'

const ProvidedContext = createContext<AudioContext | null>(null)

let sharedContext: AudioContext | null = null

/** The page-wide `AudioContext`, created on first use. Null on the server. */
export const getSharedAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    return null
  }
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext({ latencyHint: 'interactive' })
  }
  return sharedContext
}

export interface AudioContextProviderProps {
  /** Use your own context instead of the shared one. */
  context: AudioContext
  children: ReactNode
}

/** Makes every audiocn hook below it use `context`. */
export const AudioContextProvider = ({ context, children }: AudioContextProviderProps) => (
  <ProvidedContext.Provider value={context}>{children}</ProvidedContext.Provider>
)

/** The context from `AudioContextProvider`, or null. Never creates one. */
export const useProvidedAudioContext = (): AudioContext | null => useContext(ProvidedContext)

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

const noop = () => {
  // Nothing to clean up on the server.
}

const getServerContext = () => null

const getServerStatus = (): AudioContextStatus => 'suspended'

export interface UseAudioContextResult {
  context: AudioContext | null
  status: AudioContextStatus
  /** Resumes a suspended context. Call it from a user gesture. */
  resume: () => Promise<void>
}

/**
 * The shared (or provided) `AudioContext`. It resumes automatically on the
 * first click or key press, which browsers require before audio can start.
 */
export const useAudioContext = (): UseAudioContextResult => {
  const provided = useProvidedAudioContext()

  const context = useSyncExternalStore(
    () => noop,
    () => provided ?? getSharedAudioContext(),
    getServerContext
  )

  const subscribeStatus = useCallback(
    (onChange: () => void) => {
      if (!context) {
        return noop
      }
      context.addEventListener('statechange', onChange)
      return () => {
        context.removeEventListener('statechange', onChange)
      }
    },
    [context]
  )

  const status = useSyncExternalStore(
    subscribeStatus,
    (): AudioContextStatus => context?.state ?? 'unsupported',
    getServerStatus
  )

  useEffect(() => {
    if (!context) {
      return
    }
    const resumeOnGesture = async () => {
      if (context.state !== 'suspended') {
        return
      }
      try {
        await context.resume()
      } catch {
        // The browser can still refuse; the next gesture tries again.
      }
    }
    for (const event of GESTURE_EVENTS) {
      document.addEventListener(event, resumeOnGesture, { passive: true })
    }
    return () => {
      for (const event of GESTURE_EVENTS) {
        document.removeEventListener(event, resumeOnGesture)
      }
    }
  }, [context])

  const resume = useCallback(async () => {
    if (context && context.state === 'suspended') {
      await context.resume()
    }
  }, [context])

  return { context, resume, status }
}
