import { describe, expect, it } from 'vitest'

import {
  assessFirstFrame,
  assessPresenting,
  DEFAULT_FIRST_FRAME_BUDGETS,
  DEFAULT_PRESENTING_WATCH_BUDGETS,
  emptyFirstFrameLedger,
  emptyPresentingWatch,
  firstFrameBlockedReason,
  firstFrameContractMet,
  type FirstFrameSnapshot,
  type PresentingWatchState
} from './native-preview-first-frame'

function snapshot(overrides: Partial<FirstFrameSnapshot> = {}): FirstFrameSnapshot {
  return {
    elapsedMs: 0,
    surfaceLive: true,
    nativePresenting: true,
    framesAdvancing: true,
    presentationAdvancing: true,
    rendererSceneRevision: 42,
    compositorSceneRevision: 42,
    compositorFrameSceneRevision: 42,
    metalTargetPresent: true,
    ...overrides
  }
}

describe('firstFrameContractMet', () => {
  it('is met only when the whole chain agrees and advances', () => {
    expect(firstFrameContractMet(snapshot())).toBe(true)
    expect(firstFrameContractMet(snapshot({ surfaceLive: false }))).toBe(false)
    expect(firstFrameContractMet(snapshot({ nativePresenting: false }))).toBe(false)
    expect(firstFrameContractMet(snapshot({ framesAdvancing: false }))).toBe(false)
    // A first frame can satisfy startup before a second native frame exists;
    // steady-state assessment below adds the advancement requirement.
    expect(firstFrameContractMet(snapshot({ presentationAdvancing: false }))).toBe(true)
    expect(firstFrameContractMet(snapshot({ metalTargetPresent: false }))).toBe(false)
    expect(firstFrameContractMet(snapshot({ rendererSceneRevision: null }))).toBe(false)
    expect(firstFrameContractMet(snapshot({ compositorSceneRevision: 41 }))).toBe(false)
    expect(firstFrameContractMet(snapshot({ compositorFrameSceneRevision: 41 }))).toBe(false)
  })
})

describe('firstFrameBlockedReason', () => {
  it('names the first blocked link in chain order', () => {
    expect(firstFrameBlockedReason(snapshot({ surfaceLive: false }))).toMatch(/surface is starting/)
    expect(firstFrameBlockedReason(snapshot({ rendererSceneRevision: null }))).toMatch(
      /commit its scene/
    )
    // A foreign/stale compositor scene (2026-07-01 incident: smoke scene held the
    // compositor while the app had committed a different revision).
    expect(
      firstFrameBlockedReason(snapshot({ compositorSceneRevision: 7, rendererSceneRevision: 42 }))
    ).toBe('Compositor is on scene revision 7, but the app committed 42.')
    expect(
      firstFrameBlockedReason(
        snapshot({ compositorFrameSceneRevision: 41, compositorSceneRevision: 42 })
      )
    ).toBe('Waiting for the compositor to render scene revision 42.')
    expect(firstFrameBlockedReason(snapshot({ metalTargetPresent: false }))).toMatch(
      /Metal IOSurface target/
    )
    expect(firstFrameBlockedReason(snapshot({ framesAdvancing: false }))).toMatch(
      /frames are not advancing/
    )
    expect(firstFrameBlockedReason(snapshot({ presentationAdvancing: false }))).toMatch(
      /native presentation is not advancing/i
    )
    expect(firstFrameBlockedReason(snapshot({ nativePresenting: false }))).toMatch(
      /Native presenter/
    )
  })
})

