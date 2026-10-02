'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

const subscribe = (onChange: () => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {
      // Nothing to unsubscribe on the server.
    }
  }
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', onChange)
  return () => {
    media.removeEventListener('change', onChange)
  }
}

const getSnapshot = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.(QUERY).matches)

const getServerSnapshot = () => false

/** True when the user asked the system to reduce motion. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
