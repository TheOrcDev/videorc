import { describe, expect, it } from 'vitest'

import type { Scene, SceneSource } from './backend'
import { canonicalJson, sceneVisibilityIdentity } from './scene-visibility-identity'

const transform = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
}

function camera(visible: boolean): SceneSource {
  return {
    id: 'source:camera',
    name: 'Camera',
    kind: 'camera',
    transform,
    defaultTransform: transform,
    visible,
    locked: false
  }
}

function scene(visible: boolean): Scene {
  return {
    id: 'scene:default',
    name: 'Default Scene',
    sources: [camera(visible)],
    outputs: [{ id: 'output:preview', kind: 'preview', width: 640, height: 360, fps: 30 }]
  } as Scene
}

/** The same scene as another backend reply writes it: `outputs` first, keys sorted. */
function reordered(value: Scene): Scene {
  return JSON.parse(canonicalJson(value)) as Scene
}

describe('sceneVisibilityIdentity', () => {
  it('ignores key order, so an echo written in another order still matches (ogre 2026-10-13)', () => {
    const requested = scene(true)
    const echo = reordered(scene(false))
    expect(Object.keys(echo)).toEqual(['id', 'name', 'outputs', 'sources'])
    expect(JSON.stringify(requested)).not.toBe(
      JSON.stringify({ ...echo, sources: requested.sources })
    )
    expect(sceneVisibilityIdentity(echo, 'source:camera')).toBe(
      sceneVisibilityIdentity(requested, 'source:camera')
    )
  })

  it('still retires a request when anything but that source changed', () => {
    const requested = scene(true)
    const moved: Scene = {
      ...scene(true),
      sources: [{ ...camera(true), transform: { ...transform, x: 0.5 } }]
    }
    expect(sceneVisibilityIdentity(moved, 'source:camera')).not.toBe(
      sceneVisibilityIdentity(requested, 'source:camera')
    )
    // Another source's visibility is a different edit, not this request's.
    expect(sceneVisibilityIdentity(scene(false), 'source:screen')).not.toBe(
      sceneVisibilityIdentity(scene(true), 'source:screen')
    )
  })

  it('keeps array order: a z-order change is a real edit', () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}')
    expect(sceneVisibilityIdentity(null, 'source:camera')).toBe('null')
  })
})
