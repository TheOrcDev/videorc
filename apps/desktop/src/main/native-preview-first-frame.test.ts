import { describe, expect, it, vi } from 'vitest'

import {
  assessProofPresentationWatch,
  assessProofSourceFrame,
  assessFirstFrame,
  assessPresenting,
  boundedProofWatchdogRead,
  DEFAULT_FIRST_FRAME_BUDGETS,
  DEFAULT_PRESENTING_WATCH_BUDGETS,
  DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS,
  emptyFirstFrameLedger,
  emptyPresentingWatch,
  firstFrameBlockedReason,
  firstFrameContractMet,
  nativePreviewFirstFrameWatchdogEnabled,
  nativePreviewProofWatchdogEnabled,
  ProofWatchdogRendererReadSingleFlight,
  proofPresentationFallbackReason,
  proofWatchdogRendererReadAllowed,
  WatchdogTickOwnership,
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

describe('nativePreviewFirstFrameWatchdogEnabled', () => {
  it('runs the Metal first-frame contract only on macOS', () => {
    expect(nativePreviewFirstFrameWatchdogEnabled('darwin')).toBe(true)
    expect(nativePreviewFirstFrameWatchdogEnabled('win32')).toBe(false)
    expect(nativePreviewFirstFrameWatchdogEnabled('linux')).toBe(false)
  })
})

describe('nativePreviewProofWatchdogEnabled', () => {
  it('runs the independent proof liveness watch only on Windows', () => {
    expect(nativePreviewProofWatchdogEnabled('win32')).toBe(true)
    expect(nativePreviewProofWatchdogEnabled('darwin')).toBe(false)
    expect(nativePreviewProofWatchdogEnabled('linux')).toBe(false)
  })
})

describe('assessProofSourceFrame', () => {
  it('treats fresh Windows source frames as live and sustained gaps as stalled', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourcePollerCount: 1,
        freshSourceLayerCount: 1,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 125
      })
    ).toBe('met')
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourcePollerCount: 1,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 1_501
      })
    ).toBe('stalled')
  })

  it('does not diagnose intentional suppression or apply the proof contract to macOS', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: true,
        sourcePollerCount: 1,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 10_000
      })
    ).toBe('paused')
    expect(
      assessProofSourceFrame({
        platform: 'darwin',
        framePollingSuppressed: false,
        sourcePollerCount: 1,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 10_000
      })
    ).toBe('not-applicable')
  })

  it('does not report a stale prior source after switching to a static scene', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourceExpected: false,
        sourcePollerCount: 0,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false,
        sourceFrameAgeMs: 10_000
      })
    ).toBe('not-applicable')
  })

  it('keeps an expected Windows source pending while its poller initializes', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourceExpected: true,
        sourcePollerCount: 0,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false
      })
    ).toBe('pending')
  })

  it('requires every active source poller to remain fresh', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourcePollerCount: 2,
        freshSourceLayerCount: 1,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 1_501
      })
    ).toBe('stalled')
  })

  it('keeps a started poller pending until its first decoded frame reaches the startup budget', () => {
    expect(
      assessProofSourceFrame({
        platform: 'win32',
        framePollingSuppressed: false,
        sourceExpected: true,
        sourcePollerCount: 1,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false,
        sourceFrameAgeMs: 1_501
      })
    ).toBe('pending')
  })
})

