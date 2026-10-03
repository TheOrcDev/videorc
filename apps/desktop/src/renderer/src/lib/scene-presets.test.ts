import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig, reconcileSourceSelection } from './capture'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSceneVisual,
  resolveSavedBackground,
  sameSceneVisual,
  sceneNameError,
  sceneSourceProblems,
  snapshotBackground,
  sourceVisibilityFromScene
} from './scene-presets'
import { createDefaultRegistry, applySlot, effectiveSceneBackground } from './background-assets'

const visual = () =>
  normalizeSceneVisual({
    layout: defaultCaptureConfig.layout,
    sources: {
      cameraId: 'cam',
      screenId: 'screen',
      microphoneId: 'secret-mic',
      streamKey: 'secret'
    },
    background: null
  })
const saved = () => ({
  id: 'first',
  name: 'First',
  createdAt: '2026-09-22',
  updatedAt: '2026-09-22',
  visual: visual()
})
describe('scene presets', () => {
  it('normalizes hidden visual roles through saved and working snapshots', () => {
    const hidden = normalizeSceneVisual({
      ...visual(),
      layout: { ...defaultCaptureConfig.layout, sourceVisibility: { camera: false, capture: true } }
    })
    expect(hidden.layout).toHaveProperty('sourceVisibility', { camera: false, capture: true })
    const entry = { ...saved(), visual: hidden }
    const library = hydrateSceneLibrary(JSON.parse(JSON.stringify({ version: 1, scenes: [entry] })))
    const checkpoint = hydrateWorkingScene(
      JSON.parse(JSON.stringify({ version: 1, sceneId: entry.id, visual: hidden }))
    )!
    expect(library.library.scenes[0].visual.layout).toHaveProperty('sourceVisibility', {
      camera: false,
      capture: true
    })
    expect(sameSceneVisual(hidden, checkpoint.visual)).toBe(true)
    expect(sameSceneVisual(hidden, visual())).toBe(false)
    expect(hidden.sources.cameraId).toBe('cam')
    expect(hidden.sources.cameraOff).toBe(false)
  })

  it('defaults legacy visibility to visible without falsely modifying old scenes', () => {
    const legacy = visual()
    const { sourceVisibility: _visibility, ...layout } = legacy.layout
    expect(sameSceneVisual(legacy, { ...legacy, layout })).toBe(true)
    expect(
      normalizeSceneVisual({
        ...legacy,
        layout: { ...layout, sourceVisibility: { camera: false } }
      }).layout.sourceVisibility
    ).toEqual({ camera: false, capture: true })
  })
  it.each([
    null,
    [],
    'hidden',
    { camera: 'false' },
    { capture: 0 },
    { microphone: false },
    { camera: false, background: true }
  ])('rejects untrusted visibility %j', (sourceVisibility) => {
    expect(() =>
      normalizeSceneVisual({ ...visual(), layout: { ...visual().layout, sourceVisibility } })
    ).toThrow('Invalid source visibility')
  })
  it.each(['screen', 'window', 'test-pattern'] as const)(
    'merges acknowledged %s visibility while preserving an absent hidden camera',
    (kind) => {
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
      const scene = {
        id: 'main',
        name: 'Main',
        outputs: [],
        sources: [
          {
            id: kind === 'test-pattern' ? 'source:test-pattern' : 'source:base',
            name: 'Capture',
            kind,
            visible: true,
            locked: false,
            transform,
            defaultTransform: transform
          }
        ]
      }
      expect(sourceVisibilityFromScene(scene, { camera: false, capture: false })).toEqual({
        camera: false,
        capture: true
      })
      expect(
        sourceVisibilityFromScene(
          { ...scene, sources: scene.sources.map((source) => ({ ...source, visible: false })) },
          { camera: false, capture: true }
        )
      ).toEqual({ camera: false, capture: false })
    }
  )

  it('merges camera-only acknowledgements without revealing an absent capture role', () => {
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
    const scene = {
      id: 'main',
      name: 'Main',
      outputs: [],
      sources: [
        {
          id: 'source:camera',
          name: 'Camera',
          kind: 'camera' as const,
          visible: true,
          locked: false,
          transform,
          defaultTransform: transform
        }
      ]
    }
    expect(sourceVisibilityFromScene(scene, { camera: false, capture: false })).toEqual({
      camera: true,
      capture: false
    })
    expect(
      sourceVisibilityFromScene({ ...scene, sources: [] }, { camera: false, capture: false })
    ).toEqual({ camera: false, capture: false })
  })

  it('copies normalized visual fields and excludes output, audio and secrets', () => {
    const layout = {
      ...defaultCaptureConfig.layout,
      audio: { microphoneId: 'secret' },
      streamKey: 'secret',
      sourceTransformOverrides: { cam: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
    }
    const snapshot = normalizeSceneVisual({
      layout,
      sources: {
        ...defaultCaptureConfig.sources,
        cameraId: 'cam',
        microphoneId: 'mic',
        microphoneName: 'Private'
      },
      background: null
    })
    layout.sourceTransformOverrides.cam.x = 0.8
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    expect(JSON.stringify(snapshot)).not.toContain('microphone')
    expect(snapshot.layout.sourceTransformOverrides.cam.x).toBe(0.1)
  })
  it('retains valid entries independently and protects unknown future schemas', () => {
    const state = hydrateSceneLibrary({
      version: 1,
      scenes: [saved(), { ...saved(), id: 'bad', visual: null }, saved()]
    })
    expect(state.library.scenes).toHaveLength(1)
    expect(state.error).toBeTruthy()
    expect(hydrateSceneLibrary({ version: 2, scenes: [saved()] }).readOnly).toBe(true)
    expect(sceneNameError(' first ', [saved()])).toBeTruthy()
    expect(sceneNameError(' '.repeat(4), [])).toBeTruthy()
    expect(sceneNameError('x'.repeat(81), [])).toBeTruthy()
  })
  it.each([null, 'true', 1, {}, []])('rejects an untrusted Camera Off value %j', (cameraOff) => {
    expect(() =>
      normalizeSceneVisual({
        ...visual(),
        sources: { cameraOff }
      })
    ).toThrow('Invalid camera Off intent')
  })
  it('retains explicit Off through persisted library and working checkpoints', () => {
    const off = normalizeSceneVisual({ ...visual(), sources: { cameraOff: true } })
    const entry = { ...saved(), visual: off }
    const library = hydrateSceneLibrary(JSON.parse(JSON.stringify({ version: 1, scenes: [entry] })))
    const checkpoint = hydrateWorkingScene(
      JSON.parse(JSON.stringify({ version: 1, sceneId: entry.id, visual: off }))
    )!
    expect(library.library.scenes[0].visual.sources.cameraOff).toBe(true)
    expect(checkpoint.visual.sources.cameraOff).toBe(true)
    expect(checkpoint.visual.sources.cameraId).toBeUndefined()
    expect(sameSceneVisual(entry.visual, checkpoint.visual)).toBe(true)
  })
  it('normalizes On and legacy absent flags equally without treating a missing ID as Off', () => {
    const on = visual()
    expect(on.sources.cameraOff).toBe(false)
    expect(sameSceneVisual(on, { ...on, sources: { ...on.sources, cameraOff: undefined } })).toBe(
      true
    )
    expect(sameSceneVisual(on, { ...on, sources: { ...on.sources, cameraOff: false } })).toBe(true)
    const legacy = normalizeSceneVisual({ ...on, sources: {} })
    expect(legacy.sources.cameraOff).toBe(false)
    expect(
      reconcileSourceSelection(legacy.sources, [
        { id: 'cam', name: 'Camera', kind: 'camera', status: 'available' }
      ]).cameraId
    ).toBe('cam')
  })
  it('keeps selected IDs authoritative over contradictory Off and preserves missing-device policy', () => {
    const contradictory = normalizeSceneVisual({
      ...visual(),
      sources: { cameraId: 'cam', cameraOff: true }
    })
    expect(contradictory.sources.cameraOff).toBe(false)
    const devices = [
      { id: 'cam', name: 'Camera', kind: 'camera' as const, status: 'available' as const }
    ]
    expect(reconcileSourceSelection(contradictory.sources, devices).cameraId).toBe('cam')
    const missing = normalizeSceneVisual({
      ...visual(),
      layout: { ...visual().layout, layoutPreset: 'camera-only' },
      sources: { cameraId: 'missing', cameraOff: true }
    })
    expect(missing.sources.cameraOff).toBe(false)
    expect(sceneSourceProblems(missing, devices)).toEqual([
      'Camera unavailable. Choose a replacement.'
    ])
    expect(reconcileSourceSelection(missing.sources, devices).cameraId).toBe('cam')
  })
  it('restores a modified working checkpoint rather than reapplying the named snapshot', () => {
    const modified = visual()
    modified.layout.cameraZoom = 165
    const checkpoint = hydrateWorkingScene(
      JSON.parse(JSON.stringify({ version: 1, sceneId: 'first', visual: modified }))
    )!
    expect(checkpoint.visual.layout.cameraZoom).toBe(165)
    expect(sameSceneVisual(saved().visual, checkpoint.visual)).toBe(false)
  })
  it('keeps immutable bundled backgrounds by stable identity and blocks arbitrary paths', () => {
    const registry = applySlot(createDefaultRegistry(), 'bg-01')
    const snapshot = snapshotBackground(effectiveSceneBackground(registry))!
    registry.assets['builtin-bg-01'].styleDefaults.blurPx = 20
    expect(snapshot.blurPx).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain('/assets/')
    expect(resolveSavedBackground(snapshot)?.managedAssetPath).toBe(
      'videorc-asset://background/code-demo.webp'
    )
    expect(() =>
      normalizeSceneVisual({
        ...visual(),
        background: { ...snapshot, assetId: 'imported', fileName: '../secret.png' }
      })
    ).toThrow()
  })
  it('checks exact available source IDs with layout-aware and Freeform requirements', () => {
    const devices = [
      { id: 'cam', name: 'Camera', kind: 'camera' as const, status: 'available' as const }
    ]
    const target = visual()
    target.layout.layoutPreset = 'camera-only'
    expect(sceneSourceProblems(target, devices)).toEqual([])
    target.layout.arrangementMode = 'freeform'
    expect(sceneSourceProblems(target, devices)).toHaveLength(1)
    target.layout.layoutPreset = 'screen-only'
    target.sources.testPattern = true
    target.sources.screenId = undefined
    expect(sceneSourceProblems(target, [])).toHaveLength(1)
    target.layout.arrangementMode = 'preset'
    target.sources.windowId = 'closed-window'
    expect(sceneSourceProblems(target, devices)).toHaveLength(1)
    target.sources.windowId = undefined
    target.sources.screenId = 'missing-screen'
    expect(sceneSourceProblems(target, devices)).toHaveLength(1)
  })
})
