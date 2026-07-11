// Background assets domain model (Assets Tab plan, slice A2).
//
// Assets owns reusable background material; Scene owns which one is active. This
// registry ships ten bundled preset backgrounds, then lets users replace slots
// with imported app-support copies. Kept as pure data + helpers (no React, no
// storage) so the registry logic is unit-testable in isolation.

import codeDemoUrl from '../assets/backgrounds/code-demo.webp'
import darkModeUrl from '../assets/backgrounds/dark-mode.webp'
import focusUrl from '../assets/backgrounds/focus.webp'
import lightModeUrl from '../assets/backgrounds/light-mode.webp'
import livestreamUrl from '../assets/backgrounds/livestream.webp'
import minimalDeskUrl from '../assets/backgrounds/minimal-desk.webp'
import podcastUrl from '../assets/backgrounds/podcast.webp'
import productLaunchUrl from '../assets/backgrounds/product-launch.webp'
import tutorialUrl from '../assets/backgrounds/tutorial.webp'
import webinarUrl from '../assets/backgrounds/webinar.webp'

import {
  BUNDLED_BACKGROUND_MANIFEST,
  type BackgroundImportResult
} from '../../../shared/background-import'
import type { EffectiveSceneBackground } from './backend'

export type BackgroundAssetSlotStatus =
  | 'empty'
  | 'ready'
  | 'active'
  | 'missing-file'
  | 'unsupported'
export type BackgroundAssetKind = 'preset-placeholder' | 'builtin' | 'imported'
export type BackgroundFit = 'fill' | 'fit' | 'stretch'

// A slot's intrinsic state never includes 'active' — exactly one slot is active
// at a time, and that is derived from the registry's activeSlotId (see
// slotDisplayStatus) so the source of truth can't disagree with itself.
export type IntrinsicSlotStatus = Exclude<BackgroundAssetSlotStatus, 'active'>

export type BackgroundStyle = {
  fit: BackgroundFit
  scale: number
  offsetX: number
  offsetY: number
  blurPx: number
  dimPercent: number
  saturationPercent: number
  vignettePercent: number
  // How much of the screen the background occupies behind the recording (0-40):
  // 0 keeps the recording full-canvas, 20 is the classic 80% stage.
  visibilityPercent: number
}

export type BackgroundAsset = {
  id: string
  name: string
  kind: BackgroundAssetKind
  assetPath?: string
  thumbnailPath?: string
  status: BackgroundAssetSlotStatus
  dominantColor?: string
  styleDefaults: BackgroundStyle
  createdAt: string
  updatedAt: string
}

export type BackgroundAssetSlot = {
  id: string
  // Curated use-case label; stays as the slot's name until an import renames it.
  defaultLabel: string
  // Null until an image is imported into the slot (A4).
  assetId: string | null
  status: IntrinsicSlotStatus
}

export type BackgroundAssetRegistry = {
  slots: BackgroundAssetSlot[]
  assets: Record<string, BackgroundAsset>
  // The slot the user explicitly Applied; resolves to Scene.background (A5).
  // Always points at a 'ready' slot or is null — enforced by applySlot and
  // reconcileRegistry so a dangling/empty active can never persist.
  activeSlotId: string | null
  // Used to seed bundled presets into older localStorage registries exactly once.
  bundledPresetVersion: number
}