describe('assessProofPresentationWatch', () => {
  it('declares a stalled Windows proof surface when the first frame never arrives', () => {
    expect(
      assessProofPresentationWatch({
        platform: 'win32',
        framePollingSuppressed: false,
        surfaceReady: false,
        sourceExpected: true,
        sourcePollerCount: 0,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false,
        pendingElapsedMs: DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS
      })
    ).toBe('stalled')
  })

  it('detects a dropped Windows proof pump after delivered source frames become stale', () => {
    expect(
      assessProofPresentationWatch({
        platform: 'win32',
        framePollingSuppressed: false,
        surfaceReady: true,
        sourceExpected: true,
        sourcePollerCount: 1,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 1_501,
        pendingElapsedMs: 0
      })
    ).toBe('stalled')
  })

  it('times out an expected source whose proof poller never initializes', () => {
    expect(
      assessProofPresentationWatch({
        platform: 'win32',
        framePollingSuppressed: false,
        surfaceReady: true,
        sourceExpected: true,
        sourcePollerCount: 0,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false,
        pendingElapsedMs: DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS
      })
    ).toBe('stalled')
  })

  it('accepts compositor-only output when the scene expects no polled source', () => {
    expect(
      assessProofPresentationWatch({
        platform: 'win32',
        framePollingSuppressed: false,
        surfaceReady: true,
        sourceExpected: false,
        sourcePollerCount: 0,
        freshSourceLayerCount: 0,
        sourceFrameHistoryComplete: false,
        pendingElapsedMs: DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS
      })
    ).toBe('not-applicable')
  })

  it('gives an initialized poller the full first-frame budget before declaring fallback', () => {
    const startup = {
      platform: 'win32' as const,
      framePollingSuppressed: false,
      surfaceReady: true,
      sourceExpected: true,
      sourcePollerCount: 1,
      freshSourceLayerCount: 0,
      sourceFrameHistoryComplete: false,
      sourceFrameAgeMs: 1_501
    }

    expect(
      assessProofPresentationWatch({
        ...startup,
        pendingElapsedMs: DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS - 1
      })
    ).toBe('pending')
    expect(
      assessProofPresentationWatch({
        ...startup,
        pendingElapsedMs: DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS
      })
    ).toBe('stalled')
  })
})

describe('proofPresentationFallbackReason', () => {
  it('does not claim a last good frame when startup never delivered one', () => {
    const reason = proofPresentationFallbackReason({
      sourceFrameHistoryComplete: false,
      sourceFrameAgeMs: 15_000,
      pendingElapsedMs: 15_000
    })

    expect(reason).toBe('Windows preview did not deliver a first frame within 15000ms.')
    expect(reason).not.toContain('last good frame')
  })

  it('identifies a post-live source stall and retained frame', () => {
    expect(
      proofPresentationFallbackReason({
        sourceFrameHistoryComplete: true,
        sourceFrameAgeMs: 1_501,
        pendingElapsedMs: 200
      })
    ).toBe(
      'Windows preview source frames have not advanced for 1501ms; keeping the last good frame while polling retries.'
    )
  })
})

