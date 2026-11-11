import { CAMERA_KEY_EDGE_MAX_PCT, type CameraKeyEdges, type LayoutSettings } from '@/lib/backend'
import { NO_CAMERA_KEY_EDGES } from '@/lib/capture'

/**
 * Hide edges (plan 227 B): the four sides of the green-screen key's matte,
 * in the order the screen's Crop fields use.
 */
export const CAMERA_KEY_EDGE_IDS = ['leftPct', 'topPct', 'rightPct', 'bottomPct'] as const

export type CameraKeyEdgeId = (typeof CAMERA_KEY_EDGE_IDS)[number]

export const CAMERA_KEY_EDGE_LABELS: Record<CameraKeyEdgeId, string> = {
  leftPct: 'Left',
  topPct: 'Top',
  rightPct: 'Right',
  bottomPct: 'Bottom'
}

/** The layout's edges, every side present (none set reads as all 0). */
export function cameraKeyEdgesOf(layout: Pick<LayoutSettings, 'cameraChromaKeyEdges'>) {
  return layout.cameraChromaKeyEdges ?? NO_CAMERA_KEY_EDGES
}

/**
 * A typed side as a whole percent in 0–`CAMERA_KEY_EDGE_MAX_PCT`, or null
 * when the text is not a number. Accepts a trailing % and a comma decimal.
 */
export function parseCameraKeyEdgePct(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '').trim().replace(',', '.')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return null
  return Math.min(CAMERA_KEY_EDGE_MAX_PCT, Math.max(0, Math.round(parsed)))
}

/** The edges with one side changed, or null when nothing changes. */
export function cameraKeyEdgesPatch(
  edges: CameraKeyEdges,
  side: CameraKeyEdgeId,
  text: string
): CameraKeyEdges | null {
  const pct = parseCameraKeyEdgePct(text)
  if (pct === null || pct === edges[side]) return null
  return { ...edges, [side]: pct }
}

export function cameraKeyEdgesSet(edges: CameraKeyEdges): boolean {
  return CAMERA_KEY_EDGE_IDS.some((side) => edges[side] > 0)
}
