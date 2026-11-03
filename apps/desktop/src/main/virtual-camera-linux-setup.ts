// Plan 214 D1: loading v4l2loopback for Videorc Camera on Linux.
//
// The backend detects the module (installed, loaded, the device by name)
// and reports `needs-setup` with the distribution's install command; this
// module is the one step that needs the desktop session: polkit's password
// dialog. It runs `pkexec modprobe …` with an argv array, never a shell
// string, and turns the outcome into a plain result the Output page can
// show: loaded, cancelled, not installed, Secure Boot refused it, or what
// modprobe said. The backend's next probe (within a second) settles the
// status; main reports `setting-up` while this runs and never guesses the
// rest. No kernel module is bundled, built or signed (D9).
//
// Pure and electron-free so it is unit-testable; the orchestrator wires
// `runLinuxLoadModule` into the IPC channel Workstream E owns.

import { execFile as childExecFile } from 'node:child_process'

export const V4L2LOOPBACK_MODULE = 'v4l2loopback'
/** `card_label`, shared with the backend's `VIRTUAL_CAMERA_LINUX_CARD_LABEL`. */
export const VIDEORC_CAMERA_CARD_LABEL = 'Videorc Camera'
/** `video_nr`, shared with the backend's `VIRTUAL_CAMERA_LINUX_VIDEO_NR`. */
export const VIDEORC_CAMERA_VIDEO_NR = 42
export const PKEXEC = 'pkexec'

/**
 * `modprobe`'s argv, one array. kmod quotes a value with a space on its
 * own, so `card_label=Videorc Camera` reaches the kernel as
 * `card_label="Videorc Camera"`; a literal quote here would be passed
 * through and stripped, so either spelling works and this one needs no
 * escaping.
 */
export const LOAD_MODULE_ARGS: readonly string[] = Object.freeze([
  'modprobe',
  V4L2LOOPBACK_MODULE,
  'exclusive_caps=1',
  `card_label=${VIDEORC_CAMERA_CARD_LABEL}`,
  `video_nr=${VIDEORC_CAMERA_VIDEO_NR}`
])

/** The same load as a terminal line, for the fallback copy. */
export const LOAD_MODULE_TERMINAL_LINE = `sudo modprobe ${V4L2LOOPBACK_MODULE} exclusive_caps=1 card_label="${VIDEORC_CAMERA_CARD_LABEL}" video_nr=${VIDEORC_CAMERA_VIDEO_NR}`

/** polkit's dialog waits for the person; two minutes is plenty. */
export const LOAD_MODULE_TIMEOUT_MS = 120_000

export type LinuxLoadModuleOutcome =
  | 'loaded'
  /** The person dismissed polkit's dialog (pkexec exits 126). */
  | 'cancelled'
  /** polkit refused: no admin, a wrong password three times, or no agent (127). */
  | 'not-authorized'
  /** modprobe found no module for this kernel: install the package first. */
  | 'not-installed'
  /** The kernel refused the unsigned module under Secure Boot or lockdown. */
  | 'secure-boot'
  /** No `pkexec` on this box. */
  | 'no-pkexec'
  | 'timed-out'
  | 'not-linux'
  | 'failed'

export interface LinuxLoadModuleResult {
  ok: boolean
  /** Plain copy for the Output page when `ok` is false. */
  message?: string
  outcome: LinuxLoadModuleOutcome
}

/** What one `pkexec modprobe` run came back with. */
export interface LoadModuleRun {
  /** The errno name when the process could not be spawned (`ENOENT`). */
  spawnErrorCode: string | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** The runner killed it at the timeout. */
  timedOut: boolean
  stderr: string
}

export type LoadModuleExec = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<LoadModuleRun>

/** The last non-empty stderr line: what modprobe or pkexec said. */
function lastLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? ''
}

