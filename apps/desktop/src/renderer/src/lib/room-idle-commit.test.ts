import { describe, expect, it } from 'vitest'
import type { Scene } from '@/lib/backend'
import type { CaptureConfig } from '@/lib/capture'
import {
  commitSceneIdle,
  idleCommitOutput,
  roomAlignmentCommit,
  roomTransactionCommit,
  type IdleCommitState
} from './room-idle-commit'

type Background = NonNullable<Scene['background']>
const background = (assetId: string): Background => ({ assetId }) as Background

const horizontal = { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30 }
const layout = (layoutPreset: string): CaptureConfig['layout'] =>
  ({ layoutPreset, cameraShape: 'rounded' }) as unknown as CaptureConfig['layout']

function state(overrides: Partial<IdleCommitState> = {}): IdleCommitState {
  return {
    config: {
      layout: layout('camera-only'),
      sources: { cameraId: 'camera-1', screenId: 'screen-1' },
      video: horizontal,
      verticalRestoreVideo: null
    } as unknown as CaptureConfig,
    background: background('working'),
    app: undefined,
    origin: 'saved',
    ...overrides
  }
}

describe('a native layout transaction made while a room holds the camera', () => {
  it('takes the background the transaction names over the working one', () => {
    const commit = roomTransactionCommit(state(), layout('camera-only'), {
      backgroundOverride: background('picked')
    })
    expect(commit.params.background).toEqual(background('picked'))
    // The working sources and canvas: nothing native starts or changes.
    expect(commit.params.sources).toEqual({ cameraId: 'camera-1', screenId: 'screen-1' })
    expect(commit.params.video).toEqual(horizontal)
  })

  it('takes the background off when the transaction names none', () => {
    const commit = roomTransactionCommit(state(), layout('camera-only'), {
      backgroundOverride: null
    })
    expect('background' in commit.params).toBe(false)
  })

  it('keeps the working background for a change that names no background', () => {
    const next = layout('screen-camera')
    const commit = roomTransactionCommit(state(), next, undefined)
    expect(commit.params.background).toEqual(background('working'))
    expect(commit.params.layout).toBe(next)
    expect(roomTransactionCommit(state({ background: null }), next, {}).params).not.toHaveProperty(
      'background'
    )
  })

  it('is an edit of the scene on stream: it keeps the scene, its app and its origin', () => {
    const app = { bundleId: 'com.figma.Desktop' } as unknown as IdleCommitState['app']
    const commit = roomTransactionCommit(state({ app }), layout('camera-only'), {})
    expect(commit.rest).toEqual({
      captureConfigPatch: undefined,
      sceneApp: app,
      savedSceneId: undefined,
      origin: 'saved'
    })
    expect(commit.rest.sceneSwitch).toBeUndefined()
  })

  it('carries an undo: its scene, origin and canvas', () => {
    const vertical = { ...horizontal, width: 1080, height: 1920 }
    const captureConfigPatch = { video: vertical, verticalRestoreVideo: horizontal }
    const commit = roomTransactionCommit(state(), layout('camera-only'), {
      savedSceneId: 'scene-2',
      origin: 'builtin',
      videoOverride: vertical,
      captureConfigPatch
    } as Parameters<typeof roomTransactionCommit>[2])
    expect(commit.params.video).toEqual(vertical)
    expect(commit.rest).toMatchObject({
      savedSceneId: 'scene-2',
      origin: 'builtin',
      captureConfigPatch
    })
  })
})

