import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GlobalShortcutsConfig, LayoutSettings } from './backend'
import {
  defaultCaptureConfig,
  layoutPresetOrientation,
  normalizeLayoutSettings,
  simulcastLegLayout,
  type CaptureConfig
} from './capture'
import { normalizeLayoutFramingMemory } from './layout-framing-memory'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSceneVisual,
  SCENE_LIBRARY_KEY,
  WORKING_SCENE_KEY,
  type SavedScene,
  type VisualSources,
  type WorkingScene
} from './scene-presets'
import { canonicalJson } from './scene-visibility-identity'
import {
  canDeleteScene,
  defaultScenes,
  firstSceneWithLayout,
  horizontalTwin,
  hydrateScenes,
  migrateToScenes,
  normalizeScene,
  sameShows,
  sceneAtPosition,
  sceneLayout,
  sceneOnStream,
  scenePosition,
  SCENES_KEY,
  sceneShowsWords,
  showsFromSources,
  showsSources,
  withMainDisplay,
  type Scene,
  type SceneLibrary,
  type SceneShows
} from './scenes'

const NOW = '2026-11-15T12:00:00.000Z'
const FIXTURES = [
  'new-user',
  'plan-210-user',
  'builtin-user-layout-keys',
  'vertical-follow-on',
  'vertical-follow-off',
  'saved-vertical-scene',
  'working-freeform',
  'saved-scene-left-by-screen-pick',
  'default-equals-saved',
  'vertical-key-without-scene'
] as const
type Storage = Record<string, unknown>

