import { describe, expect, it } from 'vitest'

import type { LayoutSettings, SceneSource } from './backend'
import {
  previewProofBackgroundStageMargin,
  previewProofLayerFit,
  previewProofLayerShape
} from './native-preview-proof-geometry'

const camera = { kind: 'camera' } as SceneSource
const screen = { kind: 'screen' } as SceneSource

function layout(overrides: Partial<LayoutSettings> = {}): LayoutSettings {
  return {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rounded',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fit',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right',
    ...overrides
  }
}

describe('Windows proof-surface geometry', () => {
  it('matches Rust visibilityPercent background stage margins', () => {
    expect(previewProofBackgroundStageMargin(undefined)).toBe(0)
    expect(previewProofBackgroundStageMargin({ visibilityPercent: 0 })).toBe(0)
    expect(previewProofBackgroundStageMargin({ visibilityPercent: 20 })).toBe(0.1)
    expect(previewProofBackgroundStageMargin({ visibilityPercent: 40 })).toBe(0.2)
    expect(previewProofBackgroundStageMargin({ visibilityPercent: 100 })).toBe(0.2)
  })

  it('matches Rust camera fit policy when zoom turns fit into cover', () => {
    expect(previewProofLayerFit(camera, layout())).toBe('contain')
    expect(previewProofLayerFit(camera, layout({ cameraZoom: 101 }))).toBe('cover')
    expect(previewProofLayerFit(camera, layout({ cameraFit: 'fill' }))).toBe('cover')
  })

  it('covers only side-by-side screen regions', () => {
    expect(previewProofLayerFit(screen, layout({ layoutPreset: 'screen-only' }))).toBe('contain')
    expect(previewProofLayerFit(screen, layout({ layoutPreset: 'side-by-side' }))).toBe('cover')
    // Vertical screen bands CONTAIN — nothing on the user's screen is cropped.
    expect(previewProofLayerFit(screen, layout({ layoutPreset: 'vertical-camera-top' }))).toBe(
      'contain'
    )
  })

  it('preserves rounded and circle masks only for the inset scene overlays', () => {
    expect(previewProofLayerShape(camera, layout({ cameraShape: 'rounded' }))).toBe('rounded')
    expect(previewProofLayerShape(camera, layout({ cameraShape: 'circle' }))).toBe('circle')
    expect(previewProofLayerShape(camera, layout({ layoutPreset: 'vertical-screen-camera' }))).toBe(
      'rounded'
    )
    expect(previewProofLayerShape(camera, layout({ layoutPreset: 'camera-only' }))).toBe(
      'rectangle'
    )
    expect(previewProofLayerShape(camera, layout({ layoutPreset: 'vertical-camera-top' }))).toBe(
      'rectangle'
    )
    expect(previewProofLayerShape(screen, layout())).toBeUndefined()
  })
})
