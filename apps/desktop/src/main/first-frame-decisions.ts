import type { FirstFrameDecisionEvidence, FirstFrameDecisionRecord } from '../shared/backend'
import type { FirstFrameSnapshot } from './native-preview-first-frame'

// The first-frame watchdog's last decisions, for the support bundle (plan
// 216 D3).
//
// A streamer's bundle said only "Native preview presenting watchdog
// requested a clean presenter." about why their Preview ran on the fallback
// window: the watchdog's `[first-frame]` and `[preview-watch]` lines went to
// main's log, which the bundle does not carry. Each decision that changes
// the Preview (a heal, a declared fallback or stall, the contract met or
// recovered, a presenter retired) now lands here with the evidence it saw,
// and rides into the bundle via runtimeInfo.firstFrameDecisions. Pending and
// observing ticks are not decisions and are never kept.
//
// Pure, so the bound is unit-testable; index.ts records into one instance.

export type { FirstFrameDecisionEvidence, FirstFrameDecisionRecord } from '../shared/backend'

/** Decisions kept: newest last. A full healing ladder and its outcome fit. */
export const FIRST_FRAME_DECISION_LIMIT = 20
/** Cap on a reason, so a runaway presenter message cannot bloat the bundle. */
export const FIRST_FRAME_DECISION_REASON_CHARS = 400

export class FirstFrameDecisionLog {
  private readonly entries: FirstFrameDecisionRecord[] = []

  constructor(
    private readonly limit = FIRST_FRAME_DECISION_LIMIT,
    private readonly now: () => Date = () => new Date()
  ) {}

  record(decision: Omit<FirstFrameDecisionRecord, 'at'>): void {
    this.entries.push({
      at: this.now().toISOString(),
      ...decision,
      ...(decision.reason !== undefined
        ? { reason: truncateReason(decision.reason, FIRST_FRAME_DECISION_REASON_CHARS) }
        : {}),
      ...(decision.evidence ? { evidence: { ...decision.evidence } } : {})
    })
    // A full log drops its oldest "met" or "recovered" first: every Preview
    // open meets the contract again, and those must never push out the
    // fallback a bundle exported later is meant to explain.
    while (this.entries.length > this.limit) {
      const routine = this.entries.findIndex(
        (entry) => entry.decision === 'met' || entry.decision === 'recovered'
      )
      this.entries.splice(routine === -1 ? 0 : routine, 1)
    }
  }

  snapshot(): FirstFrameDecisionRecord[] {
    return this.entries.map((entry) => ({
      ...entry,
      ...(entry.evidence ? { evidence: { ...entry.evidence } } : {})
    }))
  }
}

/** What the watchdog saw on the tick it decided, as flat bundle evidence. */
export function firstFrameSnapshotEvidence(
  snapshot: FirstFrameSnapshot,
  extra: FirstFrameDecisionEvidence = {}
): FirstFrameDecisionEvidence {
  return {
    elapsedMs: Math.round(snapshot.elapsedMs),
    surfaceLive: snapshot.surfaceLive,
    nativePresenting: snapshot.nativePresenting,
    framesAdvancing: snapshot.framesAdvancing,
    presentationAdvancing: snapshot.presentationAdvancing,
    rendererSceneRevision: snapshot.rendererSceneRevision,
    compositorSceneRevision: snapshot.compositorSceneRevision,
    compositorFrameSceneRevision: snapshot.compositorFrameSceneRevision,
    metalTargetPresent: snapshot.metalTargetPresent,
    previewHold: snapshot.previewHold,
    dockHidden: snapshot.dockHidden,
    ...extra
  }
}

function truncateReason(reason: string, maxChars: number): string {
  return reason.length > maxChars ? `${reason.slice(0, maxChars - 1)}…` : reason
}
