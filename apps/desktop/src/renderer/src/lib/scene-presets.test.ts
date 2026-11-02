import { describe, expect, it } from 'vitest'
import type { Device } from './backend'
import { defaultCaptureConfig, reconcileSourceSelection } from './capture'
import {
  visualSources,
  usingVisualSources,
  sceneDisplay,
  sceneDisplayRefresh,
  withSceneDisplay,
  type SceneVisual,
  type VisualSources,
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSavedBackground,
  normalizeSceneVisual,
  resolveSavedBackground,
  sameSceneAudio,
  sameSceneVisual,
  sceneAudio,
  sceneMicrophone,
  galleryPresetIsActive,
  sceneGalleryReason,
  sceneNameError,
  sceneSourceGaps,
  orientationSwitchPreset,
  sceneSourceProblems,
  sceneSourcesTurnedOff,
  snapshotBackground,
  sourceVisibilityFromScene
} from './scene-presets'
import {
  createDefaultRegistry,
  effectiveSceneBackground,
  liveSceneBackground
} from './background-assets'
import { applySlot } from './background-library'
import { sceneSourceOffBlockedReason } from './start-blocked-copy'

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
  it('retains a screen set to None through persisted scenes (plan 0002)', () => {
    const none = normalizeSceneVisual({ ...visual(), sources: { captureOff: true } })
    expect(none.sources.captureOff).toBe(true)
    const entry = { ...saved(), visual: none }
    const library = hydrateSceneLibrary(JSON.parse(JSON.stringify({ version: 1, scenes: [entry] })))
    expect(library.library.scenes[0].visual.sources.captureOff).toBe(true)
    expect(() => normalizeSceneVisual({ ...visual(), sources: { captureOff: 'yes' } })).toThrow(
      'Invalid screen None intent'
    )
    // A chosen screen wins over a stale None, and a legacy scene is never None.
    expect(
      normalizeSceneVisual({ ...visual(), sources: { screenId: 'screen:1', captureOff: true } })
        .sources.captureOff
    ).toBe(false)
    expect(normalizeSceneVisual({ ...visual(), sources: {} }).sources.captureOff).toBe(false)
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
      'Camera unavailable. Choose a replacement in Sources.'
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

describe('scene gallery reason line (plan 174 S3.3, B-20)', () => {
  const screen = {
    id: 'screen',
    name: 'Display',
    kind: 'screen' as const,
    status: 'available' as const
  }
  const cam = { id: 'cam', name: 'Camera', kind: 'camera' as const, status: 'available' as const }

  it('tells a camera turned off from a camera that is gone', () => {
    const off = visual()
    off.layout.layoutPreset = 'camera-only'
    off.sources.cameraId = undefined
    expect(sceneSourceGaps(off, [screen, cam])).toEqual([{ source: 'camera', state: 'off' }])
    const gone = visual()
    gone.layout.layoutPreset = 'camera-only'
    expect(sceneSourceGaps(gone, [screen])).toEqual([{ source: 'camera', state: 'unavailable' }])
    const fine = visual()
    fine.layout.layoutPreset = 'screen-camera'
    expect(sceneSourceGaps(fine, [screen, cam])).toEqual([])
  })

  it('says why in one line, naming the scenes each missing source blocks', () => {
    const cameraOff = [{ source: 'camera', state: 'off' }] as const
    expect(sceneGalleryReason([])).toBeNull()
    expect(
      sceneGalleryReason([
        { label: 'Screen + camera', gaps: cameraOff },
        { label: 'Camera only', gaps: cameraOff },
        { label: 'Side by side', gaps: cameraOff }
      ])
    ).toBe(
      'Camera is off. Choose one in Sources to use Screen + camera, Camera only, and Side by side.'
    )
    expect(
      sceneGalleryReason([
        { label: 'Camera only', gaps: [{ source: 'camera', state: 'unavailable' }] },
        { label: 'Screen only', gaps: [{ source: 'screen', state: 'off' }] }
      ])
    ).toBe(
      "Your camera isn't available. Choose another in Sources to use Camera only. No screen is chosen. Choose one in Sources to use Screen only."
    )
  })

  it('blocks a start when the scene shows a source turned off on purpose (retest 150)', () => {
    // Screen None while Screen + camera stays the active scene.
    const noScreen = visual()
    noScreen.layout.layoutPreset = 'screen-camera'
    noScreen.sources.screenId = undefined
    noScreen.sources.captureOff = true
    expect(sceneSourcesTurnedOff(noScreen, [cam])).toEqual({ screen: true, camera: false })
    expect(sceneSourceOffBlockedReason(sceneSourcesTurnedOff(noScreen, [cam]))).toBe(
      'This scene shows a screen, but Screen is set to None. Choose a screen in Sources, or pick a scene without one.'
    )
    // Camera Off while Camera only stays the active scene.
    const noCamera = visual()
    noCamera.layout.layoutPreset = 'camera-only'
    noCamera.sources.cameraId = undefined
    noCamera.sources.cameraOff = true
    expect(sceneSourceOffBlockedReason(sceneSourcesTurnedOff(noCamera, [screen]))).toBe(
      'This scene shows a camera, but Camera is off. Turn it on in Sources, or pick a scene without one.'
    )
    const both = {
      ...noScreen,
      sources: { ...noScreen.sources, cameraId: undefined, cameraOff: true }
    }
    expect(sceneSourceOffBlockedReason(sceneSourcesTurnedOff(both, []))).toContain('both are off')
    // A scene without the turned-off source starts.
    const cameraOnly = {
      ...noScreen,
      layout: { ...noScreen.layout, layoutPreset: 'camera-only' as const }
    }
    expect(sceneSourceOffBlockedReason(sceneSourcesTurnedOff(cameraOnly, [cam]))).toBeNull()
    // Never chosen, or chosen and gone, is not "turned off": no new block.
    const neverChosen = visual()
    neverChosen.sources.screenId = undefined
    expect(sceneSourcesTurnedOff(neverChosen, [cam])).toEqual({ screen: false, camera: false })
    expect(sceneSourcesTurnedOff(visual(), [])).toEqual({ screen: false, camera: false })
    expect(sceneSourceOffBlockedReason({ screen: false, camera: false })).toBeNull()
  })

  it('marks no preset card active while the layout is Freeform (retest 150)', () => {
    const layout = { layoutPreset: 'camera-only' as const, arrangementMode: 'preset' as const }
    expect(galleryPresetIsActive(layout, 'camera-only', null)).toBe(true)
    expect(galleryPresetIsActive(layout, 'screen-only', null)).toBe(false)
    // Freeform keeps the last preset's name underneath: no card is on air.
    expect(
      galleryPresetIsActive({ ...layout, arrangementMode: 'freeform' }, 'camera-only', null)
    ).toBe(false)
    // A saved scene applied: the saved row is the active one.
    expect(galleryPresetIsActive(layout, 'camera-only', 'saved-1')).toBe(false)
  })

  it('a scene refused for a source turned off says so, not "unavailable" (retest 150)', () => {
    const noScreen = visual()
    noScreen.layout.layoutPreset = 'screen-camera'
    noScreen.sources.screenId = undefined
    noScreen.sources.captureOff = true
    expect(sceneSourceProblems(noScreen, [cam])).toEqual([
      'No screen is chosen. Choose one in Sources to use this scene.'
    ])
    const noCamera = visual()
    noCamera.layout.layoutPreset = 'camera-only'
    noCamera.sources.cameraId = undefined
    expect(sceneSourceProblems(noCamera, [screen])).toEqual([
      'Camera is off. Turn it on in Sources to use this scene.'
    ])
  })

  it('an orientation switch lands on a scene the sources can show (retest 150)', () => {
    const vertical = [
      'vertical-camera-top',
      'vertical-screen-only',
      'vertical-camera-only'
    ] as const
    const cameraOnly = (preset: string) => preset === 'vertical-camera-only'
    // Screen None: the remembered screen scene would be refused.
    expect(orientationSwitchPreset('vertical-camera-top', vertical, cameraOnly)).toBe(
      'vertical-camera-only'
    )
    // The remembered scene wins whenever it works.
    expect(orientationSwitchPreset('vertical-camera-top', vertical, () => true)).toBe(
      'vertical-camera-top'
    )
    // Nothing works: keep the remembered one, its refusal says why.
    expect(orientationSwitchPreset('vertical-camera-top', vertical, () => false)).toBe(
      'vertical-camera-top'
    )
  })

  it('never says a camera turned off is unavailable', () => {
    const line = sceneGalleryReason([
      { label: 'Camera only', gaps: [{ source: 'camera', state: 'off' }] }
    ])
    expect(line).not.toContain('unavailable')
    expect(line).not.toContain('replacement')
  })
})

describe('saved scenes keep live backgrounds (plan 190)', () => {
  it('round-trips a live background through a saved scene', () => {
    const live = liveSceneBackground('side-rays', {
      look: 'moonlight',
      motion: 'normal',
      dimPercent: 15,
      visibilityPercent: 30
    })
    const saved = snapshotBackground(live)
    expect(saved).not.toHaveProperty('fileName')
    expect(saved?.live).toStrictEqual({ id: 'side-rays', look: 'moonlight', motion: 'normal' })
    expect(resolveSavedBackground(JSON.parse(JSON.stringify(saved)))).toStrictEqual(live)
  })

  it('restores the shader from the poster id when a spec is missing or wrong', () => {
    const live = liveSceneBackground('silk', {
      look: 'champagne',
      motion: 'calm',
      dimPercent: 0,
      visibilityPercent: 20
    })
    const { live: _spec, ...withoutSpec } = snapshotBackground(live)!
    expect(normalizeSavedBackground(withoutSpec)?.live).toStrictEqual({
      id: 'silk',
      look: 'champagne',
      motion: 'calm'
    })
    expect(
      normalizeSavedBackground({
        ...withoutSpec,
        live: { id: 'plasma-wave', look: 'x', motion: 'normal' }
      })?.live
    ).toStrictEqual({ id: 'silk', look: 'champagne', motion: 'normal' })
  })
})

describe('saved scenes keep the microphone and system audio (owner, 2026-10-27)', () => {
  const microphones = [
    {
      id: 'mic:1',
      name: 'Microphone 1',
      kind: 'microphone' as const,
      status: 'available' as const
    },
    {
      id: 'mic:2',
      name: 'Microphone 2',
      kind: 'microphone' as const,
      status: 'unavailable' as const
    }
  ]
  it('round-trips the microphone and System audio through the library', () => {
    const audio = sceneAudio(
      { microphoneId: 'mic:1', microphoneName: 'Microphone 1', microphoneOff: true },
      { systemAudioEnabled: true }
    )
    // A chosen microphone wins over a stale None, like the camera.
    expect(audio).toStrictEqual({
      microphoneId: 'mic:1',
      microphoneName: 'Microphone 1',
      microphoneOff: false,
      systemAudioEnabled: true
    })
    const state = hydrateSceneLibrary(
      JSON.parse(JSON.stringify({ version: 1, scenes: [{ ...saved(), audio }] }))
    )
    expect(state.library.scenes[0].audio).toStrictEqual(audio)
    expect(state.error).toBeNull()
  })
  it('keeps a scene saved before scenes kept audio, with no opinion on audio', () => {
    const state = hydrateSceneLibrary(JSON.parse(JSON.stringify({ version: 1, scenes: [saved()] })))
    expect(state.library.scenes[0]).not.toHaveProperty('audio')
    expect(
      sameSceneAudio(undefined, sceneAudio({ microphoneId: 'mic:2' }, { systemAudioEnabled: true }))
    ).toBe(true)
  })
  it.each([
    null,
    'on',
    { microphoneOff: 'yes', systemAudioEnabled: true },
    { microphoneOff: false }
  ])('rejects an untrusted scene audio %j', (audio) => {
    const state = hydrateSceneLibrary({ version: 1, scenes: [{ ...saved(), audio }] })
    expect(state.library.scenes).toHaveLength(0)
    expect(state.error).toBeTruthy()
  })
  it('marks the scene modified when the microphone or System audio changes', () => {
    const saved = sceneAudio({ microphoneId: 'mic:1' }, { systemAudioEnabled: false })
    expect(
      sameSceneAudio(
        saved,
        sceneAudio(
          { microphoneId: 'mic:1', microphoneName: 'Renamed' },
          { systemAudioEnabled: false }
        )
      )
    ).toBe(true)
    expect(
      sameSceneAudio(saved, sceneAudio({ microphoneId: 'mic:2' }, { systemAudioEnabled: false }))
    ).toBe(false)
    expect(
      sameSceneAudio(saved, sceneAudio({ microphoneOff: true }, { systemAudioEnabled: false }))
    ).toBe(false)
    expect(
      sameSceneAudio(saved, sceneAudio({ microphoneId: 'mic:1' }, { systemAudioEnabled: true }))
    ).toBe(false)
    // No microphone was ever chosen: only System audio counts.
    const unchosen = sceneAudio({}, { systemAudioEnabled: false })
    expect(
      sameSceneAudio(unchosen, sceneAudio({ microphoneId: 'mic:2' }, { systemAudioEnabled: false }))
    ).toBe(true)
  })
  it('switches to None or an available microphone, and keeps the current one otherwise', () => {
    const audio = (sources: Parameters<typeof sceneAudio>[0]) =>
      sceneAudio(sources, { systemAudioEnabled: false })
    expect(
      sceneMicrophone(audio({ microphoneId: 'mic:1', microphoneName: 'Microphone 1' }), microphones)
    ).toStrictEqual({
      microphoneId: 'mic:1',
      microphoneName: 'Microphone 1',
      microphoneOff: false
    })
    expect(sceneMicrophone(audio({ microphoneOff: true }), microphones)).toStrictEqual({
      microphoneId: undefined,
      microphoneName: undefined,
      microphoneOff: true
    })
    expect(sceneMicrophone(audio({ microphoneId: 'mic:2' }), microphones)).toBeNull()
    expect(sceneMicrophone(audio({ microphoneId: 'mic:gone' }), microphones)).toBeNull()
    expect(sceneMicrophone(audio({}), microphones)).toBeNull()
  })
})

it('saves the wanted sources in a scene, never the substitutes', () => {
  expect(
    visualSources({
      cameraId: 'stand-in',
      cameraName: 'Built-in',
      wantedCameraId: 'iphone',
      wantedCameraName: 'iPhone',
      screenId: 'substitute',
      wantedWindowId: 'keynote',
      wantedWindowName: 'Keynote'
    })
  ).toMatchObject({
    cameraId: 'iphone',
    cameraName: 'iPhone',
    screenId: undefined,
    windowId: 'keynote'
  })
})

it('keeps built-in layouts available with a substitute without saving it', () => {
  const devices = [
    {
      id: 'screen:screencapturekit:1',
      name: 'Display',
      kind: 'screen' as const,
      status: 'available' as const
    },
    { id: 'builtin', name: 'Built-in', kind: 'camera' as const, status: 'available' as const }
  ]
  const sources = reconcileSourceSelection(
    { screenId: devices[0].id, cameraId: 'iphone', cameraName: 'iPhone' },
    devices
  )
  const layout = { ...defaultCaptureConfig.layout, layoutPreset: 'camera-only' as const }
  expect(
    sceneSourceGaps({ layout, sources: usingVisualSources(sources), background: null }, devices)
  ).toEqual([])
  expect(visualSources(sources).cameraId).toBe('iphone')
})

describe('a saved scene finds its display by UUID first (plan 213 F1)', () => {
  const lg: Device = {
    id: 'screen:screencapturekit:5',
    name: 'LG ULTRAWIDE · 3440 × 1440',
    displayUuid: 'E2D7A1C4-0B6F-4E3A-9C1D-5F8A2B7C9D10',
    kind: 'screen',
    status: 'available'
  }
  const lgBack: Device = { ...lg, id: 'screen:screencapturekit:9' }
  const dellOnLgId: Device = {
    id: lg.id,
    name: 'DELL U2720Q · 3840 × 2160',
    displayUuid: '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
    kind: 'screen',
    status: 'available'
  }
  const layout = { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' as const }
  const scene = (sources: VisualSources): SceneVisual =>
    normalizeSceneVisual({ layout, sources, background: null })
  const lgScene = scene({ screenId: lg.id, screenName: lg.name, screenUuid: lg.displayUuid })

  it('resolves by UUID, then id, then name, never to a display with another UUID', () => {
    expect(sceneDisplay(lgScene.sources, [dellOnLgId, lgBack])).toBe(lgBack)
    expect(sceneDisplay(lgScene.sources, [dellOnLgId])).toBeUndefined()
    expect(sceneSourceGaps(lgScene, [dellOnLgId, lgBack])).toEqual([])
    expect(sceneSourceGaps(lgScene, [dellOnLgId])).toEqual([
      { source: 'screen', state: 'unavailable' }
    ])

    const legacy = scene({ screenId: lg.id, screenName: 'Display 2' })
    expect(sceneDisplay(legacy.sources, [lg])).toBe(lg)
    const byName = scene({ screenId: 'screen:screencapturekit:3', screenName: lg.name })
    expect(sceneDisplay(byName.sources, [lgBack])).toBe(lgBack)
  })

  it('applies under the new id, and the saved scene is rewritten only for the same display', () => {
    expect(withSceneDisplay(lgScene, [lgBack]).sources).toMatchObject({
      screenId: lgBack.id,
      screenName: lg.name,
      screenUuid: lg.displayUuid
    })
    expect(withSceneDisplay(lgScene, [lg])).toBe(lgScene)

    expect(sceneDisplayRefresh(lgScene.sources, [lgBack])).toEqual({
      screenId: lgBack.id,
      screenName: lg.name,
      screenUuid: lg.displayUuid
    })
    expect(sceneDisplayRefresh(lgScene.sources, [lg])).toBeNull()
    // A scene saved before UUIDs learns its display's UUID and name by id.
    expect(
      sceneDisplayRefresh(scene({ screenId: lg.id, screenName: 'Display 2' }).sources, [lg])
    ).toEqual({ screenId: lg.id, screenName: lg.name, screenUuid: lg.displayUuid })
    // Found by name alone is not proof enough to rewrite it.
    expect(
      sceneDisplayRefresh(
        scene({ screenId: 'screen:screencapturekit:3', screenName: lg.name }).sources,
        [lgBack]
      )
    ).toBeNull()
  })

  it("a display's name, size or new id under the same UUID is not a modified scene", () => {
    const legacy = scene({ screenId: lg.id, screenName: 'Display 2' })
    expect(sameSceneVisual(legacy, lgScene)).toBe(true)
    expect(
      sameSceneVisual(
        lgScene,
        scene({ ...lgScene.sources, screenName: 'LG ULTRAWIDE · 2560 × 1080' })
      )
    ).toBe(true)
    expect(sameSceneVisual(lgScene, scene({ ...lgScene.sources, screenId: lgBack.id }))).toBe(true)
    expect(
      sameSceneVisual(
        lgScene,
        scene({
          screenId: dellOnLgId.id,
          screenName: dellOnLgId.name,
          screenUuid: dellOnLgId.displayUuid
        })
      )
    ).toBe(false)
    expect(
      sameSceneVisual(
        lgScene,
        scene({ screenId: 'screen:screencapturekit:2', screenName: lg.name })
      )
    ).toBe(false)
  })

  it('keeps a UUID only with its display, and drops a malformed one without the scene', () => {
    expect(lgScene.sources.screenUuid).toBe(lg.displayUuid)
    expect(scene({ screenUuid: lg.displayUuid }).sources.screenUuid).toBeUndefined()
    expect(scene({ screenId: lg.id, screenUuid: 42 as unknown as string }).sources).toMatchObject({
      screenId: lg.id,
      screenUuid: undefined
    })
  })
})
