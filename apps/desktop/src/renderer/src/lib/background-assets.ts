// Background assets domain model (Assets Tab plan, slice A2).
//
// Assets owns reusable background material; Scene owns which one is active. This
// slice ships ten curated placeholder slots only — image import (A4),
// Scene.background wiring (A5), and compositor output (A6) come later. Kept as
// pure data + helpers (no React, no storage) so the registry logic is
// unit-testable in isolation.

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
}

export type BackgroundStyleOverrides = Partial<BackgroundStyle>

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
  // The slot the user explicitly Applied; becomes Scene.background.assetId (A5).
  // Always points at a 'ready' slot or is null — enforced by applySlot and
  // reconcileRegistry so a dangling/empty active can never persist.
  activeSlotId: string | null
}

// The ten initial slots: stable ids the protocol/scene will reference, plus the
// locked creator/use-case labels.
const SLOT_DEFS: readonly { id: string; label: string }[] = [
  { id: 'bg-01', label: 'Code Demo' },
  { id: 'bg-02', label: 'Product Launch' },
  { id: 'bg-03', label: 'Tutorial' },
  { id: 'bg-04', label: 'Livestream' },
  { id: 'bg-05', label: 'Minimal Desk' },
  { id: 'bg-06', label: 'Podcast' },
  { id: 'bg-07', label: 'Webinar' },
  { id: 'bg-08', label: 'Dark Mode' },
  { id: 'bg-09', label: 'Light Mode' },
  { id: 'bg-10', label: 'Focus' }
]

export const BACKGROUND_SLOT_COUNT = SLOT_DEFS.length

export function defaultBackgroundStyle(): BackgroundStyle {
  return {
    fit: 'fill',
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    blurPx: 0,
    dimPercent: 0,
    saturationPercent: 100,
    vignettePercent: 0
  }
}

export function createDefaultBackgroundSlots(): BackgroundAssetSlot[] {
  return SLOT_DEFS.map((def) => ({
    id: def.id,
    defaultLabel: def.label,
    assetId: null,
    status: 'empty'
  }))
}

export function createDefaultRegistry(): BackgroundAssetRegistry {
  return {
    slots: createDefaultBackgroundSlots(),
    assets: {},
    activeSlotId: null
  }
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

// A slot can be applied only when it holds a usable image. Every A2 slot is an
// empty placeholder, so Apply stays disabled until import (A4) marks a slot
// 'ready'.
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
  if (!slot || !canApplySlot(slot)) {
    return registry
  }
  return { ...registry, activeSlotId: slotId }
}

// Recording without a digital background is always valid, so clearing is always
// allowed.
export function clearActiveSlot(registry: BackgroundAssetRegistry): BackgroundAssetRegistry {
  return registry.activeSlotId === null ? registry : { ...registry, activeSlotId: null }
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
  if (slot.assetId && slot.assetId !== asset.id) {
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

// Empty a slot back to a placeholder and drop its asset. Clears the active
// background if this slot was the active one.
export function removeSlotAsset(
  registry: BackgroundAssetRegistry,
  slotId: string
): BackgroundAssetRegistry {
  const slot = registry.slots.find((entry) => entry.id === slotId)
  if (!slot || !slot.assetId) {
    return registry
  }
  const assets = { ...registry.assets }
  delete assets[slot.assetId]
  return {
    ...registry,
    assets,
    activeSlotId: registry.activeSlotId === slotId ? null : registry.activeSlotId,
    slots: registry.slots.map(
      (entry): BackgroundAssetSlot =>
        entry.id === slotId ? { ...entry, assetId: null, status: 'empty' } : entry
    )
  }
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
    vignettePercent: numberOr(data.vignettePercent, base.vignettePercent)
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

  const data = loaded as { slots?: unknown; assets?: unknown; activeSlotId?: unknown }

  const assets: Record<string, BackgroundAsset> = {}
  if (data.assets && typeof data.assets === 'object') {
    for (const [id, raw] of Object.entries(data.assets as Record<string, unknown>)) {
      const asset = normalizeAsset(raw)
      if (asset && asset.id === id) {
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
    const assetId = typeof stored === 'string' && assets[stored] ? stored : null
    return assetId ? { ...slot, assetId, status: 'ready' } : slot
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
    if (referenced.has(id)) {
      prunedAssets[id] = asset
    }
  }

  return { slots, assets: prunedAssets, activeSlotId }
}
