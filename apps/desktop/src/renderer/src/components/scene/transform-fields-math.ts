import type { SceneSourceKind } from '@/lib/backend'
import {
  sceneFrameRect,
  sceneStageRect,
  type PixelSize
} from '../../../../shared/scene-picture-geometry'
import {
  MAX_SOURCE_FRACTION,
  MAX_SOURCE_POSITION,
  MIN_CROP_KEPT,
  MIN_SOURCE_FRACTION,
  MIN_SOURCE_POSITION,
  clampSourcePosition,
  type StageCrop,
  type StageRect
} from './stage-transform'

/**
 * Percent <-> normalized <-> pixel helpers for the Inspector's Position and
 * size fields. Values displayed to the user are PERCENT OF THE CANVAS (the
 * scene model is canvas-normalized 0..1), so they stay truthful across the
 * preview/recording output pair; the pixel readout is derived from the
 * committed output canvas.
 */

export type TransformFieldId = 'x' | 'y' | 'width' | 'height'

export const TRANSFORM_FIELD_IDS: readonly TransformFieldId[] = ['x', 'y', 'width', 'height']

export const TRANSFORM_FIELD_LABELS: Record<TransformFieldId, string> = {
  x: 'X',
  y: 'Y',
  width: 'W',
  height: 'H'
}

/** Format a normalized value as a percent string with at most one decimal. */
export function formatPercentValue(normalized: number): string {
  const percent = Math.round(normalized * 1000) / 10
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
}

/**
 * Parse a user-entered percent into a normalized value, or null when the text
 * is not a number. Accepts an optional trailing % sign and comma decimals.
 */
export function parsePercentValue(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '').replace(',', '.')
  if (!cleaned) {
    return null
  }
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return parsed / 100
}

/**
 * Clamp a parsed field value to the range the UI accepts (plan 215 E3, D2).
 * Position mirrors the backend sanitizer's [-3, 4]; size keeps the stage's 5%
 * minimum and goes up to 400% of the canvas. A position edit is clamped
 * against the committed size so at least 5% of the canvas stays covered
 * (`clampSourcePosition`); `transformFieldPatch` does that with the box. The
 * backend commit remains the final authority (snap and crop normalization
 * included) and the committed value echoes back into the fields.
 */
export function clampTransformField(field: TransformFieldId, normalized: number): number {
  if (field === 'x' || field === 'y') {
    return Math.min(Math.max(normalized, MIN_SOURCE_POSITION), MAX_SOURCE_POSITION)
  }
  return Math.min(Math.max(normalized, MIN_SOURCE_FRACTION), MAX_SOURCE_FRACTION)
}

/**
 * The transform patch a single field edit commits. A position edit keeps at
 * least 5% of the canvas covered on its axis (the box may hang off the
 * canvas by the rest, plan 215 E3). With the aspect locked, a size edit
 * scales BOTH axes around the committed aspect, clamped so neither axis
 * leaves [min, 400%] (the limiting axis wins and the aspect holds); a size
 * that would leave less than 5% of the canvas covered moves the box back
 * onto it.
 */
export function transformFieldPatch(
  field: TransformFieldId,
  value: number,
  committed: StageRect,
  aspectLocked: boolean
): { x?: number; y?: number; width?: number; height?: number } {
  const clamped = clampTransformField(field, value)
  if (field === 'x') {
    return { x: round4(clampSourcePosition(clamped, committed.width)) }
  }
  if (field === 'y') {
    return { y: round4(clampSourcePosition(clamped, committed.height)) }
  }
  if (!aspectLocked || committed.width <= 0 || committed.height <= 0) {
    return { [field]: clamped, ...onCanvasPosition(committed, { [field]: clamped }) }
  }
  let scale = field === 'width' ? clamped / committed.width : clamped / committed.height
  const minScale = Math.max(
    MIN_SOURCE_FRACTION / committed.width,
    MIN_SOURCE_FRACTION / committed.height
  )
  const maxScale = Math.min(
    MAX_SOURCE_FRACTION / committed.width,
    MAX_SOURCE_FRACTION / committed.height
  )
  scale = Math.min(Math.max(scale, minScale), Math.max(maxScale, minScale))
  const width = round4(committed.width * scale)
  const height = round4(committed.height * scale)
  return { width, height, ...onCanvasPosition(committed, { width, height }) }
}

/**
 * The position fields a size edit must also move, if any: a box that shrank
 * or grew so that less than 5% of the canvas stays covered slides back onto
 * it. A box that still covers that much keeps its place.
 */
function onCanvasPosition(
  committed: StageRect,
  size: { width?: number; height?: number }
): { x?: number; y?: number } {
  const patch: { x?: number; y?: number } = {}
  if (size.width !== undefined) {
    const x = clampSourcePosition(committed.x, size.width)
    if (x !== committed.x) patch.x = round4(x)
  }
  if (size.height !== undefined) {
    const y = clampSourcePosition(committed.y, size.height)
    if (y !== committed.y) patch.y = round4(y)
  }
  return patch
}

export type CropFieldId = keyof StageCrop

export const CROP_FIELD_IDS: readonly CropFieldId[] = [
  'cropLeft',
  'cropTop',
  'cropRight',
  'cropBottom'
]

