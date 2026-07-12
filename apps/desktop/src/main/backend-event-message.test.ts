import { describe, expect, it } from 'vitest'

import {
  parseMainBackendWireMessage,
  parseMainCompositorFrameReadyEvent,
  parseMainCompositorStatusEvent,
  parseMainRecordingStatusEvent
} from './backend-event-message'

describe('main backend event trust boundary', () => {
  it('rejects malformed and oversized websocket envelopes before privileged dispatch', () => {
    expect(() => parseMainBackendWireMessage('null')).toThrow('invalid websocket envelope')
    expect(() => parseMainBackendWireMessage(' '.repeat(16_000_001))).toThrow('oversized')
  })

  it('semantically validates capture and native-present state before mutation', () => {
    expect(() => parseMainRecordingStatusEvent({ state: 'attacker-controlled' })).toThrow(
      'recording.status'
    )
    expect(() => parseMainCompositorStatusEvent({})).toThrow('compositor.status')
    expect(() => parseMainCompositorFrameReadyEvent(null)).toThrow('preview.frameReady')

    expect(
      parseMainCompositorFrameReadyEvent({
        targetFps: 30,
        width: 1920,
        height: 1080,
        framesRendered: 42,
        frameAgeMs: 12,
        updatedAt: '2026-07-12T00:00:00.000Z'
      })
    ).toMatchObject({ framesRendered: 42, width: 1920, height: 1080 })
  })
})
