import { describe, expect, it } from 'vitest'

import type { StagePhase } from './scene-stage'
import { stageUndoControl } from './stage-undo-control'

// Plan 174 S3.9 (D15): the footer's Undo. Its mounted state must not follow
// the gesture: a footer that reflows at pointerdown shrinks the page, a pane
// scrolled to its end clamps its scrollTop, and that scroll cancels the very
// gesture that started (smoke:freeform-editor).

const PHASES: StagePhase[] = ['idle', 'dragging', 'pending']

describe('stageUndoControl', () => {
  it('keeps Undo mounted through every stage phase once there is something to undo', () => {
    for (const phase of PHASES) {
      const control = stageUndoControl({
        hasUndo: true,
        phase,
        sceneSwitchPending: false,
        preciseEditPending: false
      })
      expect(control.shown).toBe(true)
      expect(control.enabled).toBe(phase === 'idle')
    }
  })

  it('never mounts Undo without a layout change to take back', () => {
    for (const phase of PHASES) {
      expect(
        stageUndoControl({
          hasUndo: false,
          phase,
          sceneSwitchPending: false,
          preciseEditPending: false
        })
      ).toEqual({ shown: false, enabled: false })
    }
  })

  it('disables (never unmounts) Undo while a scene switch or a precise edit is in flight', () => {
    expect(
      stageUndoControl({
        hasUndo: true,
        phase: 'idle',
        sceneSwitchPending: true,
        preciseEditPending: false
      })
    ).toEqual({ shown: true, enabled: false })
    expect(
      stageUndoControl({
        hasUndo: true,
        phase: 'idle',
        sceneSwitchPending: false,
        preciseEditPending: true
      })
    ).toEqual({ shown: true, enabled: false })
  })
})
