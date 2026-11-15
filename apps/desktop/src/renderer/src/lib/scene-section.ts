import type { Device, GlobalShortcutsConfig, LayoutPreset, LayoutSettings } from './backend'
import {
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  type LayoutOrientation
} from './capture'
import { layoutPresetLabel } from './layout-labels'
import {
  sceneGalleryReason,
  sceneSourceGaps,
  type SceneOrientation,
  type SceneVisual
} from './scene-presets'
import { layoutShowsScreen, sceneLayout, type Scene, type SceneShows } from './scenes'
import { sceneSlotAccelerator } from '../../../shared/global-shortcuts'

// Plan 231 S6: the pure reads behind Studio's Scenes section (D7, D8, D19).
// It lives with the lazy scene UI, never in the Studio's first paint.

/**
 * The camera is one for every scene (D9), so a scene that needs it while it
 * is off or gone is not that card's own problem: the cards that need it are
 * off, and one line under the cards says why (plan 174 S3.3, B-20). A screen
 * that is gone stays each card's own ("Resolve sources").
 */
export function sceneCardsCameraGaps(
  scenes: readonly { id: string; name: string; visual: SceneVisual }[],
  devices: readonly Device[]
): { blocked: ReadonlySet<string>; reason: string | null } {
  const blocked = new Set<string>()
  const lines: { label: string; gaps: ReturnType<typeof sceneSourceGaps> }[] = []
  for (const scene of scenes) {
    const gaps = sceneSourceGaps(scene.visual, devices).filter((gap) => gap.source === 'camera')
    if (gaps.length === 0) continue
    blocked.add(scene.id)
    lines.push({ label: scene.name, gaps })
  }
  return { blocked, reason: sceneGalleryReason(lines) }
}

/**
 * What the scene puts on stream, in a few words: its screen, or its layout
 * when that shows none. (S1 put it in `scenes.ts`; it lives here, with the
 * lazy scene UI that reads it, so the Studio's first paint never carries it.)
 */
export function sceneShowsWords(
  scene: Pick<Scene, 'shows' | 'layouts'>,
  orientation: SceneOrientation
): string {
  const layout = sceneLayout(scene, orientation)
  return layoutShowsScreen(layout)
    ? showsWords(scene.shows)
    : layoutPresetLabel(layout.layoutPreset)
}

/** The screen a scene keeps, in a few words, whatever its layout draws. */
export function showsWords(shows: SceneShows): string {
  switch (shows.kind) {
    case 'app':
      return `${shows.name} · front window`
    case 'window':
      return shows.windowName ? `Window · ${shows.windowName}` : 'Window'
    case 'display':
      return shows.screenName ?? 'Display'
    case 'test-pattern':
      return 'Test pattern'
    case 'none':
      return 'No screen'
  }
}

/**
 * The Screen field's words (D8): the screen the scene keeps, and a note when
 * its layout draws no screen ("Not shown in Camera only"), so a Camera only
 * scene that keeps Display 1 says both.
 */
export function screenFieldWords(
  shows: SceneShows,
  layout: LayoutSettings
): { words: string; note: string | null } {
  const words = showsWords(shows)
  if (shows.kind === 'none' || layoutShowsScreen(layout)) return { words, note: null }
  return { words, note: `Not shown in ${layoutPresetLabel(layout.layoutPreset)}` }
}

/** D19: a layout that draws a screen, chosen for a scene that shows none, asks for a screen first. */
export function layoutAsksForScreen(shows: SceneShows, preset: LayoutPreset): boolean {
  return shows.kind === 'none' && layoutPresetNeedsScreen(preset)
}

/** The Layout field's choices for the studio's mode: the four 16:9 layouts or the six 9:16 ones. */
export function sceneLayoutChoices(
  orientation: LayoutOrientation,
  hasCamera: boolean
): { value: LayoutPreset; label: string; disabled: boolean }[] {
  const presets = orientation === 'vertical' ? VERTICAL_LAYOUT_PRESETS : HORIZONTAL_LAYOUT_PRESETS
  return presets.map((preset) => ({
    value: preset,
    label: layoutPresetLabel(preset),
    disabled: !hasCamera && layoutPresetNeedsCamera(preset)
  }))
}

/** Why some layouts are off: the camera, said once under the field, or null. */
export function sceneLayoutCameraLine(
  choices: readonly { label: string; disabled: boolean }[]
): string | null {
  const off = choices.filter((choice) => choice.disabled).map((choice) => choice.label)
  if (off.length === 0) return null
  return `Choose a camera in Sources to use ${new Intl.ListFormat('en-US', { type: 'conjunction' }).format(off)}.`
}

/**
 * Whether the landscape scene's screen fits or fills by the user's choice
 * (plan 213 G3): Screen + camera and Screen only. Side by side always fills
 * and Camera only has no screen.
 */
export function landscapeFramingShows(layout: LayoutSettings): boolean {
  return layout.layoutPreset === 'screen-camera' || layout.layoutPreset === 'screen-only'
}

/**
 * The keys the section's line teaches (D5): the first and the ninth position
 * keys while both are the platform's own, else null (a streamer who changed
 * them reads each card's chip instead).
 */
export function sceneSlotKeysLine(
  config: GlobalShortcutsConfig | undefined,
  platform: string | undefined
): { first: string; last: string } | null {
  const first = sceneSlotAccelerator(config ?? {}, 1, platform)
  const last = sceneSlotAccelerator(config ?? {}, 9, platform)
  const defaults = sceneSlotAccelerator({}, 1, platform)
  return first === defaults && last === sceneSlotAccelerator({}, 9, platform)
    ? { first, last }
    : null
}
