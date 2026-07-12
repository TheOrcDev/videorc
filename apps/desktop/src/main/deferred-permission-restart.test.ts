import { describe, expect, it } from 'vitest'

import {
  flushPermissionRestart,
  idleDeferredPermissionRestartState,
  requestPermissionRestart
} from './deferred-permission-restart'

describe('deferred permission restart', () => {
  it.each(['unknown', 'starting', 'recording', 'streaming', 'stopping'] as const)(
    'defers a permission restart while capture state is %s',
    (captureState) => {
      const decision = requestPermissionRestart(
        idleDeferredPermissionRestartState,
        captureState,
        'permission granted'
      )

      expect(decision.runReason).toBeNull()
      expect(decision.state.pendingReason).toBe('permission granted')
    }
  )

  it('coalesces repeated permission grants while capture remains active', () => {
    const first = requestPermissionRestart(
      idleDeferredPermissionRestartState,
      'recording',
      'camera granted'
    )
    const second = requestPermissionRestart(first.state, 'stopping', 'microphone granted')

    expect(second.runReason).toBeNull()
    expect(second.state.pendingReason).toBe('camera granted')
  })

  it.each(['idle', 'failed'] as const)('flushes exactly once when capture becomes %s', (state) => {
    const pending = requestPermissionRestart(
      idleDeferredPermissionRestartState,
      'recording',
      'permission granted'
    )
    const firstIdle = flushPermissionRestart(pending.state, state)
    const secondIdle = flushPermissionRestart(firstIdle.state, state)

    expect(firstIdle.runReason).toBe('permission granted')
    expect(firstIdle.state.pendingReason).toBeNull()
    expect(secondIdle.runReason).toBeNull()
  })

  it('runs immediately when capture is already idle', () => {
    expect(
      requestPermissionRestart(idleDeferredPermissionRestartState, 'idle', 'permission granted')
    ).toEqual({
      state: idleDeferredPermissionRestartState,
      runReason: 'permission granted'
    })
  })
})
