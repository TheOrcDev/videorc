// Plan 214 C2 (D8): the one-time, elevated setup of Videorc Camera on
// Windows. The media source DLL must be registered machine-wide (HKLM) and
// live outside the user's profile, because the Frame Server loads it as
// Local Service; the installer is per-user. So the "Set up Videorc Camera"
// button runs `videorc-camera-setup.exe` once through one UAC prompt. The
// backend detects the result itself (the registry key and the DLL version),
// so this module only runs the exe and reports plainly.
//
// Elevation: Windows has no API Electron can call to elevate a child, so the
// exe is started through PowerShell's `Start-Process -Verb RunAs -Wait`,
// which shows the UAC prompt and waits for the elevated process. Both
// files ship as extraResources beside `videorc-backend.exe`
// (electron-builder.yml, win.extraResources). Workstream E owns the IPC
// channel that calls `runWindowsCameraSetup`.

import { execFile as childExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Cargo's name for the media source cdylib. */
export const WINDOWS_CAMERA_DLL_FILE_NAME = 'videorc_virtual_camera_windows.dll'
export const WINDOWS_CAMERA_SETUP_EXE_FILE_NAME = 'videorc-camera-setup.exe'
/** Bounded: the UAC prompt plus a copy and a few registry writes. */
export const WINDOWS_CAMERA_SETUP_TIMEOUT_MS = 180_000

export interface WindowsCameraSetupResult {
  ok: boolean
  /** Plain copy for the status line or a toast; absent on success. */
  message?: string
}

export interface WindowsCameraSetupCommand {
  file: string
  args: string[]
}

export interface WindowsCameraSetupEnvironment {
  platform: NodeJS.Platform
  /** `process.resourcesPath`. */
  resourcesPath: string
  exists: (path: string) => boolean
  /** Runs `file args` and resolves with what it produced. */
  run: (
    file: string,
    args: string[],
    timeoutMs: number
  ) => Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>
}

/** Pure. A string inside a single-quoted PowerShell literal. */
export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Pure. The command that runs the setup exe elevated and exits with its
 * exit code. `remove` undoes the setup instead.
 */
export function windowsCameraSetupCommand({
  exePath,
  dllPath,
  remove = false
}: {
  exePath: string
  dllPath: string
  remove?: boolean
}): WindowsCameraSetupCommand {
  const argumentList = remove
    ? `@('/remove')`
    : `@('/install', '/dll', ${quoteForPowerShell(dllPath)})`
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$process = Start-Process -FilePath ${quoteForPowerShell(exePath)} -ArgumentList ${argumentList} -Verb RunAs -Wait -PassThru`,
    'exit $process.ExitCode'
  ].join('; ')
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  }
}

/** Pure. The result for what PowerShell and the exe reported. */
export function windowsCameraSetupResultFromRun(
  {
    code,
    stdout,
    stderr,
    error
  }: { code: number | null; stdout: string; stderr: string; error?: Error },
  { remove = false }: { remove?: boolean } = {}
): WindowsCameraSetupResult {
  const what = remove ? 'remove Videorc Camera' : 'set up Videorc Camera'
  if (code === 0) {
    return { ok: true }
  }
  const text = `${stderr}\n${stdout}\n${error?.message ?? ''}`
  if (/canceled by the user|cancelled by the user|0x800704C7|ERROR_CANCELLED/i.test(text)) {
    return {
      ok: false,
      message: `Windows needs your permission to ${what}. Try again and choose Yes in the prompt.`
    }
  }
  if (error && code === null) {
    return { ok: false, message: `Could not ${what}: ${error.message}` }
  }
  const lastLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop()
  return {
    ok: false,
    message: lastLine
      ? `Could not ${what}: ${lastLine}`
      : `Could not ${what} (exit code ${code ?? 'unknown'}).`
  }
}

function runWithExecFile(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    childExecFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? null)
            : error
              ? null
              : 0
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: error ?? undefined
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
 * Runs the setup exe elevated (one UAC prompt) and reports a plain result.
 * The backend notices the registry and DLL itself; nothing else to do here.
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
  const command = windowsCameraSetupCommand({ exePath, dllPath, remove })
  const run = await environment.run(command.file, command.args, WINDOWS_CAMERA_SETUP_TIMEOUT_MS)
  return windowsCameraSetupResultFromRun(run, { remove })
}
