import { describe, expect, it } from 'vitest'

import {
  FIRST_FRAME_DECISION_LIMIT,
  FIRST_FRAME_DECISION_REASON_CHARS,
  FirstFrameDecisionLog,
  firstFrameSnapshotEvidence
} from './first-frame-decisions'
import type { FirstFrameSnapshot } from './native-preview-first-frame'

// Plan 216 D3: the bundle says why the Preview fell back.

const snapshot: FirstFrameSnapshot = {
  elapsedMs: 5250.4,
  surfaceLive: true,
  nativePresenting: true,
  framesAdvancing: true,
  presentationAdvancing: false,
  rendererSceneRevision: 7,
  compositorSceneRevision: 7,
  compositorFrameSceneRevision: 7,
  metalTargetPresent: true,
  previewHold: null,
  dockHidden: null
}

describe('FirstFrameDecisionLog', () => {
  it('keeps the newest 20 decisions, oldest first', () => {
    let tick = 0
    const log = new FirstFrameDecisionLog(
      undefined,
      () => new Date(Date.UTC(2026, 10, 3, 14, 51, tick++))
    )
    for (let index = 0; index < FIRST_FRAME_DECISION_LIMIT + 5; index += 1) {
      log.record({ watch: 'presenting-watch', decision: 'heal', reason: `step ${index}` })
    }
    const entries = log.snapshot()
    expect(entries).toHaveLength(FIRST_FRAME_DECISION_LIMIT)
    expect(entries[0]?.reason).toBe('step 5')
    expect(entries.at(-1)?.reason).toBe(`step ${FIRST_FRAME_DECISION_LIMIT + 4}`)
    expect(entries.at(-1)?.at).toBe('2026-11-03T14:51:24.000Z')
  })

  it('records the reason, the action and what the watchdog saw', () => {
    const log = new FirstFrameDecisionLog(20, () => new Date('2026-11-03T14:51:40.000Z'))
    log.record({
      watch: 'presenting-watch',
      decision: 'heal',
      action: 'reset-native-path',
      reason: 'native presentation is not advancing',
      evidence: firstFrameSnapshotEvidence(snapshot, { brokenTicks: 9, stallElapsedMs: 6750 })
    })
    expect(log.snapshot()).toEqual([
      {
        at: '2026-11-03T14:51:40.000Z',
        watch: 'presenting-watch',
        decision: 'heal',
        action: 'reset-native-path',
        reason: 'native presentation is not advancing',
        evidence: {
          elapsedMs: 5250,
          surfaceLive: true,
          nativePresenting: true,
          framesAdvancing: true,
          presentationAdvancing: false,
          rendererSceneRevision: 7,
          compositorSceneRevision: 7,
          compositorFrameSceneRevision: 7,
          metalTargetPresent: true,
          previewHold: null,
          dockHidden: null,
          brokenTicks: 9,
          stallElapsedMs: 6750
        }
      }
    ])
  })

  it('caps a runaway reason and never hands out its own entries', () => {
    const log = new FirstFrameDecisionLog()
    const evidence = { hadDriver: true }
    log.record({
      watch: 'presenter',
      decision: 'presenter-retired',
      reason: 'x'.repeat(FIRST_FRAME_DECISION_REASON_CHARS * 2),
      evidence
    })
    evidence.hadDriver = false
    const [entry] = log.snapshot()
    expect(entry?.reason).toHaveLength(FIRST_FRAME_DECISION_REASON_CHARS)
    expect(entry?.reason?.endsWith('…')).toBe(true)
    expect(entry?.evidence).toEqual({ hadDriver: true })
    if (entry?.evidence) entry.evidence.hadDriver = false
    expect(log.snapshot()[0]?.evidence).toEqual({ hadDriver: true })
  })
})
