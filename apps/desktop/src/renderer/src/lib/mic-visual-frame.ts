export type MicVisualFrameBuffer = {
  bands: number[]
  /** Borrowed fixed ring; valid until the session is replaced or released. */
  historyRing: Float32Array
  historyStart: number
  historyLength: number
  /** Frame peak for labels: dBFS floored at the visual floor (-60); null with no data. */
  peakDb: number | null
  /**
   * Level-meter readings of the same block, in true dBFS: -Infinity for
   * digital silence and never floored, so a gain offset added later cannot
   * turn the floor into a level (plan 092).
   */
  peakDbfs: number
  rmsDbfs: number
}

const EMPTY_HISTORY_RING = new Float32Array(0)

/** Create a caller-owned mutable read buffer for the shared analyser clock. */
export function createMicVisualFrameBuffer(): MicVisualFrameBuffer {
  return {
    bands: [],
    historyRing: EMPTY_HISTORY_RING,
    historyStart: 0,
    historyLength: 0,
    peakDb: null,
    peakDbfs: Number.NEGATIVE_INFINITY,
    rmsDbfs: Number.NEGATIVE_INFINITY
  }
}
