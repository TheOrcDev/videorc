import { existsSync } from 'node:fs'
import { join } from 'node:path'

// electron-builder bakes the feed into `<resources>/app-update.yml` for the
// installers (dmg/zip, NSIS) only. A `--dir` package has no such file, so every
// check electron-updater started there failed with ENOENT on that path, in
// every smoke log. Without the file, and with no feed pinned in code (operator
// pilot), there is nothing to check: the updater skips and says so once.
// Kept electron-free so it is unit-testable.

export const APP_UPDATE_CONFIG_FILE = 'app-update.yml'

export type AppUpdateConfigGate = (feedPinned: boolean) => boolean

export function createAppUpdateConfigGate(options: {
  resourcesPath: string
  fileExists?: (path: string) => boolean
  log: (message: string) => void
}): AppUpdateConfigGate {
  const fileExists = options.fileExists ?? existsSync
  const configPath = join(options.resourcesPath, APP_UPDATE_CONFIG_FILE)
  let present: boolean | null = null
  return (feedPinned) => {
    // A pinned feed never reads the file to check.
    if (feedPinned) {
      return true
    }
    if (present === null) {
      present = fileExists(configPath)
      if (!present) {
        options.log(
          `[auto-update] no ${APP_UPDATE_CONFIG_FILE} at ${configPath} (a dev or --dir build); update checks are off.`
        )
      }
    }
    return present
  }
}
