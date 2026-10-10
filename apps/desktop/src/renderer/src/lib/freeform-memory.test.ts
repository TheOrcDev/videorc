import { describe, expect, it } from 'vitest'

import type { CameraTransform, LayoutPreset } from '@/lib/backend'
import {
  freeformEntryOverrides,
  noteLayoutLeavingFreeform,
  rememberFreeform,
  rememberedFreeform,
  type FreeformMemory
} from './freeform-memory'

// Plan 174, C-4: a preset click no longer loses a Freeform arrangement.

const base = (x: number): CameraTransform => ({ x, y: 0, width: 0.5, height: 0.5 })
const camera = (x: number): CameraTransform => ({ x, y: 0.7, width: 0.25, height: 0.25 })

const freeform = (
  overrides: Record<string, CameraTransform>,
  layoutPreset: LayoutPreset = 'screen-camera'
) => ({
  arrangementMode: 'freeform' as const,
  layoutPreset,
  sourceTransformOverrides: overrides
})

const NO_CROP = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }
const sceneSources = [
  { id: 'source:base', transform: { ...base(0), ...NO_CROP } },
  { id: 'source:camera', transform: { ...camera(0.7), ...NO_CROP } }
]

describe('Freeform memory (plan 174, C-4)', () => {
  it('remembers a Freeform layout per orientation and ignores preset layouts', () => {
    let memory: FreeformMemory = {}
    memory = rememberFreeform(memory, {
      arrangementMode: 'preset',
      layoutPreset: 'screen-camera',
      sourceTransformOverrides: { 'source:base': base(0.1) }
    })
    expect(memory).toEqual({})

    memory = rememberFreeform(memory, freeform({ 'source:base': base(0.1) }))
    memory = rememberFreeform(
      memory,
      freeform({ 'source:camera': camera(0.2) }, 'vertical-screen-camera')
    )
    expect(memory).toEqual({
      horizontal: { 'source:base': base(0.1) },
      vertical: { 'source:camera': camera(0.2) }
    })

    // An empty Freeform (the base arrangement) keeps what was remembered.
    expect(rememberFreeform(memory, freeform({}))).toBe(memory)
  })

  it('starts Freeform where it was left, for the sources the scene still has', () => {
    const memory: FreeformMemory = {
      horizontal: {
        'source:base': base(0.3),
        'source:camera': camera(0.05),
        'source:gone': base(0.9)
      }
    }
    expect(freeformEntryOverrides(memory, 'horizontal', sceneSources)).toEqual({
      'source:base': base(0.3),
      'source:camera': camera(0.05)
    })
  })

  it('seeds from the scene where nothing is remembered, so nothing moves', () => {
    const memory: FreeformMemory = { vertical: { 'source:camera': camera(0.4) } }
    expect(freeformEntryOverrides(memory, 'horizontal', sceneSources)).toEqual({
      'source:base': base(0),
      'source:camera': camera(0.7)
    })
    expect(
      freeformEntryOverrides(
        { horizontal: { 'source:base': base(0.2) } },
        'horizontal',
        sceneSources
      )
    ).toEqual({
      'source:base': base(0.2),
      'source:camera': camera(0.7)
    })
  })

  it('keeps the window memory across preset changes', () => {
    noteLayoutLeavingFreeform(freeform({ 'source:base': base(0.6) }))
    noteLayoutLeavingFreeform({
      arrangementMode: 'preset',
      layoutPreset: 'screen-only',
      sourceTransformOverrides: {}
    })
    expect(rememberedFreeform().horizontal).toEqual({ 'source:base': base(0.6) })
  })
})