// The ten initial slots: stable ids the protocol/scene will reference, plus the
// locked creator/use-case labels.
const BUNDLED_PRESET_VERSION = 1
const SLOT_DEFS: readonly { id: string; label: string; assetUrl: string }[] = [
  { id: 'bg-01', label: BUNDLED_BACKGROUND_MANIFEST[0].name, assetUrl: codeDemoUrl },
  { id: 'bg-02', label: BUNDLED_BACKGROUND_MANIFEST[1].name, assetUrl: productLaunchUrl },
  { id: 'bg-03', label: BUNDLED_BACKGROUND_MANIFEST[2].name, assetUrl: tutorialUrl },
  { id: 'bg-04', label: BUNDLED_BACKGROUND_MANIFEST[3].name, assetUrl: livestreamUrl },
  { id: 'bg-05', label: BUNDLED_BACKGROUND_MANIFEST[4].name, assetUrl: minimalDeskUrl },
  { id: 'bg-06', label: BUNDLED_BACKGROUND_MANIFEST[5].name, assetUrl: podcastUrl },
  { id: 'bg-07', label: BUNDLED_BACKGROUND_MANIFEST[6].name, assetUrl: webinarUrl },
  { id: 'bg-08', label: BUNDLED_BACKGROUND_MANIFEST[7].name, assetUrl: darkModeUrl },
  { id: 'bg-09', label: BUNDLED_BACKGROUND_MANIFEST[8].name, assetUrl: lightModeUrl },
  { id: 'bg-10', label: BUNDLED_BACKGROUND_MANIFEST[9].name, assetUrl: focusUrl }
]

export const BACKGROUND_SLOT_COUNT = SLOT_DEFS.length

export type NumericStyleField = Exclude<keyof BackgroundStyle, 'fit'>

// The numeric background-style controls in display order, with their ranges and
// units. Shared by the Assets inspector (edits asset defaults) and the Scene tab
// (edits per-scene overrides) so both render the same controls. `fit` is a
// separate segmented control, not a slider.
export const BACKGROUND_STYLE_FIELDS: readonly {
  key: NumericStyleField
  label: string
  min: number
  max: number
  suffix?: string
  bipolar?: boolean
}[] = [
  { key: 'visibilityPercent', label: 'Visibility', min: 0, max: 40, suffix: '%' },
  { key: 'scale', label: 'Scale', min: 50, max: 200, suffix: '%' },
  { key: 'offsetX', label: 'Pan X', min: -100, max: 100, bipolar: true },
  { key: 'offsetY', label: 'Pan Y', min: -100, max: 100, bipolar: true },
  { key: 'blurPx', label: 'Blur', min: 0, max: 40, suffix: 'px' },
  { key: 'dimPercent', label: 'Dim', min: 0, max: 80, suffix: '%' },
  { key: 'saturationPercent', label: 'Saturation', min: 0, max: 150, suffix: '%' },
  { key: 'vignettePercent', label: 'Vignette', min: 0, max: 100, suffix: '%' }
]

export function defaultBackgroundStyle(): BackgroundStyle {
  return {
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0,
    visibilityPercent: 20
  }
}

export function createDefaultBackgroundSlots(): BackgroundAssetSlot[] {
  return SLOT_DEFS.map((def) => ({
    id: def.id,
    defaultLabel: def.label,
    assetId: builtinAssetId(def.id),
    status: 'ready'
  }))
}

export function createDefaultRegistry(): BackgroundAssetRegistry {
  const assets = Object.fromEntries(
    SLOT_DEFS.map((def) => {
      const asset = createBuiltinAsset(def)
      return [asset.id, asset]
    })
  )
  return {
    slots: createDefaultBackgroundSlots(),
    assets,
    activeSlotId: null,
    bundledPresetVersion: BUNDLED_PRESET_VERSION
  }
}

function builtinAssetId(slotId: string): string {
  return `builtin-${slotId}`
}

function createBuiltinAsset(def: (typeof SLOT_DEFS)[number]): BackgroundAsset {
  return {
    id: builtinAssetId(def.id),
    name: def.label,
    kind: 'builtin',
    assetPath: def.assetUrl,
    thumbnailPath: def.assetUrl,
    status: 'ready',
    styleDefaults: defaultBackgroundStyle(),
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z'
  }
}

function builtinAssetForSlot(slotId: string): BackgroundAsset | null {
  const def = SLOT_DEFS.find((entry) => entry.id === slotId)
  return def ? createBuiltinAsset(def) : null
}

