import { MIN_SOURCE_FRACTION, type StageRect } from './stage-transform'

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
 * Clamp a parsed field value to the range the UI accepts. Position mirrors the
 * backend sanitizer's [-1, 2]; size keeps the stage's 5% minimum and the
 * canvas maximum. The backend commit remains the final authority (snap and
 * crop normalization included) and the committed value echoes back into the
 * fields.
 */
export function clampTransformField(field: TransformFieldId, normalized: number): number {
  if (field === 'x' || field === 'y') {
    return Math.min(Math.max(normalized, -1), 2)
  }
  return Math.min(Math.max(normalized, MIN_SOURCE_FRACTION), 1)
}

/**
 * The transform patch a single field edit commits. With the aspect locked, a
 * size edit scales BOTH axes around the committed aspect, clamped so neither
 * axis leaves [min, 1] (the limiting axis wins and the aspect holds).
 */
export function transformFieldPatch(
  field: TransformFieldId,
  value: number,
  committed: StageRect,
  aspectLocked: boolean
): { x?: number; y?: number; width?: number; height?: number } {
  const clamped = clampTransformField(field, value)
  if (field === 'x' || field === 'y') {
    return { [field]: clamped }
  }
  if (!aspectLocked || committed.width <= 0 || committed.height <= 0) {
    return { [field]: clamped }
  }
  let scale = field === 'width' ? clamped / committed.width : clamped / committed.height
  const minScale = Math.max(
    MIN_SOURCE_FRACTION / committed.width,
    MIN_SOURCE_FRACTION / committed.height
  )
  const maxScale = Math.min(1 / committed.width, 1 / committed.height)
  scale = Math.min(Math.max(scale, minScale), Math.max(maxScale, minScale))
  return {
    width: round4(committed.width * scale),
    height: round4(committed.height * scale)
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
