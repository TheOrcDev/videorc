import { app, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

import type { UpdateStatus } from '../shared/backend'
import type { AcquireBackendInterruption } from './interruption-actions'
import { safeConsole } from './safe-console'
import { secureIpcHandle, sendElectronEvent } from './secure-ipc'
import { installUpdateWithInterruptionLease } from './updater-install'
import { shouldRetryUpdateOnMirror, UPDATE_FEED_URLS } from './updater-mirror'
import type { UpdateFeedRoute } from './updater-mirror'
import {
  BACKGROUND_RECHECK_INTERVAL_MS,
  isMissingUpdateFeedError,
  shouldAutoDownload,
  shouldBackgroundRecheck,
  updateStatusFromEvent
} from './updater-status'
import {
  accountPilotUpdaterConfig,
  consumeWindowsUpdaterStartupConfig,
  isWindowsPilotUpdateGrant,
  shouldProbeAccountPilotFeed,
  WINDOWS_PILOT_UPDATE_URL
} from './windows-pilot-update'
import type { PublicFeedOutcome } from './windows-pilot-update'

const { autoUpdater } = electronUpdater

// One shared electron-updater singleton drives two flows:
//   • a silent background check on every launch (default for packaged builds;
//     opt out via VIDEORC_DISABLE_AUTO_UPDATE=1) that downloads and applies on
//     the NEXT quit (autoInstallOnAppQuit), so a recording is never cut off; and
//   • a manual "Check for updates / Download / Restart & install" button in
//     Settings → About & updates, driven over IPC.
//
// Both flows download explicitly (autoDownload = false) and share one cached
// UpdateStatus that is pushed to the renderer on every transition. The feed
// itself lives at electron-builder.yml's `publish.url`; until videorc-web serves
// it, checks resolve to `error`/`not-available` and the UI degrades gracefully.

type MainWindowGetter = () => BrowserWindow | null
type CaptureInstallBlockedGetter = () => boolean

let currentStatus: UpdateStatus = { phase: 'idle' }
let getMainWindow: MainWindowGetter = () => null
let listenersAttached = false
let updaterConfigurationBlocked = false
let feedRoute: UpdateFeedRoute = 'primary'
// Operator pilot mode (env token) pins every check to the pilot feed.
let pilotFeedActive = false
// Signed-in Windows installs: the current check moved to the pilot feed with a
// short-lived account token. Every check starts on the public feed again.
let accountPilotActive = false
let probingAccountPilot = false
let requestAccountPilotGrant: (() => Promise<unknown>) | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A caught updater failure becomes the benign 'unsupported' state when it is
// just an unpublished feed (no channel for this platform yet); otherwise it is
// a real, user-facing error.
function setStatusFromUpdaterError(message: string): void {
  setStatus(
    updateStatusFromEvent(
      isMissingUpdateFeedError(message)
        ? process.platform === 'win32'
          ? { type: 'unsupported', reason: 'windows-feed-unpublished' }
          : { type: 'unsupported' }
        : { type: 'error', message }
    )
  )
}

function setStatus(next: UpdateStatus): void {
  currentStatus = next
  const window = getMainWindow()
  if (window && !window.webContents.isDestroyed()) {
    sendElectronEvent(window.webContents, 'app:update-status', next)
  }
}

// The feed baked into the build is the primary route, so it needs no
// setFeedURL until the first fallback has moved the updater off it.
function switchFeedRoute(route: UpdateFeedRoute): void {
  if (pilotFeedActive || accountPilotActive || feedRoute === route) {
    return
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URLS[route] })
  feedRoute = route
}

function retriesOnMirror(error: unknown): boolean {
  return shouldRetryUpdateOnMirror({
    message: errorMessage(error),
    pilot: pilotFeedActive || accountPilotActive,
    route: feedRoute
  })
}