export function slotAsset(
  slot: BackgroundAssetSlot,
  registry: BackgroundAssetRegistry
): BackgroundAsset | null {
  return slot.assetId ? (registry.assets[slot.assetId] ?? null) : null
}

// An imported asset's name wins; a placeholder slot shows its curated label.
export function slotName(slot: BackgroundAssetSlot, registry: BackgroundAssetRegistry): string {
  return slotAsset(slot, registry)?.name ?? slot.defaultLabel
}

// 'active' is derived, never stored: a slot reads as active only when it is the
// registry's active slot AND actually holds a usable image.
export function slotDisplayStatus(
  slot: BackgroundAssetSlot,
  registry: BackgroundAssetRegistry
): BackgroundAssetSlotStatus {
  if (registry.activeSlotId === slot.id && slot.status === 'ready') {
    return 'active'
  }
  return slot.status
}

export function canApplySlot(slot: BackgroundAssetSlot): boolean {
  return slot.status === 'ready'
}

// Explicit Apply — selecting a tile must NOT call this. Applying a non-ready
// slot is a no-op so the active background can never point at an empty slot.
export function applySlot(
  registry: BackgroundAssetRegistry,
  slotId: string
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot) {
    return registry
  }
  const asset = slotAsset(slot, registry)
  const canRecoverBundledSlot = slot.status === 'missing-file' && asset?.kind === 'builtin'
  if (!canApplySlot(slot) && !canRecoverBundledSlot) {
    return registry
  }
  return {
    ...registry,
    activeSlotId: slotId,
    slots: canRecoverBundledSlot
      ? registry.slots.map(
          (entry): BackgroundAssetSlot =>
            entry.id === slotId ? { ...entry, status: 'ready' } : entry
        )
      : registry.slots
  }
}

// Recording without a digital background is always valid, so clearing is always
// allowed.
export function clearActiveSlot(registry: BackgroundAssetRegistry): BackgroundAssetRegistry {
  return registry.activeSlotId === null ? registry : { ...registry, activeSlotId: null }
}

export function applyBundledBackgroundAssets(
  registry: BackgroundAssetRegistry,
  bundledAssets: readonly BackgroundImportResult[]
): BackgroundAssetRegistry {
  const byId = new Map(bundledAssets.map((asset) => [asset.id, asset]))
  let changed = false
  const assets: Record<string, BackgroundAsset> = { ...registry.assets }
  let slots = registry.slots

  for (const def of SLOT_DEFS) {
    const assetId = builtinAssetId(def.id)
    const fallbackAsset = createBuiltinAsset(def)
    const current = assets[assetId] ?? fallbackAsset
    const resolved = byId.get(assetId)
    if (current.kind !== 'builtin') {
      continue
    }

    if (!assets[assetId]) {
      changed = true
      assets[assetId] = current
    }

    if (resolved?.assetPath) {
      // Keep thumbnails on the renderer-bundled URL. The native filesystem path
      // is for the compositor; a dev-server renderer cannot reliably load it.
      const thumbnailPath = fallbackAsset.thumbnailPath
      if (current.assetPath !== resolved.assetPath || current.thumbnailPath !== thumbnailPath) {
        changed = true
        assets[assetId] = {
          ...current,
          assetPath: resolved.assetPath,
          thumbnailPath,
          updatedAt: current.updatedAt
        }
      }
    }

    const nextSlots = slots.map(
      (slot): BackgroundAssetSlot =>
        slot.id === def.id &&
        (slot.assetId === null || slot.assetId === assetId) &&
        (slot.assetId !== assetId || slot.status !== 'ready')
          ? { ...slot, assetId, status: 'ready' }
          : slot
    )
    if (nextSlots.some((slot, index) => slot !== slots[index])) {
      changed = true
      slots = nextSlots
    }
  }

  return changed ? { ...registry, assets, slots } : registry
}

