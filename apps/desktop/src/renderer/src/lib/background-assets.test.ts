import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_SLOT_COUNT,
  applyBundledBackgroundAssets,
  applySlot,
  backgroundAssetDisplayUrl,
  canApplySlot,
  checkableBackgroundAssetPath,
  clearActiveSlot,
  createDefaultRegistry,
  createImportedAsset,
  defaultBackgroundStyle,
  effectiveSceneBackground,
  importIntoSlot,
  markSlotStatus,
  markSlotMissingIfAssetMatches,
  reconcileRegistry,
  removeSlotAsset,
  renameAsset,
  setAssetStyle,
  slotDisplayStatus,
  slotName,
  type BackgroundAsset,
  type BackgroundAssetRegistry,
  type BackgroundAssetSlot
} from './background-assets'

function importedAsset(id: string, name: string): BackgroundAsset {
  return createImportedAsset({
    id,
    name,
    assetPath: `/managed/${id}.png`,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z'
  })
}

function readyAsset(id: string, name: string): BackgroundAsset {
  return {
    id,
    name,
    kind: 'imported',
    assetPath: `/managed/${id}.png`,
    status: 'ready',
    styleDefaults: defaultBackgroundStyle(),
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z'
  }
}

// Wire an imported, applyable ('ready') asset into a slot — the state an A2
// placeholder slot can't reach on its own until import (A4).
function withReadySlot(
  registry: BackgroundAssetRegistry,
  slotId: string,
  asset: BackgroundAsset
): BackgroundAssetRegistry {
  return {
    ...registry,
    assets: { ...registry.assets, [asset.id]: asset },
    slots: registry.slots.map((slot) =>
      slot.id === slotId ? { ...slot, assetId: asset.id, status: 'ready' } : slot
    )
  }
}

function slotById(registry: BackgroundAssetRegistry, id: string): BackgroundAssetSlot {
  const slot = registry.slots.find((entry) => entry.id === id)
  if (!slot) {
    throw new Error(`missing slot ${id}`)
  }
  return slot
}

