// Arrange the picture (plan 209 S11b, D22): `get_scene_layout`,
// `move_on_scene` and `set_scene_item`, a drag on the Scene canvas done by
// words. Everything that decides where an item lands is the editor's own:
// the places and margins of lib/overlay-layout.ts and lib/banner-place.ts
// (the inspector's snaps are five and seven of the nine places), the drag's
// clamp in components/scene/overlay-stage.ts and the source drag's in
// components/scene/stage-transform.ts, and the freeform entry of
// lib/freeform-memory.ts. Everything that saves is the editor's own save:
// `overlays.layout.set`, `banners.update`, the camera preset's corner, and a
// released source drag in freeform. Pure where it can be: an item, a place
// and a size in, the rects and the one save out.

import {
  bannerFillsCanvas,
  stageRectToOverlay,
  withOverlayRect
} from '@/components/scene/overlay-stage'
import { MIN_SOURCE_FRACTION, roundRectForCommit } from '@/components/scene/stage-transform'
import type {
  Banner,
  CameraCorner,
  CameraShape,
  OverlayItem,
  OverlayItemLayout,
  OverlayOrientation,
  OverlayRect,
  SceneSource
} from '@/lib/backend'
import { OVERLAY_ITEMS, OVERLAY_RECT_MIN_SIZE } from '@/lib/backend'
import {
  bannerDefaultPlaces,
  bannerFitRect,
  bannerSnapRect,
  type BannerPlace
} from '@/lib/banner-place'
import { layoutPresetOrientation } from '@/lib/capture'
import { freeformEntryPatch } from '@/lib/freeform-memory'
import {
  OVERLAY_ITEM_LABELS,
  OVERLAY_PLACES,
  clampOverlayRect,
  overlayDefaultSize,
  overlayPlaceOrigin,
  overlayPlaceRect,
  type OverlayPlace
} from '@/lib/overlay-layout'
import {
  SCENE_VISIBILITY_LOCK_REASON,
  cameraShapePatch,
  sceneCameraControls,
  withOverlaySwitches
} from '@/lib/scene-edits'
import {
  overlayRectBottomGravity,
  overlayRectHorizontalGravity
} from '../../../../shared/banner-geometry'
import type { AgentToolExecutor } from './agent'
import type { SceneArrangeContext, SceneArrangeSnapshot, StudioActionOutcome } from './context'
import { REMOTE_INTENT_COPY } from './copy'

// --- Words --------------------------------------------------------------------

export type ScenePlace = BannerPlace
export type SceneSizeWord = 'small' | 'medium' | 'large'
export type SceneSize = SceneSizeWord | number
export type SceneOrientationChoice = OverlayOrientation | 'both'

/** A rect as agents read and write it: fractions of the canvas, from the top left. */
export interface SceneRect {
  x: number
  y: number
  width: number
  height: number
}

export type SceneRects = Partial<Record<OverlayOrientation, SceneRect>>

export const SCENE_PLACES: readonly ScenePlace[] = [...OVERLAY_PLACES, 'full-frame']

/** What `small` and `large` make of an item's default (`medium`) size. */
export const SCENE_SIZE_FACTOR: Readonly<Record<SceneSizeWord, number>> = {
  small: 0.75,
  medium: 1,
  large: 1.5
}

export const SCENE_LAYOUT_COPY = {
  noItem: "There's no such item on the picture. Call get_scene_layout for the items.",
  noCamera: "There's no camera in this scene. Switch to a scene with the camera first.",
  noScreen: "There's no screen in this scene. Switch to a scene with the screen first.",
  bannerMissing: REMOTE_INTENT_COPY.bannerMissing,
  moveEmpty: 'Say where: place, size, rect or rects.',
  rectOrPlace: 'Give a place and a size, or an exact rect, not both.',
  fullFrameBannersOnly: 'full-frame is for banners. Choose a place on the 3×3 grid.',
  sourceMoveLive:
    'Moving a source waits until the recording or livestream ends, as on the Scene canvas. The camera can go to a corner now.',
  setEmpty: 'Say what to change: shown, shape, showOnStream or showInRecording.',
  sourceSwitches:
    'The camera and the screen show in both the stream and the recording; use shown instead.',
  overlayShown: 'Use showOnStream and showInRecording for this item.',
  bannerShown: 'Use set_banner to show or hide a banner.',
  shapeCameraOnly: 'Only the camera has a shape.',
  shapeNotHere: "The camera's shape works in the Screen + camera scenes and in freeform.",
  windowsNextSession: 'Saved. On this PC it shows from your next recording or stream.',
  captionsNextSession: 'Saved. Captions keep where they show until your next recording or stream.',
  failed: "Couldn't change the picture. Check the Scene page on your computer."
} as const

