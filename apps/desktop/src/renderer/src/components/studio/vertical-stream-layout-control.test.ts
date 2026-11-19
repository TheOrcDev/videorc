import { describe, expect, it } from 'vitest'

import { defaultCaptureConfig } from '@/lib/capture'
import { normalizeLayoutFramingMemory } from '@/lib/layout-framing-memory'

import { verticalStreamLayout } from './vertical-stream-layout-control'

// Plan 231 D4: the Vertical stream panel's edit of the scene on stream's
// 9:16 layout, before the provider saves it and sends it to the leg.
describe('verticalStreamLayout', () => {
  const memory = normalizeLayoutFramingMemory(null)
  const arranged = {
    ...defaultCaptureConfig.layout,
    layoutPreset: 'vertical-screen-camera' as const,
    verticalScreenFraming: 'fit' as const,
    cameraTransformMode: 'custom' as const,
    cameraTransform: { x: 0.6, y: 0.7, width: 0.3, height: 0.2 },
    cameraShape: 'circle' as const
  }

  it('Fill or Fit changes the framing and keeps the arrangement', () => {
    expect(verticalStreamLayout(arranged, { verticalScreenFraming: 'fill' }, memory)).toEqual({
      ...arranged,
      verticalScreenFraming: 'fill'
    })
  })

  it('another layout is a layout pick: its remembered framing, preset arrangement, no drag', () => {
    const remembered = {
      ...memory,
      layouts: {
        ...memory.layouts,
        'vertical-split': { ...memory.layouts['vertical-split'], cameraZoom: 140 }
      }
    }
    const next = verticalStreamLayout(arranged, { layoutPreset: 'vertical-split' }, remembered)
    expect(next).toMatchObject({
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fit',
      cameraShape: 'circle',
      cameraZoom: 140,
      cameraTransformMode: 'preset',
      cameraTransform: null,
      arrangementMode: 'preset',
      sourceTransformOverrides: {}
    })
  })
})
