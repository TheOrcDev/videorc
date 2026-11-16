import type { LayoutSettings } from '@/lib/backend'

export type KeySettings = Pick<
  LayoutSettings,
  | 'cameraChromaKeyEnabled'
  | 'cameraChromaKeyColor'
  | 'cameraChromaKeySimilarityPct'
  | 'cameraChromaKeySmoothnessPct'
  | 'cameraChromaKeySpillPct'
  | 'cameraChromaKeyEdges'
  | 'cameraMirror'
>
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
export function keySpec(settings: KeySettings) {
  const hex = settings.cameraChromaKeyColor.trim().replace(/^#/, '')
  const rgb = /^[\da-f]{6}$/i.test(hex)
    ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
    : [0, 255, 0]
  const [cb, cr] = chroma(rgb)
  const length = Math.hypot(cb, cr)
  const edges = settings.cameraChromaKeyEdges
  let left = clamp(edges?.leftPct ?? 0, 0, 25) / 100
  let right = clamp(edges?.rightPct ?? 0, 0, 25) / 100
  if (settings.cameraMirror) [left, right] = [right, left]
  return {
    direction: length < 1 ? [0, 0] : [cb / length, cr / length],
    angle: clamp(settings.cameraChromaKeySimilarityPct, 0, 100) * 0.6,
    band: clamp(settings.cameraChromaKeySmoothnessPct, 0, 100) * 0.6,
    spill: clamp(settings.cameraChromaKeySpillPct, 0, 100) / 100,
    blue: rgb[2] > rgb[1],
    edges: [
      left,
      clamp(edges?.topPct ?? 0, 0, 25) / 100,
      1 - right,
      1 - clamp(edges?.bottomPct ?? 0, 0, 25) / 100
    ]
  }
}
function chroma([r, g, b]: readonly number[]): number[] {
  return [
    (-43 * r - 85 * g + 128 * b) / 256,
    (128 * r - 107 * g - 21 * b) / 256,
    (77 * r + 150 * g + 29 * b) / 256
  ]
}
/** scene_geometry.rs's per-colour oracle, in byte units (before spatial cleanup). */
export function chromaKeyReference(rgb: readonly number[], settings: KeySettings) {
  const spec = keySpec(settings)
  const [cb, cr, luma] = chroma(rgb)
  const saturation = Math.hypot(cb, cr)
  const floor = clamp(0.15 * luma, 5, 14)
  let alpha = 255
  if (saturation > floor && Math.hypot(...spec.direction) > 0) {
    const theta =
      (Math.acos(clamp((cb * spec.direction[0] + cr * spec.direction[1]) / saturation, -1, 1)) *
        180) /
      Math.PI
    const angleAlpha =
      theta <= spec.angle
        ? 0
        : spec.band <= 0 || theta >= spec.angle + spec.band
          ? 255
          : ((theta - spec.angle) / spec.band) * 255
    alpha = Math.round(
      255 - clamp((saturation - floor) / ((floor * 6) / 14), 0, 1) * (255 - angleAlpha)
    )
  }
  const color = [...rgb]
  const channel = spec.blue ? 2 : 1
  const limit = Math.max(rgb[0], rgb[spec.blue ? 1 : 2])
  if (color[channel] > limit)
    color[channel] = Math.round(color[channel] - spec.spill * (color[channel] - limit))
  return { alpha, rgb: color }
}
