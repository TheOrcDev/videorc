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

export function startGpuFallbackRetry(
  state: GpuFallbackState,
  startedAt: string
): GpuFallbackState {
  return { ...state, retryStartedAt: startedAt }
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