describe('background asset model', () => {
  it('creates exactly ten ready bundled preset slots with the locked ids and labels', () => {
    const registry = createDefaultRegistry()
    expect(BACKGROUND_SLOT_COUNT).toBe(10)
    expect(registry.slots).toHaveLength(10)
    expect(registry.slots.map((slot) => slot.id)).toEqual([
      'bg-01',
      'bg-02',
      'bg-03',
      'bg-04',
      'bg-05',
      'bg-06',
      'bg-07',
      'bg-08',
      'bg-09',
      'bg-10'
    ])
    expect(registry.slots.map((slot) => slot.defaultLabel)).toEqual([
      'Code Demo',
      'Product Launch',
      'Tutorial',
      'Livestream',
      'Minimal Desk',
      'Podcast',
      'Webinar',
      'Dark Mode',
      'Light Mode',
      'Focus'
    ])
    expect(registry.slots.every((slot) => slot.assetId?.startsWith('builtin-bg-'))).toBe(true)
    expect(registry.slots.every((slot) => slot.status === 'ready')).toBe(true)
    expect(Object.keys(registry.assets)).toHaveLength(10)
    expect(registry.assets['builtin-bg-01']?.kind).toBe('builtin')
    expect(registry.assets['builtin-bg-01']?.assetPath).toContain('code-demo')
    expect(registry.activeSlotId).toBeNull()
  })

  it('names a bundled slot by its asset name and an imported slot by its asset name', () => {
    const preset = createDefaultRegistry()
    expect(slotName(slotById(preset, 'bg-03'), preset)).toBe('Tutorial')

    const ready = withReadySlot(preset, 'bg-03', readyAsset('asset-1', 'Sunset Ridge'))
    expect(slotName(slotById(ready, 'bg-03'), ready)).toBe('Sunset Ridge')
  })

  it('lets bundled and imported ready slots be applied', () => {
    const ready = withReadySlot(createDefaultRegistry(), 'bg-03', readyAsset('asset-1', 'Sunset'))
    expect(canApplySlot(slotById(ready, 'bg-01'))).toBe(true)
    expect(canApplySlot(slotById(ready, 'bg-03'))).toBe(true)
  })

  it('recovers a stale missing bundled preset when it is clicked', () => {
    let registry = markSlotStatus(createDefaultRegistry(), 'bg-08', 'missing-file')

    registry = applySlot(registry, 'bg-08')

    expect(registry.activeSlotId).toBe('bg-08')
    expect(slotById(registry, 'bg-08').status).toBe('ready')
    expect(slotDisplayStatus(slotById(registry, 'bg-08'), registry)).toBe('active')
  })

  it('still refuses to apply a missing imported file', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = markSlotStatus(registry, 'bg-02', 'missing-file')

    const applied = applySlot(registry, 'bg-02')

    expect(applied).toBe(registry)
    expect(applied.activeSlotId).toBeNull()
  })

  it('replaces bundled preset URLs with native-readable file paths when Electron resolves them', () => {
    const registry = createDefaultRegistry()
    const resolved = applyBundledBackgroundAssets(registry, [
      {
        id: 'builtin-bg-01',
        name: 'Code Demo',
        assetPath:
          '/Applications/Videorc.app/Contents/Resources/background-assets/bundled/code-demo.webp',
        thumbnailPath:
          '/Applications/Videorc.app/Contents/Resources/background-assets/bundled/code-demo.webp',
        fileName: 'code-demo.webp'
      }
    ])

    expect(resolved.assets['builtin-bg-01']?.assetPath).toContain(
      '/Resources/background-assets/bundled/code-demo.webp'
    )
    expect(resolved.assets['builtin-bg-01']?.thumbnailPath).toBe(
      registry.assets['builtin-bg-01']?.thumbnailPath
    )
    expect(resolved.assets['builtin-bg-02']?.assetPath).toBe(
      registry.assets['builtin-bg-02']?.assetPath
    )
  })

  it('retries bundled thumbnails by clearing stale missing-file status after paths resolve', () => {
    const bundledAssets = [
      {
        id: 'builtin-bg-01',
        name: 'Code Demo',
        assetPath: '/native/backgrounds/code-demo.webp',
        thumbnailPath: '/native/backgrounds/code-demo.webp',
        fileName: 'code-demo.webp'
      }
    ]
    const resolved = applyBundledBackgroundAssets(createDefaultRegistry(), bundledAssets)
    const missing = markSlotStatus(resolved, 'bg-01', 'missing-file')

    const retried = applyBundledBackgroundAssets(missing, bundledAssets)

    expect(slotById(retried, 'bg-01').status).toBe('ready')
    expect(retried.assets['builtin-bg-01']?.assetPath).toBe('/native/backgrounds/code-demo.webp')
    expect(retried.assets['builtin-bg-01']?.thumbnailPath).toBe(
      createDefaultRegistry().assets['builtin-bg-01']?.thumbnailPath
    )
  })

  it('derives active state from the registry, not from selection', () => {
    const ready = withReadySlot(createDefaultRegistry(), 'bg-03', readyAsset('asset-1', 'Sunset'))
    // Before Apply the ready slot reads as 'ready', not 'active'.
    expect(slotDisplayStatus(slotById(ready, 'bg-03'), ready)).toBe('ready')

    const applied = applySlot(ready, 'bg-03')
    expect(applied.activeSlotId).toBe('bg-03')
    expect(slotDisplayStatus(slotById(applied, 'bg-03'), applied)).toBe('active')
  })

  it('keeps bundled preset slots ready when remove is requested', () => {
    const registry = removeSlotAsset(createDefaultRegistry(), 'bg-01')
    expect(slotById(registry, 'bg-01').assetId).toBe('builtin-bg-01')
    expect(slotById(registry, 'bg-01').status).toBe('ready')
    expect(applySlot(registry, 'bg-01').activeSlotId).toBe('bg-01')
  })

  it('moves the active marker on re-apply and clears it on demand', () => {
    let registry = withReadySlot(createDefaultRegistry(), 'bg-03', readyAsset('asset-1', 'Sunset'))
    registry = withReadySlot(registry, 'bg-07', readyAsset('asset-2', 'Studio Wall'))

    registry = applySlot(registry, 'bg-03')
    registry = applySlot(registry, 'bg-07')
    expect(registry.activeSlotId).toBe('bg-07')

    registry = clearActiveSlot(registry)
    expect(registry.activeSlotId).toBeNull()
  })

  describe('reconcileRegistry', () => {
    it('returns the default registry for missing or malformed storage', () => {
      expect(reconcileRegistry(null).slots).toHaveLength(10)
      expect(reconcileRegistry(undefined).activeSlotId).toBeNull()
      expect(reconcileRegistry('garbage').slots).toHaveLength(10)
      expect(reconcileRegistry(42).slots.map((slot) => slot.id)).toContain('bg-10')
    })

    it('drops an active selection that does not point at a known ready slot', () => {
      expect(reconcileRegistry({ activeSlotId: 'does-not-exist' }).activeSlotId).toBeNull()
    })

    it('always rebuilds the ten canonical slots from code', () => {
      const reconciled = reconcileRegistry({
        slots: [{ id: 'bg-99', defaultLabel: 'Hacked', assetId: null, status: 'empty' }]
      })
      expect(reconciled.slots).toHaveLength(10)
      expect(reconciled.slots.map((slot) => slot.id)).not.toContain('bg-99')
      expect(reconciled.slots[0].defaultLabel).toBe('Code Demo')
      expect(reconciled.slots[0].status).toBe('ready')
    })

    it('seeds bundled presets into old empty registries', () => {
      const reconciled = reconcileRegistry({
        slots: [{ id: 'bg-01', assetId: null, status: 'empty' }],
        assets: {},
        activeSlotId: null
      })
      expect(slotById(reconciled, 'bg-01').status).toBe('ready')
      expect(slotById(reconciled, 'bg-01').assetId).toBe('builtin-bg-01')
    })

    it('restores bundled presets into current-version empty registries', () => {
      const reconciled = reconcileRegistry({
        bundledPresetVersion: 1,
        slots: [{ id: 'bg-01', assetId: null, status: 'empty' }],
        assets: {},
        activeSlotId: null
      })
      expect(slotById(reconciled, 'bg-01').status).toBe('ready')
      expect(slotById(reconciled, 'bg-01').assetId).toBe('builtin-bg-01')
    })
  })
})

