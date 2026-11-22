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
    // Before the D4 migration has run, the scene's own key goes out as it was.
    expect(out.cameraChromaKeyEnabled).toBe(layout.cameraChromaKeyEnabled)
  })

  it('once migrated, the camera’s choice is what keys: one pick, never a key beside an effect', () => {
    const migrated = (backgrounds: Record<string, CameraBackground>) => ({
      cameraBackgrounds: backgrounds,
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    })
    const sceneKeyed = {
      ...layout,
      cameraChromaKeyEnabled: true,
      cameraChromaKeyColor: '#00FF00',
      cameraChromaKeySimilarityPct: 12,
      cameraChromaKeyEdges: { leftPct: 9, topPct: 0, rightPct: 0, bottomPct: 0 }
    }
    const edges = { leftPct: 3, topPct: 1, rightPct: 0, bottomPct: 0 }
    const blue: CameraBackground = {
      ...DEFAULT_CAMERA_BACKGROUND,
      mode: 'blue',
      key: { similarityPct: 44, smoothnessPct: 5, spillPct: 21, hideEdges: edges }
    }
    // Blue screen on the camera: the layout keys blue with the camera's tuning,
    // whatever the scene said, and goes out with the background.
    const keyed = cameraOutputLayout(sceneKeyed, 'camera-a', migrated({ 'camera-a': blue }))
    expect(keyed).toMatchObject({
      cameraChromaKeyEnabled: true,
      cameraChromaKeyColor: '#0000FF',
      cameraChromaKeySimilarityPct: 44,
      cameraChromaKeySmoothnessPct: 5,
      cameraChromaKeySpillPct: 21,
      cameraChromaKeyEdges: edges,
      cameraBackground: blue
    })
    // Without its own Hide edges the scene's are dropped, not kept.
    const green = { ...DEFAULT_CAMERA_BACKGROUND, mode: 'green' as const }
    const plainGreen = cameraOutputLayout(sceneKeyed, 'camera-a', migrated({ 'camera-a': green }))
    expect(plainGreen.cameraChromaKeyColor).toBe('#00FF00')
    expect(plainGreen.cameraChromaKeySimilarityPct).toBe(40)
    expect(plainGreen).not.toHaveProperty('cameraChromaKeyEdges')
    // A blur, a picture, Off, another camera's pick or no camera: never a key.
    for (const [cameraId, backgrounds] of [
      ['camera-a', { 'camera-a': { ...DEFAULT_CAMERA_BACKGROUND, mode: 'blur' as const } }],
      [
        'camera-a',
        { 'camera-a': { ...DEFAULT_CAMERA_BACKGROUND, mode: 'image' as const, assetId: 'loft' } }
      ],
      ['camera-a', { 'camera-a': { ...blue, mode: 'off' as const } }],
      ['camera-b', { 'camera-a': blue }],
      [undefined, { 'camera-a': blue }]
    ] as const) {
      const out = cameraOutputLayout(sceneKeyed, cameraId, migrated(backgrounds))
      expect(out.cameraChromaKeyEnabled, JSON.stringify(backgrounds)).toBe(false)
      // Off touches only the switch: a rollback still reads the last tuning.
      expect(out.cameraChromaKeySimilarityPct).toBe(12)
    }
    // Strong blur reaches the vertical leg with the key off there too.
    const blurred = cameraOutputLayout(
      sceneKeyed,
      'camera-a',
      migrated({ 'camera-a': { ...DEFAULT_CAMERA_BACKGROUND, mode: 'blur' } })
    )
    const leg = simulcastLegLayout({ layouts: { vertical: sceneKeyed } }, blurred)
    expect(leg.cameraChromaKeyEnabled).toBe(false)
    expect(leg.cameraBackground?.mode).toBe('blur')
  })

  it('no layout the renderer commits can drop it: every commit takes it from the settings', () => {
    // S3's smoke put the background on the layout itself; any later renderer
    // commit (a scene switch, an edit, a room's idle commit) built from a
    // scene's layout, which never carries it, disarmed the effect. The
    // controls write the per-camera setting instead, and every output
    // boundary puts it back on.
    const strong = { ...DEFAULT_CAMERA_BACKGROUND, mode: 'blur' as const }
    const stored = {
      ...settings({ 'camera-a': strong }),
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    }
    const fromScene = {
      ...layout,
      layoutPreset: 'camera-only' as const,
      cameraSize: 'large' as const
    }
    expect(fromScene).not.toHaveProperty('cameraBackground')
    expect(cameraOutputLayout(fromScene, 'camera-a', stored).cameraBackground).toStrictEqual(strong)
    // A commit that carries a stale or foreign background gets the camera's.
    const stale = { ...fromScene, cameraBackground: { ...strong, mode: 'off' as const } }
    expect(cameraOutputLayout(stale, 'camera-a', stored).cameraBackground).toStrictEqual(strong)
    // Session start reads the same settings.
    expect(
      buildStartSessionParams({
        captureConfig: {
          ...defaultCaptureConfig,
          layout: fromScene,
          sources: { ...defaultCaptureConfig.sources, cameraId: 'camera-a' }
        },
        scene: null,
        settings: stored
      }).layout.cameraBackground
    ).toStrictEqual(strong)
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
    // The tables below pin the rule run by run; the default (it settles, S5)
    // has its own test.
    settle: options.settle ?? false
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
    // Not settled on a run told not to: the camera keeps following the scenes.
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

  it('settles by default since S5: one run moves the keys as they are and stores the version', () => {
    // S5 made the camera's choice what renders, so the migration settles.
    expect(CAMERA_BACKGROUND_MIGRATION_SETTLES).toBe(true)
    const camera = 'camera-a'
    const keyed = [scene('live', keyedLayout('#0000FF', { cameraChromaKeySpillPct: 33 }))]
    const first = migrateCameraBackgrounds({
      cameraBackgrounds: undefined,
      cameraBackgroundMigration: undefined,
      cameraId: camera,
      scenes: keyed,
      onStreamId: 'live'
    })
    expect(first).toStrictEqual({
      cameraBackgrounds: {
        [camera]: {
          ...DEFAULT_CAMERA_BACKGROUND,
          mode: 'blue',
          key: { similarityPct: 35, smoothnessPct: 6, spillPct: 33 }
        }
      },
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    })
    // Settled: a scene keyed differently afterwards never reaches the camera,
    // and a picked blur is never touched again.
    for (const scenes of [
      [scene('live', keyedLayout('#00FF00'))],
      [scene('live')],
      [scene('other', keyedLayout('#00FF00'))]
    ])
      expect(
        migrateCameraBackgrounds({
          cameraBackgrounds: { [camera]: { ...fixture.minimal, mode: 'blur' } },
          cameraBackgroundMigration: first?.cameraBackgroundMigration,
          cameraId: camera,
          scenes,
          onStreamId: 'live'
        })
      ).toBeNull()
    // With no keyed scene it settles with nothing moved; with a keyed scene
    // and no camera it waits (nothing stored, so the key isn't lost).
    expect(
      migrateCameraBackgrounds({
        cameraBackgrounds: undefined,
        cameraBackgroundMigration: undefined,
        cameraId: undefined,
        scenes: [scene('live')],
        onStreamId: 'live'
      })
    ).toStrictEqual({
      cameraBackgrounds: undefined,
      cameraBackgroundMigration: CAMERA_BACKGROUND_MIGRATION_VERSION
    })
    expect(
      migrateCameraBackgrounds({
        cameraBackgrounds: undefined,
        cameraBackgroundMigration: undefined,
        cameraId: undefined,
        scenes: keyed,
        onStreamId: 'live'
      })
    ).toBeNull()
  })

  it('follows the scenes on runs that do not settle, then never runs again once it has', () => {
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