// Every check starts on the primary route and falls back to the mirror once
// when the primary fails in transport (a blocked storage origin). If the
// mirror fails too, the primary's error is the one worth reporting.
async function checkForUpdatesWithMirrorFallback(): Promise<void> {
  switchFeedRoute('primary')
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (!retriesOnMirror(error)) {
      throw error
    }
    safeConsole.warn(`[auto-update] primary feed failed (${errorMessage(error)}), retrying mirror`)
    switchFeedRoute('mirror')
    try {
      await autoUpdater.checkForUpdates()
    } catch (mirrorError) {
      safeConsole.warn(`[auto-update] mirror feed failed: ${errorMessage(mirrorError)}`)
      throw error
    }
  }
}

function leaveAccountPilotFeed(): void {
  if (!accountPilotActive) {
    return
  }
  accountPilotActive = false
  autoUpdater.requestHeaders = null
  autoUpdater.disableDifferentialDownload = false
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URLS.primary })
  feedRoute = 'primary'
}

// Returns a fresh pilot bearer for this signed-in install, or null when the
// account is signed out, the pilot is closed, or the backend is unavailable.
async function accountPilotRequestHeaders(): Promise<Record<string, string> | null> {
  if (!requestAccountPilotGrant) {
    return null
  }
  try {
    const grant = await requestAccountPilotGrant()
    return isWindowsPilotUpdateGrant(grant) ? accountPilotUpdaterConfig(grant).requestHeaders : null
  } catch (error) {
    safeConsole.warn(`[auto-update] Windows pilot access unavailable: ${errorMessage(error)}`)
    return null
  }
}

async function enterAccountPilotFeed(): Promise<boolean> {
  const requestHeaders = await accountPilotRequestHeaders()
  if (!requestHeaders) {
    return false
  }
  // The bearer stays on the branded proxy: the pilot route streams bytes and
  // the full downloader never follows a cross-origin redirect with it.
  autoUpdater.setFeedURL({ provider: 'generic', url: WINDOWS_PILOT_UPDATE_URL })
  autoUpdater.requestHeaders = requestHeaders
  autoUpdater.disableDifferentialDownload = true
  accountPilotActive = true
  return true
}

function publicFeedOutcome(error: unknown): PublicFeedOutcome {
  if (error) {
    return isMissingUpdateFeedError(errorMessage(error)) ? 'missing-feed' : 'failed'
  }
  return currentStatus.phase === 'available' ? 'available' : 'not-available'
}

// Public feed first (with its mirror fallback). A signed-in Windows install
// then consults the pilot feed when public has nothing for it; a pilot failure
// restores the public outcome instead of surfacing a pilot-only error.
async function checkForUpdatesOnAllFeeds(): Promise<void> {
  leaveAccountPilotFeed()
  let publicError: unknown = null
  try {
    await checkForUpdatesWithMirrorFallback()
  } catch (error) {
    publicError = error
  }
  if (
    shouldProbeAccountPilotFeed({
      operatorPilot: pilotFeedActive,
      platform: process.platform,
      publicOutcome: publicFeedOutcome(publicError)
    }) &&
    (await enterAccountPilotFeed())
  ) {
    const publicStatus = currentStatus
    probingAccountPilot = true
    try {
      await autoUpdater.checkForUpdates()
      return
    } catch (error) {
      safeConsole.warn(`[auto-update] Windows pilot feed check failed: ${errorMessage(error)}`)
      leaveAccountPilotFeed()
      setStatus(publicStatus)
    } finally {
      probingAccountPilot = false
    }
  }
  if (publicError) {
    throw publicError
  }
}

// A download is bound to the update info of the route that was checked, so a
// fallback re-checks on the mirror before downloading from it.
async function downloadUpdateWithMirrorFallback(): Promise<void> {
  if (accountPilotActive) {
    // The pilot bearer is short-lived; a manual download can come long after
    // the check that found the update.
    const requestHeaders = await accountPilotRequestHeaders()
    if (!requestHeaders) {
      leaveAccountPilotFeed()
      throw new Error('Windows pilot update access ended. Check for updates again.')
    }
    autoUpdater.requestHeaders = requestHeaders
  }
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    if (!retriesOnMirror(error)) {
      throw error
    }
    safeConsole.warn(
      `[auto-update] primary download failed (${errorMessage(error)}), retrying mirror`
    )
    switchFeedRoute('mirror')
    try {
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
    } catch (mirrorError) {
      safeConsole.warn(`[auto-update] mirror download failed: ${errorMessage(mirrorError)}`)
      throw error
    }
  }
}