// --- Items --------------------------------------------------------------------

type ResolvedItem =
  | { kind: 'source'; id: 'camera' | 'screen'; source: SceneSource; name: string }
  | { kind: 'overlay'; id: OverlayItem; item: OverlayItem; name: string }
  | { kind: 'banner'; id: `banner:${string}`; banner: Banner; name: string }

const SCREEN_KINDS: ReadonlySet<SceneSource['kind']> = new Set(['screen', 'window', 'test-pattern'])

function sceneSource(
  snapshot: SceneArrangeSnapshot,
  role: 'camera' | 'screen'
): SceneSource | undefined {
  return snapshot.scene?.sources.find((source) =>
    role === 'camera' ? source.kind === 'camera' : SCREEN_KINDS.has(source.kind)
  )
}

/** An agent's item name to what it stands for on the picture, or why not. */
export function resolveSceneItem(
  snapshot: SceneArrangeSnapshot,
  raw: unknown
): ResolvedItem | { error: string } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === 'camera' || name === 'screen') {
    const source = sceneSource(snapshot, name)
    if (!source) {
      return { error: name === 'camera' ? SCENE_LAYOUT_COPY.noCamera : SCENE_LAYOUT_COPY.noScreen }
    }
    return {
      kind: 'source',
      id: name,
      source,
      name: source.name || (name === 'camera' ? 'Camera' : 'Screen')
    }
  }
  if ((OVERLAY_ITEMS as readonly string[]).includes(name)) {
    const item = name as OverlayItem
    return { kind: 'overlay', id: item, item, name: OVERLAY_ITEM_LABELS[item] }
  }
  if (name.startsWith('banner:')) {
    const banner = snapshot.banners.find((candidate) => candidate.id === name.slice(7))
    if (!banner) return { error: SCENE_LAYOUT_COPY.bannerMissing }
    return { kind: 'banner', id: `banner:${banner.id}`, banner, name: banner.name }
  }
  return { error: SCENE_LAYOUT_COPY.noItem }
}

// --- Rects --------------------------------------------------------------------

