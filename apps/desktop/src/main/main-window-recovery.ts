import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Main-window recovery policy (plan 082). A renderer that dies, or a document
// that fails to load, used to leave the main window as a title bar over an
// empty client area for ever, with nothing logged (reproduced on Windows by
// crashing the renderer of a 0.9.124 build). index.ts wires these decisions to
// render-process-gone / did-fail-load and to the Windows Mica paint check.
//
// Everything here is pure or injected so the policy is unit-testable.

/** Automatic reloads allowed inside RELOAD_WINDOW_MS before the user is asked. */
export const MAX_AUTOMATIC_RELOADS = 2
export const RELOAD_WINDOW_MS = 60_000

/** Chromium's net::ERR_ABORTED: a navigation we (or the page) cancelled. */
const ERR_ABORTED = -3

/** A renderer that exited on purpose needs no recovery; every other exit does. */
export function rendererExitNeedsRecovery(reason: string): boolean {
  return reason !== 'clean-exit'
}

export function loadFailureNeedsRecovery(failure: {
  errorCode: number
  isMainFrame: boolean
}): boolean {
  return failure.isMainFrame && failure.errorCode !== ERR_ABORTED
}

export type RecoveryAction = 'reload' | 'ask'

/**
 * Bounds automatic reloads: a renderer that dies again straight after a reload
 * would otherwise loop for ever. Past the bound the user decides.
 */
export class ReloadBudget {
  private attempts: number[] = []

  constructor(
    private readonly maxReloads = MAX_AUTOMATIC_RELOADS,
    private readonly windowMs = RELOAD_WINDOW_MS
  ) {}

  next(nowMs: number): RecoveryAction {
    this.attempts = this.attempts.filter((at) => nowMs - at < this.windowMs)
    if (this.attempts.length >= this.maxReloads) {
      return 'ask'
    }
    this.attempts.push(nowMs)
    return 'reload'
  }

  /** The user asked for a reload themselves: start counting afresh. */
  reset(): void {
    this.attempts = []
  }
}

export type PaintVerdict = 'painted' | 'blank' | 'unknown'

/**
 * Reads a `capturePage()` bitmap (4 bytes per pixel, alpha last). The Mica
 * window's backing is transparent and the page's own coat is translucent, so
 * a page that painted anything has non-zero alpha somewhere; a capture with
 * no alpha at all means the web contents drew nothing. An empty capture is no
 * evidence either way.
 */
export function paintVerdictFromBitmap(bitmap: Uint8Array): PaintVerdict {
  if (bitmap.length < 4) {
    return 'unknown'
  }
  for (let offset = 3; offset < bitmap.length; offset += 4) {
    if (bitmap[offset] !== 0) {
      return 'painted'
    }
  }
  return 'blank'
}

/**
 * Persisted when the paint check finds the Mica window blank: the next launch
 * starts on the solid palette. Scoped to the app version that saw the failure,
 * so an update tries Mica once more instead of staying solid for ever.
 */
export interface MicaFallbackState {
  disableMica: true
  reason: string
  appVersion: string
  updatedAt: string
}

export function micaFallbackStatePath(userDataDir: string): string {
  return join(userDataDir, 'window-glass-fallback.json')
}

export interface MicaFallbackStore {
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  removeFile?: (path: string) => void
}

export function readMicaFallbackState(
  path: string,
  { readFile = (target) => readFileSync(target, 'utf8') }: MicaFallbackStore = {}
): MicaFallbackState | null {
  try {
    const parsed = JSON.parse(readFile(path)) as Partial<MicaFallbackState> | null
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.disableMica === true &&
      typeof parsed.appVersion === 'string'
    ) {
      return {
        disableMica: true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
        appVersion: parsed.appVersion,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
      }
    }
    return null
  } catch {
    // Missing or unreadable state means no fallback: never block startup.
    return null
  }
}

export function micaFallbackApplies(state: MicaFallbackState | null, appVersion: string): boolean {
  return state !== null && state.appVersion === appVersion
}

export function writeMicaFallbackState(
  path: string,
  state: MicaFallbackState,
  {
    writeFile = (target, contents) => writeFileSync(target, contents),
    makeDir = (target) => mkdirSync(target, { recursive: true })
  }: MicaFallbackStore = {}
): void {
  makeDir(dirname(path))
  writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

export function clearMicaFallbackState(
  path: string,
  { removeFile = (target) => rmSync(target, { force: true }) }: MicaFallbackStore = {}
): void {
  try {
    removeFile(path)
  } catch {
    // Best-effort: a stale flag only keeps the window solid, never worse.
  }
}