// Attach the autoUpdater event → UpdateStatus mapping exactly once. Safe to call
// from both initAutoUpdater (background) and registerUpdaterIpc (manual).
function attachUpdaterListeners(): void {
  if (listenersAttached) {
    return
  }
  listenersAttached = true

  // Manual + background both drive download explicitly.
  autoUpdater.autoDownload = false
  // A downloaded update still applies on the next natural quit even if the user
  // never clicks "Restart & install".
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () =>
    setStatus(updateStatusFromEvent({ type: 'checking' }))
  )
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setStatus(updateStatusFromEvent({ type: 'available', version: info.version }))
  })
  autoUpdater.on('update-not-available', () => {
    setStatus(updateStatusFromEvent({ type: 'not-available', currentVersion: app.getVersion() }))
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setStatus(updateStatusFromEvent({ type: 'progress', percent: progress.percent }))
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setStatus(updateStatusFromEvent({ type: 'downloaded', version: info.version }))
    safeConsole.log(`[auto-update] ${info.version} downloaded; ready to install.`)
    // Non-blocking heads-up for the background flow (the user may not be in
    // Settings). Accurate for the manual flow too — they can restart now or it
    // applies on the next quit.
    if (Notification.isSupported()) {
      new Notification({
        title: `Videorc ${info.version} is ready`,
        body: 'Restart Videorc to finish updating, or it will apply the next time you quit.',
        silent: true
      }).show()
    }
  })
  autoUpdater.on('error', (error) => {
    const message = errorMessage(error)
    // Update failures are non-fatal.
    safeConsole.warn(`[auto-update] error: ${message}`)
    // A failed pilot probe restores the public outcome; never flash its error.
    if (probingAccountPilot) {
      return
    }
    // A primary transport failure is about to be retried on the mirror; the
    // caller reports the outcome, so the UI never flashes an error in between.
    if (retriesOnMirror(error)) {
      return
    }
    setStatusFromUpdaterError(message)
  })
}

// Background auto-update for packaged, signed builds — ON by default since
// 0.9.10 (the feed has been live and verified since 0.9.0; the old opt-in flag
// dated from before it shipped, so users had to find Settings → Check for
// updates by hand). Every launch checks, downloads in the background, and
// applies on the NEXT quit — never a forced restart, so a recording is never
// cut off; the sidebar chip and Settings reflect the same shared status.
// Escape hatch: VIDEORC_DISABLE_AUTO_UPDATE=1.
export function initAutoUpdater(
  options: { requestWindowsPilotUpdateGrant?: () => Promise<unknown> } = {}
): void {
  if (!app.isPackaged) {
    delete process.env.VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN
    return
  }

  let backgroundUpdatesDisabled: boolean
  try {
    const startup = consumeWindowsUpdaterStartupConfig(process.env, process.platform)
    backgroundUpdatesDisabled = startup.backgroundUpdatesDisabled
    const pilot = startup.pilot
    if (pilot) {
      autoUpdater.setFeedURL({ provider: 'generic', url: pilot.url })
      pilotFeedActive = true
      autoUpdater.requestHeaders = pilot.requestHeaders
      // Keep the operator bearer on the branded proxy. electron-updater's
      // differential downloader follows redirects without cross-origin header
      // stripping, so pilot mode always uses the normal full downloader.
      autoUpdater.disableDifferentialDownload = pilot.disableDifferentialDownload
    }
  } catch (error) {
    updaterConfigurationBlocked = true
    safeConsole.warn(`[auto-update] pilot configuration blocked: ${errorMessage(error)}`)
    setStatus(updateStatusFromEvent({ type: 'unsupported' }))
    return
  }

  // Operator mode already pins the pilot feed; otherwise a signed-in Windows
  // install may follow it (manual checks included).
  if (process.platform === 'win32' && !pilotFeedActive) {
    requestAccountPilotGrant = options.requestWindowsPilotUpdateGrant ?? null
  }

  // The opt-out suppresses only silent checks. Pilot feed routing and bearer
  // ownership still apply to the packaged app's explicit manual update flow.
  if (backgroundUpdatesDisabled) return

  attachUpdaterListeners()

  // autoDownload is off, so kick the download ourselves when an update is found.
  autoUpdater.on('update-available', () => {
    void downloadUpdateWithMirrorFallback().catch((error) => {
      const message = errorMessage(error)
      safeConsole.warn(`[auto-update] background download failed: ${message}`)
      setStatusFromUpdaterError(message)
    })
  })

  const backgroundCheck = (): void => {
    void checkForUpdatesOnAllFeeds().catch((error) => {
      const message = errorMessage(error)
      safeConsole.warn(`[auto-update] check failed: ${message}`)
      setStatusFromUpdaterError(message)
    })
  }

  backgroundCheck()

  // The launch check alone misses every release shipped while the app stays
  // open — the sidebar chip never appeared until a full relaunch and the user
  // had to check manually in Settings. Re-check on an interval from settled
  // states so a running app surfaces new releases on its own.
  const recheckTimer = setInterval(() => {
    if (shouldBackgroundRecheck(currentStatus)) {
      backgroundCheck()
    }
  }, BACKGROUND_RECHECK_INTERVAL_MS)
  // Don't let the timer keep the process alive after the app quits.
  recheckTimer.unref?.()
}

