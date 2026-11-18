import { useEffect, useRef, useState, type ReactElement } from 'react'

import { ResetIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyTitle } from '@/components/ui/empty'
import type { SoundboardState } from '@/lib/backend'
import { soundboard } from '@/lib/soundboard-store'

/**
 * Waits before each re-read of the board while it is still unknown. The first
 * read is the connection's own (soundboard-store.ts); this covers it failing
 * or timing out while the socket stays up. After the last wait fails, Retry.
 */
export const SOUNDS_RETRY_MS: readonly number[] = [3_000, 6_000, 15_000]

/**
 * The soundboard before its first read lands: "Loading sounds…" while the
 * board is read again on a short ladder, then a short line and Retry. Never
 * "No sounds yet" until the board is known (J2-8). Rendered only while the
 * board is unknown, so the ladder ends with the board. Offline there is
 * nothing to read: the page says why (`label`) and the ladder starts over on
 * reconnect.
 */
export function SoundsLoadState({
  className,
  label = 'Loading sounds…',
  offline
}: {
  className?: string
  label?: string
  offline: boolean
}): ReactElement {
  const [failures, setFailures] = useState(0)
  // Retry reads at once instead of after the first wait.
  const immediate = useRef(false)
  const failed = failures >= SOUNDS_RETRY_MS.length

  useEffect(() => {
    if (offline) {
      setFailures(0)
      return undefined
    }
    if (failed) return undefined
    let live = true
    const wait = immediate.current ? 0 : SOUNDS_RETRY_MS[failures]
    immediate.current = false
    const timer = setTimeout(() => {
      const client = soundboard.client()
      if (!client) {
        setFailures((count) => count + 1)
        return
      }
      client.request<SoundboardState>('sounds.list').then(
        (board) => {
          // An event that landed meanwhile is newer than this answer.
          if (live && !soundboard.getSnapshot().board) soundboard.acceptBoard(board)
        },
        (error: unknown) => {
          console.warn('[sounds] list read failed:', error)
          if (live) setFailures((count) => count + 1)
        }
      )
    }, wait)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [failed, failures, offline])

  if (!failed || offline) {
    return (
      <Empty className={className} data-videorc-sounds-loading="">
        <EmptyTitle>{label}</EmptyTitle>
      </Empty>
    )
  }
  return (
    <Empty className={className} data-videorc-sounds-failed="">
      <EmptyTitle>Couldn&apos;t load sounds</EmptyTitle>
      <EmptyContent>
        <Button
          data-testid="sounds-retry"
          variant="outline"
          onClick={() => {
            immediate.current = true
            setFailures(0)
          }}
        >
          <ResetIcon data-icon="inline-start" />
          Retry
        </Button>
      </EmptyContent>
    </Empty>
  )
}
