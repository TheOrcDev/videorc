import type { LayoutPreset } from './backend'

// Plan 174 S1.4 (B-24, C-20, V-X3): the built-in layouts carried three name
// sets ("Screen + Cam" in Studio and Shortcuts, "Screen + camera" on the
// Scene page, "Side-by-side" beside "Side by side"). One table now names
// them everywhere. A vertical layout reads like its horizontal twin, because
// a list shows one orientation at a time; "Vertical …" is added only where
// both orientations share one list.

export const LAYOUT_PRESET_LABELS: Readonly<Record<LayoutPreset, string>> = {
  'screen-camera': 'Screen + camera',
  'screen-only': 'Screen only',
  'camera-only': 'Camera only',
  'side-by-side': 'Side by side',
  'vertical-camera-top': 'Camera top',
  'vertical-camera-bottom': 'Camera bottom',
  'vertical-split': 'Split',
  'vertical-screen-camera': 'Screen + camera',
  'vertical-screen-only': 'Screen only',
  'vertical-camera-only': 'Camera only'
}

/**
 * A built-in layout's name. `bothOrientations` is for a list that holds
 * horizontal and vertical layouts together: there the vertical twins of
 * horizontal layouts say so ("Vertical screen + camera").
 */
export function layoutPresetLabel(
  preset: LayoutPreset,
  { bothOrientations = false }: { bothOrientations?: boolean } = {}
): string {
  const label = LAYOUT_PRESET_LABELS[preset] ?? preset
  if (!bothOrientations || !preset.startsWith('vertical-')) return label
  const horizontalTwin = preset.slice('vertical-'.length) as LayoutPreset
  return horizontalTwin in LAYOUT_PRESET_LABELS
    ? `Vertical ${label.charAt(0).toLowerCase()}${label.slice(1)}`
    : label
}
