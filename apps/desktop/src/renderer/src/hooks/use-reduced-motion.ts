import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether the user asked the OS for reduced motion.
 *
 * Tailwind's `motion-reduce:` variant covers anything expressible as a class,
 * but not values computed at runtime — a per-row stagger delay has to be an
 * inline style, and inline styles are invisible to CSS variants. Components
 * that compute motion read this and drop it themselves.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true
  )

  useEffect(() => {
    const media = window.matchMedia?.(QUERY)
    if (!media) {
      return
    }
    const update = (): void => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return reduced
}