/** Pure. One run's outcome and the words for it. */
export function classifyLoadModuleRun(run: LoadModuleRun): LinuxLoadModuleResult {
  if (run.spawnErrorCode === 'ENOENT') {
    return {
      ok: false,
      outcome: 'no-pkexec',
      message: `pkexec (polkit) isn't installed, so Videorc can't ask for your password. In a terminal: ${LOAD_MODULE_TERMINAL_LINE}`
    }
  }
  if (run.spawnErrorCode) {
    return {
      ok: false,
      outcome: 'failed',
      message: `Videorc couldn't run pkexec (${run.spawnErrorCode}). In a terminal: ${LOAD_MODULE_TERMINAL_LINE}`
    }
  }
  if (run.timedOut) {
    return {
      ok: false,
      outcome: 'timed-out',
      message: 'The password dialog timed out. Choose Load module to try again.'
    }
  }
  if (run.exitCode === 0) {
    return { ok: true, outcome: 'loaded' }
  }
  const stderr = run.stderr.toLowerCase()
  if (/not found in directory|module v4l2loopback not found|could not resolve/.test(stderr)) {
    return {
      ok: false,
      outcome: 'not-installed',
      message:
        'v4l2loopback is not installed for this kernel. Install it with the command above, then choose Load module.'
    }
  }
  if (/key was rejected|required key not available|lockdown|secure boot/.test(stderr)) {
    return {
      ok: false,
      outcome: 'secure-boot',
      message:
        'Secure Boot refused the unsigned v4l2loopback module. Sign it with your Machine Owner Key (MOK) or turn Secure Boot off in firmware, then choose Load module.'
    }
  }
  if (run.exitCode === 126) {
    return {
      ok: false,
      outcome: 'cancelled',
      message: 'Loading was cancelled. Choose Load module to try again.'
    }
  }
  if (run.exitCode === 127) {
    return {
      ok: false,
      outcome: 'not-authorized',
      message: `Linux didn't authorize the load (an administrator's password is needed). In a terminal: ${LOAD_MODULE_TERMINAL_LINE}`
    }
  }
  if (run.signal) {
    return {
      ok: false,
      outcome: 'failed',
      message: `pkexec ended by ${run.signal}. Choose Load module to try again.`
    }
  }
  const detail = lastLine(run.stderr)
  return {
    ok: false,
    outcome: 'failed',
    message: detail
      ? `modprobe failed: ${detail}`
      : `modprobe exited with ${run.exitCode ?? 'no code'}. In a terminal: ${LOAD_MODULE_TERMINAL_LINE}`
  }
}

/** `execFile` with no shell, stdin closed at once, every outcome as data. */
export const nodeLoadModuleExec: LoadModuleExec = (file, args, options) =>
  new Promise((resolve) => {
    const child = childExecFile(
      file,
      args,
      { timeout: options.timeout, encoding: 'utf8', windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ spawnErrorCode: null, exitCode: 0, signal: null, timedOut: false, stderr })
          return
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string
          signal?: NodeJS.Signals | null
          killed?: boolean
        }
        resolve({
          spawnErrorCode: typeof failure.code === 'string' ? failure.code : null,
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          signal: failure.signal ?? null,
          timedOut: failure.killed === true && failure.signal === 'SIGTERM',
          stderr: typeof stderr === 'string' ? stderr : ''
        })
      }
    )
    child.stdin?.end()
  })

export interface LinuxModuleLoaderDeps {
  platform?: NodeJS.Platform
  exec?: LoadModuleExec
  log?: (line: string) => void
}

export interface LinuxModuleLoader {
  /** Runs the load; a second call while one runs joins it. */
  load(): Promise<LinuxLoadModuleResult>
}

export function createLinuxModuleLoader(deps: LinuxModuleLoaderDeps = {}): LinuxModuleLoader {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? nodeLoadModuleExec
  const log = deps.log ?? (() => {})
  let pending: Promise<LinuxLoadModuleResult> | null = null

  const run = async (): Promise<LinuxLoadModuleResult> => {
    if (platform !== 'linux') {
      return {
        ok: false,
        outcome: 'not-linux',
        message: "Videorc Camera's module load runs on Linux only."
      }
    }
    log(`Videorc Camera: ${PKEXEC} ${LOAD_MODULE_ARGS.join(' ')}`)
    const result = classifyLoadModuleRun(
      await exec(PKEXEC, [...LOAD_MODULE_ARGS], { timeout: LOAD_MODULE_TIMEOUT_MS })
    )
    log(
      `Videorc Camera: v4l2loopback load ${result.outcome}${result.message ? ` (${result.message})` : ''}`
    )
    return result
  }

  return {
    load() {
      if (pending) return pending
      pending = run().finally(() => {
        pending = null
      })
      return pending
    }
  }
}

let defaultLoader: LinuxModuleLoader | null = null

/**
 * Loads v4l2loopback with Videorc Camera's parameters through polkit and
 * reports a plain result. The IPC handler Workstream E owns calls this.
 */
export function runLinuxLoadModule(): Promise<LinuxLoadModuleResult> {
  defaultLoader ??= createLinuxModuleLoader()
  return defaultLoader.load()
}