describe('background asset import and editing', () => {
  it('creates an imported asset that is ready with default style', () => {
    const asset = importedAsset('a1', 'Sunset')
    expect(asset.kind).toBe('imported')
    expect(asset.status).toBe('ready')
    expect(asset.thumbnailPath).toBe('/managed/a1.png')
    expect(asset.styleDefaults).toEqual(defaultBackgroundStyle())
  })

  it('imports an asset into a slot and marks it ready', () => {
    const registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    const slot = slotById(registry, 'bg-02')
    expect(slot.assetId).toBe('a1')
    expect(slot.status).toBe('ready')
    expect(registry.assets.a1?.name).toBe('Sunset')
  })

  it('drops the previous asset when a slot is replaced', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'First'))
    registry = importIntoSlot(registry, 'bg-02', importedAsset('a2', 'Second'))
    expect(registry.assets.a1).toBeUndefined()
    expect(registry.assets.a2).toBeDefined()
    expect(slotById(registry, 'bg-02').assetId).toBe('a2')
  })

  it('renames an asset, ignoring blank or unchanged names', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = renameAsset(registry, 'a1', '  Dawn ')
    expect(registry.assets.a1?.name).toBe('Dawn')
    expect(renameAsset(registry, 'a1', '   ')).toBe(registry)
    expect(renameAsset(registry, 'a1', 'Dawn')).toBe(registry)
  })

  it('edits asset style defaults without touching untouched fields', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = setAssetStyle(registry, 'a1', { blurPx: 12, fit: 'fit' })
    expect(registry.assets.a1?.styleDefaults.blurPx).toBe(12)
    expect(registry.assets.a1?.styleDefaults.fit).toBe('fit')
    expect(registry.assets.a1?.styleDefaults.scale).toBe(100)
  })

  it('removes an imported slot asset and restores the bundled preset', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = applySlot(registry, 'bg-02')
    expect(registry.activeSlotId).toBe('bg-02')

    registry = removeSlotAsset(registry, 'bg-02')
    expect(registry.assets.a1).toBeUndefined()
    expect(registry.activeSlotId).toBe('bg-02')
    const slot = slotById(registry, 'bg-02')
    expect(slot.assetId).toBe('builtin-bg-02')
    expect(slot.status).toBe('ready')
    expect(registry.assets['builtin-bg-02']?.kind).toBe('builtin')
  })

  it('marks a missing file without dropping the active selection', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = applySlot(registry, 'bg-02')
    registry = markSlotStatus(registry, 'bg-02', 'missing-file')
    expect(registry.activeSlotId).toBe('bg-02')
    expect(slotDisplayStatus(slotById(registry, 'bg-02'), registry)).toBe('missing-file')
  })

  it('does not let a stale existence result mark a replacement asset missing', () => {
    const first = importedAsset('a1', 'Sunset')
    const replacement = importedAsset('a2', 'Ocean')
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', first)
    registry = importIntoSlot(registry, 'bg-02', replacement)

    const unchanged = markSlotMissingIfAssetMatches(
      registry,
      'bg-02',
      first.id,
      first.assetPath ?? ''
    )
    expect(unchanged).toBe(registry)
    expect(slotById(unchanged, 'bg-02').status).toBe('ready')

    const missing = markSlotMissingIfAssetMatches(
      registry,
      'bg-02',
      replacement.id,
      replacement.assetPath ?? ''
    )
    expect(slotById(missing, 'bg-02').status).toBe('missing-file')
  })
})

