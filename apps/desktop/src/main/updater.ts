import { app, Notification } from 'electron'
import electronUpdater from 'electron-updater'

import { safeConsole } from './safe-console'

const { autoUpdater } = electronUpdater

// Background auto-update for packaged, signed builds. The feed URL lives in the
// app's app-update.yml (baked from electron-builder's `publish` config →
// https://videorc.com/api/updates → R2). Updates download in the background and
// apply on the NEXT quit (autoInstallOnAppQuit) — never a forced restart, so an
// in-progress recording is never interrupted. Set VIDEORC_DISABLE_AUTO_UPDATE=1
// to opt out; dev builds skip it (there is no app-update.yml to read).
// See "2026-06-30 - Videorc Desktop Distribution Channel Plan" (Slice 5).
export function initAutoUpdater(): void {
  if (!app.isPackaged || process.env.VIDEORC_DISABLE_AUTO_UPDATE === '1') {
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    safeConsole.log(`[auto-update] ${info.version} available; downloading in the background.`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    safeConsole.log(`[auto-update] ${info.version} downloaded; will apply on next quit.`)
    // Non-blocking heads-up. We deliberately do not prompt to restart — the
    // update lands on the next natural quit so it can never interrupt a capture.
    if (Notification.isSupported()) {
      new Notification({
        title: `Videorc ${info.version} is ready`,
        body: 'It will be applied the next time you quit Videorc.',
        silent: true
      }).show()
    }
  })

  autoUpdater.on('error', (error) => {
    // Update failures are non-fatal and invisible to the user.
    safeConsole.warn(
      `[auto-update] error: ${error instanceof Error ? error.message : String(error)}`
    )
  })

  void autoUpdater.checkForUpdates().catch((error) => {
    safeConsole.warn(
      `[auto-update] check failed: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}
