import type { GlobalShortcutsConfig, PreviewScreenStatus } from '@/lib/backend'
import type { SettingsState } from '@/lib/capture'
import { sceneSlotAccelerator, type SceneSlotPosition } from '../../../shared/global-shortcuts'
import type { SceneHudWindowState } from '../../../shared/scene-hud'

// The key HUD (plan 231 D20): the setting, the keys, and whether Videorc's
// own capture leaves the HUD's window out. Loaded lazily through
// `scene-hud.ts`: the Studio's eager code keeps only main's window state and
// the last screen start (`SceneHudScreenStart`).

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

/** The last screen start: the exclusion list it carried and its answer. */
export type SceneHudScreenStart = readonly [
  sentIds: readonly number[],
  status: Pick<PreviewScreenStatus, 'state' | 'message'>
]

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

/**
 * Pure. Fail closed: the Studio asks main for the HUD only when Videorc's
 * own capture is known to leave it out. Windows: content protection held
 * (main says `ready`). macOS: the window is protected and on screen with an
 * id (`ready`), and either no capture runs (the next start carries the id)
 * or the running capture's last start carried that id and took it. Linux:
 * never.
 */
export function sceneHudCaptureConfirmed(input: {
  window: SceneHudWindowState | null
  lastStart: SceneHudScreenStart | null
  status: Pick<PreviewScreenStatus, 'state'>
}): boolean {
  const { window, lastStart } = input
  if (!window?.enabled || !window.ready) return false
  if (window.method === 'content-protection') return true
  if (window.method !== 'capture-filter' || window.windowId === undefined) return false
  if (!screenCaptureRunning(input.status)) return true
  return (
    !!lastStart && lastStart[0].includes(window.windowId) && screenStartHoldsExclusion(lastStart[1])
  )
}
