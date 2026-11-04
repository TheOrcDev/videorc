import { describe, expect, it } from 'vitest'

import { smokeRaiseWindowPlacement } from './smoke-raise-window-level'

describe('smokeRaiseWindowPlacement', () => {
  it('lifts just above the floating backdrop by default', () => {
    expect(smokeRaiseWindowPlacement(undefined)).toEqual({ level: 'floating', relativeLevel: 1 })
    expect(smokeRaiseWindowPlacement('floating')).toEqual({ level: 'floating', relativeLevel: 1 })
  })

  it('lifts one above the screen-saver level for the invisibility smokes', () => {
    // The native motion stimulus is an NSPanel at .screenSaver (1000); the
    // window under test must sit above it or the gate never sees it.
    expect(smokeRaiseWindowPlacement('screen-saver')).toEqual({
      level: 'screen-saver',
      relativeLevel: 1
    })
  })

  it('refuses any other level', () => {
    expect(() => smokeRaiseWindowPlacement('normal')).toThrow(/floating.*screen-saver/)
    expect(() => smokeRaiseWindowPlacement(42)).toThrow(/got 42/)
  })
})
