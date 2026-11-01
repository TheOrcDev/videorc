// Arrow keys on the Scene stage (plan 174 S3.9, C-31): a nudge of the
// selected source, Shift for the larger step. The steps themselves belong to
// the backend's `scene.source.nudge`; this only reads the key.

export interface StageNudge {
  directionX: -1 | 0 | 1
  directionY: -1 | 0 | 1
  large: boolean
}

const NUDGE_KEYS: Record<string, Pick<StageNudge, 'directionX' | 'directionY'>> = {
  ArrowUp: { directionX: 0, directionY: -1 },
  ArrowDown: { directionX: 0, directionY: 1 },
  ArrowLeft: { directionX: -1, directionY: 0 },
  ArrowRight: { directionX: 1, directionY: 0 }
}

/** The nudge an arrow keydown asks for; null for any other key or chord. */
export function stageNudgeForKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>
): StageNudge | null {
  if (event.altKey || event.metaKey || event.ctrlKey) return null
  const direction = NUDGE_KEYS[event.key]
  return direction ? { ...direction, large: event.shiftKey } : null
}
