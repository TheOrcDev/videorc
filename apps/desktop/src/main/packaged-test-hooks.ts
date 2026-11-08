// Plan 0002 (retest 152): debug and code-loading hooks that a release build
// must not honour. Each one lets another same-user process run code as
// Videorc (a CDP port into the renderer, which holds the backend token, or a
// native module/helper path loaded into or spawned by the main process), and
// on macOS that code inherits Videorc's Screen Recording, Camera and
// Microphone grants. Development runs keep them. A packaged build keeps them
// only when it was built as a test build (`VIDEORC_PACKAGED_TEST_HOOKS=1` at
// `electron-vite build`, see electron.vite.config.ts); release workflows never
// set it, and `pnpm check:packaged-app` refuses an artifact that carries it.

/** Build-time switch for a packaged test build. Never set for a release. */
export const PACKAGED_TEST_HOOKS_BUILD_ENV = 'VIDEORC_PACKAGED_TEST_HOOKS'

/** Written into out/main by the build; `pnpm check:packaged-app` reads it from app.asar. */
export const BUILD_FLAGS_FILE_NAME = 'videorc-build-flags.json'

export const PACKAGED_TEST_HOOK_ENV_NAMES = Object.freeze([
  'VIDEORC_REMOTE_DEBUG_PORT',
  'VIDEORC_NATIVE_PREVIEW_HOST_MODULE',
  'VIDEORC_NATIVE_PREVIEW_IN_PROCESS_MODULE',
  'VIDEORC_NATIVE_PREVIEW_HOST_HELPER'
])

/** Chromium switches that open a DevTools endpoint when passed on the command line. */
export const PACKAGED_TEST_HOOK_SWITCHES = Object.freeze([
  'remote-debugging-port',
  'remote-debugging-pipe'
])

declare const __VIDEORC_PACKAGED_TEST_HOOKS__: boolean | undefined

/** Whether this bundle was built as a packaged test build. False under vitest and in release builds. */
export function buildAllowsPackagedTestHooks(): boolean {
  return typeof __VIDEORC_PACKAGED_TEST_HOOKS__ === 'boolean' && __VIDEORC_PACKAGED_TEST_HOOKS__
}

/** The build-time decision (pure): only the exact value "1" makes a test build. */
export function packagedTestHooksBuildEnabled(env: Record<string, string | undefined>): boolean {
  return env[PACKAGED_TEST_HOOKS_BUILD_ENV]?.trim() === '1'
}

export function packagedTestHooksAllowed(options: {
  isPackaged: boolean
  buildAllowsTestHooks: boolean
}): boolean {
  return !options.isPackaged || options.buildAllowsTestHooks
}

export interface CommandLineSwitches {
  hasSwitch(name: string): boolean
  removeSwitch(name: string): void
}

/**
 * Removes the test hooks from a release build's environment and command line
 * before anything reads them, so the app and its children never see them.
 * Returns what it refused, for one explicit log line.
 */
export function refusePackagedTestHooks(
  env: NodeJS.ProcessEnv,
  commandLine: CommandLineSwitches,
  options: { isPackaged: boolean; buildAllowsTestHooks: boolean }
): string[] {
  if (packagedTestHooksAllowed(options)) {
    return []
  }
  const refused: string[] = []
  for (const name of PACKAGED_TEST_HOOK_ENV_NAMES) {
    if (env[name] !== undefined) {
      refused.push(name)
      delete env[name]
    }
  }
  for (const name of PACKAGED_TEST_HOOK_SWITCHES) {
    if (commandLine.hasSwitch(name)) {
      refused.push(`--${name}`)
      commandLine.removeSwitch(name)
    }
  }
  return refused
}

export interface SignalTarget {
  on(signal: 'SIGUSR1', listener: () => void): unknown
}

/**
 * With the EnableNodeCliInspectArguments fuse off, Node no longer turns
 * SIGUSR1 into an inspector, so the signal falls through to its default
 * action and kills the app mid-recording without finalizing. Every packaged
 * build (the fuse is flipped in test builds too) on macOS or Linux keeps the
 * signal and logs it instead. Windows has no SIGUSR1; development keeps
 * Node's inspector behaviour.
 */
export function ignoreInspectorSignal(
  target: SignalTarget,
  options: { isPackaged: boolean; platform: NodeJS.Platform },
  onSignal: () => void
): boolean {
  if (!options.isPackaged || options.platform === 'win32') {
    return false
  }
  target.on('SIGUSR1', onSignal)
  return true
}
