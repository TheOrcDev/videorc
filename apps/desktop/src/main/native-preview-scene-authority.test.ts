import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceSceneState, PreviewSurfaceStatus } from '../shared/backend'
import {
  compositorSceneConflictsWithCommitted,
  nativePreviewStatusProvesSceneRevision
} from '../shared/native-preview-scene-authority'

describe('native preview compositor scene authority', () => {
  it('rejects different scene content claiming the same revision in one compositor run', () => {
    const committed = scene(12, 'side-by-side')
    const conflicting = scene(12, 'screen-camera')

    expect(
      compositorSceneConflictsWithCommitted(committed, conflicting, {
        committedRunId: 'run-a',
        candidateRunId: 'run-a'
      })
    ).toBe(true)
  })

  it('ignores timestamps and allows a new compositor run to restart revision numbering', () => {
    const committed = scene(3, 'side-by-side')
    const sameContent = {
      ...committed,
      updatedAt: 'later',
      sources: [
        {
          id: 'screen',
          name: 'Screen',
          kind: 'screen' as const,
          transform: transform(),
          visible: true,
          frameUrl: 'http://preview/frame.png?maxWidth=640',
          fit: 'contain' as const,
          mirror: false
        }
      ]
    }
    committed.sources = [
      {
        ...sameContent.sources[0],
        frameUrl: 'http://preview/frame.png?maxWidth=1280'
      }
    ]
    const restarted = scene(3, 'screen-only')

    expect(
      compositorSceneConflictsWithCommitted(committed, sameContent, {
        committedRunId: 'run-a',
        candidateRunId: 'run-a'
      })
    ).toBe(false)
    expect(
      compositorSceneConflictsWithCommitted(committed, restarted, {
        committedRunId: 'run-a',
        candidateRunId: 'run-b'
      })
    ).toBe(false)
  })

  it('requires an attached in-process present at or beyond the committed revision', () => {
    const status = {
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      sourcePixelsPresent: true,
      nativePreviewHostKind: 'in-process',
      nativePreviewHostAttached: true,
      nativePreviewPresentedSceneRevision: 12
    } as PreviewSurfaceStatus

    expect(nativePreviewStatusProvesSceneRevision(status, 12)).toBe(true)
    expect(nativePreviewStatusProvesSceneRevision(status, 13)).toBe(false)
    expect(
      nativePreviewStatusProvesSceneRevision(
        { ...status, nativePreviewHostKind: 'proof-surface', nativePreviewHostAttached: false },
        12
      )
    ).toBe(false)
  })

  it('accepts a newer presented revision as proof of a superseded commit', () => {
    const status = {
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      sourcePixelsPresent: true,
      nativePreviewHostKind: 'in-process',
      nativePreviewHostAttached: true,
      nativePreviewPresentedSceneRevision: 13
    } as PreviewSurfaceStatus

    // Latest-wins presentation may skip an intermediate committed revision and
    // land directly on a newer one; the older commit is proven, not stale.
    expect(nativePreviewStatusProvesSceneRevision(status, 12)).toBe(true)
    expect(
      nativePreviewStatusProvesSceneRevision(
        { ...status, nativePreviewPresentedSceneRevision: undefined },
        12
      )
    ).toBe(false)
  })
})

function scene(
  revision: number,
  layoutPreset: PreviewSurfaceSceneState['layout']['layoutPreset']
): PreviewSurfaceSceneState {
  return {
    revision,
    sceneId: 'scene-1',
    layout: {
      layoutPreset,
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraCornerRadiusPct: 12,
      cameraAspect: 'source',
      cameraChromaKeyEnabled: false,
      cameraChromaKeyColor: '#00FF00',
      cameraChromaKeySimilarityPct: 40,
      cameraChromaKeySmoothnessPct: 8,
      cameraChromaKeySpillPct: 10,
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    sources: [],
    updatedAt: 'now'
  }
}

function transform() {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
}
