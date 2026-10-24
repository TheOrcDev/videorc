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
import {
  LIVE_BACKGROUND_DEFAULT_LOOKS,
  LIVE_BACKGROUND_IDS,
  isLiveBackgroundId,
  isLiveBackgroundLook,
  livePosterAssetId,
  livePosterFileName,
  type LiveBackgroundId,
  type LiveBackgroundMotion
} from '../../../shared/live-background-ids'
import type { EffectiveSceneBackground, LiveBackgroundStatus } from './backend'

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
  version: 2
  slots: BackgroundAssetSlot[]
  assets: Record<string, BackgroundAsset>
  // The slot the user explicitly Applied; resolves to Scene.background (A5).
  // Always points at a 'ready' slot or is null — enforced by applySlot and
  // reconcileRegistry so a dangling/empty active can never persist.
  activeSlotId: string | null
  // Used to seed bundled presets into older localStorage registries exactly once.
  bundledPresetVersion: number
  // Plan 190: the live backgrounds. At most one of `activeSlotId` and
  // `live.activeId` is set: a scene has one background.
  live: LiveBackgroundState
}

/** A live background's choices (plan 190 D8): look, motion, Visibility, Dim. */
export type LiveBackgroundSettings = {
  look: string
  motion: LiveBackgroundMotion
  dimPercent: number
  visibilityPercent: number
}

export type LiveBackgroundState = {
  activeId: LiveBackgroundId | null
  // Each background remembers its own look and style once changed.
  settings: Partial<Record<LiveBackgroundId, LiveBackgroundSettings>>
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
    version: 2,
    slots: createDefaultBackgroundSlots(),
    assets,
    activeSlotId: null,
    bundledPresetVersion: BUNDLED_PRESET_VERSION,
    live: { activeId: null, settings: {} }
  }
}

export function defaultLiveBackgroundSettings(id: LiveBackgroundId): LiveBackgroundSettings {
  return {
    look: LIVE_BACKGROUND_DEFAULT_LOOKS[id],
    motion: 'calm',
    dimPercent: 0,
    visibilityPercent: defaultBackgroundStyle().visibilityPercent
  }
}

/** A live background's stored choices, or its defaults. */
export function liveBackgroundSettings(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId
): LiveBackgroundSettings {
  return registry.live.settings[id] ?? defaultLiveBackgroundSettings(id)
}

/** Put a live background on the scene; the picture slot leaves it. */
export function applyLiveBackground(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId
): BackgroundAssetRegistry {
  return { ...registry, activeSlotId: null, live: { ...registry.live, activeId: id } }
}

