import type { LayoutSettings, SceneSourceKind, SourceCrop } from './backend'

/**
 * Where a scene source's PICTURE lands (plan 216 B1, owner decision D2).
 *
 * A source's transform is its FRAME: a box in canvas fractions. The
 * compositor fits the source's picture into that frame (Fit letterboxes it,
 * Fill crops it), after mapping a screen's frame onto the scene background's
 * stage margin. The camera of a camera-only scene sits on that stage too
 * (plan 235, owner decision D9 a; `sceneCameraOnStage`). Until plan 216 nothing on the renderer side knew the picture:
 * the Scene stage drew its box, handles and hit target on the frame, so a
 * MacBook display (1.547:1) Fit in a 16:9 frame had about 150 px of empty
 * space inside the handles on each side. This module is the one rule for the
 * picture rect, mirrored by Rust `scene_geometry::scene_picture_rect_pixels`
 * (the compositor's own fit shares its arithmetic) and pinned to it by
 * `protocol-fixtures/scene-picture-geometry.json`.
 *
 * Everything here is pure and canvas-relative; nothing reads the DOM or the
 * scene store.
 */

export type PictureFit = 'contain' | 'cover'

export interface PixelSize {
  width: number
  height: number
}

/** A box in canvas fractions (0..1 of the canvas, signed and uncut). */
export interface FractionRect {
  x: number
  y: number
  width: number
  height: number
}

/** A box in canvas pixels: integers, signed (plan 215 E1: it may start off the canvas). */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScenePictureInput {
  /** The source's stored frame (its transform's box). */
  frame: FractionRect
  kind: SceneSourceKind
  /** How the compositor fits the picture into the frame (`previewProofLayerFit`). */
  fit: PictureFit
  /** The source's picture size in pixels, or null while it is unknown. */
  source: PixelSize | null | undefined
  /** The screen's crop, as fractions of its own picture (plan 213 G2). */
  crop?: Partial<SourceCrop> | null
  /** The scene background's stage margin per side (`previewProofBackgroundStageMargin`). */
  stageMargin?: number
  /** Whether the scene's camera sits on the stage (`sceneCameraOnStage`). */
  cameraOnStage?: boolean
  /** The output canvas in pixels: the fit rounds to pixels, as the compositor does. */
  canvas: PixelSize
}

/** Mirrors Rust `scene_geometry` bounds (plan 215 E3). */
const MIN_POSITION = -3
const MAX_POSITION = 4
const MAX_SIZE = 4

const finiteOrZero = (value: number): number => (Number.isFinite(value) ? value : 0)
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

/**
 * The one rule for which sources sit on the scene background's stage
 * (mirrors Rust `scene_source_uses_background_stage`; plan 235, D9 a): a
 * screen, a window and the test pattern always do, the camera only when the
 * scene says so (`sceneCameraOnStage`).
 */
export function sceneSourceUsesBackgroundStage(
  kind: SceneSourceKind,
  cameraOnStage = false
): boolean {
  return kind === 'camera' ? cameraOnStage : true
}

/** The facts the camera's stage rule reads from a scene. */
export interface SceneCameraStageFacts {
  /** Every source's kind, hidden ones too: hiding a screen must not move the camera. */
  sourceKinds: readonly SceneSourceKind[]
  /** Key out background is on (`layout.cameraChromaKeyEnabled`). */
  cameraKeyed?: boolean
  /** The scene is Freeform: its boxes are the streamer's own. */
  freeform?: boolean
}

/**
 * Whether a scene's camera sits on the background's stage (mirrors Rust
 * `camera_uses_background_stage`; plan 235, D9 a): the scene is camera-only,
 * on either canvas, and the camera is not keyed. A keyed camera stays full
 * frame over the background, a camera over or beside a screen keeps its
 * place, and a Freeform scene is left alone.
 */
export function sceneCameraUsesBackgroundStage(facts: SceneCameraStageFacts): boolean {
  if (facts.freeform || facts.cameraKeyed) return false
  return (
    facts.sourceKinds.includes('camera') && facts.sourceKinds.every((kind) => kind === 'camera')
  )
}

/** `sceneCameraUsesBackgroundStage` for a scene's sources under its layout. */
export function sceneCameraOnStage(
  sources: readonly { kind: SceneSourceKind }[] | null | undefined,
  layout: Pick<LayoutSettings, 'arrangementMode' | 'cameraChromaKeyEnabled'> | null | undefined
): boolean {
  if (!sources || !layout) return false
  return sceneCameraUsesBackgroundStage({
    sourceKinds: sources.map((source) => source.kind),
    cameraKeyed: layout.cameraChromaKeyEnabled,
    freeform: layout.arrangementMode === 'freeform'
  })
}

const SCENE_SOURCE_KINDS: readonly string[] = ['screen', 'window', 'camera', 'test-pattern']

/**
 * The scene's own sources among a list that also carries the compositor's
 * stand-ins (the background image, a takeover image): what the camera's
 * stage rule counts, as Rust counts `scene.sources`.
 */
export function previewSurfaceSceneSources<T extends { kind: string }>(
  sources: readonly T[]
): (T & { kind: SceneSourceKind })[] {
  return sources.filter((source): source is T & { kind: SceneSourceKind } =>
    SCENE_SOURCE_KINDS.includes(source.kind)
  )
}

/**
 * The stage rule for a preview surface layer: a scene source asks
 * `sceneSourceUsesBackgroundStage`; the takeover image stands in for a
 * screen; the background, banners and the Buddy are placed against the canvas.
 */
export function previewSurfaceLayerUsesBackgroundStage(
  kind: SceneSourceKind | 'screen-image' | 'background' | 'banner' | 'buddy',
  cameraOnStage: boolean
): boolean {
  if (kind === 'screen-image') return true
  if (kind === 'background' || kind === 'banner' || kind === 'buddy') return false
  return sceneSourceUsesBackgroundStage(kind, cameraOnStage)
}

