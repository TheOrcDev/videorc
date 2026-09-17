import type { BackendRestartBoundary, MediaAccessResult } from '../shared/backend'

export type MediaAccessPane = 'camera' | 'microphone'

export type MediaAccessRestartResult = {
  /** True when the grant transitioned and the capture backend was restarted. */
  restarted: boolean
  /** The process whose capture state predates the grant, without its renderer token. */
  staleBackend?: BackendRestartBoundary
}

export type { MediaAccessResult }

export interface MediaAccessDeps {
  getStatus: (pane: MediaAccessPane) => string
  askForAccess: (pane: MediaAccessPane) => Promise<boolean>
  restartBackend: (reason: string) => Promise<MediaAccessRestartResult>
  stopGrantWatcher: () => void
  log: (level: 'info' | 'warn', message: string) => void
}

// Permissions onboarding: fire the native macOS grant prompt in place. The
// backend restart exists to initialize capture for a FRESH grant — when the
// grant already existed, restarting is pure churn (and races whatever the
// renderer does next), so it is skipped.
export async function requestMediaAccessWithRestart(
  deps: MediaAccessDeps,
  pane: MediaAccessPane
): Promise<MediaAccessResult> {
  let status: string
  try {
    status = deps.getStatus(pane)
  } catch (error) {
    deps.log('warn', `Could not read ${pane} permission status: ${String(error)}`)
    return { granted: false, restarted: false }
  }

  if (status === 'granted') {
    return { granted: true, restarted: false }
  }
  if (status !== 'not-determined') {
    // macOS never re-prompts after a denial — System Settings is the only door.
    return { granted: false, restarted: false }
  }

  let granted: boolean
  try {
    granted = await deps.askForAccess(pane)
  } catch (error) {
    deps.log('warn', `Could not request ${pane} permission: ${String(error)}`)
    return { granted: false, restarted: false }
  }
  if (!granted) {
    return { granted: false, restarted: false }
  }

  deps.stopGrantWatcher()
  const restart = await deps.restartBackend(
    `Restarting capture backend after ${pane} permission became available.`
  )
  return { granted: true, ...restart }
}