describe('boundedProofWatchdogRead', () => {
  it('releases the watchdog when the proof renderer never answers', async () => {
    vi.useFakeTimers()
    try {
      const result = boundedProofWatchdogRead(new Promise<never>(() => undefined), 500)
      await vi.advanceTimersByTimeAsync(500)
      await expect(result).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ProofWatchdogRendererReadSingleFlight', () => {
  it('reuses one unresolved renderer read across repeated bounded timeouts', async () => {
    vi.useFakeTimers()
    try {
      const reads = new ProofWatchdogRendererReadSingleFlight<never>()
      const owner = { watchdogRun: {}, webContents: {} }
      const startRead = vi.fn(() => new Promise<never>(() => undefined))

      const first = reads.read(owner, startRead, 500)
      await vi.advanceTimersByTimeAsync(500)
      await expect(first).resolves.toBeNull()

      const second = reads.read(owner, startRead, 500)
      expect(second).toBe(first)
      expect(startRead).toHaveBeenCalledTimes(1)
      await expect(second).resolves.toBeNull()
      expect(startRead).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires an old run without letting its deferred settlement clear the reopened read', async () => {
    let resolveOld!: (value: string) => void
    let resolveReopened!: (value: string) => void
    const oldRead = new Promise<string>((resolve) => {
      resolveOld = resolve
    })
    const reopenedRead = new Promise<string>((resolve) => {
      resolveReopened = resolve
    })
    const reads = new ProofWatchdogRendererReadSingleFlight<string>()
    const webContents = {}
    const oldOwner = { watchdogRun: {}, webContents }
    const reopenedOwner = { watchdogRun: {}, webContents }
    const startRead = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(reopenedRead)

    const oldResult = reads.read(oldOwner, startRead)
    reads.retire(oldOwner)
    const reopenedResult = reads.read(reopenedOwner, startRead)
    resolveOld('old')
    await expect(oldResult).resolves.toBe('old')

    const reusedReopenedResult = reads.read(reopenedOwner, startRead)
    expect(startRead).toHaveBeenCalledTimes(2)
    resolveReopened('reopened')
    await expect(reopenedResult).resolves.toBe('reopened')
    await expect(reusedReopenedResult).resolves.toBe('reopened')
  })

  it('supersedes an unresolved read when the proof WebContents changes', async () => {
    let resolveOld!: (value: string) => void
    let resolveReplacement!: (value: string) => void
    const oldRead = new Promise<string>((resolve) => {
      resolveOld = resolve
    })
    const replacementRead = new Promise<string>((resolve) => {
      resolveReplacement = resolve
    })
    const reads = new ProofWatchdogRendererReadSingleFlight<string>()
    const watchdogRun = {}
    const oldOwner = { watchdogRun, webContents: {} }
    const replacementOwner = { watchdogRun, webContents: {} }
    const startRead = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(replacementRead)

    const oldResult = reads.read(oldOwner, startRead)
    const replacementResult = reads.read(replacementOwner, startRead)
    expect(startRead).toHaveBeenCalledTimes(2)

    resolveOld('old')
    await expect(oldResult).resolves.toBe('old')
    const reusedReplacementResult = reads.read(replacementOwner, startRead)
    expect(startRead).toHaveBeenCalledTimes(2)

    resolveReplacement('replacement')
    await expect(replacementResult).resolves.toBe('replacement')
    await expect(reusedReplacementResult).resolves.toBe('replacement')
  })
})

describe('WatchdogTickOwnership', () => {
  it('does not let a deferred old tick release the reopened watchdog tick', () => {
    const ownership = new WatchdogTickOwnership()
    const oldRun = ownership.startRun()
    const oldTick = ownership.tryAcquire(oldRun)
    expect(oldTick).not.toBeNull()

    ownership.stopRun(oldRun)
    const reopenedRun = ownership.startRun()
    const reopenedTick = ownership.tryAcquire(reopenedRun)
    expect(reopenedTick).not.toBeNull()
    expect(ownership.isCurrent(oldTick!)).toBe(false)

    ownership.stopRun(oldRun)
    ownership.release(oldTick!)
    expect(ownership.tryAcquire(reopenedRun)).toBeNull()

    ownership.release(reopenedTick!)
    expect(ownership.tryAcquire(reopenedRun)).not.toBeNull()
  })
})

describe('proofWatchdogRendererReadAllowed', () => {
  it('never waits on an intentionally hidden, suppressed, or non-painting proof window', () => {
    expect(
      proofWatchdogRendererReadAllowed({
        framePollingSuppressed: true,
        intentionallyHidden: false,
        proofWindowVisible: true
      })
    ).toBe(false)
    expect(
      proofWatchdogRendererReadAllowed({
        framePollingSuppressed: false,
        intentionallyHidden: true,
        proofWindowVisible: true
      })
    ).toBe(false)
    expect(
      proofWatchdogRendererReadAllowed({
        framePollingSuppressed: false,
        intentionallyHidden: false,
        proofWindowVisible: false
      })
    ).toBe(false)
    expect(
      proofWatchdogRendererReadAllowed({
        framePollingSuppressed: false,
        intentionallyHidden: false,
        proofWindowVisible: true
      })
    ).toBe(true)
  })
})

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
