import type { SystemPermissionPane } from '../shared/backend'

export type MediaAccessPermissionName = 'camera' | 'microphone' | 'screen'
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export type MediaPermissionGrantWatcher = {
  stop: () => void
  watch: (pane: SystemPermissionPane, reason: string) => void
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

  const stop = (): void => {
    watchId += 1
    if (timer) {
      clearTimeout(timer)
      timer = null
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
          watchId += 1
          log?.('info', `${pane} permission is now granted; requesting a capture backend restart.`)
          try {
            await restartBackend(reason)
          } catch (error) {
            log?.(
              'warn',
              `Could not restart capture backend after ${pane} permission grant: ${error instanceof Error ? error.message : String(error)}`
            )
          }
          return
        }
        previousStatus = status

        remainingChecks -= 1
        if (remainingChecks <= 0) {
          timer = null
          log?.('warn', `${pane} permission did not become granted before the watcher timed out.`)
          return
        }

        schedule(() => {
          void poll()
        })
      }

      schedule(() => {
        void poll()
      })
    }
  }
}
