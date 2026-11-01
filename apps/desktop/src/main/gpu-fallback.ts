import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

// GPU fallback policy for machines where the Chromium GPU process is broken
// (seen on Windows Insider builds: the app only boots with GPU flags and
// window compositing silently fails). Two entry points:
//
//   • VIDEORC_DISABLE_GPU=1 — explicit user escape hatch, honored every launch.
//   • Automatic: repeated GPU-process crashes in one launch persist a flag in
//     userData, and the NEXT launch disables hardware acceleration before
//     app.ready. VIDEORC_FORCE_GPU=1 overrides and clears the persisted flag.
//   • Once per app version (plan 195 S5): a fallback another version recorded
//     gets one accelerated launch on the first launch of a new version, armed
//     like Settings' "Retry on next launch". A crash in it restores the
//     fallback for this version, so a broken GPU never loops.
//
// Everything here is pure/injected so the policy is unit-testable; index.ts
// wires it to app.disableHardwareAcceleration() and child-process-gone.

/** GPU-process crashes in ONE launch before we persist the fallback. The first
 * crash can be a fluke Chromium recovers from; a second means the GPU path is
 * genuinely unreliable on this machine. */
export const GPU_CRASH_PERSIST_THRESHOLD = 2

/** A retry that keeps its GPU process alive for this long is considered
 * recovered and the persisted fallback is removed. */
export const GPU_RETRY_STABILITY_MS = 60_000

export interface GpuFallbackState {
  disableHardwareAcceleration: boolean
  reason: string
  crashCount: number
  updatedAt: string
  retryRequestedAt?: string
  retryStartedAt?: string
  retryAttempts?: number
  /** The app version whose launch recorded this state: the crash, or the
   * accelerated retry it tried. Missing in files written before plan 195. */
  appVersion?: string
}

export function gpuFallbackStatePath(userDataDir: string): string {
  return join(userDataDir, 'gpu-fallback.json')
}

export function shouldPersistGpuFallback(crashCount: number): boolean {
  return crashCount >= GPU_CRASH_PERSIST_THRESHOLD
}

/** child-process-gone reasons that indicate a genuinely broken GPU process —
 * clean shutdowns must not count toward the fallback. */
export function isGpuCrashReason(reason: string): boolean {
  switch (reason) {
    case 'crashed':
    case 'abnormal-exit':
    case 'launch-failed':
    case 'integrity-failure':
    case 'oom':
      return true
    default:
      return false
  }
}

export interface GpuFallbackDecision {
  disable: boolean
  /** Human-readable source of the decision, for logs / runtime info. */
  source: 'env' | 'persisted' | 'retry' | 'none'
  /** True when VIDEORC_FORCE_GPU=1 asked us to clear a persisted fallback. */
  clearPersisted: boolean
}

export function decideGpuFallback({
  env,
  persisted
}: {
  env: Partial<Pick<NodeJS.ProcessEnv, 'VIDEORC_DISABLE_GPU' | 'VIDEORC_FORCE_GPU'>>
  persisted: GpuFallbackState | null
}): GpuFallbackDecision {
  if (env.VIDEORC_FORCE_GPU === '1') {
    return { disable: false, source: 'none', clearPersisted: persisted !== null }
  }
  if (env.VIDEORC_DISABLE_GPU === '1') {
    return { disable: true, source: 'env', clearPersisted: false }
  }
  if (persisted?.disableHardwareAcceleration) {
    return { disable: true, source: 'persisted', clearPersisted: false }
  }
  if (persisted?.retryRequestedAt && !persisted.retryStartedAt) {
    return { disable: false, source: 'retry', clearPersisted: false }
  }
  if (persisted?.retryStartedAt) {
    return { disable: true, source: 'persisted', clearPersisted: false }
  }
  return { disable: false, source: 'none', clearPersisted: false }
}

/** Preserve the original failure evidence while arming one explicit accelerated
 * launch. If that launch crashes twice, index.ts disables acceleration again. */
export function scheduleGpuFallbackRetry(
  state: GpuFallbackState,
  requestedAt: string
): GpuFallbackState {
  const { retryStartedAt: _previousRetryStartedAt, ...preserved } = state
  return {
    ...preserved,
    disableHardwareAcceleration: false,
    retryRequestedAt: requestedAt,
    retryAttempts: (state.retryAttempts ?? 0) + 1
  }
}

/** The accelerated launch begins: it belongs to this app version (plan 195 S5),
 * so a crash or an unfinished retry is never retried again on this version. */
