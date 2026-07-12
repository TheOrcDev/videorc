export type MediaAccessPane = 'camera' | 'microphone'

export interface MediaAccessResult {
  granted: boolean
  /** True when the grant transitioned and the capture backend was restarted.
   * Callers that probe a device right after (the mic meter sample) must wait
   * for the backend to reconnect first — sampling mid-restart is the FX1 race
   * that left the permissions-dialog chip stuck on "Checked on first use". */
  restarted: boolean
}

export interface MediaAccessDeps {
  getStatus: (pane: MediaAccessPane) => string
  askForAccess: (pane: MediaAccessPane) => Promise<boolean>
  restartBackend: (reason: string) => Promise<boolean | void>
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
  const restarted =
    (await deps.restartBackend(
      `Restarting capture backend after ${pane} permission became available.`
    )) !== false
  return { granted: true, restarted }
}