// Wire the manual update controls (Settings → About & updates). A manual check
// works whenever the app is packaged (explicit user intent) and does NOT require
// VIDEORC_DISABLE_AUTO_UPDATE — that flag only gates the silent background check.
export function registerUpdaterIpc(
  mainWindowGetter: MainWindowGetter,
  captureInstallBlocked: CaptureInstallBlockedGetter,
  acquireInterruption: (
    reason: string,
    action: 'update-install'
  ) => ReturnType<AcquireBackendInterruption>
): void {
  getMainWindow = mainWindowGetter
  if (!updaterConfigurationBlocked) {
    attachUpdaterListeners()
  }

  secureIpcHandle('updates:get-status', () => currentStatus)

  secureIpcHandle('updates:check', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged || updaterConfigurationBlocked) {
      setStatus(updateStatusFromEvent({ type: 'unsupported' }))
      return currentStatus
    }
    try {
      setStatus(updateStatusFromEvent({ type: 'checking' }))
      await checkForUpdatesOnAllFeeds()
      // The events above have set the truth by the time checkForUpdates resolves.
      // If an update is available, start downloading immediately for a one-click
      // feel; progress + downloaded states flow through the listeners.
      if (shouldAutoDownload(currentStatus)) {
        void downloadUpdateWithMirrorFallback().catch((error) => {
          setStatus(updateStatusFromEvent({ type: 'error', message: errorMessage(error) }))
        })
      }
      return currentStatus
    } catch (error) {
      const message = errorMessage(error)
      safeConsole.warn(`[auto-update] check failed: ${message}`)
      setStatusFromUpdaterError(message)
      return currentStatus
    }
  })

  secureIpcHandle('updates:download', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged || updaterConfigurationBlocked) {
      setStatus(updateStatusFromEvent({ type: 'unsupported' }))
      return currentStatus
    }
    try {
      await downloadUpdateWithMirrorFallback()
      return currentStatus
    } catch (error) {
      const message = errorMessage(error)
      setStatusFromUpdaterError(message)
      return currentStatus
    }
  })

  // Quit, install, and relaunch. The renderer MUST block this while a capture is
  // live — never interrupt a recording.
  secureIpcHandle('updates:install', async () => {
    if (!app.isPackaged || updaterConfigurationBlocked) {
      return
    }
    try {
      const admission = await installUpdateWithInterruptionLease(
        captureInstallBlocked,
        () => acquireInterruption('Installing a downloaded Videorc update.', 'update-install'),
        () => autoUpdater.quitAndInstall()
      )
      if (admission !== 'installing') {
        safeConsole.warn(
          '[auto-update] install deferred because capture is active, starting, or unconfirmed.'
        )
      }
    } catch (error) {
      // Admission transport failures are fail-closed: never quit on a guess.
      safeConsole.warn(`[auto-update] install admission failed: ${errorMessage(error)}`)
    }
  })
}