// Build an imported asset record from the main process's copy result plus the
// caller's timestamps (kept out of this pure module so it stays deterministic).
export function createImportedAsset(input: {
  id: string
  name: string
  assetPath: string
  thumbnailPath?: string
  createdAt: string
  updatedAt: string
  styleDefaults?: BackgroundStyle
}): BackgroundAsset {
  return {
    id: input.id,
    name: input.name,
    kind: 'imported',
    assetPath: input.assetPath,
    thumbnailPath: input.thumbnailPath ?? input.assetPath,
    status: 'ready',
    styleDefaults: input.styleDefaults ?? defaultBackgroundStyle(),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  }
}

// Link an imported asset into a slot, marking it ready. Replacing a slot's asset
// drops the previous record so the registry can't leak orphaned assets.
export function firstEmptySlotId(registry: BackgroundAssetRegistry): string | null {
  return registry.slots.find((slot) => slot.status === 'empty')?.id ?? null
}

export function importIntoSlot(
  registry: BackgroundAssetRegistry,
  slotId: string,
  asset: BackgroundAsset
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot) {
    return registry
  }
  const assets: Record<string, BackgroundAsset> = { ...registry.assets }
  const previousAsset = slot.assetId ? assets[slot.assetId] : null
  if (slot.assetId && slot.assetId !== asset.id && previousAsset?.kind !== 'builtin') {
    delete assets[slot.assetId]
  }
  assets[asset.id] = asset
  return {
    ...registry,
    assets,
    slots: registry.slots.map(
      (entry): BackgroundAssetSlot =>
        entry.id === slotId ? { ...entry, assetId: asset.id, status: 'ready' } : entry
    )
  }
}

export function renameAsset(
  registry: BackgroundAssetRegistry,
  assetId: string,
  name: string
): BackgroundAssetRegistry {
  const asset = registry.assets[assetId]
  const trimmed = name.trim()
  if (!asset || trimmed === '' || trimmed === asset.name) {
    return registry
  }
  return {
    ...registry,
    assets: { ...registry.assets, [assetId]: { ...asset, name: trimmed } }
  }
}

// Edit asset-level style defaults (Assets owns defaults; Scene overrides come in A5).
export function setAssetStyle(
  registry: BackgroundAssetRegistry,
  assetId: string,
  patch: Partial<BackgroundStyle>
): BackgroundAssetRegistry {
  const asset = registry.assets[assetId]
  if (!asset) {
    return registry
  }
  return {
    ...registry,
    assets: {
      ...registry.assets,
      [assetId]: { ...asset, styleDefaults: { ...asset.styleDefaults, ...patch } }
    }
  }
}

// Remove an imported replacement and restore the app-owned bundled preset. The
// ten bundled backgrounds should never disappear from local state.
export function removeSlotAsset(
  registry: BackgroundAssetRegistry,
  slotId: string
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot) {
    return registry
  }
  const builtinAsset = builtinAssetForSlot(slot.id)
  if (!builtinAsset) {
    return registry
  }

  const assets = { ...registry.assets }
  if (slot.assetId && slot.assetId !== builtinAsset.id) {
    delete assets[slot.assetId]
  }
  assets[builtinAsset.id] = assets[builtinAsset.id] ?? builtinAsset

  return {
    ...registry,
    assets,
    slots: registry.slots.map(
      (entry): BackgroundAssetSlot =>
        entry.id === slotId ? { ...entry, assetId: builtinAsset.id, status: 'ready' } : entry
    )
  }
}

/**
 * Display URL for a background asset path. Bundler URLs, data/blob/http and
 * relative paths pass through untouched; ABSOLUTE filesystem paths (imported
 * assets in app storage) are served through the scoped `videorc-asset://`
 * protocol — raw file:// subresources are blocked from the dev server's http
 * origin, which made fresh imports fail onError and get branded "Missing"
 * while the file sat safely on disk (post-0.9.4 fix batch F4).
 */