export function toSceneRect(rect: OverlayRect): SceneRect {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

function fromSceneRect(rect: SceneRect): OverlayRect {
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}

function sourceRect(source: Pick<SceneSource, 'transform'>): SceneRect {
  const { x, y, width, height } = source.transform
  return { x, y, width, height }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The scene's orientation: sources have one layout for both (overlays.md). */
function sourceOrientation(snapshot: SceneArrangeSnapshot): OverlayOrientation {
  return layoutPresetOrientation(snapshot.layout.layoutPreset)
}

/**
 * A resize with no place keeps the item where it hugs: its left, centre or
 * right by the rect's horizontal gravity, its bottom edge in the lower half,
 * else its top (the gravity a banner's picture already follows).
 */
function anchored(current: OverlayRect, w: number, h: number): OverlayRect {
  const gravity = overlayRectHorizontalGravity(current)
  const x =
    gravity === 'left'
      ? current.x
      : gravity === 'center'
        ? current.x + (current.w - w) / 2
        : current.x + current.w - w
  const y = overlayRectBottomGravity(current) ? current.y + current.h - h : current.y
  return { x, y, w, h }
}

/** A size word's (or fraction's) width and height for an overlay item. */
function overlaySize(
  item: OverlayItem,
  orientation: OverlayOrientation,
  size: SceneSize | undefined,
  current: OverlayRect
): readonly [number, number] {
  const defaults = overlayDefaultSize(item, orientation)
  if (size === undefined) {
    // At its default size the item is the editor's snap, to the last digit.
    const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
    return current.w === round6(defaults[0]) && current.h === round6(defaults[1])
      ? defaults
      : [current.w, current.h]
  }
  // Buddy keeps its default shape, square on the canvas it was drawn for;
  // the card and the caption bar keep the shape they have for a fraction.
  const buddyRatio = defaults[1] / defaults[0]
  if (typeof size === 'number') {
    return fitShape(size, item === 'buddy' ? buddyRatio : current.h / current.w)
  }
  const factor = SCENE_SIZE_FACTOR[size]
  if (size === 'medium') return defaults
  return item === 'buddy'
    ? fitShape(defaults[0] * factor, buddyRatio)
    : clampSize(defaults[0] * factor, defaults[1] * factor)
}

/** Whole and inside the canvas, as `overlayRectValid` says (kept here, in
 * this lazy module, so the eager overlay chunk doesn't grow by it). */
function onCanvas(rect: OverlayRect): boolean {
  return (
    rect.w >= OVERLAY_RECT_MIN_SIZE &&
    rect.h >= OVERLAY_RECT_MIN_SIZE &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= 1 + 1e-6 &&
    rect.y + rect.h <= 1 + 1e-6
  )
}

function clampSize(w: number, h: number, min = 0.02): readonly [number, number] {
  return [clamp(w, min, 1), clamp(h, min, 1)]
}

/**
 * A `w` wide item of shape `ratio` (h / w, canvas units), as wide as asked
 * but never so wide that its height leaves the canvas, nor so narrow that a
 * side drops under the drag's 0.02: it keeps its shape (Buddy stays square)
 * instead of being squashed by a clamp on one side.
 */
function fitShape(w: number, ratio: number, min = 0.02): readonly [number, number] {
  const shape = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const width = clamp(w, Math.max(min, min / shape), Math.min(1, 1 / shape))
  return [width, width * shape]
}

/**
 * Where an overlay item lands for a place, a size or both, on one
 * orientation. A place keeps the size it has (or takes the one asked for)
 * and sits at the editor's margins: at its default size it is exactly the
 * inspector's snap (`overlaySnapRect`) for the places the inspector has.
 */
export function overlayPlacement(
  item: OverlayItem,
  orientation: OverlayOrientation,
  current: OverlayRect,
  place: OverlayPlace | undefined,
  size: SceneSize | undefined
): OverlayRect {
  const dimensions = overlaySize(item, orientation, size, current)
  if (place) {
    // A large item at a side place would cross the far edge (captions large
    // at bottom left): it slides in as a drag's clamp moves it. Every place
    // at an item's default size is already inside, so the inspector's snaps
    // stay exactly what they were.
    const placed = overlayPlaceRect(place, orientation, dimensions)
    return onCanvas(placed) ? placed : clampOverlayRect(placed)
  }
  return clampOverlayRect(anchored(current, dimensions[0], dimensions[1]))
}

/** A banner's rect for a size, keeping its image's shape on this canvas. */
function bannerSized(
  banner: Banner,
  orientation: OverlayOrientation,
  canvasAspect: number,
  size: SceneSize
): OverlayRect {
  const current = bannerFitRect(banner, banner[orientation], canvasAspect, orientation)
  const defaults = bannerFitRect(
    banner,
    bannerDefaultPlaces(banner)[orientation],
    canvasAspect,
    orientation
  )
  const imageAspect = Math.max(1, banner.width) / Math.max(1, banner.height)
  const asked = typeof size === 'number' ? size : defaults.w * SCENE_SIZE_FACTOR[size]
  // As wide as asked, but never wider or taller than the canvas.
  const w = Math.min(asked, 1, imageAspect / canvasAspect)
  return { ...current, w, h: (w * canvasAspect) / imageAspect }
}

/**
 * Where a banner lands, on one orientation: the inspector's snap
 * (`bannerSnapRect`, which keeps the size its image has) for a place, with
 * the size asked for first. A banner always keeps its image's shape.
 */
export function bannerPlacement(
  banner: Banner,
  orientation: OverlayOrientation,
  canvasAspect: number,
  place: BannerPlace | undefined,
  size: SceneSize | undefined
): OverlayRect {
  const rect =
    size === undefined ? banner[orientation] : bannerSized(banner, orientation, canvasAspect, size)
  if (place) return bannerSnapRect(banner, rect, orientation, canvasAspect, place)
  const current = bannerFitRect(banner, banner[orientation], canvasAspect, orientation)
  return clampOverlayRect(anchored(current, rect.w, rect.h))
}

/** A source rect inside the canvas, no smaller than a resize may leave it,
 * rounded as a released drag commits it. */
function clampSourceRect(rect: SceneRect): SceneRect {
  const width = clamp(rect.width, MIN_SOURCE_FRACTION, 1)
  const height = clamp(rect.height, MIN_SOURCE_FRACTION, 1)
  return roundRectForCommit({
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
    width,
    height
  })
}

/** Where a source lands in freeform for a place, a size or an exact rect. */
export function sourcePlacement(
  source: Pick<SceneSource, 'transform' | 'defaultTransform'>,
  orientation: OverlayOrientation,
  place: OverlayPlace | undefined,
  size: SceneSize | undefined,
  rect: SceneRect | undefined
): SceneRect {
  if (rect) return clampSourceRect(rect)
  const current = sourceRect(source)
  let width = current.width
  let height = current.height
  if (size !== undefined) {
    if (typeof size === 'number') {
      height = size * (current.height / Math.max(current.width, 1e-6))
      width = size
    } else {
      width = source.defaultTransform.width * SCENE_SIZE_FACTOR[size]
      height = source.defaultTransform.height * SCENE_SIZE_FACTOR[size]
    }
  }
  if (place) {
    const { x, y } = overlayPlaceOrigin(place, orientation, width, height)
    return clampSourceRect({ x, y, width, height })
  }
  const next = anchored(fromSceneRect(current), width, height)
  return clampSourceRect(toSceneRect(next))
}

const CAMERA_CORNERS: ReadonlySet<string> = new Set([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
])

// --- What a call saved --------------------------------------------------------
//
// A re-read right after a save is stale: the Studio's overlay and banner refs
// update on the next render, and a preset transaction answers before its
// scene is applied. So a move's rects and overlaps come from what the call
// itself saved, laid over the snapshot it started from.

/** The scene with these sources' rects replaced. */
function withSourceRects(
  snapshot: SceneArrangeSnapshot,
  rects: Readonly<Record<string, SceneRect>>
): SceneArrangeSnapshot {
  if (!snapshot.scene) return snapshot
  return {
    ...snapshot,
    scene: {
      ...snapshot.scene,
      sources: snapshot.scene.sources.map((entry) => {
        const rect = Object.hasOwn(rects, entry.id) ? rects[entry.id] : undefined
        return rect ? { ...entry, transform: { ...entry.transform, ...rect } } : entry
      })
    }
  }
}

/** Float noise off a rect edge computed from two others. */
function round9(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000
}

/**
 * Where the preset puts the camera at `corner`: the same box (a corner never
 * changes the preset's size), at the same margins, on the other side where
 * the corner flips. Null when the camera has a custom size, which the
 * corner's transaction resets to a preset size this module doesn't know.
 */
function presetCornerRect(
  snapshot: SceneArrangeSnapshot,
  camera: SceneRect,
  corner: CameraCorner
): SceneRect | null {
  if (snapshot.layout.cameraTransformMode === 'custom') return null
  const from = snapshot.layout.cameraCorner
  const side = (same: boolean, at: number, size: number): number =>
    same ? at : Math.max(0, round9(1 - size - at))
  return {
    x: side(from.endsWith('-left') === corner.endsWith('-left'), camera.x, camera.width),
    y: side(from.startsWith('top-') === corner.startsWith('top-'), camera.y, camera.height),
    width: camera.width,
    height: camera.height
  }
}

// --- Overlaps -----------------------------------------------------------------

interface PlacedItem {
  id: string
  name: string
  orientation: OverlayOrientation
  rect: OverlayRect
}

/**
 * Every item's rects, per orientation, as rects that cover: a source's
 * place, an overlay's zone, a banner's picture (`bannerFitRect`). With
 * `drawnOnly`, only what an output draws now: a visible source, an overlay
 * an output shows, a banner that is showing.
 */
function placedItems(snapshot: SceneArrangeSnapshot, drawnOnly: boolean): PlacedItem[] {
  const placed: PlacedItem[] = []
  const orientation = sourceOrientation(snapshot)
  for (const role of ['camera', 'screen'] as const) {
    const source = sceneSource(snapshot, role)
    if (source && (source.visible || !drawnOnly)) {
      placed.push({
        id: role,
        name: source.name || role,
        orientation,
        rect: fromSceneRect(sourceRect(source))
      })
    }
  }
  for (const item of OVERLAY_ITEMS) {
    const layout = snapshot.overlayLayout[item]
    if (drawnOnly && !layout.showOnStream && !layout.showInRecording) continue
    for (const side of ['horizontal', 'vertical'] as const) {
      placed.push({
        id: item,
        name: OVERLAY_ITEM_LABELS[item],
        orientation: side,
        rect: layout[side]
      })
    }
  }
  for (const banner of snapshot.banners) {
    if (drawnOnly && !banner.shown) continue
    for (const side of ['horizontal', 'vertical'] as const) {
      placed.push({
        id: `banner:${banner.id}`,
        name: banner.name,
        orientation: side,
        rect: bannerFitRect(banner, banner[side], snapshot.canvasAspect[side], side)
      })
    }
  }
  return placed
}

function intersects(a: OverlayRect, b: OverlayRect): boolean {
  const epsilon = 1e-6
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > epsilon &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > epsilon
  )
}

/**
 * The items `id` overlaps in this snapshot ("Now covers:
 * Sponsor banner"). Something that fills the canvas (the screen, a frame
 * banner) is a frame around the picture, never news. Buddy, the highlight
 * card and the captions count only while an output shows them, a banner
 * only while it is showing.
 */
export function sceneOverlaps(
  snapshot: SceneArrangeSnapshot,
  id: string
): { item: string; name: string }[] {
  // Only canvases an output draws: the program's, and the vertical stream's
  // while one is armed.
  const drawn = new Set<OverlayOrientation>([snapshot.orientation])
  if (snapshot.verticalStream) drawn.add('vertical')
  const placed = placedItems(snapshot, true).filter((entry) => drawn.has(entry.orientation))
  // The item asked about counts wherever it is, whatever its switches say.
  const mine = placedItems(snapshot, false).filter(
    (entry) => entry.id === id && drawn.has(entry.orientation)
  )
  const found = new Map<string, string>()
  for (const entry of placed) {
    if (entry.id === id || found.has(entry.id)) continue
    if (bannerFillsCanvas({ x: 0, y: 0, width: entry.rect.w, height: entry.rect.h })) continue
    if (
      mine.some((own) => own.orientation === entry.orientation && intersects(own.rect, entry.rect))
    ) {
      found.set(entry.id, entry.name)
    }
  }
  return [...found].map(([item, name]) => ({ item, name }))
}

// --- Reading ------------------------------------------------------------------

export interface SceneItemView {
  item: string
  name: string
  kind: 'camera' | 'screen' | 'overlay' | 'banner'
  rects: SceneRects
  shown?: boolean
  showOnStream?: boolean
  showInRecording?: boolean
  corner?: CameraCorner
  shape?: CameraShape
}

function overlayView(item: OverlayItem, layout: OverlayItemLayout): SceneItemView {
  return {
    item,
    name: OVERLAY_ITEM_LABELS[item],
    kind: 'overlay',
    rects: { horizontal: toSceneRect(layout.horizontal), vertical: toSceneRect(layout.vertical) },
    showOnStream: layout.showOnStream,
    showInRecording: layout.showInRecording
  }
}

/** `get_scene_layout`'s answer: every item, where it sits, and its switches. */
export function sceneLayoutView(snapshot: SceneArrangeSnapshot): {
  orientation: OverlayOrientation
  verticalStream: boolean
  layoutId: string
  arrangement: 'preset' | 'freeform'
  items: SceneItemView[]
} {
  const items: SceneItemView[] = []
  const orientation = sourceOrientation(snapshot)
  const controls = sceneCameraControls(snapshot.layout)
  for (const role of ['camera', 'screen'] as const) {
    const source = sceneSource(snapshot, role)
    if (!source) continue
    items.push({
      item: role,
      name: source.name || role,
      kind: role,
      rects: { [orientation]: sourceRect(source) },
      shown: source.visible,
      ...(role === 'camera' && controls.corner && snapshot.layout.cameraTransformMode !== 'custom'
        ? { corner: snapshot.layout.cameraCorner }
        : {}),
      ...(role === 'camera' && controls.bubble ? { shape: snapshot.layout.cameraShape } : {})
    })
  }
  for (const item of OVERLAY_ITEMS) items.push(overlayView(item, snapshot.overlayLayout[item]))
  for (const banner of snapshot.banners) {
    items.push({
      item: `banner:${banner.id}`,
      name: banner.name,
      kind: 'banner',
      rects: { horizontal: toSceneRect(banner.horizontal), vertical: toSceneRect(banner.vertical) },
      shown: banner.shown,
      showOnStream: banner.showOnStream,
      showInRecording: banner.showInRecording
    })
  }
  return {
    orientation: snapshot.orientation,
    verticalStream: snapshot.verticalStream,
    layoutId: snapshot.layout.layoutPreset,
    arrangement: snapshot.layout.arrangementMode === 'freeform' ? 'freeform' : 'preset',
    items
  }
}

// --- Arguments ----------------------------------------------------------------

function isPlace(value: unknown): value is ScenePlace {
  return typeof value === 'string' && (SCENE_PLACES as readonly string[]).includes(value)
}

function sizeArgument(value: unknown): SceneSize | undefined {
  if (value === 'small' || value === 'medium' || value === 'large') return value
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0.02, 1)
  return undefined
}