export function startGpuFallbackRetry(
  state: GpuFallbackState,
  startedAt: string,
  appVersion: string
): GpuFallbackState {
  return { ...state, retryStartedAt: startedAt, appVersion }
}

/**
 * Plan 195 S5: one accelerated launch per app version. A crash fallback
 * recorded under another version (or before versions were recorded) is armed
 * exactly like Settings' "Retry on next launch", so the same two-crash guard
 * and stability window apply. Null when nothing is to retry: no fallback, a
 * retry already pending, this version already decided, or an explicit launch
 * setting (VIDEORC_DISABLE_GPU, VIDEORC_FORCE_GPU, the smokes' GPU switch),
 * which always wins.
 */
export function armGpuFallbackVersionRetry({
  env,
  persisted,
  appVersion,
  requestedAt
}: {
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      'VIDEORC_DISABLE_GPU' | 'VIDEORC_FORCE_GPU' | 'VIDEORC_SMOKE_DISABLE_ELECTRON_GPU'
    >
  >
  persisted: GpuFallbackState | null
  appVersion: string
  requestedAt: string
}): GpuFallbackState | null {
  if (
    env.VIDEORC_FORCE_GPU === '1' ||
    env.VIDEORC_DISABLE_GPU === '1' ||
    env.VIDEORC_SMOKE_DISABLE_ELECTRON_GPU === '1'
  ) {
    return null
  }
  if (!persisted?.disableHardwareAcceleration || !appVersion) return null
  if (persisted.appVersion === appVersion) return null
  return scheduleGpuFallbackRetry(persisted, requestedAt)
}

/**
 * The fallback a launch persists after repeated GPU-process crashes. It keeps
 * the retry evidence and records the version, so the next launch of this
 * version stays in software rendering and only a new version retries.
 */
export function gpuCrashFallbackState({
  previous,
  crashCount,
  duringRetry,
  appVersion,
  updatedAt
}: {
  previous: GpuFallbackState | null
  crashCount: number
  duringRetry: boolean
  appVersion: string
  updatedAt: string
}): GpuFallbackState {
  return {
    disableHardwareAcceleration: true,
    reason: duringRetry ? 'gpu-retry-failed' : 'gpu-process-crashes',
    crashCount,
    updatedAt,
    ...(previous?.retryRequestedAt ? { retryRequestedAt: previous.retryRequestedAt } : {}),
    ...(previous?.retryAttempts !== undefined ? { retryAttempts: previous.retryAttempts } : {}),
    appVersion
  }
}

export interface GpuFallbackStore {
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  removeFile?: (path: string) => void
}

export function readGpuFallbackState(
  path: string,
  { readFile = (target) => readFileSync(target, 'utf8') }: GpuFallbackStore = {}
): GpuFallbackState | null {
  try {
    const parsed = JSON.parse(readFile(path)) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as GpuFallbackState).disableHardwareAcceleration === 'boolean'
    ) {
      const state = parsed as Partial<GpuFallbackState>
      return {
        disableHardwareAcceleration: state.disableHardwareAcceleration === true,
        reason: typeof state.reason === 'string' ? state.reason : 'unknown',
        crashCount: typeof state.crashCount === 'number' ? state.crashCount : 0,
        updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
        ...(typeof state.retryRequestedAt === 'string'
          ? { retryRequestedAt: state.retryRequestedAt }
          : {}),
        ...(typeof state.retryStartedAt === 'string'
          ? { retryStartedAt: state.retryStartedAt }
          : {}),
        ...(typeof state.retryAttempts === 'number' && Number.isInteger(state.retryAttempts)
          ? { retryAttempts: Math.max(0, state.retryAttempts) }
          : {}),
        ...(typeof state.appVersion === 'string' && state.appVersion
          ? { appVersion: state.appVersion }
          : {})
      }
    }
    return null
  } catch {
    // Missing or unreadable state means no fallback — never block startup.
    return null
  }
}

export function writeGpuFallbackState(
  path: string,
  state: GpuFallbackState,
  {
    writeFile = (target, contents) => writeFileSync(target, contents),
    makeDir = (target) => mkdirSync(target, { recursive: true })
  }: GpuFallbackStore = {}
): void {
  makeDir(dirname(path))
  writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

export function clearGpuFallbackState(
  path: string,
  { removeFile = (target) => rmSync(target, { force: true }) }: GpuFallbackStore = {}
): void {
  try {
    removeFile(path)
  } catch {
    // Best-effort: a stale flag only re-disables acceleration, never worse.
  }
}
