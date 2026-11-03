import type { BrowserWindow } from 'electron'

import type { StreamManagerHideMethod } from '../shared/backend'

export type { StreamManagerHideMethod }

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
  | { state: 'failed' | 'unsupported'; protected: false; reason: string }

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

/** What a window's owner has chosen, where the rule depends on a choice. */
export interface WindowCaptureProtectionContext {
  /** The Stream Manager's Hide from stream switch (plan 215 D6). */
  hiddenFromStream?: boolean
}

/**
 * How the Stream Manager leaves the stream when Hide from stream is on
 * (plan 215 D6). On macOS Videorc's own ScreenCaptureKit filter leaves the
 * window out of every capture it starts, applied live, so the streamer's
 * screenshots, QuickTime and Zoom still see it. On Windows the monitor
 * capture has no exclusion list; content protection
 * (`WDA_EXCLUDEFROMCAPTURE`) is the only route, and it hides the window from
 * every capture app and screenshot too. Linux has neither.
 */
export function streamManagerHideMethod(platform: NodeJS.Platform): StreamManagerHideMethod {
  if (platform === 'darwin') {
    return 'capture-filter'
  }
  if (platform === 'win32') {
    return 'content-protection'
  }
  return 'unsupported'
}

/**
 * Notes is a private teleprompter that must never enter a captured display;
 * Comments and Captions are part of the show and stay VISIBLE in recordings
 * by default (owner call, 2026-08-19 — "only notes should be invisible").
 * Plan 215 D6 adds the one choice: the Stream Manager is protected while
 * its Hide from stream switch is on, but only where content protection is
 * how it hides (Windows). On macOS the capture filter does that job, and
 * content protection would also hide the window from the streamer's own
 * tools, so it is never applied there. Notes' rule stays identical on every
 * platform.
 */
export function videorcWindowRequiresCaptureProtection(
  role: VideorcWindowRole,
  platform: NodeJS.Platform,
  context: WindowCaptureProtectionContext = {}
): boolean {
  if (role === 'notes') {
    return true
  }
  if (role === 'comments') {
    return (
      context.hiddenFromStream === true &&
      streamManagerHideMethod(platform) === 'content-protection'
    )
  }
  return false
}

/**
 * Electron implements BrowserWindow content protection on macOS and Windows
 * only; elsewhere `setContentProtection` returns without doing anything. The
 * Notes window says "Hidden from recordings and streams" when protection
 * holds, so a platform without it must report the window as visible (plan
 * 174 I-2).
 */
export function platformSupportsCaptureProtection(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export const CAPTURE_PROTECTION_UNSUPPORTED_REASON =
  'This system cannot hide a window from screen capture.'

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
  } & WindowCaptureProtectionContext = {}
): WindowCaptureProtectionResult {
  const platform = options.platform ?? process.platform
  if (
    !videorcWindowRequiresCaptureProtection(role, platform, {
      hiddenFromStream: options.hiddenFromStream
    })
  ) {
    return { state: 'not-required', protected: false }
  }
  if (protectedWindows.has(window)) {
    return { state: 'already-protected', protected: true }
  }
  if (!platformSupportsCaptureProtection(platform)) {
    options.onFailure?.(CAPTURE_PROTECTION_UNSUPPORTED_REASON)
    return { state: 'unsupported', protected: false, reason: CAPTURE_PROTECTION_UNSUPPORTED_REASON }
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

/**
 * Takes a window's content protection off again (plan 215 D6: Hide from
 * stream turned off on Windows). A window this module never protected is
 * left alone, so Notes can never be exposed by a Stream Manager toggle.
 * Returns whether the window is still protected afterwards.
 */
export function releaseVideorcWindowCaptureProtection(window: ContentProtectionWindow): boolean {
  if (!protectedWindows.has(window)) {
    return false
  }
  try {
    window.setContentProtection(false)
    protectedWindows.delete(window)
    return false
  } catch {
    return true
  }
}
