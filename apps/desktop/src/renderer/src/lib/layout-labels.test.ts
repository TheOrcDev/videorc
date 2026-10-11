import { describe, expect, it } from 'vitest'

import { LAYOUT_PRESET_VALUES } from '@/lib/backend'

import { LAYOUT_PRESET_LABELS, layoutPresetLabel } from './layout-labels'

// Plan 174 S1.4 (B-24, C-20, V-X3): one name set for the built-in layouts.

describe('LAYOUT_PRESET_LABELS', () => {
  it('names every built-in layout in sentence case', () => {
    for (const preset of LAYOUT_PRESET_VALUES) {
      const label = LAYOUT_PRESET_LABELS[preset]
      expect(label).toBeTruthy()
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase())
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase())
    }
  })

  it('uses the canonical names and none of the old ones', () => {
    expect(LAYOUT_PRESET_LABELS['screen-camera']).toBe('Screen + camera')
    expect(LAYOUT_PRESET_LABELS['screen-only']).toBe('Screen only')
    expect(LAYOUT_PRESET_LABELS['camera-only']).toBe('Camera only')
    expect(LAYOUT_PRESET_LABELS['side-by-side']).toBe('Side by side')
    for (const label of Object.values(LAYOUT_PRESET_LABELS)) {
      expect(label).not.toMatch(/Cam\b|Side-by-side|^Screen$|^Camera$/)
    }
  })
})

describe('layoutPresetLabel', () => {
  it('reads a vertical twin like its horizontal layout in a one-orientation list', () => {
    expect(layoutPresetLabel('vertical-screen-camera')).toBe('Screen + camera')
    expect(layoutPresetLabel('vertical-camera-only')).toBe('Camera only')
    expect(layoutPresetLabel('screen-camera')).toBe('Screen + camera')
  })

  it('says Vertical only where both orientations share a list', () => {
    expect(layoutPresetLabel('vertical-screen-camera', { bothOrientations: true })).toBe(
      'Vertical screen + camera'
    )
    expect(layoutPresetLabel('vertical-screen-only', { bothOrientations: true })).toBe(
      'Vertical screen only'
    )
    // Vertical-only layouts have no horizontal twin to tell apart.
    expect(layoutPresetLabel('vertical-camera-top', { bothOrientations: true })).toBe('Camera top')
    expect(layoutPresetLabel('screen-camera', { bothOrientations: true })).toBe('Screen + camera')
  })

  it('names every layout uniquely in a list of both orientations', () => {
    const labels = LAYOUT_PRESET_VALUES.map((preset) =>
      layoutPresetLabel(preset, { bothOrientations: true })
    )
    expect(new Set(labels).size).toBe(labels.length)
  })
})