function rectArgument(value: unknown): SceneRect | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const rect = value as Record<string, unknown>
  const fields = [rect.x, rect.y, rect.width, rect.height]
  if (!fields.every((field) => typeof field === 'number' && Number.isFinite(field)))
    return undefined
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number
  }
}

function placeLabel(place: ScenePlace): string {
  return place === 'full-frame' ? 'the full frame' : `the ${place.replace('-', ' ')}`
}

function coverSentence(overlaps: readonly { name: string }[]): string {
  return overlaps.length ? ` Now covers: ${overlaps.map((entry) => entry.name).join(', ')}.` : ''
}

// --- The tools ----------------------------------------------------------------

function arrangeOf(context: { arrange?: SceneArrangeContext }): SceneArrangeContext | null {
  return context.arrange ?? null
}

/** `get_scene_layout`: what is on the picture and where (read only). */
export const getSceneLayout: AgentToolExecutor = async (context) => {
  const arrange = arrangeOf(context)
  if (!arrange) return { ok: false, message: REMOTE_INTENT_COPY.unsupported }
  const view = sceneLayoutView(arrange.read())
  const names = view.items.map((item) => item.name)
  return {
    ok: true,
    message: `${view.items.length} items on the picture: ${names.join(', ')}.`,
    result: view
  }
}

