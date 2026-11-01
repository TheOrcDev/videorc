import type { Device, RecordingStatus, StreamHealth } from '../../../shared/backend'
import { isActiveRecordingState as isSharedActiveRecordingState } from '../../../shared/capture-state'
import { formatTimecode } from '../../../shared/timecode'

export function compactTime(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

export function dayLabel(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

/**
 * The backend names an unnamed session after its start, "Session 2026-10-02
 * 14:55" (`session_title` in recording.rs), in the time zone it was recorded
 * in. A list that already shows when it ran should not repeat that clock.
 */
export function isAutoSessionTitle(title: string): boolean {
  return /^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(title.trim())
}

/**
 * A recording's length as the one timecode (plan 174 S1.4, E-20): "12:34",
 * "1:12:00", never "1 hour and 12 minutes". Unknown is the placeholder.
 */
export function durationMsLabel(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return NO_VALUE
  }
  return formatTimecode(durationMs)
}

/** A measured value and its unit ("29.9 fps"), or the placeholder. */
export function formatMetric(value: number | undefined, suffix: string): string {
  return typeof value === 'number'
    ? `${value.toFixed(suffix === 'fps' ? 1 : 2)} ${suffix}`
    : NO_VALUE
}

/** "1 drop", "12 drops", or the placeholder. */
export function formatDroppedFrames(value: number | undefined): string {
  return typeof value === 'number' ? plural(value, 'drop') : NO_VALUE
}

export function mergeStreamHealth(
  current: StreamHealth | null,
  update: StreamHealth
): StreamHealth {
  if (!current || current.sessionId !== update.sessionId) {
    return update
  }

  return {
    ...current,
    ...update,
    fps: update.fps ?? current.fps,
    droppedFrames: update.droppedFrames ?? current.droppedFrames,
    speed: update.speed ?? current.speed,
    bitrateKbps: update.bitrateKbps ?? current.bitrateKbps,
    totalBytes: update.totalBytes ?? current.totalBytes,
    duplicatedFrames: update.duplicatedFrames ?? current.duplicatedFrames
  }
}

export function isActiveRecordingState(state: RecordingStatus['state']): boolean {
  return isSharedActiveRecordingState(state)
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    ? Boolean(target.closest('input, textarea, select, button, [contenteditable="true"]'))
    : false
}

export function findDevice(devices: Device[], id?: string): Device | undefined {
  return id ? devices.find((device) => device.id === id) : undefined
}

export function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '-'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  const shown = (value: number): number =>
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  let value = bytes
  let unit = 'B'
  for (const candidate of units) {
    value /= 1024
    unit = candidate
    // Pick the unit by the value as it will be shown: 1023.9 KB rounds to
    // 1024, which belongs in the next unit as 1 MB, never "1024 KB".
    if (shown(value) < 1024) {
      break
    }
  }
  return `${shown(value)} ${unit}`
}

/**
 * The one placeholder for a value that cannot be shown (plan 174 S1.4,
 * I-25, H-10): an en dash, never "-", "--", "--:--" or "Unknown". Show it
 * with its reason (a tooltip, a hover card or a note), never alone.
 */
export const NO_VALUE = '–'

/** A placeholder and why it is one: `{ value: '–', reason: 'Not measured yet' }`. */
export function missingValue(reason: string): { value: typeof NO_VALUE; reason: string } {
  return { value: NO_VALUE, reason }
}

/**
 * A count and its noun, agreeing: "1 drop", "12 drops", "1,204 viewers".
 * `many` defaults to the noun plus "s".
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}
