import type { VisualFrame } from '@/lib/audio/types'

export const appendHistory = (
  frame: VisualFrame,
  level: number,
  nowMs: number,
  intervalMs: number
): void => {
  const interval = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 0
  const elapsed = nowMs - (frame.historyUpdatedAt ?? 0)
  if (elapsed < interval || frame.history.length === 0) {
    return
  }

  frame.historyIntervalMs = interval
  frame.historyUpdatedAt = nowMs
  const size = frame.history.length
  if (frame.historyLength < size) {
    frame.history[(frame.historyStart + frame.historyLength) % size] = level
    frame.historyLength += 1
  } else {
    frame.historyPreviousLevel = frame.history[frame.historyStart]
    frame.history[frame.historyStart] = level
    frame.historyStart = (frame.historyStart + 1) % size
  }
}
