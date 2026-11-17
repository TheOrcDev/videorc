import { describe, expect, it } from 'vitest'

import { captureStateBlocksInterruption } from '../shared/capture-state'
import { DisplaySleepGuard } from './display-sleep-guard'
import { requestPermissionRestart } from './deferred-permission-restart'
import { guardCaptureState } from './live-activity'

// Plan 249 S26: a cloud room on air or recording is live activity for the
// display-sleep, update and permission-restart guards, which read main's
// capture state through guardCaptureState.

describe('guardCaptureState', () => {
  it('reads an idle app with a live room as streaming, a recording room as recording', () => {
    expect(guardCaptureState('idle', 'live')).toBe('streaming')
    expect(guardCaptureState('failed', 'recording')).toBe('recording')
    expect(guardCaptureState('idle', null)).toBe('idle')
  })
  it('never downgrades a local session and keeps unknown unknown', () => {
    expect(guardCaptureState('recording', 'live')).toBe('recording')
    expect(guardCaptureState('stopping', 'recording')).toBe('stopping')
    expect(guardCaptureState('unknown', 'live')).toBe('unknown')
  })
  it('blocks an update install, defers a permission restart and holds the display', () => {
    const guarded = guardCaptureState('idle', 'live')
    expect(captureStateBlocksInterruption(guarded, true)).toBe(true)
    expect(captureStateBlocksInterruption(guardCaptureState('idle', null), true)).toBe(false)
    expect(requestPermissionRestart({ pendingReason: null }, guarded, 'camera').runReason).toBe(
      null
    )
    let held = 0
    const guard = new DisplaySleepGuard(
      () => ++held,
      () => undefined
    )
    guard.update(guarded)
    expect(guard.holding).toBe(true)
    guard.update(guardCaptureState('idle', null))
    expect(guard.holding).toBe(false)
  })
})
