// Plan 174 S3.10 (C-17): takeovers reorder from the keyboard too, never only
// by dragging (WCAG 2.1.1, 2.5.7). Move earlier and Move later are buttons on
// each tile, and Alt+← / Alt+→ do the same while the tile holds focus.

/** The accelerators the Move buttons show (ShortcutKeys) and the tile answers. */
export const MOVE_EARLIER_ACCELERATOR = 'Alt+Left'
export const MOVE_LATER_ACCELERATOR = 'Alt+Right'

/** Where a move by `step` lands, or null when it can't move that way. */
export function takeoverMoveTarget(index: number, step: -1 | 1, count: number): number | null {
  const target = index + step
  return index < 0 || target < 0 || target >= count ? null : target
}

/**
 * Alt+← or Alt+→ alone (no other modifier) on a tile: the step, else null.
 * A text field keeps the keys (Alt+arrow moves by word there).
 */
export function takeoverMoveKeyStep(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  inTextField: boolean
}): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.inTextField) {
    return null
  }
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null
}