export const CROP_FIELD_LABELS: Record<CropFieldId, string> = {
  cropLeft: 'Left',
  cropTop: 'Top',
  cropRight: 'Right',
  cropBottom: 'Bottom'
}

const OPPOSITE_CROP_SIDE: Record<CropFieldId, CropFieldId> = {
  cropLeft: 'cropRight',
  cropRight: 'cropLeft',
  cropTop: 'cropBottom',
  cropBottom: 'cropTop'
}

/**
 * The patch one crop side's edit commits (plan 213 G2), as a share of the
 * picture: at least nothing, and at most what leaves 5% of the picture beside
 * the opposite side's crop (the backend's 95% ceiling per axis). The box
 * stays where it is; the kept picture fits into it again. The backend commit
 * remains the authority and its value echoes back into the fields.
 */
export function cropFieldPatch(
  field: CropFieldId,
  value: number,
  committed: StageCrop
): Partial<StageCrop> {
  const most = Math.max(0, 1 - MIN_CROP_KEPT - committed[OPPOSITE_CROP_SIDE[field]])
  return { [field]: round4(Math.min(Math.max(value, 0), most)) }
}

export type TransformPatch = { x?: number; y?: number; width?: number; height?: number }

/**
 * A field edit made on the PICTURE (plan 216 B5: the Inspector's X, Y, W, H
 * describe the picture the stage shows), as the frame patch the backend
 * stores: each present field back through the scene background's stage
 * margin (`sceneFrameRect`), which is affine per axis, so a partial patch
 * maps field by field. No margin, or a camera, leaves the patch as it is.
 */
export function pictureEditToFrame(
  patch: TransformPatch,
  kind: SceneSourceKind,
  stageMargin: number
): TransformPatch {
  const frame = sceneFrameRect(
    {
      x: patch.x ?? 0,
      y: patch.y ?? 0,
      width: patch.width ?? 0,
      height: patch.height ?? 0
    },
    kind,
    stageMargin
  )
  const result: TransformPatch = {}
  for (const key of TRANSFORM_FIELD_IDS)
    if (patch[key] !== undefined) result[key] = round4(frame[key])
  return result
}

/**
 * The frame patch a field edit on the picture commits (plan 216 B5). While
 * the box is the frame (Fill, an unknown size: the picture is the frame
 * rounded to pixels), the edited fields alone go back through the margin.
 * Once the picture differs from the frame (Fit with a known size, before
 * the first edit), the whole picture goes with the edit, so that first
 * edit makes the frame the picture (D3) and the typed number lands where
 * it was typed.
 */
export function pictureEditFramePatch(
  patch: TransformPatch,
  box: StageRect,
  frame: StageRect,
  kind: SceneSourceKind,
  stageMargin: number,
  canvas: PixelSize
): TransformPatch {
  const staged = sceneStageRect(frame, kind, stageMargin)
  const boxIsFrame = TRANSFORM_FIELD_IDS.every(
    (key) =>
      Math.abs(box[key] - staged[key]) *
        (key === 'x' || key === 'width' ? canvas.width : canvas.height) <=
      1
  )
  return pictureEditToFrame(boxIsFrame ? patch : { ...box, ...patch }, kind, stageMargin)
}

/**
 * A typed crop while the box is the picture (plan 216 D2): the crop, and
 * the box the kept picture now fills, in picture (stage) coordinates. The
 * uncropped picture stays where it is, so what stays on screen does not
 * move or scale, exactly as an Alt-drag crop on the stage cuts it. The
 * caller maps the box back to a frame with `pictureEditToFrame`.
 */
export function cropEditOnPicture(
  patch: Partial<StageCrop>,
  picture: StageRect,
  committed: StageCrop
): Partial<StageCrop> & StageRect {
  const next: StageCrop = { ...committed, ...patch }
  const keptX = Math.max(MIN_CROP_KEPT, 1 - committed.cropLeft - committed.cropRight)
  const keptY = Math.max(MIN_CROP_KEPT, 1 - committed.cropTop - committed.cropBottom)
  // The whole picture, from the part the box shows now.
  const fullWidth = picture.width / keptX
  const fullHeight = picture.height / keptY
  const fullX = picture.x - committed.cropLeft * fullWidth
  const fullY = picture.y - committed.cropTop * fullHeight
  const nextKeptX = Math.max(MIN_CROP_KEPT, 1 - next.cropLeft - next.cropRight)
  const nextKeptY = Math.max(MIN_CROP_KEPT, 1 - next.cropTop - next.cropBottom)
  return {
    ...patch,
    x: round4(fullX + next.cropLeft * fullWidth),
    y: round4(fullY + next.cropTop * fullHeight),
    width: round4(fullWidth * nextKeptX),
    height: round4(fullHeight * nextKeptY)
  }
}

/** Pixel readout for the committed box on the output canvas. */
export function pixelReadout(rect: StageRect, outputWidth: number, outputHeight: number): string {
  const width = Math.round(rect.width * Math.max(0, outputWidth))
  const height = Math.round(rect.height * Math.max(0, outputHeight))
  return `${width} × ${height} px on ${outputWidth} × ${outputHeight}`
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
