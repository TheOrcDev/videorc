import type { StagePhase } from './scene-stage'

/**
 * The stage footer's Undo (plan 174 S3.9, D15), as mounted and enabled
 * states that are decided separately on purpose.
 *
 * Nothing on the Scene page may change size when a pointer gesture starts:
 * the stage cancels its gesture on any `scroll`, and a page that shrinks
 * under a pane scrolled to its end clamps that pane's `scrollTop`, which IS a
 * scroll. Unmounting Undo at `dragging` reflowed the wrapping footer by one
 * line and killed every drag that started with the pane scrolled down
 * (`smoke:freeform-editor`, "pointer capture was not acquired"). So Undo
 * stays mounted while there is a layout change to take back, and only its
 * enabled state follows the gesture, the commit, the precise edit and the
 * scene switch in flight.
 */
export function stageUndoControl({
  hasUndo,
  phase,
  sceneSwitchPending,
  preciseEditPending
}: {
  /** A committed layout change exists to take back. */
  hasUndo: boolean
  phase: StagePhase
  sceneSwitchPending: boolean
  preciseEditPending: boolean
}): { shown: boolean; enabled: boolean } {
  const shown = hasUndo
  const enabled = shown && phase === 'idle' && !sceneSwitchPending && !preciseEditPending
  return { shown, enabled }
}
