import { clamp } from '@/lib/audio/decibels'
import type { VisualFrame } from '@/lib/audio/types'

interface HistorySample {
  frame: VisualFrame
  fromMs: number
  toMs: number
}

export const createHistoryPlayback = () => {
  const samples: HistorySample[] = []
  let previousMs: number | undefined
  let previousLength = 0
  let intervalMs: number | undefined

  const clear = () => {
    samples.length = 0
    previousMs = undefined
    previousLength = 0
    intervalMs = undefined
  }

  const read = (frame: VisualFrame, nowMs: number): { frame: VisualFrame; progress: number } => {
    const time = frame.historyUpdatedAt
    const interval = frame.historyIntervalMs
    if (
      time === undefined ||
      !Number.isFinite(time) ||
      interval === undefined ||
      !Number.isFinite(interval) ||
      interval <= 0 ||
      frame.historyLength === 0
    ) {
      clear()
      return { frame, progress: 1 }
    }
    if (
      intervalMs !== interval ||
      frame.historyLength < previousLength ||
      (previousMs !== undefined && time < previousMs)
    ) {
      clear()
    }
    intervalMs = interval
    previousLength = frame.historyLength
    if (time !== previousMs) {
      samples.push({
        frame: { ...frame, history: new Float32Array(frame.history) },
        fromMs: previousMs ?? time - interval,
        toMs: time
      })
      previousMs = time
    }

    const displayMs = nowMs - interval * 2
    while (samples.length > 1 && (samples[0]?.toMs ?? 0) <= displayMs) {
      samples.shift()
    }
    const [sample] = samples
    if (!sample) {
      return { frame, progress: 1 }
    }
    return {
      frame: sample.frame,
      progress: clamp((displayMs - sample.fromMs) / (sample.toMs - sample.fromMs), 0, 1)
    }
  }

  return { clear, read }
}
