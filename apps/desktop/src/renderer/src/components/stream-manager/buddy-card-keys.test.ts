// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { BUDDY_CARD_PRECEDENCE, buddyCardKeyTaker, registerBuddyCardKeys } from './buddy-card-keys'

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('Buddy card key precedence (plan 174 S3.14c, H-23)', () => {
  it('answers a voice command first, then a removal, then a proposed post', () => {
    expect(BUDDY_CARD_PRECEDENCE).toEqual(['command', 'removal', 'utterance'])
    expect(buddyCardKeyTaker(['utterance', 'removal'])).toBe('removal')
    expect(buddyCardKeyTaker(['utterance', 'command', 'removal'])).toBe('command')
    expect(buddyCardKeyTaker(['utterance'])).toBe('utterance')
    expect(buddyCardKeyTaker([])).toBeNull()
  })

  it('lets the first taker keep the key, and passes a key nobody takes along', () => {
    const removal = vi.fn(() => true)
    const utterance = vi.fn(() => true)
    const offUtterance = registerBuddyCardKeys('utterance', utterance)
    const offRemoval = registerBuddyCardKeys('removal', removal)
    press('Enter')
    expect(removal).toHaveBeenCalledTimes(1)
    expect(utterance).not.toHaveBeenCalled()
    // A removal that declines the key (a focused composer) lets the next answer.
    removal.mockReturnValueOnce(false)
    press('Enter')
    expect(utterance).toHaveBeenCalledTimes(1)
    offRemoval()
    press('Escape')
    expect(utterance).toHaveBeenCalledTimes(2)
    offUtterance()
    press('Enter')
    expect(utterance).toHaveBeenCalledTimes(2)
    expect(removal).toHaveBeenCalledTimes(2)
  })
})
