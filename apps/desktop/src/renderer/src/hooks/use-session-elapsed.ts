import { useEffect, useState } from 'react'

import { sessionElapsedMs } from '@/lib/studio-session-view'

/**
 * The running session's elapsed time, re-read once a second (plan 095 S5).
 * The backend sends `durationMs` only in the terminal status, so a live clock
 * counts from `startedAt`. The tick is the caller's local state: only the
 * clock re-renders, never the Studio provider tree.
 */
export function useSessionElapsedMs(startedAt: string | undefined): number | undefined {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) {
      return
    }
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [startedAt])
  return sessionElapsedMs(startedAt, nowMs)
}
