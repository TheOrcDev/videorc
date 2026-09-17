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

describe('nextModifierHeldState — sources beyond this window', () => {
  it('closes when a page shortcut fires', () => {
    // ⌘1–⌘9 are intercepted by the main process, so this window never sees the
    // chord and, in practice, never sees the keyup that ends it. Without this
    // the chips stayed on screen after every ⌘+digit.
    assert.equal(nextModifierHeldState(true, { kind: 'shortcut-fired' }), false)
  })

  it('takes the main process as the authority in both directions', () => {
    assert.equal(nextModifierHeldState(false, { kind: 'main', modifierDown: true }), true)
    // Stale local state must lose to a fresher reading from main.
    assert.equal(nextModifierHeldState(true, { kind: 'main', modifierDown: false }), false)
  })

  it('repairs a stuck layer on pointer movement without the modifier', () => {
    assert.equal(nextModifierHeldState(true, { kind: 'pointer', modifierDown: false }), false)
  })

  it('keeps the layer up while the mouse moves WITH the modifier held', () => {
    // Reaching for the mouse mid-⌘ must not hide the shortcuts you are reading.
    assert.equal(nextModifierHeldState(true, { kind: 'pointer', modifierDown: true }), true)
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

  it('reveals with a fade, a slide and a scale — and hides instantly', () => {
    const shown = shortcutChipProps(true)
    assert.match(shown.className, /duration-\[120ms\]/)
    assert.match(shown.className, /translate-x-0/)
    assert.match(shown.className, /scale-100/)
    // Hiding has no transition: a keyboard layer that lingers after the key is
    // released reads as lag, not polish.
    const hidden = shortcutChipProps(false)
    assert.match(hidden.className, /duration-0/)
    assert.match(hidden.className, /translate-x-1/)
    assert.match(hidden.className, /scale-\[0\.98\]/)
  })

  it('cascades down the list on reveal and never on hide', () => {
    assert.equal(shortcutChipProps(true, 0).style.transitionDelay, undefined)
    assert.equal(shortcutChipProps(true, 3).style.transitionDelay, '36ms')
    // Capped, so the last row is still fast — the cascade is a texture, not a wait.
    assert.equal(shortcutChipProps(true, 50).style.transitionDelay, '96ms')
    assert.equal(shortcutChipProps(false, 5).style.transitionDelay, undefined)
  })

  it('drops the transform under reduced motion, and can drop the cascade too', () => {
    const props = shortcutChipProps(true, 4)
    assert.match(props.className, /motion-reduce:transition-opacity/)
    assert.match(props.className, /motion-reduce:transform-none/)
    // The cascade is an inline delay, which no CSS variant can reach — the
    // caller opts out by passing index 0 (see the sidebar's reduced-motion
    // read). Proving the opt-out works is the most this pure function can do.
    assert.equal(shortcutChipProps(true, 0).style.transitionDelay, undefined)
  })
})
