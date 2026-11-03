// Plan 214 C2 (D8): the one-time, elevated setup of Videorc Camera on
// Windows. The media source DLL must be registered machine-wide (HKLM) and
// live outside the user's profile, because the Frame Server loads it as
// Local Service; the installer is per-user. So the "Set up Videorc Camera"
// button runs `videorc-camera-setup.exe` once through one UAC prompt. The
// backend detects the result itself (the registry key and the DLL version),
// so this module only runs the exe and reports plainly.
//
// Elevation: the exe is started unelevated with an argv array (never a
// shell string). It asks Windows for the one UAC prompt itself, starts its
// elevated copy with fixed arguments, waits, and exits with that copy's exit
// code after printing one plain line for it. Both files ship as
// extraResources beside `videorc-backend.exe` (electron-builder.yml,
// win.extraResources). Workstream E owns the IPC channel that calls
// `runWindowsCameraSetup`.

import { execFile as childExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Cargo's name for the media source cdylib. */
export const WINDOWS_CAMERA_DLL_FILE_NAME = 'videorc_virtual_camera_windows.dll'
export const WINDOWS_CAMERA_SETUP_EXE_FILE_NAME = 'videorc-camera-setup.exe'
/** Bounded: the UAC prompt plus a copy and a few registry writes. */
export const WINDOWS_CAMERA_SETUP_TIMEOUT_MS = 180_000
/** `SetupExit::Declined`: the person said No at the UAC prompt. */
export const WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE = 3

export interface WindowsCameraSetupResult {
  ok: boolean
  /** Plain copy for the status line or a toast; absent on success. */
  message?: string
}

export interface WindowsCameraSetupRun {
  code: number | null
  stdout: string
  stderr: string
  error?: Error
  timedOut?: boolean
}

export interface WindowsCameraSetupEnvironment {
  platform: NodeJS.Platform
  /** `process.resourcesPath`. */
  resourcesPath: string
  exists: (path: string) => boolean
  /** Runs `file` with `args` (no shell) and resolves with what it produced. */
  run: (file: string, args: string[], timeoutMs: number) => Promise<WindowsCameraSetupRun>
}

/** Pure. The exe's arguments: `/install`, or `/remove` to undo it. */
export function windowsCameraSetupArgs({ remove = false }: { remove?: boolean } = {}): string[] {
  return [remove ? '/remove' : '/install']
}

/**
 * Pure. The result for the exe's exit code and output. The exe's first
 * line on failure is already plain copy for the person (`SetupExit::line`);
 * the lines after it are detail for an administrator terminal.
 */
export function windowsCameraSetupResultFromRun(
  run: WindowsCameraSetupRun,
  { remove = false }: { remove?: boolean } = {}
): WindowsCameraSetupResult {
  const what = remove ? 'remove Videorc Camera' : 'set up Videorc Camera'
  if (run.code === 0) {
    return { ok: true }
  }
  if (run.code === WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE) {
    return {
      ok: false,
      message: `Windows needs your permission to ${what}. Try again and choose Yes in the prompt.`
    }
  }
  if (run.timedOut) {
    return {
      ok: false,
      message: `Could not ${what}: it did not finish within ${WINDOWS_CAMERA_SETUP_TIMEOUT_MS / 60_000} minutes.`
    }
  }
  if (run.code === null) {
    return {
      ok: false,
      message: `Could not ${what}: ${run.error?.message ?? 'the setup did not start'}`
    }
  }
  const firstLine = `${run.stderr}\n${run.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return {
    ok: false,
    message: firstLine ?? `Could not ${what} (exit code ${run.code}).`
  }
}

function runWithExecFile(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<WindowsCameraSetupRun> {
  return new Promise((resolve) => {
    childExecFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean }) | null
        resolve({
          code: !failure ? 0 : typeof failure.code === 'number' ? failure.code : null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: failure ?? undefined,
          timedOut: failure?.killed === true
        })
      }
    )
  })
}

export function defaultWindowsCameraSetupEnvironment(): WindowsCameraSetupEnvironment {
  return {
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    exists: (path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    },
    run: runWithExecFile
  }
}

/**
 * Runs the setup exe (one UAC prompt) and reports a plain result. The
 * backend notices the registry and DLL itself; nothing else to do here.
 */
export async function runWindowsCameraSetup(
  options: { remove?: boolean; environment?: WindowsCameraSetupEnvironment } = {}
): Promise<WindowsCameraSetupResult> {
  const remove = options.remove ?? false
  const environment = options.environment ?? defaultWindowsCameraSetupEnvironment()
  if (environment.platform !== 'win32') {
    return { ok: false, message: 'Videorc Camera setup is a Windows step.' }
  }
  const exePath = join(environment.resourcesPath, WINDOWS_CAMERA_SETUP_EXE_FILE_NAME)
  const dllPath = join(environment.resourcesPath, WINDOWS_CAMERA_DLL_FILE_NAME)
  if (!environment.exists(exePath) || (!remove && !environment.exists(dllPath))) {
    return {
      ok: false,
      message: 'This Videorc build is missing the Videorc Camera files. Reinstall Videorc.'
    }
  }
  const run = await environment.run(
    exePath,
    windowsCameraSetupArgs({ remove }),
    WINDOWS_CAMERA_SETUP_TIMEOUT_MS
  )
  return windowsCameraSetupResultFromRun(run, { remove })
}
