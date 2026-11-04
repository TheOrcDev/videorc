import { useEffect, useRef } from 'react'
import type { MarkerContext } from '../../../shared/session-markers'

/**
 * Publishes the Stream Manager's marker and clip facts (plan 068, plan 181
 * R4) to Electron main, which hands them to the window.
 *
 * The window mounts its composer only while a context exists, and the
 * composer's state (a `/buddy` answer, a saved marker) lives in that
 * mount. So a change to the facts is one push of the new context, never a
 * `null` in between: a `null` for one render unmounts the composer and
 * drops what it was saying. `null` goes out once, when the Studio that owns
 * the facts unmounts.
 */
export function useMarkerContextPublisher(
  context: MarkerContext,
  push: ((context: MarkerContext | null) => unknown) | undefined
): void {
  const pushRef = useRef(push)
  pushRef.current = push
  // The object is rebuilt each render; its JSON is what changed.
  const serialized = JSON.stringify(context)
  useEffect(() => {
    void pushRef.current?.(JSON.parse(serialized) as MarkerContext)
  }, [serialized])
  useEffect(() => {
    return () => {
      void pushRef.current?.(null)
    }
  }, [])
}
