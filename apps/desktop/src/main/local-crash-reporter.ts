import { join } from 'node:path'

import type { CrashReporterStartOptions } from 'electron'

// Local crash dumps (plan 166 S3 step 3). Crashpad writes a minidump for any
// crashed Electron process (main, renderer, GPU, utility) into
// `<userData>/Crashpad`. Nothing is uploaded: there is no submit URL and
// `uploadToServer` is false. Crashpad ships inside Electron's framework, so
// this needs no entitlement and no extra signing step.

export const LOCAL_CRASH_REPORTER_OPTIONS: CrashReporterStartOptions = Object.freeze({
  uploadToServer: false
})

export function localCrashDumpsPath(userDataDir: string): string {
  return join(userDataDir, 'Crashpad')
}

export interface LocalCrashReporterDeps {
  setCrashDumpsPath: (path: string) => void
  start: (options: CrashReporterStartOptions) => void
  onError?: (error: unknown) => void
}

/**
 * Pins the dump directory under the (possibly smoke-isolated) userData dir,
 * then starts Crashpad with uploads off. Call before `app.ready`. A failure
 * is reported and swallowed: crash dumps are evidence, never a launch gate.
 */
export function startLocalCrashReporter(
  userDataDir: string,
  deps: LocalCrashReporterDeps
): boolean {
  try {
    deps.setCrashDumpsPath(localCrashDumpsPath(userDataDir))
    deps.start({ ...LOCAL_CRASH_REPORTER_OPTIONS })
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}
