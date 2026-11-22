import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CameraBackground, LayoutSettings } from '../../../shared/backend'
import { validateBackendRpcParams } from '../../../shared/backend-rpc-contract'
import { validateElectronInvokeArgs } from '../../../shared/electron-ipc-contract'
import {
  CAMERA_BACKGROUND_MIGRATION_SETTLES,
  CAMERA_BACKGROUND_MIGRATION_VERSION,
  cameraBackgroundLayout,
  cameraOutputLayout,
  DEFAULT_CAMERA_BACKGROUND,
  migrateCameraBackgrounds,
  normalizeCameraBackground,
  normalizeCameraBackgrounds,
  type CameraBackgroundMigrationScene
} from './camera-background'
import {
  defaultCaptureConfig,
  normalizeLayoutSettings,
  persistableCaptureConfig,
  simulcastLegLayout,
  type SettingsState
} from './capture'
import { greenScreenColor } from './green-screen'
import { normalizeSceneVisual } from './scene-presets'
import { buildStartSessionParams } from './session-params'

type Fixture = {
  full: CameraBackground
  minimal: CameraBackground
  everyMode: CameraBackground[]
  rejectedEverywhere: unknown[]
  rejectedByContract: unknown[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/camera-background.json', import.meta.url),
    'utf8'
  )
) as Fixture

const layout = defaultCaptureConfig.layout
const settings = (backgrounds: Record<string, CameraBackground>): SettingsState => ({
  outputDirectory: '',
  keepOriginalRecording: false,
  cameraBackgrounds: backgrounds
})

function applyLive(layout: LayoutSettings): unknown {
  return validateBackendRpcParams('scene.layout.apply_live', { intentId: 1, layout, sources: {} })
}

function previewUpdate(layout: LayoutSettings): unknown {
  return validateElectronInvokeArgs('preview-surface:update-scene', [
    { revision: 1, scene: null, layout, activeScreen: null }
  ])
}

describe('camera background wire shape (plan 258 S1)', () => {
  const wires = [
    fixture.full,
    fixture.minimal,
    ...fixture.everyMode.filter((b) => b.mode !== 'off')
  ]

  it('every field survives each mirror: contracts, normalization, storage and the output boundary', () => {
    expect(fixture.everyMode.map(({ mode }) => mode)).toEqual([
      'off',
      'blur',
      'image',
      'video',
      'cutout',
      'green',
      'blue'
    ])
    for (const background of wires) {
      // Normalization is the identity on a valid background.
      expect(normalizeCameraBackground(background)).toStrictEqual(background)
      // Storage: the settings are JSON in localStorage.
      const stored = JSON.parse(
        JSON.stringify(settings({ 'camera-a': background }))
      ) as SettingsState
      expect(normalizeCameraBackgrounds(stored.cameraBackgrounds)).toStrictEqual({
        'camera-a': background
      })
      // The output boundary puts it on the layout.
      const injected = cameraBackgroundLayout(layout, 'camera-a', stored.cameraBackgrounds)
      expect(injected.cameraBackground).toStrictEqual(background)
      expect(normalizeLayoutSettings(injected).cameraBackground).toStrictEqual(background)
      // Both strict contracts accept it unchanged.
      expect(applyLive(injected)).toStrictEqual({ intentId: 1, layout: injected, sources: {} })
      expect(previewUpdate(injected)).toStrictEqual([
        { revision: 1, scene: null, layout: injected, activeScreen: null }
      ])
    }
  })

  it('goes out at session start and on the vertical leg, and never into a scene or the capture config', () => {
    const config = {
      ...defaultCaptureConfig,
      sources: { ...defaultCaptureConfig.sources, cameraId: 'camera-a' }
    }
    const params = buildStartSessionParams({
      captureConfig: config,
      scene: null,
      settings: {
        ...settings({ 'camera-a': fixture.full }),
        cameraLooks: { 'camera-a': { brightness: 0.05, contrast: 1.1, saturation: 0.8 } }
      }
    })
    expect(params.layout.cameraBackground).toStrictEqual(fixture.full)
    expect(params.layout.cameraLook).toEqual({ brightness: 0.05, contrast: 1.1, saturation: 0.8 })
    const leg = simulcastLegLayout(
      { layouts: { vertical: { ...layout, layoutPreset: 'vertical-camera-bottom' } } },
      params.layout
    )
    expect(leg.cameraBackground).toStrictEqual(fixture.full)
    const effective = { ...config, layout: params.layout }
    expect(persistableCaptureConfig(effective).layout).not.toHaveProperty('cameraBackground')
    expect(
      normalizeSceneVisual({ layout: params.layout, sources: config.sources, background: null })
        .layout
    ).not.toHaveProperty('cameraBackground')
  })

  it('both strict contracts refuse every malformed background', () => {
    for (const cameraBackground of [...fixture.rejectedEverywhere, ...fixture.rejectedByContract]) {
      const bad = { ...layout, cameraBackground } as unknown as LayoutSettings
      expect(() => applyLive(bad), JSON.stringify(cameraBackground)).toThrow()
      expect(() => previewUpdate(bad), JSON.stringify(cameraBackground)).toThrow()
    }
  })

  it('a layout without one, from before plan 258, still passes both contracts', () => {
    expect(layout).not.toHaveProperty('cameraBackground')
    expect(applyLive(layout)).toStrictEqual({ intentId: 1, layout, sources: {} })
    expect(previewUpdate(layout)).toHaveLength(1)
  })
})