type MoveResult = {
  item: string
  name: string
  rects: SceneRects
  previous: SceneRects
  overlaps: { item: string; name: string }[]
  arrangement?: 'preset' | 'freeform'
  corner?: CameraCorner
}

function moved(
  result: MoveResult,
  sentence: string,
  note: string | null
): { ok: true; message: string; result: MoveResult } {
  return {
    ok: true,
    message: `${note ?? sentence}${coverSentence(result.overlaps)}`,
    result
  }
}

/**
 * `move_on_scene`: one item to a place on the 3×3 grid (or the full frame
 * for a banner), a size, an exact rect, or `rects` per orientation (what
 * `previous` returns, so "put it back" is one call). A place writes both
 * orientations unless one is named; a rect writes the one named, or
 * horizontal. The camera at a corner of an inset scene keeps the scene;
 * any other source move enters freeform first, as the canvas's "Make
 * freeform" does, and is the canvas's released drag.
 */
export const moveOnScene: AgentToolExecutor = async (context, args) => {
  const arrange = arrangeOf(context)
  if (!arrange) return { ok: false, message: REMOTE_INTENT_COPY.unsupported }
  const snapshot = arrange.read()
  if (snapshot.blockedReason) return { ok: false, message: snapshot.blockedReason }
  const target = resolveSceneItem(snapshot, args.item)
  if ('error' in target) return { ok: false, message: target.error }
  const place = isPlace(args.place) ? args.place : undefined
  const size = sizeArgument(args.size)
  const rect = rectArgument(args.rect)
  const rectsArg =
    args.rects && typeof args.rects === 'object' ? (args.rects as Record<string, unknown>) : null
  const exact: SceneRects = {}
  if (rectsArg) {
    for (const side of ['horizontal', 'vertical'] as const) {
      const value = rectArgument(rectsArg[side])
      if (value) exact[side] = value
    }
  }
  const exactSides = Object.keys(exact) as OverlayOrientation[]
  if (!place && size === undefined && !rect && exactSides.length === 0) {
    return { ok: false, message: SCENE_LAYOUT_COPY.moveEmpty }
  }
  if ((rect || exactSides.length) && (place || size !== undefined)) {
    return { ok: false, message: SCENE_LAYOUT_COPY.rectOrPlace }
  }
  if (place === 'full-frame' && target.kind !== 'banner') {
    return { ok: false, message: SCENE_LAYOUT_COPY.fullFrameBannersOnly }
  }
  const choice = args.orientation
  const sides: OverlayOrientation[] = exactSides.length
    ? exactSides
    : choice === 'horizontal' || choice === 'vertical'
      ? [choice]
      : choice === 'both' || !rect
        ? ['horizontal', 'vertical']
        : ['horizontal']
  const note =
    snapshot.sessionActive && snapshot.startTimeOverlays && target.kind !== 'source'
      ? SCENE_LAYOUT_COPY.windowsNextSession
      : null
  const what = place ? `Moved ${target.name} to ${placeLabel(place)}.` : `Placed ${target.name}.`

  if (target.kind === 'overlay') {
    const previous: SceneRects = {}
    const rects: SceneRects = {}
    let layout = snapshot.overlayLayout
    for (const side of sides) {
      const current = layout[target.item][side]
      const exactRect = exact[side] ?? rect
      const next = exactRect
        ? stageRectToOverlay(exactRect)
        : overlayPlacement(
            target.item,
            side,
            current,
            place === 'full-frame' ? undefined : place,
            size
          )
      previous[side] = toSceneRect(current)
      rects[side] = toSceneRect(next)
      layout = withOverlayRect(layout, target.item, side, next)
    }
    try {
      await arrange.setOverlayLayout(layout)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : SCENE_LAYOUT_COPY.failed
      }
    }
    // The layout just saved, not a re-read (the ref updates on the next render).
    const overlaps = sceneOverlaps({ ...snapshot, overlayLayout: layout }, target.id)
    return moved({ item: target.id, name: target.name, rects, previous, overlaps }, what, note)
  }

  if (target.kind === 'banner') {
    const previous: SceneRects = {}
    const rects: SceneRects = {}
    const patch: Partial<Record<OverlayOrientation, OverlayRect>> = {}
    for (const side of sides) {
      const exactRect = exact[side] ?? rect
      const next = exactRect
        ? stageRectToOverlay(exactRect)
        : bannerPlacement(target.banner, side, snapshot.canvasAspect[side], place, size)
      previous[side] = toSceneRect(target.banner[side])
      rects[side] = toSceneRect(next)
      patch[side] = next
    }
    if (!(await arrange.updateBanner(target.banner.id, patch))) {
      return { ok: false, message: SCENE_LAYOUT_COPY.failed }
    }
    // The banner as just saved, not a re-read (the list updates on the next render).
    const saved: SceneArrangeSnapshot = {
      ...snapshot,
      banners: snapshot.banners.map((entry) =>
        entry.id === target.banner.id ? { ...entry, ...patch } : entry
      )
    }
    const overlaps = sceneOverlaps(saved, target.id)
    return moved({ item: target.id, name: target.name, rects, previous, overlaps }, what, note)
  }

  // A source: one layout for both orientations, the scene's.
  const orientation = sourceOrientation(snapshot)
  const previous: SceneRects = { [orientation]: sourceRect(target.source) }
  const controls = sceneCameraControls(snapshot.layout)
  if (
    target.id === 'camera' &&
    controls.corner &&
    place &&
    CAMERA_CORNERS.has(place) &&
    size === undefined &&
    !rect &&
    exactSides.length === 0
  ) {
    // The inspector's Corner: the scene stays its preset (D22).
    const corner = place as CameraCorner
    if (!(await arrange.applyCameraPreset({ cameraCorner: corner }))) {
      return { ok: false, message: SCENE_LAYOUT_COPY.failed }
    }
    // The transaction answers before its scene is applied: the camera's box
    // comes from the corner just saved. Only a custom-sized camera (reset to
    // a preset size here) reads back what the Studio has.
    const cornered = presetCornerRect(snapshot, sourceRect(target.source), corner)
    const after = cornered
      ? withSourceRects(snapshot, { [target.source.id]: cornered })
      : arrange.read()
    const camera = sceneSource(after, 'camera')
    const result: MoveResult = {
      item: 'camera',
      name: target.name,
      rects: camera ? { [orientation]: sourceRect(camera) } : {},
      previous,
      overlaps: sceneOverlaps(after, 'camera'),
      arrangement: 'preset',
      corner
    }
    return moved(result, `Moved ${target.name} to ${placeLabel(place)}.`, null)
  }
  // Off a corner the canvas drags, and it drags nothing while recording or live.
  if (snapshot.sessionActive) return { ok: false, message: SCENE_LAYOUT_COPY.sourceMoveLive }
  let current = snapshot
  if (!controls.freeform) {
    // "Make freeform": the arrangement a preset last replaced, or where the
    // scene draws every source now, so nothing else moves.
    if (!snapshot.scene) return { ok: false, message: SCENE_LAYOUT_COPY.failed }
    const entry = freeformEntryPatch(orientation, snapshot.scene.sources)
    const entered = await arrange.applyCameraPreset(entry)
    if (!entered) return { ok: false, message: SCENE_LAYOUT_COPY.failed }
    // Where the entry draws every source: its own overrides (the scene a
    // re-read gives isn't applied yet).
    current = withSourceRects(snapshot, entry.sourceTransformOverrides)
  }
  const source = current.scene?.sources.find((candidate) => candidate.id === target.source.id)
  if (!source) return { ok: false, message: SCENE_LAYOUT_COPY.failed }
  const exactRect =
    exact[orientation] ?? rect ?? (exactSides.length ? Object.values(exact)[0] : undefined)
  const next = sourcePlacement(
    source,
    orientation,
    place === 'full-frame' ? undefined : place,
    size,
    exactRect
  )
  if (!(await arrange.setSourceTransform(source.id, next))) {
    return { ok: false, message: SCENE_LAYOUT_COPY.failed }
  }
  // The rect just committed (a released drag commits it unsnapped).
  const result: MoveResult = {
    item: target.id,
    name: target.name,
    rects: { [orientation]: next },
    previous,
    overlaps: sceneOverlaps(withSourceRects(current, { [source.id]: next }), target.id),
    arrangement: 'freeform'
  }
  return moved(result, what, null)
}

