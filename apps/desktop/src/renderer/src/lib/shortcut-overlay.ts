import { isMacPlatform } from '@/lib/platform'

/**
 * The sidebar's shortcut layer: key chips stay hidden until the user reaches
 * for the command modifier, then fade in together.
 *
 * The shortcuts themselves are always live — the chips are only the reminder,
 * and a reminder that never goes away stops being read and starts being
 * noise. Holding ⌘ is also how people ASK "what can I press here", so the
 * chips arrive exactly when the question is asked.
 *
 * The state machine lives here rather than in the hook so it can be tested
 * without a DOM (the desktop suite runs in node, per vitest.config.ts).
 */

/** The physical key that opens the shortcut layer: ⌘ on macOS, Ctrl elsewhere. */
export type ModifierKey = 'Meta' | 'Control'

export function commandModifierKey(platform: string | undefined): ModifierKey {
  return isMacPlatform(platform) ? 'Meta' : 'Control'
}

/**
 * A DOM event reduced to only what the state machine needs. `modifierDown`
 * comes from `KeyboardEvent.getModifierState`, which reports the REAL state
 * of the key rather than what the last event implied — that is what lets a
 * missed event self-correct on the next one.
 */
export type ModifierProbe =
  /** A keydown/keyup the window actually received. */
  | { kind: 'key'; modifierDown: boolean }
  /**
   * The authoritative reading from the main process. Main intercepts ⌘1–⌘9 in
   * `before-input-event`, so those chords — and in practice the keyup that
   * ends them — never reach this window at all. Main still sees every one, so
   * its reading wins over anything derived from DOM events.
   */
  | { kind: 'main'; modifierDown: boolean }
  /** A page shortcut fired: the reminder has served its purpose. */
  | { kind: 'shortcut-fired' }
  /**
   * Pointer movement, carrying the modifier state the event was born with.
   * A last-resort repair: if the layer is somehow stuck, it clears the moment
   * the user moves the mouse — while moving the mouse WITH ⌘ held keeps it up.
   */
  | { kind: 'pointer'; modifierDown: boolean }
  | { kind: 'blur' }
  | { kind: 'visibility'; hidden: boolean }

/**
 * Next visibility state for the shortcut layer.
 *
 * `blur` and a hidden document force it closed: when ⌘Tab, ⌘Q or a native
 * menu takes focus mid-press, the window never receives the `keyup`, so
 * without this the chips would stay stuck on until the next key press.
 *
 * Every source that carries a modifier reading is treated the same way —
 * whoever spoke last saw the key most recently. That is deliberate: the DOM
 * signal is lossy for ⌘+digit chords, and main's is not, so the layer must
 * never prefer stale local state over a fresher reading from anywhere.
 */
export function nextModifierHeldState(current: boolean, probe: ModifierProbe): boolean {
  switch (probe.kind) {
    case 'key':
    case 'main':
    case 'pointer':
      return probe.modifierDown
    case 'shortcut-fired':
      return false
    case 'blur':
      return false
    case 'visibility':
      return probe.hidden ? false : current
  }
}

/** Reveal cascades down the list at this step, so it reads as one motion. */
const CHIP_STAGGER_MS = 12
/** …but the last row still arrives fast; the cascade is a texture, not a wait. */
const CHIP_STAGGER_MAX_MS = 96

/**
 * Presentation for one key chip in the sidebar.
 *
 * The chip is always MOUNTED — hiding it with opacity keeps its width
 * reserved, so rows do not reflow the instant ⌘ goes down — and always
 * `aria-hidden`, because the row's own `aria-keyshortcuts` is what assistive
 * tech reads.
 *
 * Reveal is a 120ms fade with a 1px slide and a scale from 0.98 (the design
 * language's panel motion, borrowed at chip scale), staggered by row so the
 * layer cascades instead of flashing on as a block. Hiding is instant and
 * unstaggered: a keyboard layer that lingers after the key is released reads
 * as lag, not polish.
 *
 * Reduced motion is handled in two halves, because it has to be: the
 * transform is dropped by Tailwind's `motion-reduce:` variant, but the
 * cascade is an inline delay computed at runtime, which no CSS variant can
 * see — so callers pass `index: 0` when the user asked for less motion.
 *
 * @param index Row position, for the cascade. Pass 0 to opt out.
 */
export function shortcutChipProps(
  visible: boolean,
  index = 0
): {
  'aria-hidden': true
  'data-videorc-nav-shortcut': string
  'data-visible': 'true' | 'false'
  className: string
  style: { transitionDelay?: string }
} {
  const delayMs = visible ? Math.min(index * CHIP_STAGGER_MS, CHIP_STAGGER_MAX_MS) : 0
  return {
    'aria-hidden': true,
    'data-videorc-nav-shortcut': '',
    'data-visible': visible ? 'true' : 'false',
    className: [
      'transition-[opacity,transform] ease-out motion-reduce:transition-opacity',
      'motion-reduce:transform-none',
      visible
        ? 'opacity-100 translate-x-0 scale-100 duration-[120ms]'
        : 'opacity-0 translate-x-1 scale-[0.98] duration-0'
    ].join(' '),
    style: delayMs > 0 ? { transitionDelay: `${delayMs}ms` } : {}
  }
}