describe('camera background at the output boundary', () => {
  it('follows the selected camera, drops a previous camera’s, and leaves Off off the wire', () => {
    const backgrounds = {
      'camera-a': fixture.minimal,
      'camera-b': { ...fixture.minimal, mode: 'off' as const }
    }
    const withA = cameraBackgroundLayout(layout, 'camera-a', backgrounds)
    expect(withA.cameraBackground).toStrictEqual(fixture.minimal)
    expect(cameraBackgroundLayout(withA, 'camera-b', backgrounds)).not.toHaveProperty(
      'cameraBackground'
    )
    expect(cameraBackgroundLayout(withA, 'camera-c', backgrounds)).not.toHaveProperty(
      'cameraBackground'
    )
    expect(cameraBackgroundLayout(withA, undefined, backgrounds)).not.toHaveProperty(
      'cameraBackground'
    )
    expect(
      normalizeLayoutSettings({ ...layout, cameraBackground: backgrounds['camera-b'] })
    ).not.toHaveProperty('cameraBackground')
  })

  it('applies the look and the background together, each per camera', () => {
    const look = { brightness: 0.1, contrast: 1, saturation: 1 }
    const out = cameraOutputLayout(layout, 'camera-a', {
      cameraLooks: { 'camera-a': look },
      cameraBackgrounds: { 'camera-a': fixture.full }
    })
    expect(out.cameraLook).toEqual(look)
    expect(out.cameraBackground).toStrictEqual(fixture.full)
    // Nothing renders differently yet: the scene's own key is untouched.
    expect(out.cameraChromaKeyEnabled).toBe(layout.cameraChromaKeyEnabled)
  })

  it('reads damaged storage as bounded, and an unknown pick as Off, never an effect', () => {
    expect(normalizeCameraBackground(undefined)).toBeUndefined()
    expect(normalizeCameraBackground([])).toBeUndefined()
    expect(normalizeCameraBackground({})).toStrictEqual(DEFAULT_CAMERA_BACKGROUND)
    expect(
      normalizeCameraBackground({
        mode: 'portrait',
        blurPct: 300,
        edges: 'fuzzy',
        assetId: '',
        key: { similarityPct: -4, smoothnessPct: 'x', spillPct: 12.6, hideEdges: { leftPct: 90 } }
      })
    ).toStrictEqual({
      mode: 'off',
      blurPct: 100,
      edges: 'balanced',
      key: {
        similarityPct: 0,
        smoothnessPct: 8,
        spillPct: 13,
        hideEdges: { leftPct: 25, topPct: 0, rightPct: 0, bottomPct: 0 }
      }
    })
    expect(normalizeCameraBackgrounds({ '': fixture.full, 'camera-a': 'blur' })).toBeUndefined()
  })
})

function keyedLayout(
  color: string,
  tuning: Partial<LayoutSettings> = {}
): CameraBackgroundMigrationScene['layouts']['horizontal'] {
  return {
    ...layout,
    cameraChromaKeyEnabled: true,
    cameraChromaKeyColor: color,
    cameraChromaKeySimilarityPct: 35,
    cameraChromaKeySmoothnessPct: 6,
    cameraChromaKeySpillPct: 20,
    ...tuning
  }
}

function scene(
  id: string,
  horizontal: CameraBackgroundMigrationScene['layouts']['horizontal'] = layout,
  vertical: CameraBackgroundMigrationScene['layouts']['vertical'] = layout
): CameraBackgroundMigrationScene {
  return { id, layouts: { horizontal, vertical } }
}

function migrate(
  scenes: CameraBackgroundMigrationScene[],
  onStreamId: string | null,
  options: {
    cameraId?: string
    cameraBackgrounds?: Record<string, CameraBackground>
    version?: number
    settle?: boolean
  } = {}
): ReturnType<typeof migrateCameraBackgrounds> {
  return migrateCameraBackgrounds({
    cameraBackgrounds: options.cameraBackgrounds,
    cameraBackgroundMigration: options.version,
    cameraId: 'cameraId' in options ? options.cameraId : 'camera-a',
    scenes,
    onStreamId,
    settle: options.settle
  })
}

