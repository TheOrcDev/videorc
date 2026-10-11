import { describe, expect, it } from 'vitest'

import type { CameraTransform, LayoutPreset, LayoutSettings } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import {
  freeformEntryOverrides,
  layoutUndoAfterCommit,
  noteLayoutCommitted,
  noteLayoutLeavingFreeform,
  peekLayoutUndo,
  rememberFreeform,
  rememberedFreeform,
  restoreLayoutUndo,
  takeLayoutUndo,
  type FreeformMemory,
  type LayoutUndoEntry
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

// Plan 174 S3.9 (D15, C-4): one ⌘Z returns to the layout the last change replaced.

const layoutWith = (patch: Partial<LayoutSettings>): LayoutSettings => ({
  ...defaultCaptureConfig.layout,
  ...patch
})
const entry = (layout: LayoutSettings, savedSceneId: string | null = null): LayoutUndoEntry => ({
  layout,
  savedSceneId,
  origin: savedSceneId ? 'saved' : 'builtin'
})

describe('Layout undo (plan 174 S3.9, D15)', () => {
  const freeformLayout = layoutWith({
    arrangementMode: 'freeform',
    sourceTransformOverrides: { 'source:camera': camera(0.1) }
  })
  const presetLayout = layoutWith({ layoutPreset: 'screen-only' })

  it('holds the layout a commit replaced, and keeps it through commits that change nothing', () => {
    expect(layoutUndoAfterCommit(null, null, presetLayout)).toBeNull()
    const slot = layoutUndoAfterCommit(null, entry(freeformLayout), presetLayout)
    expect(slot).toEqual(entry(freeformLayout))
    // A background-only commit or a reconciliation carries the same layout.
    expect(layoutUndoAfterCommit(slot, entry(presetLayout), { ...presetLayout })).toBe(slot)
    // The next real change replaces the slot: a single level, no history.
    const sized = layoutWith({ layoutPreset: 'screen-only', cameraSize: 'large' })
    expect(layoutUndoAfterCommit(slot, entry(presetLayout, 'scene-a'), sized)).toEqual(
      entry(presetLayout, 'scene-a')
    )
  })

  it('gives the entry to one undo at a time, and holds the undone layout afterwards', () => {
    takeLayoutUndo()
    noteLayoutCommitted(entry(freeformLayout), presetLayout)
    expect(peekLayoutUndo()).toEqual(entry(freeformLayout))
    const taken = takeLayoutUndo()
    expect(taken).toEqual(entry(freeformLayout))
    expect(peekLayoutUndo()).toBeNull()
    // The undo's own commit lands: ⌘Z again brings the preset back.
    noteLayoutCommitted(entry(presetLayout), freeformLayout)
    expect(peekLayoutUndo()).toEqual(entry(presetLayout))
  })

  it('puts a refused undo back unless a newer change filled the slot', () => {
    takeLayoutUndo()
    noteLayoutCommitted(entry(freeformLayout), presetLayout)
    const taken = takeLayoutUndo()
    restoreLayoutUndo(taken)
    expect(peekLayoutUndo()).toEqual(entry(freeformLayout))
    takeLayoutUndo()
    noteLayoutCommitted(entry(presetLayout, 'scene-b'), freeformLayout)
    restoreLayoutUndo(taken)
    expect(peekLayoutUndo()).toEqual(entry(presetLayout, 'scene-b'))
    restoreLayoutUndo(null)
    expect(peekLayoutUndo()).toEqual(entry(presetLayout, 'scene-b'))
  })
})
