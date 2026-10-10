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

/**
 * The behaviour for a script-driven scroll (plan 174 S1.8, J1-23): smooth,
 * unless the user asked the system to reduce motion. CSS scroll-behavior
 * already collapses under reduced motion; `scrollIntoView` and `scrollTo`
 * calls pass this instead of a bare 'smooth'.
 */
export function smoothScrollBehavior(): ScrollBehavior {
  return getSnapshot() ? 'auto' : 'smooth'
}
