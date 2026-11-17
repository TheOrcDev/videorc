import type { SourceSelection } from '@/lib/backend'

/**
 * Plan 249 S14. The room's screen share follows the scene's own screen or
 * window, as natively: a saved scene, a Follow switch (the app in front, the
 * window in front) or a preset with a chosen screen puts THAT screen on the
 * room program, instead of whatever was shared by hand.
 *
 * The share stays the S2 privacy-gated browser capture (Hide screen, the
 * password-manager hide and their acknowledgements are unchanged): only the
 * source it captures is chosen here. The S13a frame bridge is a 640x360
 * camera transport and would make shared text unreadable, so a native screen
 * role over it is not used.
 *
 * Native sources are ScreenCaptureKit ids on macOS
 * (`screen:screencapturekit:<CGDirectDisplayID>`,
 * `window:screencapturekit:<CGWindowID>`); Electron's capturer names the same
 * display or window `screen:<id>:0` / `window:<id>:0`. Main still checks the
 * id against its own capturer list before answering `getDisplayMedia`, so a
 * window that has gone fails the switch visibly. Other platforms' native ids
 * do not map one to one: the share is kept and the reason said (Follow is
 * macOS only, D12).
 */
export type RoomScreenWant =
  /** The scene names no screen: keep whatever the room shares. */
  | { kind: 'keep' }
  | { kind: 'source'; capturerId: string; sourceKind: 'screen' | 'window' }
  | { kind: 'unsupported'; reason: string }

/** How the room's screen is captured, measured facts only (V13). */
export const ROOM_SCREEN_CAPTURE_FACTS = {
  engine: 'browser-capturer',
  /** Chromium's capturer draws the pointer; the native cursor setting is not applied. */
  cursor: 'capturer-default',
  /** Videorc's own windows are left out only where they use content protection. */
  ownWindows: 'content-protection-only',
  productionQualified: false
} as const

const NATIVE = /^(screen|window):screencapturekit:([0-9]{1,10})$/

/** `screen:screencapturekit:5` -> `screen:5:0`; null when the id does not map. */
export function capturerIdForNative(nativeId: string | undefined): string | null {
  const match = nativeId ? NATIVE.exec(nativeId) : null
  if (!match) return null
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) return null
  return `${match[1]}:${id}:0`
}

/** What the room should share for a scene's sources. A window wins over a display, as natively. */
export function roomScreenWant(
  sources: Pick<SourceSelection, 'screenId' | 'windowId' | 'captureOff'>
): RoomScreenWant {
  const native = sources.windowId || (sources.captureOff ? undefined : sources.screenId)
  if (!native) return { kind: 'keep' }
  const capturerId = capturerIdForNative(native)
  if (!capturerId)
    return {
      kind: 'unsupported',
      reason: "This scene's screen can't be shared into the room here. Share it yourself."
    }
  return {
    kind: 'source',
    capturerId,
    sourceKind: capturerId.startsWith('window:') ? 'window' : 'screen'
  }
}

/** Switch only when the room shares something else (or nothing). */
export function roomScreenNeedsSwitch(want: RoomScreenWant, current: string | null): boolean {
  return want.kind === 'source' && want.capturerId !== current
}
