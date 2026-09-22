import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig } from './capture'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSceneVisual,
  resolveSavedBackground,
  sameSceneVisual,
  sceneNameError,
  sceneSourceProblems,
  snapshotBackground
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
