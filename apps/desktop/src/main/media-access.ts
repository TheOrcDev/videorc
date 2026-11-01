import type {
  BackendRestartBoundary,
  MediaAccessResult,
  MediaAccessStatus,
  ScreenAccessResult
} from '../shared/backend'

export type MediaAccessPane = 'camera' | 'microphone'

export type MediaAccessRestartResult = {
  /** True when the grant transitioned and the capture backend was restarted. */
  restarted: boolean
  /** The process whose capture state predates the grant, without its renderer token. */
  staleBackend?: BackendRestartBoundary
}

export type { MediaAccessResult, ScreenAccessResult }

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

export interface ScreenAccessDeps {
  platform: NodeJS.Platform
  getStatus: () => string
  /** The request that adds the app to Screen & System Audio Recording. */
  requestAccess: () => Promise<void>
  /** Starts the grant watcher for the screen pane (restart once on grant). */
  watchGrant: (reason: string) => void
  restartBackend: (reason: string) => Promise<MediaAccessRestartResult>
  stopGrantWatcher: () => void
  log: (level: 'info' | 'warn', message: string) => void
}

export const SCREEN_ACCESS_RESTART_REASON =
  'Restarting capture backend after Screen Recording permission became available.'

function screenStatus(raw: string): MediaAccessStatus {
  switch (raw) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'not-determined':
    case 'not-applicable':
      return raw
    default:
      return 'unknown'
  }
}

// Plan 203 S2: the in-place Screen & System Audio Recording request. Only a
// never-asked Mac is asked (macOS never re-prompts after a denial; System
// Settings is the only door there). The watcher starts BEFORE the request so
// a grant that lands at once still counts as a transition, and it outlives
// the request: macOS answers the first screen prompt in System Settings, not
// in place, so `status` right after is usually still 'not-determined'.
export async function requestScreenAccessWithWatch(
  deps: ScreenAccessDeps
): Promise<ScreenAccessResult> {
  if (deps.platform !== 'darwin') {
    return { status: 'not-applicable', granted: false, restarted: false }
  }

  let status: MediaAccessStatus
  try {
    status = screenStatus(deps.getStatus())
  } catch (error) {
    deps.log('warn', `Could not read screen permission status: ${String(error)}`)
    return { status: 'unknown', granted: false, restarted: false }
  }

  if (status === 'granted') {
    return { status, granted: true, restarted: false }
  }
  if (status !== 'not-determined') {
    return { status, granted: false, restarted: false }
  }

  deps.watchGrant(SCREEN_ACCESS_RESTART_REASON)
  try {
    await deps.requestAccess()
  } catch (error) {
    deps.log('warn', `Could not request screen permission: ${String(error)}`)
  }

  let next: MediaAccessStatus
  try {
    next = screenStatus(deps.getStatus())
  } catch (error) {
    deps.log('warn', `Could not re-read screen permission status: ${String(error)}`)
    return { status: 'unknown', granted: false, restarted: false }
  }
  if (next !== 'granted') {
    // The watcher keeps looking; the grant lands in System Settings.
    return { status: next, granted: false, restarted: false }
  }

  // Granted in place (an already-listed app re-asked, or a managed grant):
  // the same single restart the camera path makes, never a second one from
  // the watcher.
  deps.stopGrantWatcher()
  const restart = await deps.restartBackend(SCREEN_ACCESS_RESTART_REASON)
  return { status: next, granted: true, ...restart }
}