describe('the native working scene after a scene went to the room program', () => {
  it('is a switch to that scene, without the app the room resolved', () => {
    const commit = roomAlignmentCommit(
      state(),
      {
        layout: layout('screen-camera'),
        sources: {
          cameraId: 'camera-1',
          windowId: 'window-9',
          app: { bundleId: 'com.figma.Desktop' }
        } as unknown as CaptureConfig['sources'],
        background: background('scene')
      },
      'scene-3'
    )
    expect(commit.params).toEqual({
      sources: { cameraId: 'camera-1', windowId: 'window-9' },
      layout: layout('screen-camera'),
      video: horizontal,
      background: background('scene')
    })
    expect(commit.rest).toEqual({ origin: 'saved', savedSceneId: 'scene-3', sceneSwitch: true })
  })

  it('names a preset as built in and sends no background when the scene has none', () => {
    const commit = roomAlignmentCommit(
      state(),
      { layout: layout('camera-only'), sources: { cameraId: 'camera-1' }, background: null },
      null
    )
    expect(commit.rest).toEqual({ origin: 'builtin', savedSceneId: null, sceneSwitch: true })
    expect(commit.params).not.toHaveProperty('background')
  })

  it('takes the canvas of the other orientation with a vertical scene', () => {
    const commit = roomAlignmentCommit(
      state(),
      {
        layout: layout('vertical-camera-only'),
        sources: { cameraId: 'camera-1' },
        background: null
      },
      'scene-v'
    )
    expect(commit.params.video.height).toBeGreaterThan(commit.params.video.width)
    expect(commit.rest.captureConfigPatch?.video).toEqual(commit.params.video)
    expect(commit.rest.captureConfigPatch?.verticalRestoreVideo).toEqual(horizontal)
  })
})

describe('the idle commit', () => {
  it('commits through scene.load_from_capture_config and never a layout transaction', async () => {
    const requests: { method: string; params: unknown }[] = []
    const scene = { id: 'scene', background: background('picked') } as unknown as Scene
    const compositorStatus = { sceneRevision: 7 } as never
    const commit = roomTransactionCommit(state(), layout('camera-only'), {
      backgroundOverride: background('picked')
    })
    const snapshot = await commitSceneIdle(
      {
        request: async <T>(method: string, params?: unknown) => {
          requests.push({ method, params })
          return { applied: true, mode: 'idle', sceneRevision: 7, scene, compositorStatus } as T
        }
      },
      commit
    )
    expect(requests).toEqual([{ method: 'scene.load_from_capture_config', params: commit.params }])
    expect(snapshot).toEqual({
      sceneRevision: 7,
      scene,
      layout: commit.params.layout,
      compositorStatus,
      sources: commit.params.sources,
      ...commit.rest
    })
  })

  it('lets a refused commit reach the caller, which reports it', async () => {
    await expect(
      commitSceneIdle(
        { request: async () => Promise.reject(new Error('superseded by session startup')) },
        roomTransactionCommit(state(), layout('camera-only'), undefined)
      )
    ).rejects.toThrow('superseded by session startup')
  })
})

// Plan 258 S1 put the camera's background on a room's idle commit and left the
// look off it: a scene's layout carries no look, so putting a scene on the room
// program took the look off the camera while every other output kept it.
describe('the idle commit at the output boundary', () => {
  const look = { brightness: 0.1, contrast: 1.2, saturation: 0.8 }
  const keyed = { mode: 'green', blurPct: 0, edges: 'soft' } as never

  const aligned = () =>
    roomAlignmentCommit(
      state(),
      { layout: layout('screen-camera'), sources: { cameraId: 'camera-1' }, background: null },
      'scene-3'
    )

  it("puts the selected camera's look on a scene's layout, as every other output does", () => {
    const out = idleCommitOutput(aligned(), { cameraLooks: { 'camera-1': look } })
    expect(out.params.layout.cameraLook).toEqual(look)
  })

  it("puts the look and the background on together, and never another camera's", () => {
    const out = idleCommitOutput(aligned(), {
      cameraLooks: {
        'camera-1': look,
        'camera-2': { brightness: -0.2, contrast: 1, saturation: 1 }
      },
      cameraBackgrounds: { 'camera-1': keyed }
    })
    expect(out.params.layout.cameraLook).toEqual(look)
    expect(out.params.layout.cameraBackground).toEqual(keyed)
  })

  it("drops a look the camera no longer has instead of keeping the scene's", () => {
    const base = aligned()
    const stale = {
      ...base,
      params: { ...base.params, layout: { ...base.params.layout, cameraLook: look } }
    }
    expect(idleCommitOutput(stale, {}).params.layout).not.toHaveProperty('cameraLook')
  })

  it('leaves everything but the layout as it was', () => {
    const base = aligned()
    const out = idleCommitOutput(base, { cameraLooks: { 'camera-1': look } })
    expect(out.rest).toBe(base.rest)
    expect(out.params.sources).toBe(base.params.sources)
    expect(out.params.video).toBe(base.params.video)
  })
})