describe('assessFirstFrame', () => {
  it('reports met and leaves the ledger untouched', () => {
    const ledger = emptyFirstFrameLedger()
    const { assessment } = assessFirstFrame(snapshot({ elapsedMs: 500 }), ledger)
    expect(assessment).toEqual({ kind: 'met' })
  })

  it('is pending (no heal) before the first action budget', () => {
    const { assessment } = assessFirstFrame(
      snapshot({ elapsedMs: 800, nativePresenting: false }),
      emptyFirstFrameLedger()
    )
    expect(assessment.kind).toBe('pending')
  })

  it('fires present-kick first for a generic stall', () => {
    const { assessment, ledger } = assessFirstFrame(
      snapshot({ elapsedMs: 1600, framesAdvancing: false, nativePresenting: false }),
      emptyFirstFrameLedger()
    )
    expect(assessment).toMatchObject({ kind: 'heal', action: 'present-kick' })
    expect(ledger.attempts['present-kick']).toBe(1)
    expect(ledger.lastActionAtMs).toBe(1600)
  })

  it('goes straight to resync-scene when the compositor holds a foreign scene', () => {
    const { assessment } = assessFirstFrame(
      snapshot({
        elapsedMs: 3200,
        compositorSceneRevision: 999999,
        compositorFrameSceneRevision: 999999,
        nativePresenting: false
      }),
      emptyFirstFrameLedger()
    )
    expect(assessment).toMatchObject({ kind: 'heal', action: 'resync-scene' })
  })

  it('goes straight to reset-native-path when frames render but native never presents', () => {
    const { assessment } = assessFirstFrame(
      snapshot({ elapsedMs: 6500, nativePresenting: false }),
      emptyFirstFrameLedger()
    )
    expect(assessment).toMatchObject({ kind: 'heal', action: 'reset-native-path' })
  })

  it('spaces actions and caps attempts per action', () => {
    let ledger = emptyFirstFrameLedger()
    const stall = (elapsedMs: number) =>
      snapshot({ elapsedMs, framesAdvancing: false, nativePresenting: false })

    let result = assessFirstFrame(stall(1600), ledger)
    expect(result.assessment).toMatchObject({ kind: 'heal', action: 'present-kick' })
    ledger = result.ledger

    // Too soon after the last action: pending, not another heal.
    result = assessFirstFrame(stall(2200), ledger)
    expect(result.assessment.kind).toBe('pending')

    result = assessFirstFrame(stall(2900), ledger)
    expect(result.assessment).toMatchObject({ kind: 'heal', action: 'present-kick' })
    ledger = result.ledger

    // present-kick exhausted (2 attempts): the ladder moves on.
    result = assessFirstFrame(stall(4200), ledger)
    expect(result.assessment).toMatchObject({ kind: 'heal', action: 'resync-scene' })
  })

  it('declares fallback with the truthful reason after the budget', () => {
    const { assessment } = assessFirstFrame(
      snapshot({ elapsedMs: 15001, metalTargetPresent: false, nativePresenting: false }),
      emptyFirstFrameLedger()
    )
    expect(assessment).toMatchObject({ kind: 'fallback' })
    expect((assessment as { reason: string }).reason).toMatch(/Metal IOSurface target/)
  })

  it('keeps the default budgets ordered cheapest-first', () => {
    const budgets = DEFAULT_FIRST_FRAME_BUDGETS
    expect(budgets.presentKickAfterMs).toBeLessThan(budgets.resyncSceneAfterMs)
    expect(budgets.resyncSceneAfterMs).toBeLessThan(budgets.resetNativePathAfterMs)
    expect(budgets.resetNativePathAfterMs).toBeLessThan(budgets.declareFallbackAfterMs)
  })
})

