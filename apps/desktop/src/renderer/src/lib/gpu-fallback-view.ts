import type { RuntimeInfo } from './backend'
import { plural } from './format'

export function gpuFallbackAge(updatedAt: string | null, nowMs = Date.now()): string | null {
  if (!updatedAt) return null
  const updatedAtMs = Date.parse(updatedAt)
  if (!Number.isFinite(updatedAtMs)) return null
  const elapsedMs = Math.max(0, nowMs - updatedAtMs)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, 'hour')} ago`
  const days = Math.floor(hours / 24)
  return `${plural(days, 'day')} ago`
}

export function gpuRenderingLabel(runtimeInfo: RuntimeInfo): string {
  if (runtimeInfo.hardwareAccelerationDisabled) return 'Software rendering'
  if (runtimeInfo.gpuFallback.source === 'retry') return 'Hardware retry active'
  return 'Hardware accelerated'
}
