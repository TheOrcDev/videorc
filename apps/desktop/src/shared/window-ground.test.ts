import { describe, expect, it } from 'vitest'

import {
  WINDOW_GROUND_ARGUMENT_PREFIX,
  windowGroundArgument,
  windowGroundFromArguments
} from './window-ground'

// Plan 208 S2: the ground rides the window's argv like the renderer role, so
// the preload can hand it to the theme bootstrap before the first paint.

describe('window ground argument', () => {
  it('round-trips every ground through the argv', () => {
    for (const ground of ['chrome', 'glass', 'solid'] as const) {
      const argument = windowGroundArgument(ground)
      expect(argument).toBe(`${WINDOW_GROUND_ARGUMENT_PREFIX}${ground}`)
      expect(
        windowGroundFromArguments(['electron', '--videorc-renderer-role=main', argument])
      ).toBe(ground)
    }
  })

  it('reads the final occurrence, so an inherited app argument cannot pick a window ground', () => {
    expect(
      windowGroundFromArguments(['--videorc-window-ground=glass', '--videorc-window-ground=chrome'])
    ).toBe('chrome')
  })

  it('returns null without an argument or with a value it does not know', () => {
    expect(windowGroundFromArguments([])).toBeNull()
    expect(windowGroundFromArguments(['electron', '--videorc-renderer-role=notes'])).toBeNull()
    expect(windowGroundFromArguments(['--videorc-window-ground=desktop'])).toBeNull()
    expect(windowGroundFromArguments(['--videorc-window-ground='])).toBeNull()
  })
})