/**
 * A frame mapped onto the scene background's stage (Rust
 * `scene_source_render_transform`): where the compositor really draws the
 * box, in canvas fractions. No margin, or a source that is not on the stage,
 * leaves the frame alone.
 */
export function sceneStageRect(
  frame: FractionRect,
  kind: SceneSourceKind,
  stageMargin = 0,
  cameraOnStage = false
): FractionRect {
  if (!(stageMargin > 0) || !sceneSourceUsesBackgroundStage(kind, cameraOnStage))
    return { ...frame }
  const scale = 1 - stageMargin * 2
  return {
    x: stageMargin + frame.x * scale,
    y: stageMargin + frame.y * scale,
    width: frame.width * scale,
    height: frame.height * scale
  }
}

/** The inverse of `sceneStageRect`: the frame a box on the stage is stored as. */
export function sceneFrameRect(
  stageRect: FractionRect,
  kind: SceneSourceKind,
  stageMargin = 0,
  cameraOnStage = false
): FractionRect {
  if (!(stageMargin > 0) || !sceneSourceUsesBackgroundStage(kind, cameraOnStage))
    return { ...stageRect }
  const scale = 1 - stageMargin * 2
  return {
    x: (stageRect.x - stageMargin) / scale,
    y: (stageRect.y - stageMargin) / scale,
    width: stageRect.width / scale,
    height: stageRect.height / scale
  }
}

/**
 * A box in canvas pixels, rounded like Rust `scene_source_rect_pixels`:
 * signed, uncut, at least one pixel a side, within the protocol's bounds.
 */
export function sceneRectPixels(rect: FractionRect, canvas: PixelSize): PixelRect {
  const position = (value: number, span: number): number =>
    Math.round(clamp(finiteOrZero(value), MIN_POSITION, MAX_POSITION) * span)
  const size = (value: number, span: number): number =>
    Math.max(1, Math.round(clamp(finiteOrZero(value), 0, MAX_SIZE) * span))
  return {
    x: position(rect.x, canvas.width),
    y: position(rect.y, canvas.height),
    width: size(rect.width, canvas.width),
    height: size(rect.height, canvas.height)
  }
}

/**
 * The largest box of the picture's aspect inside `rect`, centred: the
 * compositor's Fit, with its rounding (Rust `contain_rect_pixels`, which
 * `source_fit` draws with). `sourceWidth` and `sourceHeight` are the picture
 * after its crop. A degenerate box or picture is returned as the box.
 */
export function containRectPixels(
  sourceWidth: number,
  sourceHeight: number,
  rect: PixelRect
): PixelRect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || rect.width <= 0 || rect.height <= 0)
    return { ...rect }
  const sourceAspect = sourceWidth / sourceHeight
  const rectAspect = rect.width / rect.height
  let width: number
  let height: number
  if (sourceAspect > rectAspect) {
    width = rect.width
    height = Math.min(rect.height, Math.max(1, Math.round(width / sourceAspect)))
  } else {
    height = rect.height
    width = Math.min(rect.width, Math.max(1, Math.round(height * sourceAspect)))
  }
  return {
    x: rect.x + Math.floor((rect.width - width) / 2),
    y: rect.y + Math.floor((rect.height - height) / 2),
    width,
    height
  }
}

/** The share of the picture a crop keeps per axis (the backend's `kept_*`). */
function keptFraction(first: number | undefined, second: number | undefined): number {
  const side = (value: number | undefined): number => clamp(finiteOrZero(value ?? 0), 0, 0.95)
  return Math.max(0.001, 1 - side(first) - side(second))
}

/**
 * Where the picture lands, in canvas pixels. Fill, the test pattern (drawn
 * at the canvas size) and an unknown size give the frame itself, on the
 * stage margin; Fit gives the cropped picture's largest box inside it.
 */
export function scenePictureRectPixels(input: ScenePictureInput): PixelRect {
  const rect = sceneRectPixels(
    sceneStageRect(input.frame, input.kind, input.stageMargin, input.cameraOnStage),
    input.canvas
  )
  const source = input.source
  if (!source || input.fit === 'cover' || input.kind === 'test-pattern') return rect
  if (!(source.width > 0) || !(source.height > 0)) return rect
  const crop = input.crop ?? undefined
  return containRectPixels(
    source.width * keptFraction(crop?.cropLeft, crop?.cropRight),
    source.height * keptFraction(crop?.cropTop, crop?.cropBottom),
    rect
  )
}

/** `scenePictureRectPixels` as canvas fractions: what the stage draws and edits. */
export function scenePictureRect(input: ScenePictureInput): FractionRect {
  const pixels = scenePictureRectPixels(input)
  const width = Math.max(1, input.canvas.width)
  const height = Math.max(1, input.canvas.height)
  return {
    x: pixels.x / width,
    y: pixels.y / height,
    width: pixels.width / width,
    height: pixels.height / height
  }
}

/**
 * Whether a screen's box IS its picture (plan 216 D2): in Freeform a screen
 * or window on Fit with a known size keeps the shape of its picture. The
 * aspect key never stretches it; crop is how its shape changes. On Fill the
 * picture covers whatever box is drawn, and an unknown size has no shape to
 * follow. The camera keeps its own law (the mask aspect).
 */
export function screenBoxIsPicture(
  kind: SceneSourceKind,
  fit: PictureFit,
  source: PixelSize | null | undefined
): boolean {
  return (
    (kind === 'screen' || kind === 'window') &&
    fit === 'contain' &&
    Boolean(source && source.width > 0 && source.height > 0)
  )
}