/**
 * `set_scene_item`: an item's switches and look. The camera and the screen
 * are shown or hidden (the inspector's Visible, locked while recording or
 * live); the camera has a shape where the inspector offers one; Buddy, the
 * highlight card, the captions and every banner have "Show on stream" and
 * "Show in recording".
 */
export const setSceneItem: AgentToolExecutor = async (context, args) => {
  const arrange = arrangeOf(context)
  if (!arrange) return { ok: false, message: REMOTE_INTENT_COPY.unsupported }
  const snapshot = arrange.read()
  if (snapshot.blockedReason) return { ok: false, message: snapshot.blockedReason }
  const target = resolveSceneItem(snapshot, args.item)
  if ('error' in target) return { ok: false, message: target.error }
  const shown = typeof args.shown === 'boolean' ? args.shown : undefined
  const shape =
    args.shape === 'rectangle' || args.shape === 'rounded' || args.shape === 'circle'
      ? (args.shape as CameraShape)
      : undefined
  const showOnStream = typeof args.showOnStream === 'boolean' ? args.showOnStream : undefined
  const showInRecording =
    typeof args.showInRecording === 'boolean' ? args.showInRecording : undefined
  const switches = {
    ...(showOnStream !== undefined ? { showOnStream } : {}),
    ...(showInRecording !== undefined ? { showInRecording } : {})
  }
  const hasSwitches = Object.keys(switches).length > 0
  if (shown === undefined && !shape && !hasSwitches) {
    return { ok: false, message: SCENE_LAYOUT_COPY.setEmpty }
  }
  if (shape && target.id !== 'camera')
    return { ok: false, message: SCENE_LAYOUT_COPY.shapeCameraOnly }

  if (target.kind === 'source') {
    if (hasSwitches) return { ok: false, message: SCENE_LAYOUT_COPY.sourceSwitches }
    const said: string[] = []
    const result: Record<string, unknown> = { item: target.id, name: target.name }
    if (shape) {
      if (!sceneCameraControls(snapshot.layout).bubble) {
        return { ok: false, message: SCENE_LAYOUT_COPY.shapeNotHere }
      }
      if (!(await arrange.applyLayoutPatch(cameraShapePatch(shape)))) {
        return { ok: false, message: SCENE_LAYOUT_COPY.failed }
      }
      result.shape = shape
      said.push(`The camera is a ${shape === 'rounded' ? 'rounded square' : shape}.`)
    }
    if (shown !== undefined) {
      if (snapshot.sessionActive) {
        return { ok: false, message: [...said, SCENE_VISIBILITY_LOCK_REASON].join(' ') }
      }
      if (!(await arrange.setSourceVisible(target.source.id, shown))) {
        return { ok: false, message: [...said, SCENE_LAYOUT_COPY.failed].join(' ') }
      }
      result.shown = shown
      said.push(shown ? `${target.name} is shown.` : `${target.name} is hidden.`)
    }
    return { ok: true, message: said.join(' '), result }
  }

  if (shown !== undefined) {
    return {
      ok: false,
      message:
        target.kind === 'banner' ? SCENE_LAYOUT_COPY.bannerShown : SCENE_LAYOUT_COPY.overlayShown
    }
  }
  const note =
    snapshot.sessionActive && snapshot.startTimeOverlays
      ? SCENE_LAYOUT_COPY.windowsNextSession
      : snapshot.sessionActive && target.id === 'captions'
        ? SCENE_LAYOUT_COPY.captionsNextSession
        : null
  const outcome: StudioActionOutcome =
    target.kind === 'overlay'
      ? await arrange
          .setOverlayLayout(withOverlaySwitches(snapshot.overlayLayout, target.item, switches))
          .then(
            () => ({ ok: true }),
            (error: unknown) => ({
              ok: false,
              message: error instanceof Error ? error.message : SCENE_LAYOUT_COPY.failed
            })
          )
      : (await arrange.updateBanner(target.banner.id, switches))
        ? { ok: true }
        : { ok: false, message: SCENE_LAYOUT_COPY.failed }
  if (!outcome.ok) return outcome
  const said = [
    showOnStream === undefined
      ? ''
      : showOnStream
        ? `${target.name} shows on stream.`
        : `${target.name} stays off the stream.`,
    showInRecording === undefined
      ? ''
      : showInRecording
        ? `${target.name} shows in the recording.`
        : `${target.name} stays out of the recording.`
  ].filter(Boolean)
  return {
    ok: true,
    message: note ?? said.join(' '),
    result: { item: target.id, name: target.name, ...switches }
  }
}
