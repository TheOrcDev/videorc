/**
 * Plan 219 S3: a closed-and-reopened window is picked up again at Record.
 *
 * ScreenCaptureKit hands a reopened window a new id, and the saved selection
 * keeps the dead one; the renderer refreshes `devices.list` only at launch,
 * on Sources' Refresh and in permission flows. So a start whose picked
 * window is not already live reads the window list once and rebinds the
 * pick to the same window under its new id. Two rules hold here:
 *
 * - Never substitute a display or another app's window: a window pick is a
 *   privacy promise. No match leaves the selection unchanged, and the
 *   backend then refuses the start with the "closed" copy (S2).
 * - Never add a round trip when the capture is already live on that id (the
 *   record-latency budget).
 *
 * The lookup is `devices.list`: it reuses the backend's one-second content
 * cache, lists every on-screen window, and `findRememberedSource` already
 * holds the matching rules (exact id, then exact name). The app-window
 * resolver (`sources.resolve_app_window`, plan 210) needs a bundle id the
 * saved selection does not carry and may hand back a sibling window of the
 * same app, which a window pick must never become.
 */

import type { Device, PreviewScreenStatus, SourceSelection } from '../../../shared/backend'
import { findRememberedSource, isNativeWindowSourceId } from './capture'

/** True when the start should read the window list before `session.start`. */
export function shouldRefreshWindowListBeforeStart(
  sources: Pick<SourceSelection, 'windowId'>,
  previewScreen: Pick<PreviewScreenStatus, 'state' | 'sourceId'>
): boolean {
  if (!sources.windowId || !isNativeWindowSourceId(sources.windowId)) {
    return false
  }
  return !(previewScreen.state === 'live' && previewScreen.sourceId === sources.windowId)
}

/**
 * The selection rebound to the remembered window's new id, or null when the
 * pick is not a window, is listed under its current id, or has no match.
 */
export function rebindRememberedWindow(
  sources: SourceSelection,
  devices: readonly Device[]
): SourceSelection | null {
  if (!sources.windowId || !isNativeWindowSourceId(sources.windowId)) {
    return null
  }
  const windows = devices.filter(
    (device) =>
      device.kind === 'window' && device.status === 'available' && isNativeWindowSourceId(device.id)
  )
  const match = findRememberedSource(sources.windowId, sources.windowName, windows)
  if (!match || match.kind !== 'window' || match.id === sources.windowId) {
    return null
  }
  return { ...sources, windowId: match.id, windowName: match.name }
}
