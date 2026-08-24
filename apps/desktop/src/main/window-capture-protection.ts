import type { BrowserWindow } from 'electron'

export type VideorcWindowRole =
  | 'main'
  | 'preview'
  | 'comments'
  | 'notes'
  | 'captions'
  | 'proof-surface'

type ContentProtectionWindow = Pick<BrowserWindow, 'setContentProtection'>

export type WindowCaptureProtectionResult =
  | { state: 'protected' | 'already-protected'; protected: true }
  | { state: 'not-required'; protected: false }
  | { state: 'failed'; protected: false; reason: string }

const protectedWindows = new WeakSet<object>()

/**
 * Deliberately unusual, role-specific colors used only by the installed-app
 * physical acceptance harness. The RTMP artifact gate looks for each color
 * independently, so one protected window cannot stand in as evidence for
 * another.
 */
export const WINDOW_CAPTURE_PROTECTION_SMOKE_MARKERS: Readonly<Record<VideorcWindowRole, string>> =
  Object.freeze({
    main: '#8b1e3f',
    preview: '#2e8b57',
    comments: '#5f4b8b',
    notes: '#c41e3a',
    captions: '#d2691e',
    'proof-surface': '#1e90a8'
  })

/**
 * Notes is a private teleprompter and must never enter a captured display.
 * Main and preview are the operator's own control surfaces — they must not
 * leak into Videorc's own preview or recordings either (owner call,
 * 2026-08-24 — "the main app shows up in the preview view and in the
 * recordings and it is not supposed to"), nor into other apps' captures.
 * Comments and Captions are part of the show and stay VISIBLE in recordings
 * (owner call, 2026-08-19). The rule is deliberately identical on every
 * platform.
 */
const CAPTURE_PROTECTED_ROLES: ReadonlySet<VideorcWindowRole> = new Set([
  'main',
  'preview',
  'notes',
  'proof-surface'
])

export function videorcWindowRequiresCaptureProtection(
  role: VideorcWindowRole,
  _platform: NodeJS.Platform
): boolean {
  return CAPTURE_PROTECTED_ROLES.has(role)
}

/**
 * Applies Electron's exact BrowserWindow capture exclusion once per window
 * instance. Re-created windows are distinct instances and are protected
 * independently; no title, process-name, or broad PID matching is involved.
 */
export function applyVideorcWindowCaptureProtection(
  window: ContentProtectionWindow,
  role: VideorcWindowRole,
  options: {
    platform?: NodeJS.Platform
    onFailure?: (reason: string) => void
  } = {}
): WindowCaptureProtectionResult {
  const platform = options.platform ?? process.platform
  if (!videorcWindowRequiresCaptureProtection(role, platform)) {
    return { state: 'not-required', protected: false }
  }
  if (protectedWindows.has(window)) {
    return { state: 'already-protected', protected: true }
  }

  try {
    window.setContentProtection(true)
    protectedWindows.add(window)
    return { state: 'protected', protected: true }
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim()
        ? error.message.trim().slice(0, 512)
        : 'Electron rejected content protection.'
    options.onFailure?.(reason)
    return { state: 'failed', protected: false, reason }
  }
}
