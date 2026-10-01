'use client'

import { useEffect, useEffectEvent, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Tracks whether an element is on screen, in a ref, so a painter can skip
 * frames nobody can see. Reading it never re-renders. `onChange` runs when the
 * element comes into or leaves view, so a painter that slept while hidden can
 * wake up.
 */
export const useVisibility = (
  target: RefObject<Element | null>,
  onChange?: (visible: boolean) => void
): RefObject<boolean> => {
  const visibleRef = useRef(true)
  const handleChange = useEffectEvent((visible: boolean) => {
    onChange?.(visible)
  })
  useEffect(() => {
    const element = target.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting !== visibleRef.current) {
          visibleRef.current = entry.isIntersecting
          handleChange(entry.isIntersecting)
        }
      }
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [target])
  return visibleRef
}