/** What a profile's localStorage holds, parsed, by key. */
function fixture(name: string): Storage {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/scenes/${name}.json`, import.meta.url), 'utf8')
  ) as Storage
}

function inputs(storage: Storage) {
  const stored = (storage['videorc.captureConfig'] ?? {}) as Partial<CaptureConfig>
  const layout = normalizeLayoutSettings(stored.layout)
  const config: CaptureConfig = {
    ...defaultCaptureConfig,
    ...stored,
    sources: { ...stored.sources },
    layout,
    layoutFramingMemory: normalizeLayoutFramingMemory(stored.layoutFramingMemory, layout)
  }
  const settings = storage['videorc.settings'] as
    | { globalShortcuts?: GlobalShortcutsConfig }
    | undefined
  return {
    v1: hydrateSceneLibrary(storage[SCENE_LIBRARY_KEY] ?? null).library,
    working: hydrateWorkingScene(storage[WORKING_SCENE_KEY] ?? null),
    config,
    shortcuts: settings?.globalShortcuts
  }
}

function migrate(name: string) {
  const { v1, working, config, shortcuts } = inputs(fixture(name))
  return migrateToScenes(v1, working, config, shortcuts, NOW)
}

function showsTag(shows: SceneShows): string {
  switch (shows.kind) {
    case 'app':
      return `app:${shows.bundleId}${shows.follows ? ':follows' : ''}`
    case 'window':
      return `window:${shows.windowId}`
    case 'display':
      return `display:${shows.screenId}`
    default:
      return shows.kind
  }
}

/** Order, names, each scene's 16:9 and 9:16 layout, and what it shows. */
function rows(library: SceneLibrary) {
  return library.scenes.map((scene) => [
    scene.id,
    scene.name,
    scene.layouts.horizontal.layoutPreset,
    scene.layouts.vertical.layoutPreset,
    showsTag(scene.shows)
  ])
}

describe('migrateToScenes on the fixtures (plan 231 D15)', () => {
  it.each(FIXTURES)('%s: nothing on stream changes, and the library reads back', (name) => {
    const { working, config } = inputs(fixture(name))
    const { library } = migrate(name)
    const on = sceneOnStream(library)
    const visual =
      working?.visual ??
      normalizeSceneVisual({ layout: config.layout, sources: config.sources, background: null })
    const orientation = layoutPresetOrientation(visual.layout.layoutPreset)
    // The program: the working layout, background and screen, exactly.
    expect(canonicalJson(sceneLayout(on, orientation))).toBe(canonicalJson(visual.layout))
    expect(on.background).toEqual(visual.background)
    expect(sameShows(on.shows, showsFromSources(visual.sources))).toBe(true)
    // The vertical stream: what the leg builder gives for the program today.
    if (orientation === 'horizontal')
      expect(canonicalJson(on.layouts.vertical)).toBe(
        canonicalJson(simulcastLegLayout({ ...config, layout: visual.layout }))
      )
    // Every scene is valid, and the stored library hydrates to itself.
    for (const scene of library.scenes) {
      expect(normalizeScene(scene)).toEqual(scene)
      expect(layoutPresetOrientation(scene.layouts.horizontal.layoutPreset)).toBe('horizontal')
      expect(layoutPresetOrientation(scene.layouts.vertical.layoutPreset)).toBe('vertical')
    }
    expect(new Set(library.scenes.map(({ id }) => id)).size).toBe(library.scenes.length)
    expect(new Set(library.scenes.map(({ name }) => name.toLowerCase())).size).toBe(
      library.scenes.length
    )
    const stored = JSON.parse(JSON.stringify(library)) as unknown
    expect(hydrateScenes(stored)).toEqual({ library, readOnly: false, error: null })
    // D9: no scene names a camera device.
    expect(JSON.stringify(library)).not.toMatch(/"(cameraId|cameraName|cameraOff)"/)
  })

  it('new user: the four defaults, Screen + camera on stream, no keys', () => {
    const { library, globalShortcuts } = migrate('new-user')
    expect(rows(library)).toEqual([
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:'
      ],
      ['default-screen-only', 'Screen only', 'screen-only', 'vertical-screen-only', 'display:'],
      ['default-camera-only', 'Camera only', 'camera-only', 'vertical-camera-only', 'none'],
      ['default-side-by-side', 'Side by side', 'side-by-side', 'vertical-camera-top', 'display:']
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    expect(globalShortcuts).toEqual({ scenes: {} })
    expect(library.scenes).toEqual(defaultScenes(null, NOW))
  })

  it('plan 210 user: Figma first, on stream, at position 1; T3 Code second with its key', () => {
    const { library, globalShortcuts } = migrate('plan-210-user')
    // The default Screen + camera would show Figma like the saved scene: left out.
    expect(rows(library)).toEqual([
      [
        '5d0c8a4e-figma',
        'Figma',
        'screen-camera',
        'vertical-camera-top',
        'app:com.figma.Desktop:follows'
      ],
      [
        '9b7e21c3-t3code',
        'T3 Code',
        'screen-camera',
        'vertical-camera-top',
        'app:tools.t3.code:follows'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'app:com.figma.Desktop'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'app:com.figma.Desktop'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'app:com.figma.Desktop'
      ]
    ])
    expect(library.onStreamId).toBe('5d0c8a4e-figma')
    expect(sceneAtPosition(library.scenes, 1)?.name).toBe('Figma')
    expect(scenePosition(library.scenes, library.onStreamId)).toBe(1)
    expect(sceneAtPosition(library.scenes, 2)?.name).toBe('T3 Code')
    expect(library.scenes[0]!.shows).toEqual({
      kind: 'app',
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      follows: true
    })
    expect(globalShortcuts).toEqual({ scenes: { '9b7e21c3-t3code': 'Control+Alt+T' } })
  })

  it('built-in user: the layout on stream is its default scene, and the layout keys move', () => {
    const { library, globalShortcuts } = migrate('builtin-user-layout-keys')
    expect(rows(library)).toEqual([
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'display:screen:1'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:1'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:1'
      ]
    ])
    expect(library.onStreamId).toBe('default-screen-only')
    // Today's look goes to every default, as the built-in layouts share it.
    for (const scene of library.scenes) {
      expect(scene.layouts.horizontal.cameraCorner).toBe('top-left')
      expect(scene.layouts.horizontal.cameraShape).toBe('circle')
      expect(scene.layouts.vertical.cameraShape).toBe('circle')
    }
    expect(library.scenes[0]!.shows).toEqual({
      kind: 'display',
      screenId: 'screen:1',
      screenName: 'Display 1',
      screenUuid: '37D8832A-2D66-02CA-B9F7-8F30A301B230'
    })
    // 16:9 keys go to their defaults. The 9:16 key goes to the first scene
    // with that 9:16 layout and no key yet: Screen + camera has one.
    expect(globalShortcuts).toEqual({
      layoutNext: 'Control+Alt+Right',
      recordToggle: 'Control+Alt+R',
      scenes: {
        'default-screen-camera': 'Control+Alt+1',
        'default-camera-only': 'Control+Alt+3',
        'default-side-by-side': 'Control+Alt+7'
      }
    })
  })

  it('vertical stream, follow on: Camera only and Screen only keep their twins', () => {
    const { library } = migrate('vertical-follow-on')
    expect(rows(library).map((row) => [row[2], row[3]])).toEqual([
      ['screen-camera', 'vertical-split'],
      ['screen-only', 'vertical-screen-only'],
      ['camera-only', 'vertical-camera-only'],
      ['side-by-side', 'vertical-split']
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    for (const scene of library.scenes)
      expect(scene.layouts.vertical.verticalScreenFraming).toBe('fit')
  })

  it('vertical stream, follow off: every scene streams the remembered 9:16 layout', () => {
    const { library } = migrate('vertical-follow-off')
    expect(rows(library).map((row) => [row[2], row[3]])).toEqual([
      ['screen-camera', 'vertical-camera-bottom'],
      ['screen-only', 'vertical-camera-bottom'],
      ['camera-only', 'vertical-camera-bottom'],
      ['side-by-side', 'vertical-camera-bottom']
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    for (const scene of library.scenes) {
      expect(scene.layouts.vertical.verticalScreenFraming).toBe('fill')
      // Camera only streams a 9:16 layout with a screen: it keeps today's.
      expect(showsTag(scene.shows)).toBe('display:screen:1')
    }
  })

  it('a saved 9:16 scene keeps its layout and takes its 16:9 twin', () => {
    const { library, globalShortcuts } = migrate('saved-vertical-scene')
    expect(rows(library)).toEqual([
      ['c41f77aa-shorts', 'Shorts', 'screen-camera', 'vertical-split', 'display:screen:1'],
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'display:screen:1'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:1'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:1'
      ]
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    const shorts = library.scenes[0]!
    const saved = (fixture('saved-vertical-scene')[SCENE_LIBRARY_KEY] as { scenes: SavedScene[] })
      .scenes[0]!
    expect(shorts.layouts.vertical).toEqual(saved.visual.layout)
    expect(shorts.layouts.vertical.verticalScreenFraming).toBe('fill')
    expect(shorts.layouts.horizontal.cameraZoom).toBe(140)
    expect(globalShortcuts).toEqual({ scenes: {} })
  })

  it('a working Freeform arrangement becomes a scene named after its display, on stream', () => {
    const { library } = migrate('working-freeform')
    expect(rows(library)).toEqual([
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'display:screen:1'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:1'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:1'
      ],
      ['migrated-working', 'Display 1', 'screen-camera', 'vertical-camera-top', 'display:screen:1']
    ])
    expect(library.onStreamId).toBe('migrated-working')
    const on = sceneOnStream(library)
    expect(on.layouts.horizontal.arrangementMode).toBe('freeform')
    expect(Object.keys(on.layouts.horizontal.sourceTransformOverrides)).toEqual([
      'camera',
      'capture'
    ])
    // The freeform arrangement never leaks into 9:16 or into the defaults.
    expect(on.layouts.vertical.arrangementMode).toBe('preset')
    expect(on.layouts.vertical.sourceTransformOverrides).toEqual({})
    for (const scene of library.scenes.slice(0, 4)) {
      expect(scene.layouts.horizontal.arrangementMode).toBe('preset')
      expect(scene.layouts.horizontal.sourceTransformOverrides).toEqual({})
    }
  })

  it('a saved scene left by a Screen pick: the scene stays, and what is on becomes a scene', () => {
    const { library } = migrate('saved-scene-left-by-screen-pick')
    expect(rows(library)).toEqual([
      [
        '5d0c8a4e-figma',
        'Figma',
        'screen-camera',
        'vertical-camera-top',
        'app:com.figma.Desktop:follows'
      ],
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:2'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'display:screen:2'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:2'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:2'
      ],
      ['migrated-working', 'Display 2', 'screen-camera', 'vertical-camera-top', 'display:screen:2']
    ])
    expect(library.onStreamId).toBe('migrated-working')
    // The dragged camera is the scene's and the working look's, never a default's.
    expect(library.scenes[0]!.layouts.horizontal.cameraTransformMode).toBe('custom')
    expect(sceneOnStream(library).layouts.horizontal.cameraTransformMode).toBe('custom')
    expect(library.scenes[1]!.layouts.horizontal.cameraTransformMode).toBe('preset')
    expect(sceneOnStream(library).layouts.vertical.cameraTransform).toBeNull()
  })

  it('a default equal to a saved scene is left out, and its layout key goes to that scene', () => {
    const { library, globalShortcuts } = migrate('default-equals-saved')
    expect(rows(library)).toEqual([
      [
        '0e6b5d10-my-screen',
        'My screen',
        'screen-only',
        'vertical-screen-only',
        'display:screen:1'
      ],
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:1'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:1'
      ]
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    expect(globalShortcuts).toEqual({ scenes: { '0e6b5d10-my-screen': 'Control+Alt+2' } })
  })

  it('a 9:16 layout key with no scene for it adds one, so the key keeps working', () => {
    const { library, globalShortcuts } = migrate('vertical-key-without-scene')
    expect(rows(library)).toEqual([
      [
        'default-screen-camera',
        'Screen + camera',
        'screen-camera',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'default-screen-only',
        'Screen only',
        'screen-only',
        'vertical-screen-only',
        'display:screen:1'
      ],
      [
        'default-camera-only',
        'Camera only',
        'camera-only',
        'vertical-camera-only',
        'display:screen:1'
      ],
      [
        'default-side-by-side',
        'Side by side',
        'side-by-side',
        'vertical-camera-top',
        'display:screen:1'
      ],
      [
        'layout-vertical-camera-bottom',
        'Camera bottom',
        'screen-camera',
        'vertical-camera-bottom',
        'display:screen:1'
      ]
    ])
    expect(library.onStreamId).toBe('default-screen-camera')
    expect(globalShortcuts).toEqual({
      scenes: { 'layout-vertical-camera-bottom': 'Control+Alt+8' }
    })
  })

  it('unknown version: nothing is hydrated and the library is read-only', () => {
    expect(hydrateScenes(fixture('unknown-version')[SCENES_KEY])).toEqual({
      library: null,
      readOnly: true,
      error: 'Update Videorc to open these scenes. Your saved data is preserved.'
    })
  })
})

describe('migrateToScenes rules', () => {
  const base = () => inputs(fixture('default-equals-saved'))
  const display1 = (fixture('default-equals-saved')[WORKING_SCENE_KEY] as WorkingScene).visual
    .sources
  const working = (
    origin: 'builtin' | 'saved',
    sceneId: string | null,
    layout: Partial<LayoutSettings>,
    sources: VisualSources = display1
  ): WorkingScene => ({
    version: 1,
    origin,
    sceneId,
    visual: normalizeSceneVisual({
      layout: { ...defaultCaptureConfig.layout, ...layout },
      sources,
      background: null
    })
  })

  it('a 9:16 studio lands on the default the 16:9 toggle would, with its own Fill', () => {
    const { config } = base()
    const vertical = working('builtin', null, {
      layoutPreset: 'vertical-split',
      verticalScreenFraming: 'fill'
    })
    const { library } = migrateToScenes(
      null,
      vertical,
      { ...config, lastHorizontalPreset: 'side-by-side', lastVerticalPreset: 'vertical-split' },
      undefined,
      NOW
    )
    expect(rows(library).map((row) => [row[2], row[3]])).toEqual([
      ['screen-camera', 'vertical-split'],
      ['screen-only', 'vertical-screen-only'],
      ['camera-only', 'vertical-camera-only'],
      ['side-by-side', 'vertical-split']
    ])
    expect(library.onStreamId).toBe('default-side-by-side')
    expect(sceneOnStream(library).layouts.vertical).toEqual(vertical.visual.layout)
    for (const scene of library.scenes)
      expect(scene.layouts.vertical.verticalScreenFraming).toBe('fill')
  })

  it('a 9:16 studio on a layout no default streams becomes its own scene', () => {
    const { config } = base()
    const vertical = working('builtin', null, { layoutPreset: 'vertical-camera-bottom' })
    const { library } = migrateToScenes(null, vertical, config, undefined, NOW)
    expect(rows(library).at(-1)).toEqual([
      'migrated-working',
      'Display 1',
      'screen-camera',
      'vertical-camera-bottom',
      'display:screen:1'
    ])
    expect(library.onStreamId).toBe('migrated-working')
  })

  it('the default on stream is left out only for a saved scene with the same look', () => {
    const { v1, config } = base()
    const onScreenOnly = working('builtin', null, { layoutPreset: 'screen-only' })
    const same = migrateToScenes(v1, onScreenOnly, config, undefined, NOW).library
    expect(same.scenes.map(({ id }) => id)).not.toContain('default-screen-only')
    expect(same.onStreamId).toBe('0e6b5d10-my-screen')
    // Another look on stream: leaving the default out would change the stream.
    const mirrored = working('builtin', null, { layoutPreset: 'screen-only', cameraMirror: true })
    const other = migrateToScenes(v1, mirrored, config, undefined, NOW).library
    expect(other.onStreamId).toBe('default-screen-only')
    expect(other.scenes.map(({ name }) => name)).toEqual([
      'My screen',
      'Screen + camera',
      'Screen only',
      'Camera only',
      'Side by side'
    ])
  })

  it('a default stays when its layout key could not move to the equal scene', () => {
    const { v1, working: on, config } = base()
    const { library, globalShortcuts } = migrateToScenes(
      v1,
      on,
      config,
      {
        scenes: { '0e6b5d10-my-screen': 'Control+Alt+M' },
        layouts: { 'screen-only': 'Control+Alt+2' }
      },
      NOW
    )
    expect(library.scenes.map(({ id }) => id)).toContain('default-screen-only')
    expect(globalShortcuts.scenes).toEqual({
      '0e6b5d10-my-screen': 'Control+Alt+M',
      'default-screen-only': 'Control+Alt+2'
    })
  })

  it('a look that drifted from its saved scene stays on stream, in that scene', () => {
    const { v1, config } = base()
    const drifted = working('saved', '0e6b5d10-my-screen', {
      layoutPreset: 'side-by-side',
      sideBySideSplit: '50-50'
    })
    const { library } = migrateToScenes(v1, drifted, config, undefined, NOW)
    expect(library.onStreamId).toBe('0e6b5d10-my-screen')
    expect(library.scenes[0]!.layouts.horizontal).toEqual(drifted.visual.layout)
    expect(library.scenes[0]!.layouts.vertical.layoutPreset).toBe('vertical-camera-top')
  })

  it('a working look that is exactly a default goes on that default, with no extra scene', () => {
    const { v1, config } = base()
    const left = working('saved', null, { layoutPreset: 'side-by-side' })
    const { library } = migrateToScenes(v1, left, config, undefined, NOW)
    expect(library.onStreamId).toBe('default-side-by-side')
    expect(library.scenes.map(({ id }) => id)).not.toContain('migrated-working')
  })

  it('a working scene whose saved scene is gone becomes a scene, named apart from a taken name', () => {
    const { config } = base()
    const gone = working('saved', 'deleted', {
      layoutPreset: 'camera-only',
      cameraTransformMode: 'custom',
      cameraTransform: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
    })
    const { library } = migrateToScenes(null, gone, config, undefined, NOW)
    expect(rows(library).at(-1)).toEqual([
      'migrated-working',
      'Camera only 2',
      'camera-only',
      'vertical-camera-only',
      'display:screen:1'
    ])
    expect(library.onStreamId).toBe('migrated-working')
  })

  it('Screen None and the test pattern are what the defaults show', () => {
    const { config } = base()
    const none = working('builtin', null, { layoutPreset: 'camera-only' }, { captureOff: true })
    expect(
      migrateToScenes(null, none, config, undefined, NOW).library.scenes.map(({ shows }) => shows)
    ).toEqual(Array(4).fill({ kind: 'none' }))
    const pattern = working('builtin', null, {}, { testPattern: true })
    expect(migrateToScenes(null, pattern, config, undefined, NOW).library.scenes[0]!.shows).toEqual(
      { kind: 'test-pattern' }
    )
  })

  it('a second run over its own shortcuts keeps every key', () => {
    const { v1, working: on, config, shortcuts } = inputs(fixture('builtin-user-layout-keys'))
    const first = migrateToScenes(v1, on, config, shortcuts, NOW)
    const second = migrateToScenes(v1, on, config, first.globalShortcuts, NOW)
    expect(second).toEqual(first)
  })

  it('ignores shortcut entries that are not keys', () => {
    const { v1, working: on, config } = base()
    const { globalShortcuts } = migrateToScenes(
      v1,
      on,
      config,
      { scenes: { a: '', b: 3 as unknown as string }, layouts: { 'screen-camera': '' } },
      NOW
    )
    expect(globalShortcuts).toEqual({ scenes: {} })
  })
})

describe('defaultScenes (D3)', () => {
  it('shows the main display on the three screen scenes and no screen on Camera only', () => {
    const scenes = defaultScenes(
      { id: 'screen:7', name: 'Studio Display', displayUuid: 'U-7' },
      NOW
    )
    expect(scenes.map(({ name, shows }) => [name, shows])).toEqual([
      [
        'Screen + camera',
        { kind: 'display', screenId: 'screen:7', screenName: 'Studio Display', screenUuid: 'U-7' }
      ],
      [
        'Screen only',
        { kind: 'display', screenId: 'screen:7', screenName: 'Studio Display', screenUuid: 'U-7' }
      ],
      ['Camera only', { kind: 'none' }],
      [
        'Side by side',
        { kind: 'display', screenId: 'screen:7', screenName: 'Studio Display', screenUuid: 'U-7' }
      ]
    ])
    expect(scenes.every((scene) => scene.createdAt === NOW && scene.background === null)).toBe(true)
  })

  it('waits for the main display when none is known, and takes it once', () => {
    const library: SceneLibrary = {
      version: 2,
      scenes: defaultScenes(null, NOW),
      onStreamId: 'default-screen-camera'
    }
    const pinned = withMainDisplay(library, { id: 'screen:1', name: 'Display 1' })
    expect(pinned.scenes.map(({ shows }) => showsTag(shows))).toEqual([
      'display:screen:1',
      'display:screen:1',
      'none',
      'display:screen:1'
    ])
    expect(pinned.scenes).toEqual(defaultScenes({ id: 'screen:1', name: 'Display 1' }, NOW))
    expect(withMainDisplay(pinned, { id: 'screen:2', name: 'Display 2' })).toBe(pinned)
  })
})

describe('hydrateScenes and normalizeScene', () => {
  const library = (): SceneLibrary => ({
    version: 2,
    scenes: defaultScenes({ id: 'screen:1', name: 'Display 1' }, NOW),
    onStreamId: 'default-screen-only'
  })
  const scene = (): Scene => library().scenes[0]!

  it('nothing stored is no library and writable: the caller migrates', () => {
    expect(hydrateScenes(null)).toEqual({ library: null, readOnly: false, error: null })
    expect(hydrateScenes(undefined)).toEqual({ library: null, readOnly: false, error: null })
  })

  it('anything but version 2 is read-only', () => {
    for (const raw of [{ version: 1, scenes: [] }, { scenes: [] }, 'scenes', 7, []])
      expect(hydrateScenes(raw)).toMatchObject({ library: null, readOnly: true })
  })

  it('rejects only the malformed entries, and says so', () => {
    const good = library()
    const result = hydrateScenes({
      ...good,
      scenes: [
        null,
        'scene',
        { ...scene(), id: '' },
        { ...scene(), id: 'x'.repeat(129) },
        { ...scene(), id: 'no-name', name: '  ' },
        { ...scene(), id: 'no-shows', name: 'A', shows: undefined },
        { ...scene(), id: 'odd-shows', name: 'B', shows: { kind: 'hologram' } },
        { ...scene(), id: 'no-window', name: 'C', shows: { kind: 'window', windowId: '' } },
        { ...scene(), id: 'bad-app', name: 'D', shows: { kind: 'app', bundleId: 'figma' } },
        { ...scene(), id: 'no-display', name: 'E', shows: { kind: 'display' } },
        { ...scene(), id: 'no-layouts', name: 'F', layouts: undefined },
        {
          ...scene(),
          id: 'swapped',
          name: 'G',
          layouts: { horizontal: scene().layouts.vertical, vertical: scene().layouts.horizontal }
        },
        {
          ...scene(),
          id: 'odd-layout',
          name: 'H',
          layouts: {
            ...scene().layouts,
            horizontal: { ...scene().layouts.horizontal, layoutPreset: 'mosaic' }
          }
        },
        { ...scene(), id: 'bad-background', name: 'I', background: { assetId: '../x' } },
        { ...scene(), id: 'bad-audio', name: 'J', audio: { microphoneOff: 'yes' } },
        ...good.scenes,
        { ...good.scenes[1]!, id: 'same-name' },
        { ...good.scenes[1]!, name: 'Same id' }
      ]
    })
    expect(result.library).toEqual(good)
    expect(result.readOnly).toBe(false)
    expect(result.error).toBe("Some invalid scenes couldn't be loaded.")
  })

  it('a lost on-stream id falls to the first scene', () => {
    expect(hydrateScenes({ ...library(), onStreamId: 'gone' }).library?.onStreamId).toBe(
      'default-screen-camera'
    )
    expect(hydrateScenes({ ...library(), onStreamId: 4 }).library?.onStreamId).toBe(
      'default-screen-camera'
    )
  })

  it('no usable scene is no library, still writable', () => {
    expect(hydrateScenes({ version: 2, scenes: [], onStreamId: 'x' })).toEqual({
      library: null,
      readOnly: false,
      error: null
    })
    expect(hydrateScenes({ version: 2, scenes: [{}], onStreamId: 'x' })).toEqual({
      library: null,
      readOnly: false,
      error: "Some invalid scenes couldn't be loaded."
    })
  })

  it('keeps what a scene may hold and drops what it may not', () => {
    const audio = { microphoneId: 'mic:1', microphoneOff: false, systemAudioEnabled: true }
    const normalized = normalizeScene({
      ...scene(),
      name: '  Figma  ',
      shows: {
        kind: 'app',
        bundleId: 'com.figma.Desktop',
        name: ' Figma ',
        follows: 'yes',
        windowId: 'window:1'
      },
      layouts: {
        horizontal: { ...scene().layouts.horizontal, cameraZoom: 900, madeUp: true },
        vertical: scene().layouts.vertical
      },
      audio,
      cameraId: 'camera:1'
    })
    expect(normalized.name).toBe('Figma')
    expect(normalized.shows).toEqual({
      kind: 'app',
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      follows: false
    })
    expect(normalized.layouts.horizontal.cameraZoom).toBe(200)
    expect(normalized.layouts.horizontal).not.toHaveProperty('madeUp')
    expect(normalized.audio).toEqual({ ...audio, microphoneName: undefined })
    expect(normalized).not.toHaveProperty('cameraId')
    expect(
      normalizeScene({ ...scene(), shows: { kind: 'display', screenId: '', screenUuid: 'U' } })
        .shows
    ).toEqual({ kind: 'display', screenId: '' })
    expect(
      normalizeScene({ ...scene(), shows: { kind: 'window', windowId: 'w', windowName: 'Notes' } })
        .shows
    ).toEqual({ kind: 'window', windowId: 'w', windowName: 'Notes' })
  })
})

describe('scene helpers', () => {
  const scenes = (): Scene[] => migrate('plan-210-user').library.scenes
  const withShows = (shows: SceneShows, patch: Partial<LayoutSettings> = {}): Scene => {
    const scene = defaultScenes(null, NOW)[0]!
    return {
      ...scene,
      shows,
      layouts: { ...scene.layouts, horizontal: { ...scene.layouts.horizontal, ...patch } }
    }
  }

  it('finds the scene at a position, and a scene’s position', () => {
    const list = scenes()
    expect(sceneAtPosition(list, 1)?.id).toBe('5d0c8a4e-figma')
    expect(sceneAtPosition(list, 5)?.id).toBe('default-side-by-side')
    for (const position of [0, 6, -1, 1.5, Number.NaN])
      expect(sceneAtPosition(list, position)).toBeUndefined()
    expect(scenePosition(list, '9b7e21c3-t3code')).toBe(2)
    expect(scenePosition(list, 'gone')).toBeNull()
  })

  it('gives a scene’s layout for an orientation', () => {
    const scene = scenes()[2]!
    expect(sceneLayout(scene, 'horizontal').layoutPreset).toBe('screen-only')
    expect(sceneLayout(scene, 'vertical').layoutPreset).toBe('vertical-screen-only')
  })

  it('says what a scene shows in words', () => {
    const app: SceneShows = {
      kind: 'app',
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      follows: true
    }
    expect(sceneShowsWords(withShows(app), 'horizontal')).toBe('Figma · front window')
    expect(
      sceneShowsWords(
        withShows({ kind: 'window', windowId: 'w', windowName: 'Notes' }),
        'horizontal'
      )
    ).toBe('Window · Notes')
    expect(sceneShowsWords(withShows({ kind: 'window', windowId: 'w' }), 'horizontal')).toBe(
      'Window'
    )
    expect(
      sceneShowsWords(
        withShows({ kind: 'display', screenId: 's', screenName: 'Display 1' }),
        'horizontal'
      )
    ).toBe('Display 1')
    expect(sceneShowsWords(withShows({ kind: 'display', screenId: '' }), 'horizontal')).toBe(
      'Display'
    )
    expect(sceneShowsWords(withShows({ kind: 'test-pattern' }), 'horizontal')).toBe('Test pattern')
    expect(sceneShowsWords(withShows({ kind: 'none' }), 'horizontal')).toBe('No screen')
    // A layout with no screen says the layout; Freeform shows what it has.
    expect(sceneShowsWords(withShows(app, { layoutPreset: 'camera-only' }), 'horizontal')).toBe(
      'Camera only'
    )
    expect(
      sceneShowsWords(
        withShows(app, { layoutPreset: 'camera-only', arrangementMode: 'freeform' }),
        'horizontal'
      )
    ).toBe('Figma · front window')
    // Each orientation by its own layout.
    const cameraOnly = defaultScenes({ id: 's', name: 'Display 1' }, NOW)[2]!
    expect(sceneShowsWords({ ...cameraOnly, shows: app }, 'vertical')).toBe('Camera only')
  })

  it('finds the first scene with a layout in an orientation (D14)', () => {
    const list = scenes()
    expect(firstSceneWithLayout(list, 'horizontal', 'screen-camera')?.id).toBe('5d0c8a4e-figma')
    expect(firstSceneWithLayout(list, 'horizontal', 'side-by-side')?.id).toBe(
      'default-side-by-side'
    )
    expect(firstSceneWithLayout(list, 'vertical', 'vertical-screen-only')?.id).toBe(
      'default-screen-only'
    )
    expect(firstSceneWithLayout(list, 'vertical', 'vertical-split')).toBeUndefined()
    expect(firstSceneWithLayout(list, 'horizontal', 'vertical-camera-top')).toBeUndefined()
    // A Freeform arrangement is not the layout underneath it.
    const freeform = withShows({ kind: 'none' }, { arrangementMode: 'freeform' })
    expect(firstSceneWithLayout([freeform, ...list], 'horizontal', 'screen-camera')?.id).toBe(
      '5d0c8a4e-figma'
    )
  })

  it('decides whether a scene can be deleted (D16)', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const ask = (id: string, onStreamId: string, sessionActive = false, scenes = list) =>
      canDeleteScene({ scenes, id, onStreamId, sessionActive })
    expect(ask('a', 'a', false, [{ id: 'a' }])).toEqual({
      allowed: false,
      reason: 'Keep at least one scene.'
    })
    expect(ask('b', 'a')).toEqual({ allowed: true, switchToId: null })
    expect(ask('b', 'a', true)).toEqual({ allowed: true, switchToId: null })
    // Off air, the scene on stream goes after a switch to the one before it.
    expect(ask('c', 'c')).toEqual({ allowed: true, switchToId: 'b' })
    expect(ask('b', 'b')).toEqual({ allowed: true, switchToId: 'a' })
    expect(ask('a', 'a')).toEqual({ allowed: true, switchToId: 'b' })
    expect(ask('b', 'b', true)).toEqual({
      allowed: false,
      reason: 'Switch to another scene first.'
    })
    expect(ask('gone', 'a')).toEqual({ allowed: false, reason: null })
  })

  it('compares what two scenes show', () => {
    const display = (screenId: string, screenUuid?: string): SceneShows => ({
      kind: 'display',
      screenId,
      ...(screenUuid ? { screenUuid } : {})
    })
    expect(sameShows(display('1', 'U'), display('9', 'U'))).toBe(true)
    expect(sameShows(display('1', 'U'), display('1', 'V'))).toBe(false)
    expect(sameShows(display('1', 'U'), display('1'))).toBe(true)
    expect(sameShows(display('1'), display('2'))).toBe(false)
    expect(sameShows(display(''), display(''))).toBe(true)
    expect(
      sameShows(
        { kind: 'app', bundleId: 'a.b', name: 'A', follows: true },
        { kind: 'app', bundleId: 'a.b', name: 'A', follows: false }
      )
    ).toBe(true)
    expect(
      sameShows(
        { kind: 'window', windowId: 'w' },
        { kind: 'app', bundleId: 'a.b', name: 'A', follows: true }
      )
    ).toBe(false)
    expect(sameShows({ kind: 'none' }, { kind: 'none' })).toBe(true)
    expect(sameShows({ kind: 'none' }, { kind: 'test-pattern' })).toBe(false)
  })

  it('turns sources into what a scene shows and back', () => {
    const cases: [VisualSources, SceneShows][] = [
      [
        { windowId: 'w', app: { bundleId: 'a.b', name: 'A', follows: true } },
        { kind: 'app', bundleId: 'a.b', name: 'A', follows: true }
      ],
      [
        { windowId: 'w', windowName: 'Notes' },
        { kind: 'window', windowId: 'w', windowName: 'Notes' }
      ],
      [
        { screenId: 's', screenName: 'Display 1', screenUuid: 'U' },
        { kind: 'display', screenId: 's', screenName: 'Display 1', screenUuid: 'U' }
      ],
      [{ testPattern: true }, { kind: 'test-pattern' }],
      [{ captureOff: true }, { kind: 'none' }],
      [{ cameraId: 'c' }, { kind: 'display', screenId: '' }]
    ]
    for (const [sources, shows] of cases) expect(showsFromSources(sources)).toEqual(shows)
    for (const [, shows] of cases) expect(showsFromSources(showsSources(shows))).toEqual(shows)
    // Every capture key is written, so the previous screen never survives a spread.
    expect(showsSources({ kind: 'none' })).toEqual({
      screenId: undefined,
      screenName: undefined,
      screenUuid: undefined,
      windowId: undefined,
      windowName: undefined,
      app: undefined,
      captureOff: true,
      testPattern: false
    })
    expect(Object.keys(showsSources({ kind: 'window', windowId: 'w' }))).toHaveLength(8)
  })

  it('gives a 9:16 layout its 16:9 twin', () => {
    expect(horizontalTwin('vertical-camera-only')).toBe('camera-only')
    expect(horizontalTwin('vertical-screen-only')).toBe('screen-only')
    for (const preset of [
      'vertical-camera-top',
      'vertical-camera-bottom',
      'vertical-split',
      'vertical-screen-camera'
    ] as const)
      expect(horizontalTwin(preset)).toBe('screen-camera')
  })
})