describe('reconcileRegistry with imported assets', () => {
  it('round-trips an imported, applied asset through persistence', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = applySlot(registry, 'bg-02')

    const restored = reconcileRegistry(JSON.parse(JSON.stringify(registry)))
    expect(restored.assets.a1).toBeDefined()
    expect(slotById(restored, 'bg-02').status).toBe('ready')
    expect(restored.activeSlotId).toBe('bg-02')
  })

  it('prunes orphan imported assets, drops malformed ones, and keeps bundled assets', () => {
    const restored = reconcileRegistry({
      bundledPresetVersion: 1,
      slots: [],
      assets: {
        a1: { id: 'a1', name: 'Orphan', assetPath: '/m/a1.png', styleDefaults: {} },
        bad: { name: 'No id' }
      },
      activeSlotId: null
    })
    expect(Object.keys(restored.assets)).toHaveLength(10)
    expect(restored.assets.a1).toBeUndefined()
    expect(restored.assets.bad).toBeUndefined()
    expect(restored.assets['builtin-bg-01']?.kind).toBe('builtin')
  })

  it('fills missing style fields from defaults on reload', () => {
    const restored = reconcileRegistry({
      slots: [{ id: 'bg-02', assetId: 'a1' }],
      assets: {
        a1: { id: 'a1', name: 'Partial', assetPath: '/m/a1.png', styleDefaults: { blurPx: 9 } }
      },
      activeSlotId: null
    })
    expect(restored.assets.a1?.styleDefaults.blurPx).toBe(9)
    expect(restored.assets.a1?.styleDefaults.scale).toBe(100)
  })
})

describe('effective scene background', () => {
  it('returns null when no slot is active', () => {
    expect(effectiveSceneBackground(createDefaultRegistry())).toBeNull()
  })

  it('resolves the active asset into an effective background', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = applySlot(registry, 'bg-02')
    expect(effectiveSceneBackground(registry)).toEqual({
      assetId: 'a1',
      managedAssetPath: '/managed/a1.png',
      fit: 'fill',
      scale: 100,
      offsetX: 0,
      offsetY: 0,
      blurPx: 0,
      dimPercent: 0,
      saturationPercent: 100,
      vignettePercent: 0,
      visibilityPercent: 20
    })
  })

  it('carries the asset visibility default into the effective background', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = setAssetStyle(registry, 'a1', { visibilityPercent: 0 })
    registry = applySlot(registry, 'bg-02')

    // 0 keeps the recording full-canvas; the backend maps this to a zero stage margin.
    expect(effectiveSceneBackground(registry)?.visibilityPercent).toBe(0)
  })

  it('defaults visibility for registries persisted before the slider existed', () => {
    const registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    const stored = JSON.parse(JSON.stringify(registry)) as {
      assets: Record<string, { styleDefaults: Record<string, unknown> }>
    }
    // Simulate a registry saved by an older build: no visibilityPercent field.
    delete stored.assets['a1'].styleDefaults.visibilityPercent

    const reconciled = reconcileRegistry(stored)
    expect(reconciled.assets['a1']?.styleDefaults.visibilityPercent).toBe(20)
  })

  it('does not resolve a missing active slot into the scene background', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = applySlot(registry, 'bg-02')
    registry = markSlotStatus(registry, 'bg-02', 'missing-file')

    expect(effectiveSceneBackground(registry)).toBeNull()
  })

  it('renders the asset style defaults exactly (no hidden override layer)', () => {
    let registry = importIntoSlot(createDefaultRegistry(), 'bg-02', importedAsset('a1', 'Sunset'))
    registry = setAssetStyle(registry, 'a1', { blurPx: 4, scale: 150 })
    registry = applySlot(registry, 'bg-02')

    const effective = effectiveSceneBackground(registry)
    expect(effective?.blurPx).toBe(4)
    expect(effective?.scale).toBe(150)
  })

  it('ignores sceneOverrides persisted by older builds', () => {
    // The override layer was removed with the Scene-page Background section;
    // stale persisted overrides must not shape the output invisibly.
    const restored = reconcileRegistry({
      sceneOverrides: { blurPx: 9, fit: 'fit' }
    }) as unknown as Record<string, unknown>
    expect('sceneOverrides' in restored).toBe(false)
  })
})

