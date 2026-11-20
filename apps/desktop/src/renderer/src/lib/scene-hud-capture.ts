import type { GlobalShortcutsConfig, PreviewScreenStatus } from '@/lib/backend'
import type { SettingsState } from '@/lib/capture'
import { sceneSlotAccelerator, type SceneSlotPosition } from '../../../shared/global-shortcuts'
import type { SceneHudWindowState } from '../../../shared/scene-hud'

// The key HUD (plan 231 D20), the Studio's eager half: the setting, and
// whether Videorc's own capture leaves the HUD's window out. Kept tiny: the
// request itself is built in the lazy `scene-hud.ts`.

/** Settings → Shortcuts' switch, on by default: an absent key is on. */
export function sceneHudEnabled(settings: Pick<SettingsState, 'sceneHud'>): boolean {
  return settings.sceneHud !== false
}

/**
 * Pure. Whether any key can switch a scene: Next or Previous, a scene's own
 * key, or a position key with a scene in that place (on by default; an empty
 * key is released). Main makes the HUD's window only then.
 */
export function sceneHudKeySet(
  config: GlobalShortcutsConfig = {},
  scenes: readonly { id: string }[],
  platform: string | undefined
): boolean {
  if (!scenes.length) return false
  if (config.layoutNext || config.layoutPrevious) return true
  if (scenes.some((scene) => config.scenes?.[scene.id])) return true
  return scenes
    .slice(0, 9)
    .some((_, index) => !!sceneSlotAccelerator(config, (index + 1) as SceneSlotPosition, platform))
}

/**
 * What the Studio knows about the running screen capture and the HUD's
 * window id (macOS): `held` is true once a capture is known to have taken
 * the id into its ScreenCaptureKit filter, or when no capture ran since the
 * id was known (every later start carries it).
 */
export interface SceneHudExclusion {
  windowId: number
  held: boolean
}

export function screenCaptureRunning(status: Pick<PreviewScreenStatus, 'state'>): boolean {
  return status.state === 'starting' || status.state === 'live'
}

/**
 * Pure. Whether a screen start's answer says the capture holds the list it
 * was sent: a fresh start is built with it, and a reused capture says either
 * "applied to the running capture" or "updates at the next capture start".
 */
export function screenStartHoldsExclusion(
  status: Pick<PreviewScreenStatus, 'state' | 'message'>
): boolean {
  return (
    screenCaptureRunning(status) && !/updates at the next capture start/.test(status.message ?? '')
  )
}

/** Pure. The ledger after the HUD's window changed (a new id, or none). */
export function sceneHudExclusionForWindow(
  window: SceneHudWindowState | null,
  previous: SceneHudExclusion | null,
  captureRunning: boolean
): SceneHudExclusion | null {
  if (!window || window.method !== 'capture-filter' || window.windowId === undefined) return null
  if (previous?.windowId === window.windowId) return previous
  // A capture running now was started without this id: unconfirmed until
  // the Studio's resend says the filter took it.
  return { windowId: window.windowId, held: !captureRunning }
}

/** Pure. The ledger after a screen start that carried `sentIds`. */
export function sceneHudExclusionAfterStart(
  previous: SceneHudExclusion | null,
  sentIds: readonly number[],
  status: Pick<PreviewScreenStatus, 'state' | 'message'>
): SceneHudExclusion | null {
  if (!previous || !sentIds.includes(previous.windowId)) return previous
  return { windowId: previous.windowId, held: screenStartHoldsExclusion(status) }
}

/**
 * Pure. Fail closed: the Studio asks main for the HUD only when Videorc's
 * own capture is known to leave it out. Windows: content protection held
 * (main says `ready`). macOS: the window is on screen with an id (`ready`),
 * and the running capture took that id, or no capture runs. Linux: never.
 */
export function sceneHudCaptureConfirmed(input: {
  window: SceneHudWindowState | null
  exclusion: SceneHudExclusion | null
  captureRunning: boolean
}): boolean {
  const { window, exclusion } = input
  if (!window?.enabled || !window.ready) return false
  if (window.method === 'content-protection') return true
  if (window.method !== 'capture-filter' || window.windowId === undefined) return false
  if (exclusion?.windowId !== window.windowId) return false
  return exclusion.held || !input.captureRunning
}
