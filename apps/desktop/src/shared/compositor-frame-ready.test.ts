import { describe, expect, it } from 'vitest'

import type { CompositorFrameReady, CompositorStatus } from './backend'
import { compositorStatusFromFrameReady } from './compositor-frame-ready'

function frame(overrides: Partial<CompositorFrameReady> = {}): CompositorFrameReady {
  return {
    targetFps: 60,
    width: 1920,
    height: 1080,
    runId: 'run-a',
    sceneRevision: 7,
    frameSceneRevision: 7,
    framesRendered: 42,
    frameAgeMs: 3,
    metalTargetIosurfaceId: 99,
    metalTargetWidth: 1920,
    metalTargetHeight: 1080,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides
  }
}

function status(overrides: Partial<CompositorStatus> = {}): CompositorStatus {
  return {
    state: 'live',
    targetFps: 60,
    width: 1920,
    height: 1080,
    runId: 'run-a',
    sceneRevision: 7,
    frameSceneRevision: 6,
    sceneId: 'scene-a',
    sceneSources: [],
    sources: [],
    framesRendered: 41,
    repeatedFrames: 2,
    droppedFrames: 1,
    imageCache: {
      budgetBytes: 1024,
      entryBudget: 2,
      entries: 1,
      decodedBytes: 4,
      preconvertedBgraBytes: 4,
      residentBytes: 8,
      pinnedEntries: 1,
      pinnedBytes: 8,
      hits: 3,
      misses: 1,
      evictions: 0
    },
    framePipeline: {
      consumer: 'native-preview',
      gpuReadbacks: 0,
      bgraBytesCopied: 0,
      yuvFramesConverted: 0,
      immutableTextureUploads: 1,
      immutableTextureReuses: 4
    },
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides
  }
}

describe('compositor frame-ready expansion', () => {
  it('advances only compact frame fields while retaining matching diagnostics', () => {
    const previous = status()
    const next = compositorStatusFromFrameReady(frame(), previous)

    expect(next.framesRendered).toBe(42)
    expect(next.frameSceneRevision).toBe(7)
    expect(next.sceneId).toBe('scene-a')
    expect(next.imageCache).toBe(previous.imageCache)
    expect(next.framePipeline).toBe(previous.framePipeline)
  })

  it('does not attach stale scene data to a new run or revision', () => {
    const next = compositorStatusFromFrameReady(
      frame({ runId: 'run-b', sceneRevision: 8, frameSceneRevision: 8 }),
      status()
    )

    expect(next.sceneId).toBeUndefined()
    expect(next.sceneSources).toEqual([])
    expect(next.sources).toEqual([])
    expect(next.imageCache?.entries).toBe(0)
  })
})