export function setLiveBackgroundSettings(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId,
  patch: Partial<LiveBackgroundSettings>
): BackgroundAssetRegistry {
  return {
    ...registry,
    live: {
      ...registry.live,
      settings: {
        ...registry.live.settings,
        [id]: normalizeLiveSettings(id, { ...liveBackgroundSettings(registry, id), ...patch })
      }
    }
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
    live: { ...registry.live, activeId: null },
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
  return registry.activeSlotId === null && registry.live.activeId === null
    ? registry
    : { ...registry, activeSlotId: null, live: { ...registry.live, activeId: null } }
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
        slot.assetId === assetId &&
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

export function firstEmptySlotId(registry: BackgroundAssetRegistry): string | null {
  return registry.slots.find((slot) => slot.status === 'empty')?.id ?? null
}

/**
 * Where Assets' Import puts a new image (plan 174, C-2 and D14): the first
 * empty slot, or, with all ten in use (every fresh profile), the slot the
 * streamer picks under "Replace which background?", starting from the
 * active background, else the last slot.
 */
export type BackgroundImportTarget =
  | { kind: 'slot'; slotId: string }
  | { kind: 'replace'; preselectedSlotId: string }

export function backgroundImportTarget(
  registry: BackgroundAssetRegistry
): BackgroundImportTarget | null {
  const empty = firstEmptySlotId(registry)
  if (empty) return { kind: 'slot', slotId: empty }
  const active = registry.slots.find((slot) => slot.id === registry.activeSlotId)
  const preselected = active ?? registry.slots.at(-1)
  return preselected ? { kind: 'replace', preselectedSlotId: preselected.id } : null
}

/**
 * Where an import nobody is asked about goes (the OBS import, C-7): the first
 * empty slot, else the last slot holding a built-in preset (Remove, then
 * Restore default, brings it back), else the last slot. `replaces` names the
 * background it takes the place of, so the report can say so before apply.
 */
export function unattendedImportSlot(
  registry: BackgroundAssetRegistry
): { slotId: string; replaces: string | null } | null {
  const empty = firstEmptySlotId(registry)
  if (empty) return { slotId: empty, replaces: null }
  const slot =
    [...registry.slots].reverse().find((entry) => slotAsset(entry, registry)?.kind === 'builtin') ??
    registry.slots.at(-1)
  return slot ? { slotId: slot.id, replaces: slotName(slot, registry) } : null
}

// Link an imported asset into a slot, marking it ready. Replacing a slot's asset
// drops the previous record so the registry can't leak orphaned assets.
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

/**
 * Whether removing a slot's background asks first (plan 174 S0.3, C-12): when
 * it leaves the scene (the slot is active, or its asset is the scene's
 * background), or when it is an imported file (pruned on the next load, so
 * gone for good). Emptying a built-in slot is reversible (Restore default).
 */
export function removeSlotNeedsConfirm(
  registry: BackgroundAssetRegistry,
  slotId: string,
  sceneBackgroundAssetId: string | null | undefined
): boolean {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot) return false
  if (registry.activeSlotId === slotId) return true
  if (slot.assetId !== null && slot.assetId === sceneBackgroundAssetId) return true
  return slotAsset(slot, registry)?.kind === 'imported'
}

// Removing a library entry never deletes its managed file or saved-scene references.
export function removeSlotAsset(
  registry: BackgroundAssetRegistry,
  slotId: string
): BackgroundAssetRegistry {
  if (!registry.slots.some((slot) => slot.id === slotId)) return registry
  return {
    ...registry,
    activeSlotId: registry.activeSlotId === slotId ? null : registry.activeSlotId,
    slots: registry.slots.map((slot) =>
      slot.id === slotId ? { ...slot, assetId: null, status: 'empty' } : slot
    )
  }
}

export function restoreSlotDefault(
  registry: BackgroundAssetRegistry,
  slotId: string
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  const builtin = builtinAssetForSlot(slotId)
  if (!slot || slot.assetId !== null || !builtin) return registry
  return {
    ...registry,
    assets: { ...registry.assets, [builtin.id]: registry.assets[builtin.id] ?? builtin },
    slots: registry.slots.map((entry) =>
      entry.id === slotId ? { ...entry, assetId: builtin.id, status: 'ready' } : entry
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

/** A built-in asset with the name and style a stored record carries, if any. */
function withStoredBuiltinEdits(builtin: BackgroundAsset, raw: unknown): BackgroundAsset {
  if (!raw || typeof raw !== 'object') return builtin
  const stored = raw as Partial<Record<'name' | 'styleDefaults', unknown>>
  return {
    ...builtin,
    name: typeof stored.name === 'string' && stored.name.trim() !== '' ? stored.name : builtin.name,
    styleDefaults:
      stored.styleDefaults && typeof stored.styleDefaults === 'object'
        ? normalizeStyle(stored.styleDefaults)
        : builtin.styleDefaults
  }
}

// Rebuild a trustworthy registry from whatever localStorage held. The canonical
// ten slots always come from code (ids + labels), so a stale or partial store
// can never drop a slot or resurrect a renamed one; only the mutable overlay
// (imported assets, per-slot link, active selection, a built-in's name and
// style) is restored, validated, and pruned of orphans. Imported slots reload
// as 'ready'; a missing managed file is re-detected at runtime (the tile <img>
// onError), not persisted.
export function reconcileRegistry(loaded: unknown): BackgroundAssetRegistry {
  const base = createDefaultRegistry()
  if (!loaded || typeof loaded !== 'object') {
    return base
  }

  const data = loaded as {
    version?: unknown
    slots?: unknown
    assets?: unknown
    activeSlotId?: unknown
    bundledPresetVersion?: unknown
  }
  const assets: Record<string, BackgroundAsset> = { ...base.assets }
  if (data.assets && typeof data.assets === 'object') {
    for (const [id, raw] of Object.entries(data.assets as Record<string, unknown>)) {
      const builtin = base.assets[id]
      if (builtin) {
        // Built-in assets come from this build so hashed bundle URLs stay
        // fresh; the streamer's rename and style edits survive (plan 174, C-3).
        assets[id] = withStoredBuiltinEdits(builtin, raw)
        continue
      }
      const asset = normalizeAsset(raw)
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
    const assetId =
      data.version === 2 && stored === null
        ? null
        : typeof stored === 'string' && assets[stored]
          ? stored
          : slot.assetId
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

  const live = normalizeLiveState((data as { live?: unknown }).live)
  return {
    version: 2,
    slots,
    assets: prunedAssets,
    // One background per scene: a stored live selection wins over a slot.
    activeSlotId: live.activeId ? null : activeSlotId,
    bundledPresetVersion: BUNDLED_PRESET_VERSION,
    live
  }
}

function normalizeLiveSettings(id: LiveBackgroundId, raw: unknown): LiveBackgroundSettings {
  const base = defaultLiveBackgroundSettings(id)
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Partial<LiveBackgroundSettings>
  const clamp = (value: unknown, fallback: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(max, value))
      : fallback
  return {
    look: isLiveBackgroundLook(data.look) ? data.look : base.look,
    motion: data.motion === 'normal' ? 'normal' : 'calm',
    dimPercent: clamp(data.dimPercent, base.dimPercent, 80),
    visibilityPercent: clamp(data.visibilityPercent, base.visibilityPercent, 40)
  }
}

function normalizeLiveState(raw: unknown): LiveBackgroundState {
  const state: LiveBackgroundState = { activeId: null, settings: {} }
  if (!raw || typeof raw !== 'object') return state
  const data = raw as { activeId?: unknown; settings?: unknown }
  state.activeId = isLiveBackgroundId(data.activeId) ? data.activeId : null
  if (data.settings && typeof data.settings === 'object') {
    for (const id of LIVE_BACKGROUND_IDS) {
      const stored = (data.settings as Record<string, unknown>)[id]
      if (stored !== undefined) state.settings[id] = normalizeLiveSettings(id, stored)
    }
  }
  return state
}

/** The bundled poster URL a live background's managed path names. */
export function livePosterManagedPath(id: LiveBackgroundId, look: string): string {
  return `videorc-asset://background/${encodeURIComponent(livePosterFileName(id, look))}`
}

/** The scene background for a live background with its stored choices. */
export function liveSceneBackground(
  id: LiveBackgroundId,
  settings: LiveBackgroundSettings
): EffectiveSceneBackground {
  const style = defaultBackgroundStyle()
  return {
    assetId: livePosterAssetId(id, settings.look),
    managedAssetPath: livePosterManagedPath(id, settings.look),
    fit: style.fit,
    scale: style.scale,
    offsetX: style.offsetX,
    offsetY: style.offsetY,
    blurPx: style.blurPx,
    dimPercent: settings.dimPercent,
    saturationPercent: style.saturationPercent,
    vignettePercent: style.vignettePercent,
    visibilityPercent: settings.visibilityPercent,
    live: { id, look: settings.look, motion: settings.motion }
  }
}

/**
 * The registry after the backend committed a live `background` (the
 * transaction's truth): that live background becomes active, the picture slot
 * leaves, and its committed choices are remembered. Returns the same registry
 * when nothing changes.
 */
export function registryForCommittedLiveBackground(
  registry: BackgroundAssetRegistry,
  background: EffectiveSceneBackground
): BackgroundAssetRegistry {
  const live = background.live
  if (!live || !isLiveBackgroundId(live.id)) return registry
  const settings = normalizeLiveSettings(live.id, {
    look: live.look,
    motion: live.motion,
    dimPercent: background.dimPercent,
    visibilityPercent: background.visibilityPercent
  })
  const current = registry.live.settings[live.id]
  if (
    registry.activeSlotId === null &&
    registry.live.activeId === live.id &&
    current &&
    JSON.stringify(current) === JSON.stringify(settings)
  ) {
    return registry
  }
  return {
    ...registry,
    activeSlotId: null,
    live: { activeId: live.id, settings: { ...registry.live.settings, [live.id]: settings } }
  }
}

/** How the applied live background is drawn, as Assets shows it. */
export type LiveBackgroundStatusView = Pick<LiveBackgroundStatus, 'id' | 'rendering' | 'reason'>

/**
 * The view of a compositor status's live background. It keeps `current` while
 * nothing Assets shows changed, so a status that only moves the timings or
 * the look publishes nothing.
 */
export function nextLiveBackgroundStatusView(
  current: LiveBackgroundStatusView | null,
  incoming: LiveBackgroundStatus | null | undefined
): LiveBackgroundStatusView | null {
  const next = incoming
    ? { id: incoming.id, rendering: incoming.rendering, reason: incoming.reason }
    : null
  return JSON.stringify(next) === JSON.stringify(current) ? current : next
}

// The resolved background for the active scene, or null when nothing usable is
// selected (no active slot, or its asset has no managed file). The renderer
// injects this onto Scene.background before sending to the backend.
export function effectiveSceneBackground(
  registry: BackgroundAssetRegistry
): EffectiveSceneBackground | null {
  if (registry.live.activeId) {
    return liveSceneBackground(
      registry.live.activeId,
      liveBackgroundSettings(registry, registry.live.activeId)
    )
  }
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