export function backgroundAssetDisplayUrl(path: string): string {
  if (
    /^(blob|data|file|https?|videorc-asset):/i.test(path) ||
    path.startsWith('/assets/') ||
    path.startsWith('/src/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    !isAbsoluteBackgroundAssetPath(path)
  ) {
    return path
  }
  const normalized = path.replace(/\\/g, '/')
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return `videorc-asset://background/${encodeURIComponent(baseName)}`
}

/** Browser-safe absolute-path detection for paths returned by Electron. */
export function isAbsoluteBackgroundAssetPath(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path)
  )
}

/** Only imported absolute files are safe and useful for the main-process existence oracle. */
export function checkableBackgroundAssetPath(asset: BackgroundAsset | null): string | null {
  const path = asset?.assetPath
  return asset?.kind === 'imported' && path && isAbsoluteBackgroundAssetPath(path) ? path : null
}

// Set a slot's intrinsic status — used when an <img> fails to load to surface
// 'missing-file' without dropping the active selection (A6 records without a
// background and warns; A4 just shows the state).
export function markSlotStatus(
  registry: BackgroundAssetRegistry,
  slotId: string,
  status: IntrinsicSlotStatus
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot || slot.status === status) {
    return registry
  }
  return {
    ...registry,
    slots: registry.slots.map(
      (entry): BackgroundAssetSlot => (entry.id === slotId ? { ...entry, status } : entry)
    )
  }
}

/** Apply an async missing-file result only while the checked asset still owns the slot. */
export function markSlotMissingIfAssetMatches(
  registry: BackgroundAssetRegistry,
  slotId: string,
  expectedAssetId: string,
  expectedAssetPath: string
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  const currentAsset = slot ? slotAsset(slot, registry) : null
  if (
    currentAsset?.id !== expectedAssetId ||
    currentAsset.assetPath !== expectedAssetPath ||
    currentAsset.kind !== 'imported'
  ) {
    return registry
  }
  return markSlotStatus(registry, slotId, 'missing-file')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeStyle(raw: unknown): BackgroundStyle {
  const base = defaultBackgroundStyle()
  if (!raw || typeof raw !== 'object') {
    return base
  }
  const data = raw as Partial<BackgroundStyle>
  return {
    fit: data.fit === 'fit' || data.fit === 'stretch' ? data.fit : base.fit,
    scale: numberOr(data.scale, base.scale),
    offsetX: numberOr(data.offsetX, base.offsetX),
    offsetY: numberOr(data.offsetY, base.offsetY),
    blurPx: numberOr(data.blurPx, base.blurPx),
    dimPercent: numberOr(data.dimPercent, base.dimPercent),
    saturationPercent: numberOr(data.saturationPercent, base.saturationPercent),
    vignettePercent: numberOr(data.vignettePercent, base.vignettePercent),
    visibilityPercent: numberOr(data.visibilityPercent, base.visibilityPercent)
  }
}

function normalizeAsset(raw: unknown): BackgroundAsset | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const data = raw as Partial<BackgroundAsset>
  if (typeof data.id !== 'string' || typeof data.assetPath !== 'string') {
    return null
  }
  return {
    id: data.id,
    name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name : 'Background',
    kind: data.kind === 'builtin' || data.kind === 'preset-placeholder' ? data.kind : 'imported',
    assetPath: data.assetPath,
    thumbnailPath: typeof data.thumbnailPath === 'string' ? data.thumbnailPath : data.assetPath,
    status: 'ready',
    dominantColor: typeof data.dominantColor === 'string' ? data.dominantColor : undefined,
    styleDefaults: normalizeStyle(data.styleDefaults),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : ''
  }
}

