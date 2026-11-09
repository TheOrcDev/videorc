// A logout, a shutdown, `pkill videorc` or Ctrl+C in a terminal sends the
// signal to every process of the app at once: a systemd scope stop, a name
// match or a process group. Chromium's zygote, GPU and network helpers then
// die while the browser process is still draining its quit, and Chromium
// relaunches the GPU process with no zygote left, fails nine times in about
// 2 ms and aborts with "GPU process isn't usable. Goodbye." That is a SIGTRAP,
// a core dump, and on Hyprland a "not responding" dialog that outlives the
// app (electron/electron#54547).
//
// Electron's own handler, installed after the main script so it replaces any
// listener added before `ready`, always quits gracefully. On Linux Videorc
// takes the three signals over once the app is ready:
//
//   • A signal sent to the main process alone still asks for the graceful
//     quit (the backend drain, the export guard), every time it arrives.
//   • A signal that reached the helpers too ends the app at once by that same
//     signal, before the relaunch storm, after the backend is handed its own
//     SIGTERM so it finalizes the recording itself.
//
// The helpers are checked when the signal arrives and for a short window
// after it. Renderers are never counted: their windows close, and they exit,
// during an ordinary quit too.
//
// Everything is injected so the policy is unit-testable; index.ts wires it to
// `process`, `app.getAppMetrics()` and `/proc`.

export const LINUX_TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const
export type LinuxTerminationSignal = (typeof LINUX_TERMINATION_SIGNALS)[number]

/** How often a signalled quit re-checks the helpers. The relaunch storm that
 * aborts Chromium starts about 15 ms after the helpers die. */
export const LINUX_HELPER_WATCH_INTERVAL_MS = 5
/** How long after the first signal a helper's exit still counts as the same
 * signal. An ordinary quit with nothing to drain takes about 120 ms, but
 * renderers are its only helpers that exit before Chromium tears down. */
export const LINUX_HELPER_WATCH_WINDOW_MS = 250

export type ChromiumHelperProcess = { pid: number; type: string }

export type LinuxTerminationSignalSource = {
  on(signal: LinuxTerminationSignal, listener: () => void): unknown
  removeAllListeners(signal: LinuxTerminationSignal): unknown
}

export type LinuxTerminationSignalOptions = {
  source: LinuxTerminationSignalSource
  browserPid: number
  /** Every Chromium process of the app; the browser itself is skipped. */
  listHelpers: () => ChromiumHelperProcess[]
  /** The text of `/proc/<pid>/stat`, or null when the process is gone. */
  readProcStat: (pid: number) => string | null
  requestQuit: (signal: LinuxTerminationSignal) => void
  /** Hands the backend its own SIGTERM and logs why; runs before the raise. */
  beforeEnd: (signal: LinuxTerminationSignal, reason: string) => void
  /** Delivers `signal` to this process; its listeners are already removed,
   * so the default action ends the app. */
  raise: (signal: LinuxTerminationSignal) => void
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  now: () => number
}

export type LinuxTerminationSignalTakeover = {
  /** Feed every `child-process-gone`: a helper that dies during a signalled
   * quit means the signal reached the whole app. */
  childProcessGone(details: { type: string; reason: string }): void
}

/** The state letter of a `/proc/<pid>/stat` line, or null when unparseable.
 * The command name may itself contain `)`, so the last one ends it. */
export function procStatState(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) {
    return null
  }
  const state = stat.slice(close + 2, close + 3)
  return /^[A-Za-z]$/.test(state) ? state : null
}

/** Names the first helper that has exited, or null while every one runs. A
 * helper still waiting to be reaped is a zombie (`Z`), not gone. Renderers
 * (`Tab`) are skipped: closing a window ends one in any quit. */
export function exitedChromiumHelper(
  helpers: readonly ChromiumHelperProcess[],
  browserPid: number,
  readProcStat: (pid: number) => string | null
): string | null {
  for (const helper of helpers) {
    if (helper.pid === browserPid || helper.type === 'Tab') {
      continue
    }
    const stat = readProcStat(helper.pid)
    const state = stat === null ? null : procStatState(stat)
    if (state === null) {
      return `${helper.type} process ${helper.pid} is gone`
    }
    if (state === 'Z' || state === 'X' || state === 'x') {
      return `${helper.type} process ${helper.pid} exited`
    }
  }
  return null
}

export function installLinuxTerminationSignalTakeover(
  options: LinuxTerminationSignalOptions
): LinuxTerminationSignalTakeover {
  let quitSignal: LinuxTerminationSignal | null = null
  let quitSignalAt = 0
  let watch: unknown = null
  let ended = false

  const stopWatching = (): void => {
    if (watch !== null) {
      options.clearInterval(watch)
      watch = null
    }
  }
  const watching = (): boolean =>
    watch !== null && options.now() - quitSignalAt <= LINUX_HELPER_WATCH_WINDOW_MS

  const exitedHelper = (): string | null => {
    try {
      return exitedChromiumHelper(options.listHelpers(), options.browserPid, options.readProcStat)
    } catch {
      return null
    }
  }

  const end = (signal: LinuxTerminationSignal, reason: string): void => {
    if (ended) {
      return
    }
    ended = true
    stopWatching()
    options.beforeEnd(signal, reason)
    // Node restores the default action only when a signal has no listener
    // left, so every listener goes, not just this module's.
    for (const each of LINUX_TERMINATION_SIGNALS) {
      options.source.removeAllListeners(each)
    }
    options.raise(signal)
  }

  const onSignal = (signal: LinuxTerminationSignal): void => {
    if (ended) {
      return
    }
    const exited = exitedHelper()
    if (exited) {
      end(signal, exited)
      return
    }
    if (quitSignal === null) {
      quitSignal = signal
      quitSignalAt = options.now()
      watch = options.setInterval(() => {
        if (!watching()) {
          stopWatching()
          return
        }
        const helper = exitedHelper()
        if (helper && quitSignal) {
          end(quitSignal, helper)
        }
      }, LINUX_HELPER_WATCH_INTERVAL_MS)
    }
    options.requestQuit(signal)
  }

  for (const signal of LINUX_TERMINATION_SIGNALS) {
    options.source.on(signal, () => onSignal(signal))
  }

  return {
    childProcessGone(details) {
      if (
        quitSignal &&
        !ended &&
        watching() &&
        details.type !== 'Tab' &&
        details.reason !== 'clean-exit'
      ) {
        end(quitSignal, `Chromium ${details.type} process ${details.reason}`)
      }
    }
  }
}