describe('D4 migration: the scenes’ key moves to the camera', () => {
  it('with no keyed scene, the camera keeps Off: nothing to write, or settled with nothing moved', () => {
    expect(migrate([scene('a'), scene('b')], 'a')).toBeNull()
    expect(migrate([scene('a'), scene('b')], 'a', { settle: true })).toStrictEqual({
      cameraBackgrounds: undefined,
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    })
    // With no camera selected either.
    expect(migrate([scene('a')], 'a', { cameraId: undefined })).toBeNull()
  })

  it('takes the key and its tuning from the scene on stream when it keys', () => {
    const edges = { leftPct: 4, topPct: 0, rightPct: 2, bottomPct: 0 }
    const result = migrate(
      [
        scene('first', keyedLayout('#0000FF')),
        scene(
          'live',
          keyedLayout('#00FF00', { cameraChromaKeySimilarityPct: 51, cameraChromaKeyEdges: edges })
        )
      ],
      'live'
    )
    expect(result?.cameraBackgrounds?.['camera-a']).toStrictEqual({
      ...DEFAULT_CAMERA_BACKGROUND,
      mode: 'green',
      key: { similarityPct: 51, smoothnessPct: 6, spillPct: 20, hideEdges: edges }
    })
    // Not settled before S5: the camera keeps following the scenes.
    expect(result?.cameraBackgroundMigration).toBeUndefined()
  })

  it('takes the first keyed scene when the scene on stream does not key', () => {
    const result = migrate(
      [
        scene('live'),
        scene('plain'),
        scene('second', keyedLayout('#00ff00')),
        scene('third', keyedLayout('#0000FF'))
      ],
      'live'
    )
    expect(result?.cameraBackgrounds?.['camera-a']).toStrictEqual({
      ...DEFAULT_CAMERA_BACKGROUND,
      mode: 'green',
      key: { similarityPct: 35, smoothnessPct: 6, spillPct: 20 }
    })
    // A scene keyed only in its 9:16 layout counts too.
    expect(
      migrate([scene('live'), scene('vertical', layout, keyedLayout('#0000FF'))], 'live')
        ?.cameraBackgrounds?.['camera-a']?.mode
    ).toBe('blue')
  })

  it('keeps both colours: green stays Green screen, blue becomes Blue screen', () => {
    for (const [color, mode] of [
      ['#00FF00', 'green'],
      ['#00ff00', 'green'],
      ['#0000FF', 'blue'],
      ['#0000ff', 'blue'],
      ['#FF00FF', 'green']
    ] as const) {
      expect(
        migrate([scene('live', keyedLayout(color))], 'live')?.cameraBackgrounds?.['camera-a']?.mode,
        color
      ).toBe(mode)
      // The same rule as the Studio's green-screen control.
      expect(greenScreenColor({ cameraChromaKeyColor: color })).toBe(mode)
    }
  })

  it('waits for a camera, keeps other cameras and never replaces an effect', () => {
    const keyed = [scene('live', keyedLayout('#0000FF'))]
    expect(migrate(keyed, 'live', { cameraId: undefined })).toBeNull()
    expect(migrate(keyed, 'live', { cameraId: undefined, settle: true })).toBeNull()
    const other = { ...fixture.minimal, mode: 'cutout' as const }
    const result = migrate(keyed, 'live', {
      cameraBackgrounds: {
        'camera-b': other,
        'camera-a': { ...fixture.minimal, mode: 'off', blurPct: 30 }
      }
    })
    expect(result?.cameraBackgrounds).toStrictEqual({
      'camera-b': other,
      'camera-a': {
        ...fixture.minimal,
        blurPct: 30,
        mode: 'blue',
        key: { similarityPct: 35, smoothnessPct: 6, spillPct: 20 }
      }
    })
    // The blur picked for the camera (S3 onwards) is never swapped for a key.
    const blurred = { 'camera-a': fixture.minimal }
    expect(migrate(keyed, 'live', { cameraBackgrounds: blurred })).toBeNull()
    expect(migrate(keyed, 'live', { cameraBackgrounds: blurred, settle: true })).toStrictEqual({
      cameraBackgrounds: blurred,
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    })
  })

  it('follows the scenes until it settles, then never runs again', () => {
    expect(CAMERA_BACKGROUND_MIGRATION_SETTLES).toBe(false)
    const camera = 'camera-a'
    // A camera chosen with no keyed scene, then a key turned on later: it moves.
    expect(migrate([scene('live')], 'live')).toBeNull()
    const keyedLater = migrate([scene('live', keyedLayout('#00FF00'))], 'live')
    const green = keyedLater?.cameraBackgrounds?.[camera]
    expect(green?.mode).toBe('green')
    // The same scenes again: nothing to write (no settings churn).
    expect(
      migrate([scene('live', keyedLayout('#00FF00'))], 'live', {
        cameraBackgrounds: keyedLater?.cameraBackgrounds
      })
    ).toBeNull()
    // The key turned off in every scene: the camera's screen goes Off, tuning kept.
    expect(
      migrate([scene('live')], 'live', { cameraBackgrounds: { [camera]: green! } })
        ?.cameraBackgrounds
    ).toStrictEqual({ [camera]: { ...green!, mode: 'off' } })
    // Settling stores the version; after that nothing moves.
    const settled = migrate([scene('live', keyedLayout('#0000FF'))], 'live', { settle: true })
    expect(settled?.cameraBackgroundMigration).toBe(CAMERA_BACKGROUND_MIGRATION_VERSION)
    expect(
      migrate([scene('live', keyedLayout('#00FF00'))], 'live', {
        cameraBackgrounds: settled?.cameraBackgrounds,
        version: settled?.cameraBackgroundMigration
      })
    ).toBeNull()
  })
})