// Rebuild a trustworthy registry from whatever localStorage held. The canonical
// ten slots always come from code (ids + labels), so a stale or partial store
// can never drop a slot or resurrect a renamed one; only the mutable overlay
// (imported assets, per-slot link, active selection) is restored, validated, and
// pruned of orphans. Imported slots reload as 'ready'; a missing managed file is
// re-detected at runtime (the tile <img> onError), not persisted.
export function reconcileRegistry(loaded: unknown): BackgroundAssetRegistry {
  const base = createDefaultRegistry()
  if (!loaded || typeof loaded !== 'object') {
    return base
  }

  const data = loaded as {
    slots?: unknown
    assets?: unknown
    activeSlotId?: unknown
    bundledPresetVersion?: unknown
  }
  const assets: Record<string, BackgroundAsset> = { ...base.assets }
  if (data.assets && typeof data.assets === 'object') {
    for (const [id, raw] of Object.entries(data.assets as Record<string, unknown>)) {
      const asset = normalizeAsset(raw)
      // Built-in assets always come from this build so hashed bundle URLs stay fresh.
      if (asset && asset.id === id && asset.kind !== 'builtin') {
        assets[id] = asset
      }
    }
  }

  // slotId -> stored assetId (validated below); the canonical slots themselves
  // always come from code, never from storage.
  const storedAssetId = new Map<string, unknown>()
  if (Array.isArray(data.slots)) {
    for (const raw of data.slots) {
      if (raw && typeof raw === 'object') {
        const slot = raw as { id?: unknown; assetId?: unknown }
        if (typeof slot.id === 'string') {
          storedAssetId.set(slot.id, slot.assetId)
        }
      }
    }
  }
  const slots = base.slots.map((slot): BackgroundAssetSlot => {
    const stored = storedAssetId.get(slot.id)
    const assetId = typeof stored === 'string' && assets[stored] ? stored : slot.assetId
    return assetId
      ? { ...slot, assetId, status: 'ready' }
      : { ...slot, assetId: null, status: 'empty' }
  })

  const storedActive = data.activeSlotId
  const activeSlotId =
    typeof storedActive === 'string' &&
    slots.some((slot) => slot.id === storedActive && slot.status === 'ready')
      ? storedActive
      : null

  // Drop assets no slot references so orphans can't accumulate in storage.
  const referenced = new Set(slots.map((slot) => slot.assetId).filter(Boolean))
  const prunedAssets: Record<string, BackgroundAsset> = {}
  for (const [id, asset] of Object.entries(assets)) {
    if (asset.kind === 'builtin' || referenced.has(id)) {
      prunedAssets[id] = asset
    }
  }

  return {
    slots,
    assets: prunedAssets,
    activeSlotId,
    bundledPresetVersion: BUNDLED_PRESET_VERSION
  }
}

// The resolved background for the active scene, or null when nothing usable is
// selected (no active slot, or its asset has no managed file). The renderer
// injects this onto Scene.background before sending to the backend.
export function effectiveSceneBackground(
  registry: BackgroundAssetRegistry
): EffectiveSceneBackground | null {
  if (!registry.activeSlotId) {
    return null
  }
  const slot = registry.slots.find((entry) => entry.id === registry.activeSlotId)
  if (!slot || slot.status !== 'ready') {
    return null
  }
  const asset = slot ? slotAsset(slot, registry) : null
  if (!asset || !asset.assetPath) {
    return null
  }
  // The asset's style defaults ARE the style — the scene-override layer was
  // removed with the Scene-page Background section (its map was global, never
  // actually per-scene); Assets' Adjust-style popover is the single editing home.
  const style = asset.styleDefaults
  return {
    assetId: asset.id,
    managedAssetPath: asset.assetPath,
    fit: style.fit,
    scale: style.scale,
    offsetX: style.offsetX,
    offsetY: style.offsetY,
    blurPx: style.blurPx,
    dimPercent: style.dimPercent,
    saturationPercent: style.saturationPercent,
    vignettePercent: style.vignettePercent,
    visibilityPercent: style.visibilityPercent
  }
}
