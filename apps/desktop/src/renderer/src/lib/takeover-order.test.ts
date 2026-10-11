import { describe, expect, it } from 'vitest'

import { takeoverMoveKeyStep, takeoverMoveTarget } from '@/lib/takeover-order'

const key = (overrides: Partial<Parameters<typeof takeoverMoveKeyStep>[0]>) =>
  takeoverMoveKeyStep({
    key: 'ArrowLeft',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    inTextField: false,
    ...overrides
  })

describe('takeover order (plan 174 C-17)', () => {
  it('moves within the list and stops at its ends', () => {
    expect(takeoverMoveTarget(1, -1, 3)).toBe(0)
    expect(takeoverMoveTarget(1, 1, 3)).toBe(2)
    expect(takeoverMoveTarget(0, -1, 3)).toBeNull()
    expect(takeoverMoveTarget(2, 1, 3)).toBeNull()
    expect(takeoverMoveTarget(-1, 1, 3)).toBeNull()
  })

  it('answers Alt+← and Alt+→ only, and leaves text fields their keys', () => {
    expect(key({})).toBe(-1)
    expect(key({ key: 'ArrowRight' })).toBe(1)
    expect(key({ altKey: false })).toBeNull()
    expect(key({ shiftKey: true })).toBeNull()
    expect(key({ metaKey: true })).toBeNull()
    expect(key({ inTextField: true })).toBeNull()
    expect(key({ key: 'ArrowUp' })).toBeNull()
  })
})