describe('backgroundAssetDisplayUrl', () => {
  it('serves imported absolute paths through the scoped asset protocol', () => {
    expect(
      backgroundAssetDisplayUrl(
        '/Users/me/Library/Application Support/videorc/background-assets/abc-photo.png'
      )
    ).toBe('videorc-asset://background/abc-photo.png')
    expect(backgroundAssetDisplayUrl('C:\\Users\\me\\videorc\\background-assets\\abc.png')).toBe(
      'videorc-asset://background/abc.png'
    )
    expect(backgroundAssetDisplayUrl('C:/Users/me/videorc/background-assets/abc.png')).toBe(
      'videorc-asset://background/abc.png'
    )
    expect(
      backgroundAssetDisplayUrl('\\\\server\\share\\videorc\\background-assets\\abc.png')
    ).toBe('videorc-asset://background/abc.png')
    expect(backgroundAssetDisplayUrl('//server/share/videorc/background-assets/abc.png')).toBe(
      'videorc-asset://background/abc.png'
    )
  })

  it('only exposes absolute imported files to the existence oracle', () => {
    for (const assetPath of [
      '/managed/abc.png',
      'C:\\Users\\me\\videorc\\background-assets\\abc.png',
      'C:/Users/me/videorc/background-assets/abc.png',
      '\\\\server\\share\\videorc\\background-assets\\abc.png',
      '//server/share/videorc/background-assets/abc.png'
    ]) {
      expect(checkableBackgroundAssetPath({ ...readyAsset('abc', 'ABC'), assetPath })).toBe(
        assetPath
      )
    }

    expect(
      checkableBackgroundAssetPath({
        ...readyAsset('abc', 'ABC'),
        assetPath: 'C:background-assets\\abc.png'
      })
    ).toBeNull()
    expect(
      checkableBackgroundAssetPath({
        ...readyAsset('abc', 'ABC'),
        assetPath: 'background-assets/abc.png'
      })
    ).toBeNull()
    expect(
      checkableBackgroundAssetPath({
        ...readyAsset('abc', 'ABC'),
        kind: 'builtin',
        assetPath: '/assets/backgrounds/abc.webp'
      })
    ).toBeNull()
  })

  it('encodes basenames safely', () => {
    expect(backgroundAssetDisplayUrl('/managed/dir/my photo #1.png')).toBe(
      'videorc-asset://background/my%20photo%20%231.png'
    )
  })

  it('passes bundler URLs, data/blob/http/file and relative paths through', () => {
    for (const passthrough of [
      '/assets/backgrounds/one.png',
      '/src/assets/backgrounds/two.jpg',
      './three.png',
      '../four.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/xyz',
      'https://example.com/img.png',
      'file:///already/url.png',
      'videorc-asset://background/five.png',
      'C:drive-relative.png',
      'plain-name.png'
    ]) {
      expect(backgroundAssetDisplayUrl(passthrough)).toBe(passthrough)
    }
  })
})