// Mid-session presenting contract (plan 021 F1): after the first frame lands,
// the same chain snapshot keeps being watched. A stall re-enters the healing
// ladder; exhaustion declares a truthful stall but KEEPS watching so a revival
// (the reporter's "click brings it back") re-arms a fresh ladder instead of
// leaving the placeholder forever.
describe('assessPresenting', () => {
  const TICK_MS = 750

  function run(
    snapshots: FirstFrameSnapshot[],
    watch: PresentingWatchState = emptyPresentingWatch()
  ): { kinds: string[]; watch: PresentingWatchState; last: ReturnType<typeof assessPresenting> } {
    const kinds: string[] = []
    let last: ReturnType<typeof assessPresenting> | null = null
    for (const snap of snapshots) {
      last = assessPresenting(snap, watch, TICK_MS)
      watch = last.watch
      kinds.push(last.assessment.kind)
    }
    return { kinds, watch, last: last! }
  }

  const broken = (overrides: Partial<FirstFrameSnapshot> = {}) =>
    snapshot({ surfaceLive: false, nativePresenting: false, ...overrides })

  it('reports presenting and stays quiet while the chain is healthy', () => {
    const { kinds } = run([snapshot(), snapshot(), snapshot()])
    expect(kinds).toEqual(['presenting', 'presenting', 'presenting'])
  })

  it('observes a transient stall without healing before the tick threshold', () => {
    const { kinds } = run([broken(), broken()])
    expect(kinds).toEqual(['observing', 'observing'])
  })

  it('treats advancing compositor frames with a frozen native presentation as a stall', () => {
    const frozenPresentation = snapshot({ presentationAdvancing: false })
    const { kinds, last } = run([frozenPresentation, frozenPresentation, frozenPresentation])

    expect(kinds).toEqual(['observing', 'observing', 'heal'])
    expect(last.assessment).toMatchObject({
      kind: 'heal',
      action: 'present-kick',
      reason: 'Native presentation is not advancing.'
    })
  })

  it('a healthy tick resets the stall counter', () => {
    const { kinds } = run([broken(), broken(), snapshot(), broken(), broken()])
    expect(kinds).toEqual(['observing', 'observing', 'presenting', 'observing', 'observing'])
  })

  // Plan 024 S4: the wait hint may only be painted for 'heal'/'stalled'. A
  // single broken tick from a focus/click re-kick on a healthy preview must
  // stay 'observing' (silent) — never a reason string — so the fallback hint is
  // never un-hidden. Only 'heal'/'stalled' emit a non-empty reason.
  it('a lone broken tick between healthy ticks never surfaces a wait-detail reason', () => {
    const REASON_KINDS = new Set(['heal', 'stalled'])
    const { kinds, last } = run([snapshot(), broken(), snapshot(), snapshot()])
    expect(kinds).toEqual(['presenting', 'observing', 'presenting', 'presenting'])
    expect(kinds.some((kind) => REASON_KINDS.has(kind))).toBe(false)
    expect(last.assessment.kind).toBe('presenting')
  })

  it('arms the ladder after the threshold, cheapest action first and immediately', () => {
    const { last } = run([broken(), broken(), broken()])
    expect(last.assessment).toMatchObject({ kind: 'heal', action: 'present-kick' })
    expect((last.assessment as { reason: string }).reason).toMatch(/surface is starting/)
  })

  it('escalates through the ladder and declares a stall when exhausted, then re-arms after recovery', () => {
    // Drive broken ticks until the ladder exhausts its budget.
    const ticksToExhaust = Math.ceil(
      DEFAULT_PRESENTING_WATCH_BUDGETS.healing.declareFallbackAfterMs / TICK_MS
    )
    const { kinds, watch } = run(Array.from({ length: ticksToExhaust + 4 }, () => broken()))
    expect(kinds).toContain('heal')
    expect(kinds[kinds.length - 1]).toBe('stalled')
    // Still stalled on further broken ticks — no healing spam.
    const stalledAgain = run([broken()], watch)
    expect(stalledAgain.kinds).toEqual(['stalled'])
    // Recovery (e.g. the user's click revived it) resets everything...
    const recovered = run([snapshot()], stalledAgain.watch)
    expect(recovered.kinds).toEqual(['presenting'])
    // ...so the NEXT stall re-arms a fresh ladder instead of staying stalled.
    const rearmed = run([broken(), broken(), broken()], recovered.watch)
    expect(rearmed.last.assessment).toMatchObject({ kind: 'heal', action: 'present-kick' })
  })

  it('never fires the disruptive path reset for a soft stall (only frames not advancing)', () => {
    // Everything healthy except framesAdvancing: could be a legitimately static
    // scene, so tearing down the native path would blink a fine preview.
    const soft = () => snapshot({ framesAdvancing: false })
    const ticks = Math.ceil(
      (DEFAULT_PRESENTING_WATCH_BUDGETS.healing.declareFallbackAfterMs + 5000) / TICK_MS
    )
    const { kinds } = run(Array.from({ length: ticks }, () => soft()))
    const heals = kinds.filter((kind) => kind === 'heal')
    expect(heals.length).toBeGreaterThan(0)
    // Re-run collecting actions to assert none was reset-native-path.
    let watch = emptyPresentingWatch()
    for (let i = 0; i < ticks; i++) {
      const result = assessPresenting(soft(), watch, TICK_MS)
      watch = result.watch
      if (result.assessment.kind === 'heal') {
        expect(result.assessment.action).not.toBe('reset-native-path')
      }
    }
  })
})
