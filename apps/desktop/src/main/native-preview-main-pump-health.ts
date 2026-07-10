export const DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS = 2_000
export const DEFAULT_MAIN_PUMP_COMPACT_EVENT_GRACE_MS = 1_000

export interface MainPumpFrameDeliveryHealth {
  active: boolean
  surfaceLive: boolean
  compositorFramesAdvancing: boolean
  activatedAtMs: number
  lastPresentDrivingEventAtMs: number
  nowMs: number
  timeoutMs?: number
}

/**
 * Detect a half-open main event socket without mistaking compositor idle/startup
 * for a transport failure. The compositor status watchdog is HTTP-based, so
 * advancing compositor truth plus a stale presentation-driving event proves
 * the socket lane is the blocked link. Both compact frameReady and the
 * status-only compatibility lane count as healthy delivery.
 */
export function mainPumpFrameDeliveryStalled({
  active,
  surfaceLive,
  compositorFramesAdvancing,
  activatedAtMs,
  lastPresentDrivingEventAtMs,
  nowMs,
  timeoutMs = DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS
}: MainPumpFrameDeliveryHealth): boolean {
  if (!active || !surfaceLive || !compositorFramesAdvancing) {
    return false
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return false
  }
  const heartbeatAtMs = Math.max(activatedAtMs, lastPresentDrivingEventAtMs)
  return heartbeatAtMs > 0 && nowMs - heartbeatAtMs >= timeoutMs
}

export function mainPumpStatusCompatibilityMayPresent({
  activatedAtMs,
  lastFrameReadyAtMs,
  nowMs,
  compactEventGraceMs = DEFAULT_MAIN_PUMP_COMPACT_EVENT_GRACE_MS
}: {
  activatedAtMs: number
  lastFrameReadyAtMs: number
  nowMs: number
  compactEventGraceMs?: number
}): boolean {
  if (!Number.isFinite(compactEventGraceMs) || compactEventGraceMs < 0) {
    return false
  }
  const compactHeartbeatAtMs = Math.max(activatedAtMs, lastFrameReadyAtMs)
  return compactHeartbeatAtMs > 0 && nowMs - compactHeartbeatAtMs > compactEventGraceMs
}
