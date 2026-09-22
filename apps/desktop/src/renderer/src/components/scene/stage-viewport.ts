export interface StageMapping {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  width: number
  height: number
}

/** Freeze the SVG screen matrix at pointer-down, including letterboxing. */
export function stagePoint(
  mapping: StageMapping,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const { a, b, c, d, e, f, width, height } = mapping
  const determinant = a * d - b * c
  if (
    ![a, b, c, d, e, f, width, height, clientX, clientY].every(Number.isFinite) ||
    Math.abs(determinant) < 1e-10 ||
    width <= 0 ||
    height <= 0
  )
    return null
  const x = clientX - e
  const y = clientY - f
  return { x: (d * x - c * y) / determinant / width, y: (a * y - b * x) / determinant / height }
}

export function stagePixelSize(mapping: StageMapping): { width: number; height: number } {
  return {
    width: Math.hypot(mapping.a, mapping.b) * mapping.width,
    height: Math.hypot(mapping.c, mapping.d) * mapping.height
  }
}
