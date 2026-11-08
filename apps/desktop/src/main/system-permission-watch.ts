import type { SystemPermissionPane } from '../shared/backend'

export type MediaAccessPermissionName = 'camera' | 'microphone' | 'screen'
export type MediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'
  | 'not-applicable'

export type MediaPermissionGrantWatcher = {
  stop: () => void
  watch: (pane: SystemPermissionPane, reason: string) => void
  /** Re-read the watched grant now (plan 203 S2: window focus, setup open
   * past the polling window). Resolves true when a real not-granted →
   * granted transition restarted capture just now; a pane that was already
   * granted, or never watched, never restarts. */
  recheck: () => Promise<boolean>
}

type TrackedGrant = {
  pane: SystemPermissionPane
  permission: MediaAccessPermissionName
  reason: string
  status: MediaAccessStatus
}

export type MediaPermissionGrantWatcherOptions = {
  getStatus: (permission: MediaAccessPermissionName) => MediaAccessStatus
  intervalMs?: number
  maxChecks?: number
  log?: (level: 'info' | 'warn', message: string) => void
  restartBackend: (reason: string) => Promise<void> | void
}

export function mediaAccessPermissionForPane(
  pane: SystemPermissionPane
): MediaAccessPermissionName | null {
  if (pane === 'camera' || pane === 'microphone') {
    return pane
  }
  if (pane === 'screen-recording') {
    return 'screen'
  }
  return null
}

export function createMediaPermissionGrantWatcher({
  getStatus,
  intervalMs = 1000,
  maxChecks = 90,
  log,
  restartBackend
}: MediaPermissionGrantWatcherOptions): MediaPermissionGrantWatcher {
  let watchId = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // The grant we are still waiting for. Set when a watch starts from a
  // non-granted status; kept past the polling timeout so a late re-check can
  // still notice the transition; cleared by the one restart or by stop().
  let tracked: TrackedGrant | null = null

  const stop = (): void => {
    watchId += 1
    tracked = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  // Exactly one restart per transition: the tracking is cleared and the poll
  // retired before the restart runs, so a poll and a re-check can never both
  // restart for the same grant.
  const restartOnce = async (grant: TrackedGrant, how: string): Promise<void> => {
    tracked = null
    watchId += 1
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    log?.(
      'info',
      `${grant.pane} permission is now granted (${how}); requesting a capture backend restart.`
    )
    try {
      await restartBackend(grant.reason)
    } catch (error) {
      log?.(
        'warn',
        `Could not restart capture backend after ${grant.pane} permission grant: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const schedule = (fn: () => void): void => {
    timer = setTimeout(fn, intervalMs)
  }

  return {
    stop,
    watch: (pane, reason): void => {
      const permission = mediaAccessPermissionForPane(pane)
      if (!permission) {
        return
      }

      stop()
      const currentWatchId = watchId
      let remainingChecks = Math.max(1, maxChecks)
      let previousStatus: MediaAccessStatus
      try {
        previousStatus = getStatus(permission)
      } catch (error) {
        log?.(
          'warn',
          `Could not read ${pane} permission before Settings opened: ${error instanceof Error ? error.message : String(error)}`
        )
        return
      }
      // Opening Settings is navigation, not a permission transition. In
      // particular, an already-granted pane must never restart the backend.
      if (previousStatus === 'granted') {
        return
      }
      tracked = { pane, permission, reason, status: previousStatus }

      const poll = async (): Promise<void> => {
        if (currentWatchId !== watchId) {
          return
        }

        let status: MediaAccessStatus
        try {
          status = getStatus(permission)
        } catch (error) {
          timer = null
          log?.(
            'warn',
            `Could not check ${pane} permission after Settings opened: ${error instanceof Error ? error.message : String(error)}`
          )
          return
        }

        if (status === 'granted' && previousStatus !== 'granted') {
          timer = null
          await restartOnce({ pane, permission, reason, status: previousStatus }, 'polled')
          return
        }
        previousStatus = status
        if (tracked && tracked.permission === permission) {
          tracked.status = status
        }

        remainingChecks -= 1
        if (remainingChecks <= 0) {
          timer = null
          log?.(
            'warn',
            `${pane} permission did not become granted before the watcher timed out; it is re-checked on focus.`
          )
          return
        }

        schedule(() => {
          void poll()
        })
      }

      schedule(() => {
        void poll()
      })
    },
    recheck: async (): Promise<boolean> => {
      const grant = tracked
      if (!grant) {
        return false
      }
      let status: MediaAccessStatus
      try {
        status = getStatus(grant.permission)
      } catch (error) {
        log?.(
          'warn',
          `Could not re-check ${grant.pane} permission: ${error instanceof Error ? error.message : String(error)}`
        )
        return false
      }
      if (status !== 'granted') {
        grant.status = status
        return false
      }
      if (grant.status === 'granted') {
        return false
      }
      await restartOnce(grant, 'noticed on re-check')
      return true
    }
  }
}
