import { describe, expect, it } from 'vitest'

import { SmokeAppQuitGuard } from './smoke-app-quit-guard'

describe('SmokeAppQuitGuard', () => {
  it('blocks an unexpected quit only while the lifecycle probe owns the app', () => {
    const guard = new SmokeAppQuitGuard(true)

    expect(guard.shouldPreventQuit()).toBe(true)
    guard.allowQuit()
    expect(guard.shouldPreventQuit()).toBe(false)
  })

  it('never changes normal app quit behavior outside the lifecycle probe', () => {
    const guard = new SmokeAppQuitGuard(false)

    expect(guard.shouldPreventQuit()).toBe(false)
    guard.allowQuit()
    expect(guard.shouldPreventQuit()).toBe(false)
  })
})
