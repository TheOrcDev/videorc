export type MicVisualFrameBuffer = {
  bands: number[]
  /** Borrowed fixed ring; valid until the session is replaced or released. */
  historyRing: Float32Array
  historyStart: number
  historyLength: number
  peakDb: number | null
}

const EMPTY_HISTORY_RING = new Float32Array(0)

/** Create a caller-owned mutable read buffer for the shared analyser clock. */
export function createMicVisualFrameBuffer(): MicVisualFrameBuffer {
  return {
    bands: [],
    historyRing: EMPTY_HISTORY_RING,
    historyStart: 0,
    historyLength: 0,
    peakDb: null
  }
}

/** Resample into a fixed caller-owned target without allocating per frame. */
export function resampleMicVisualLevelsInto(levels: ArrayLike<number>, target: number[]): number[] {
  const count = target.length
  if (count === 0) {
    return target
  }
  if (levels.length === 0) {
    target.fill(0)
    return target
  }
  if (levels.length === count) {
    for (let index = 0; index < count; index += 1) {
      target[index] = levels[index]
    }
    return target
  }
  if (count === 1) {
    let total = 0
    for (let index = 0; index < levels.length; index += 1) total += levels[index]
    target[0] = total / levels.length
    return target
  }
  if (count > levels.length) {
    for (let index = 0; index < count; index += 1) {
      const position = (index * (levels.length - 1)) / (count - 1)
      const left = Math.floor(position)
      const right = Math.min(levels.length - 1, left + 1)
      const fraction = position - left
      target[index] = levels[left] * (1 - fraction) + levels[right] * fraction
    }
    return target
  }

  for (let index = 0; index < count; index += 1) {
    const start = (index * levels.length) / count
    const end = ((index + 1) * levels.length) / count
    let total = 0
    let weight = 0
    for (let source = Math.floor(start); source < Math.ceil(end); source += 1) {
      const overlap = Math.max(0, Math.min(end, source + 1) - Math.max(start, source))
      total += levels[Math.min(source, levels.length - 1)] * overlap
      weight += overlap
    }
    target[index] = weight > 0 ? total / weight : 0
  }
  return target
}

/** Resize one shared analyser spectrum for a visual's bar geometry. */
export function resampleMicVisualLevels(
  levels: ArrayLike<number>,
  requestedCount: number
): number[] {
  const count = Math.max(0, Math.floor(requestedCount))
  if (count === 0) {
    return []
  }
  return resampleMicVisualLevelsInto(levels, new Array<number>(count).fill(0))
}
