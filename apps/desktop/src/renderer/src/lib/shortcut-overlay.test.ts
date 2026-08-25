import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  commandModifierKey,
  nextModifierHeldState,
  shortcutChipProps
} from '@/lib/shortcut-overlay'

describe('commandModifierKey', () => {
  it('uses the platform command key', () => {
    assert.equal(commandModifierKey('darwin'), 'Meta')
    assert.equal(commandModifierKey('win32'), 'Control')
    assert.equal(commandModifierKey('linux'), 'Control')
    // Before runtimeInfo arrives the platform is unknown. displayKeyGlyph
    // renders 'Ctrl' in that state, so the watched key must be Control — the
    // chip and the key it advertises can never disagree.
    assert.equal(commandModifierKey(undefined), 'Control')
  })
})

describe('nextModifierHeldState', () => {
  it('opens and closes with the real modifier state', () => {
    assert.equal(nextModifierHeldState(false, { kind: 'key', modifierDown: true }), true)
    assert.equal(nextModifierHeldState(true, { kind: 'key', modifierDown: false }), false)
  })

  it('is idempotent under key repeat', () => {
    // Holding ⌘ fires keydown over and over; every repeat must land on the
    // same state instead of flickering the chips.
    let state = false
    for (let index = 0; index < 5; index += 1) {
      state = nextModifierHeldState(state, { kind: 'key', modifierDown: true })
    }
    assert.equal(state, true)
  })

  it('stays open while a second key is pressed and released', () => {
    // ⌘ down, K down, K up — the modifier is still held throughout, so the
    // chips must not blink off when the non-modifier key is released.
    let state = nextModifierHeldState(false, { kind: 'key', modifierDown: true })
    state = nextModifierHeldState(state, { kind: 'key', modifierDown: true })
    state = nextModifierHeldState(state, { kind: 'key', modifierDown: true })
    assert.equal(state, true)
  })

  it('self-corrects when an event was missed', () => {
    // A keyup swallowed by a native menu leaves state stale; the next event
    // reports the true modifier state and repairs it.
    assert.equal(nextModifierHeldState(true, { kind: 'key', modifierDown: false }), false)
  })

  it('closes on blur so ⌘Tab cannot leave chips stuck on', () => {
    assert.equal(nextModifierHeldState(true, { kind: 'blur' }), false)
    assert.equal(nextModifierHeldState(false, { kind: 'blur' }), false)
  })

  it('closes when the window is hidden and leaves it alone when shown', () => {
    assert.equal(nextModifierHeldState(true, { kind: 'visibility', hidden: true }), false)
    // Becoming visible again must not GUESS that the key is down; the next
    // key event supplies the truth.
    assert.equal(nextModifierHeldState(false, { kind: 'visibility', hidden: false }), false)
    assert.equal(nextModifierHeldState(true, { kind: 'visibility', hidden: false }), true)
  })
})

describe('shortcutChipProps', () => {
  it('keeps chips mounted and out of the accessibility tree in both states', () => {
    for (const visible of [true, false]) {
      const props = shortcutChipProps(visible)
      assert.equal(props['aria-hidden'], true)
      assert.equal(props['data-visible'], visible ? 'true' : 'false')
      // Opacity, never display/hidden: the chip must keep its width so rows
      // do not reflow when the layer opens.
      assert.match(props.className, /opacity-(100|0)/)
      assert.doesNotMatch(props.className, /\bhidden\b/)
    }
  })

  it('fades in fast and respects reduced motion', () => {
    const props = shortcutChipProps(true)
    assert.match(props.className, /duration-100/)
    assert.match(props.className, /motion-reduce:transition-none/)
  })
})
