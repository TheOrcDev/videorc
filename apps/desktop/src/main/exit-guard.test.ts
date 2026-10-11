import { describe, expect, it } from 'vitest'

import { LiveExitGuard } from './exit-guard'

const ON_AIR = { state: 'recording', sessionId: 's1', streamUrl: 'rtmp://127.0.0.1/live/***' }
const RECORDING = { state: 'recording', sessionId: 's1' }

// Plan 174 S3.1 (D2): ⌘Q and ⌘W while on air ask first; a recording quits
// as it always did (finalization drains in the backend shutdown).
describe('LiveExitGuard', () => {
  it('never asks unless a livestream is on air', () => {
    const guard = new LiveExitGuard()
    expect(guard.shouldAsk('quit', true)).toBe(false)
    guard.observeRecordingStatus(RECORDING)
    expect(guard.livestreamOnAir).toBe(false)
    expect(guard.shouldAsk('quit', true)).toBe(false)
    expect(guard.shouldAsk('close', true)).toBe(false)
  })

  it('asks for a quit and for a window close while on air', () => {
    const guard = new LiveExitGuard()
    guard.observeRecordingStatus(ON_AIR)
    expect(guard.livestreamOnAir).toBe(true)
    expect(guard.shouldAsk('quit', true)).toBe(true)
    expect(guard.shouldAsk('close', true)).toBe(true)
    // Asking again is still asking: nothing was answered.
    expect(guard.shouldAsk('quit', true)).toBe(true)
  })

  it('lets exactly the allowed exit through, once', () => {
    const guard = new LiveExitGuard()
    guard.observeRecordingStatus(ON_AIR)
    guard.allow('quit')
    expect(guard.shouldAsk('close', true)).toBe(true)
    expect(guard.shouldAsk('quit', true)).toBe(false)
    // Spent: a later livestream asks again.
    expect(guard.shouldAsk('quit', true)).toBe(true)
    guard.allow('close')
    expect(guard.shouldAsk('quit', true)).toBe(true)
    expect(guard.shouldAsk('close', true)).toBe(false)
    expect(guard.shouldAsk('close', true)).toBe(true)
  })

  it('stops asking once the session leaves the air or the event socket is lost', () => {
    const guard = new LiveExitGuard()
    guard.observeRecordingStatus(ON_AIR)
    guard.observeRecordingStatus({ state: 'stopping', sessionId: 's1' })
    expect(guard.shouldAsk('quit', true)).toBe(false)
    guard.observeRecordingStatus(ON_AIR)
    guard.transportLost()
    expect(guard.livestreamOnAir).toBe(false)
    expect(guard.shouldAsk('quit', true)).toBe(false)
  })

  it('does not hold an exit when no renderer can show the question', () => {
    const guard = new LiveExitGuard()
    guard.observeRecordingStatus(ON_AIR)
    expect(guard.shouldAsk('quit', false)).toBe(false)
    expect(guard.shouldAsk('close', false)).toBe(false)
  })
})
