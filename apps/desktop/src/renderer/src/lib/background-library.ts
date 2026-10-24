// Background library editing (Assets Tab plan; split out in plan 190): the
// helpers only the Assets page, the Scene stage and the OBS import use. Kept
// out of `background-assets.ts` so they ship in lazy chunks, never eagerly.

import {
  builtinAssetForSlot,
  defaultBackgroundStyle,
  normalizeLiveSettings,
  slotAsset,
  type BackgroundAsset,
  type BackgroundAssetRegistry,
  type BackgroundAssetSlot,
  type BackgroundAssetSlotStatus,
  type BackgroundStyle,
  type IntrinsicSlotStatus,
  type LiveBackgroundSettings,
  type NumericStyleField
} from './background-assets'
import type { LiveBackgroundId } from '../../../shared/live-background-ids'

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

/** A live background's defaults: its first look, Calm, no Dim, the classic stage. */
export function defaultLiveBackgroundSettings(id: LiveBackgroundId): LiveBackgroundSettings {
  return normalizeLiveSettings(id, undefined)
}

export function setLiveBackgroundSettings(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId,
  patch: Partial<LiveBackgroundSettings>
): BackgroundAssetRegistry {
  const settings = normalizeLiveSettings(id, { ...registry.live.settings[id], ...patch })
  return {
    ...registry,
    live: { ...registry.live, settings: { ...registry.live.settings, [id]: settings } }
  }
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
