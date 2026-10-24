// Background assets domain model (Assets Tab plan, slice A2): the core the
// eager bundle needs (load, reconcile, the scene's effective background and
// the commit sync). The Assets page's editing helpers live in
// `background-library.ts`, which only lazy chunks import (plan 190: every
// export of a module in the eager chunk ships eagerly).
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
  livePosterAssetId,
  parseLivePosterAssetId,
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

/** A live background's stored choices, or its defaults. */
export function liveBackgroundSettings(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId
): LiveBackgroundSettings {
  return normalizeLiveSettings(id, registry.live.settings[id])
}

/** Put a live background on the scene; the picture slot leaves it. */
export function applyLiveBackground(
  registry: BackgroundAssetRegistry,
  id: LiveBackgroundId
): BackgroundAssetRegistry {
  return { ...registry, activeSlotId: null, live: { ...registry.live, activeId: id } }
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

export function builtinAssetForSlot(slotId: string): BackgroundAsset | null {
  const def = SLOT_DEFS.find((entry) => entry.id === slotId)
  return def ? createBuiltinAsset(def) : null
}

export function slotAsset(
  slot: BackgroundAssetSlot,
  registry: BackgroundAssetRegistry
): BackgroundAsset | null {
  return slot.assetId ? (registry.assets[slot.assetId] ?? null) : null
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

export function normalizeLiveSettings(id: LiveBackgroundId, raw: unknown): LiveBackgroundSettings {
  const data = (raw ?? {}) as Partial<LiveBackgroundSettings>
  const clamp = (value: unknown, max: number, fallback: number): number =>
    Math.min(max, Math.max(0, numberOr(value, fallback)))
  return {
    // A look is any well-formed id; the backend draws the first look for one
    // this build doesn't know.
    look:
      typeof data.look === 'string' && parseLivePosterAssetId(livePosterAssetId(id, data.look))
        ? data.look
        : LIVE_BACKGROUND_DEFAULT_LOOKS[id],
    motion: data.motion === 'normal' ? 'normal' : 'calm',
    dimPercent: clamp(data.dimPercent, 80, 0),
    visibilityPercent: clamp(data.visibilityPercent, 40, 20)
  }
}

function normalizeLiveState(raw: unknown): LiveBackgroundState {
  const data = (raw ?? {}) as Partial<LiveBackgroundState>
  const settings: LiveBackgroundState['settings'] = {}
  for (const id of LIVE_BACKGROUND_IDS) {
    if (data.settings?.[id]) settings[id] = normalizeLiveSettings(id, data.settings[id])
  }
  return { activeId: isLiveBackgroundId(data.activeId) ? data.activeId : null, settings }
}

/** The scene background for a live background with its choices: its poster plus the shader. */
export function liveSceneBackground(
  id: LiveBackgroundId,
  settings: LiveBackgroundSettings
): EffectiveSceneBackground {
  const assetId = livePosterAssetId(id, settings.look)
  return {
    ...defaultBackgroundStyle(),
    assetId,
    managedAssetPath: `videorc-asset://background/${assetId}.webp`,
    dimPercent: settings.dimPercent,
    visibilityPercent: settings.visibilityPercent,
    live: { id, look: settings.look, motion: settings.motion }
  }
}

/**
 * The registry after the backend committed a live `background` (the
 * transaction's truth): that live background becomes active, the picture slot
 * leaves, and its committed choices are remembered. The same registry when
 * nothing changes.
 */
export function registryForCommittedLiveBackground(
  registry: BackgroundAssetRegistry,
  background: EffectiveSceneBackground
): BackgroundAssetRegistry {
  const { live } = background
  if (!live || !isLiveBackgroundId(live.id)) return registry
  const settings = normalizeLiveSettings(live.id, { ...live, ...background })
  const next = {
    ...registry,
    activeSlotId: null,
    live: { activeId: live.id, settings: { ...registry.live.settings, [live.id]: settings } }
  }
  return registry.activeSlotId === null &&
    JSON.stringify(next.live) === JSON.stringify(registry.live)
    ? registry
    : next
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
  if (!registry.activeSlotId) {
    const id = registry.live.activeId
    return id ? liveSceneBackground(id, liveBackgroundSettings(registry, id)) : null
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
