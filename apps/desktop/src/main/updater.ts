import { app, ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

import type { UpdateStatus } from '../shared/backend'
import { safeConsole } from './safe-console'
import {
  BACKGROUND_RECHECK_INTERVAL_MS,
  isMissingUpdateFeedError,
  shouldAutoDownload,
  shouldBackgroundRecheck,
  updateStatusFromEvent
} from './updater-status'

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

let currentStatus: UpdateStatus = { phase: 'idle' }
let getMainWindow: MainWindowGetter = () => null
let listenersAttached = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A caught updater failure becomes the benign 'unsupported' state when it is
// just an unpublished feed (no channel for this platform yet); otherwise it is
// a real, user-facing error.
function setStatusFromUpdaterError(message: string): void {
  setStatus(
    updateStatusFromEvent(
      isMissingUpdateFeedError(message) ? { type: 'unsupported' } : { type: 'error', message }
    )
  )
}

function setStatus(next: UpdateStatus): void {
  currentStatus = next
  const window = getMainWindow()
  if (window && !window.webContents.isDestroyed()) {
    window.webContents.send('app:update-status', next)
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
export function initAutoUpdater(): void {
  if (!app.isPackaged || process.env.VIDEORC_DISABLE_AUTO_UPDATE === '1') {
    return
  }

  attachUpdaterListeners()

  // autoDownload is off, so kick the download ourselves when an update is found.
  autoUpdater.on('update-available', () => {
    void autoUpdater.downloadUpdate().catch((error) => {
      safeConsole.warn(`[auto-update] background download failed: ${errorMessage(error)}`)
    })
  })

  const backgroundCheck = (): void => {
    void autoUpdater.checkForUpdates().catch((error) => {
      safeConsole.warn(`[auto-update] check failed: ${errorMessage(error)}`)
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
// VIDEORC_ENABLE_AUTO_UPDATE — that flag only gates the silent background check.
export function registerUpdaterIpc(mainWindowGetter: MainWindowGetter): void {
  getMainWindow = mainWindowGetter
  attachUpdaterListeners()

  ipcMain.handle('updates:get-status', () => currentStatus)

  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) {
      setStatus(updateStatusFromEvent({ type: 'unsupported' }))
      return currentStatus
    }
    try {
      setStatus(updateStatusFromEvent({ type: 'checking' }))
      await autoUpdater.checkForUpdates()
      // The events above have set the truth by the time checkForUpdates resolves.
      // If an update is available, start downloading immediately for a one-click
      // feel; progress + downloaded states flow through the listeners.
      if (shouldAutoDownload(currentStatus)) {
        void autoUpdater.downloadUpdate().catch((error) => {
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

  ipcMain.handle('updates:download', async (): Promise<UpdateStatus> => {
    if (!app.isPackaged) {
      setStatus(updateStatusFromEvent({ type: 'unsupported' }))
      return currentStatus
    }
    try {
      await autoUpdater.downloadUpdate()
      return currentStatus
    } catch (error) {
      const message = errorMessage(error)
      setStatusFromUpdaterError(message)
      return currentStatus
    }
  })

  // Quit, install, and relaunch. The renderer MUST block this while a capture is
  // live — never interrupt a recording.
  ipcMain.handle('updates:install', () => {
    if (!app.isPackaged) {
      return
    }
    autoUpdater.quitAndInstall()
  })
}
