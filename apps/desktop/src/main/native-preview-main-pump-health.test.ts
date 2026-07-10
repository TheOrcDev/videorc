import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS,
  mainPumpFrameDeliveryStalled,
  mainPumpStatusCompatibilityMayPresent
} from './native-preview-main-pump-health'

describe('mainPumpFrameDeliveryStalled', () => {
  const healthy = {
    active: true,
    surfaceLive: true,
    compositorFramesAdvancing: true,
    activatedAtMs: 1_000,
    lastPresentDrivingEventAtMs: 2_000,
    nowMs: 2_500
  }

  it('retires a half-open pump when compositor truth advances without frame delivery', () => {
    expect(
      mainPumpFrameDeliveryStalled({
        ...healthy,
        nowMs: 2_000 + DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS
      })
    ).toBe(true)
  })

  it('does not flap during startup, inactive ownership, or a stopped compositor', () => {
    expect(mainPumpFrameDeliveryStalled(healthy)).toBe(false)
    expect(mainPumpFrameDeliveryStalled({ ...healthy, active: false, nowMs: 10_000 })).toBe(false)
    expect(mainPumpFrameDeliveryStalled({ ...healthy, surfaceLive: false, nowMs: 10_000 })).toBe(
      false
    )
    expect(
      mainPumpFrameDeliveryStalled({
        ...healthy,
        compositorFramesAdvancing: false,
        nowMs: 10_000
      })
    ).toBe(false)
  })

  it('uses activation time until the first compact frame arrives', () => {
    expect(
      mainPumpFrameDeliveryStalled({
        ...healthy,
        activatedAtMs: 4_000,
        lastPresentDrivingEventAtMs: 0,
        nowMs: 4_000 + DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS - 1
      })
    ).toBe(false)
    expect(
      mainPumpFrameDeliveryStalled({
        ...healthy,
        activatedAtMs: 4_000,
        lastPresentDrivingEventAtMs: 0,
        nowMs: 4_000 + DEFAULT_MAIN_PUMP_FRAME_STALL_TIMEOUT_MS
      })
    ).toBe(true)
  })

  it('accepts the status-only compatibility lane as a presentation heartbeat', () => {
    expect(
      mainPumpFrameDeliveryStalled({
        ...healthy,
        lastPresentDrivingEventAtMs: 9_500,
        nowMs: 10_000
      })
    ).toBe(false)
  })

  it('gives the compact lane one grace window after every connection', () => {
    expect(
      mainPumpStatusCompatibilityMayPresent({
        activatedAtMs: 10_000,
        lastFrameReadyAtMs: 0,
        nowMs: 10_500
      })
    ).toBe(false)
    expect(
      mainPumpStatusCompatibilityMayPresent({
        activatedAtMs: 10_000,
        lastFrameReadyAtMs: 0,
        nowMs: 11_001
      })
    ).toBe(true)
    expect(
      mainPumpStatusCompatibilityMayPresent({
        activatedAtMs: 10_000,
        lastFrameReadyAtMs: 12_000,
        nowMs: 12_500
      })
    ).toBe(false)
  })
})
