import { describe, expect, it } from 'vitest'

import type { CaptionsUpdate } from '@/lib/backend'
import {
  appendCaptionLine,
  captionDwellMs,
  captionLineAboveFloor,
  captionOverlayKey,
  captionOverlayTargetPlan,
  captionSessionFloor,
  CaptionCueRenderGuard,
  captionStripLines,
  captionsStatusIsActive,
  decideCaptionsRuntimeIntent,
  decideOverlayPush,
  LatestWinsScheduler,
  latestFinalCaptionText,
  shouldCancelCaptionCueRender
} from './captions-ui'

describe('CaptionCueRenderGuard', () => {
  it('invalidates queued cue renders on supersession and authoritative clear', () => {
    const guard = new CaptionCueRenderGuard()
    const first = guard.begin()
    expect(guard.isCurrent(first)).toBe(true)

    const replacement = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(replacement)).toBe(true)

    guard.cancel()
    expect(guard.isCurrent(replacement)).toBe(false)
  })

  it('purges on sign-out without cancelling normal final-copy boundaries', () => {
    expect(shouldCancelCaptionCueRender('signed-out')).toBe(true)
    expect(shouldCancelCaptionCueRender('capture-ended')).toBe(false)
    expect(shouldCancelCaptionCueRender('blocked')).toBe(false)
    expect(shouldCancelCaptionCueRender(undefined)).toBe(false)
  })
})

const update = (seq: number, overrides: Partial<CaptionsUpdate> = {}): CaptionsUpdate => ({
  sessionClientId: 'captions-session-a',
  seq,
  text: `line ${seq}`,
  chunkSeconds: 3,
  ...overrides
})

describe('appendCaptionLine', () => {
  it('appends in order, replaces same-seq updates, drops older seqs', () => {
    let lines: CaptionsUpdate[] = []
    lines = appendCaptionLine(lines, update(1))
    lines = appendCaptionLine(lines, update(2, { kind: 'partial', text: 'hel' }))
    // Streaming: the same utterance refines partial → partial → final.
    lines = appendCaptionLine(lines, update(2, { kind: 'partial', text: 'hello there' }))
    lines = appendCaptionLine(lines, update(2, { kind: 'final', text: 'Hello there.' }))
    lines = appendCaptionLine(lines, update(1))
    expect(lines.map((line) => line.seq)).toEqual([1, 2])
    expect(lines.at(-1)?.text).toBe('Hello there.')
    expect(lines.at(-1)?.kind).toBe('final')
  })

  it('resets the buffer when a new caption session starts', () => {
    let lines = [update(5)]
    lines = appendCaptionLine(lines, update(1, { sessionClientId: 'captions-session-b' }))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.sessionClientId).toBe('captions-session-b')
  })

  it('ignores empty text and caps the buffer', () => {
    let lines: CaptionsUpdate[] = []
    lines = appendCaptionLine(lines, update(1, { text: '   ' }))
    expect(lines).toHaveLength(0)
    for (let seq = 1; seq <= 60; seq += 1) {
      lines = appendCaptionLine(lines, update(seq), 50)
    }
    expect(lines).toHaveLength(50)
    expect(lines.at(0)?.seq).toBe(11)
    expect(lines.at(-1)?.seq).toBe(60)
  })
})

describe('captionStripLines', () => {
  it('returns only the most recent lines', () => {
    const lines = [update(1), update(2), update(3), update(4)]
    expect(captionStripLines(lines, 2).map((line) => line.seq)).toEqual([3, 4])
  })

  it('selects settled text for aria-live and ignores the latest partial', () => {
    const lines = [
      update(1, { kind: 'final', text: 'Settled.' }),
      update(2, { kind: 'partial', text: 'Still changing' })
    ]
    expect(latestFinalCaptionText(lines)).toBe('Settled.')
    expect(latestFinalCaptionText([lines[1]!])).toBeUndefined()
  })
})

describe('caption runtime helpers', () => {
  it('recognizes both the new state machine and the rolling Alpha live state', () => {
    expect(captionsStatusIsActive({ state: 'starting' })).toBe(true)
    expect(captionsStatusIsActive({ state: 'listening' })).toBe(true)
    expect(captionsStatusIsActive({ state: 'reconnecting' })).toBe(true)
    expect(captionsStatusIsActive({ state: 'degraded' })).toBe(true)
    expect(captionsStatusIsActive({ state: 'live' })).toBe(true)
    expect(captionsStatusIsActive({ state: 'ready' })).toBe(false)
  })

  it('bounds caption dwell between two and six seconds', () => {
    expect(captionDwellMs('Hi')).toBe(2000)
    expect(captionDwellMs('x'.repeat(500))).toBe(6000)
  })

  it('serializes persisted idle enable into backend Ready intent', () => {
    expect(
      decideCaptionsRuntimeIntent({
        persistedEnabled: true,
        suppressForSession: false,
        captureActive: false,
        status: { state: 'idle', desiredEnabled: false },
        startAttempted: false,
        stopAttempted: false
      })
    ).toBe('start')
    expect(
      decideCaptionsRuntimeIntent({
        persistedEnabled: true,
        suppressForSession: false,
        captureActive: false,
        status: { state: 'ready', desiredEnabled: true },
        startAttempted: true,
        stopAttempted: false
      })
    ).toBe('none')
  })

  it.each(['ready', 'blocked', 'error'] as const)(
    'serializes idle disable from %s into backend Idle intent',
    (state) => {
      expect(
        decideCaptionsRuntimeIntent({
          persistedEnabled: false,
          suppressForSession: false,
          captureActive: false,
          status: { state, desiredEnabled: true },
          startAttempted: false,
          stopAttempted: false
        })
      ).toBe('stop')
    }
  )

  it('starts Ready captions at the next capture and does not spin failed attempts', () => {
    expect(
      decideCaptionsRuntimeIntent({
        persistedEnabled: true,
        suppressForSession: false,
        captureActive: true,
        status: { state: 'ready', desiredEnabled: true },
        startAttempted: false,
        stopAttempted: false
      })
    ).toBe('start')
    expect(
      decideCaptionsRuntimeIntent({
        persistedEnabled: true,
        suppressForSession: false,
        captureActive: true,
        status: { state: 'blocked', desiredEnabled: true },
        startAttempted: true,
        stopAttempted: false
      })
    ).toBe('none')
    expect(
      decideCaptionsRuntimeIntent({
        persistedEnabled: false,
        suppressForSession: false,
        captureActive: false,
        status: { state: 'error', desiredEnabled: true },
        startAttempted: false,
        stopAttempted: true
      })
    ).toBe('none')
  })
})

describe('caption session floor', () => {
  it('captures the newest line identity and gates lines at or below it', () => {
    const floor = captionSessionFloor([update(3), update(7)])
    expect(floor).toEqual({ sessionClientId: 'captions-session-a', seq: 7 })
    // Late transcript of PREVIOUS-video audio (same caption session, in-flight
    // seq assigned before the boundary) must be rejected.
    expect(captionLineAboveFloor(update(7), floor)).toBe(false)
    expect(captionLineAboveFloor(update(8), floor)).toBe(true)
    // A restarted caption session is always fresh.
    expect(captionLineAboveFloor(update(1, { sessionClientId: 'captions-session-b' }), floor)).toBe(
      true
    )
  })

  it('is null (gates nothing) for an empty buffer', () => {
    expect(captionSessionFloor([])).toBeNull()
    expect(captionLineAboveFloor(update(1), null)).toBe(true)
  })
})

describe('decideOverlayPush', () => {
  const base = {
    burnIn: true,
    captionsRunning: true,
    sessionActive: true,
    latest: update(8),
    floor: { sessionClientId: 'captions-session-a', seq: 5 },
    pushedKey: null,
    busy: false
  }

  it('pushes a fresh line once, then goes quiet until the text evolves', () => {
    const first = decideOverlayPush(base)
    expect(first.action).toBe('push')
    expect(decideOverlayPush({ ...base, pushedKey: first.key }).action).toBe('none')
    expect(
      decideOverlayPush({
        ...base,
        pushedKey: first.key,
        latest: update(8, { text: 'line 8 refined' })
      }).action
    ).toBe('push')
  })

  it('repushes the same text when style, revision, dimensions, or placement changes', () => {
    const firstKey = captionOverlayKey(update(8), {
      styleId: 'glass',
      styleRevision: 1,
      position: 'bottom',
      textSize: 'm',
      canvasWidth: 1920,
      canvasHeight: 1080,
      outputLeg: 'stream'
    })
    const nextKey = captionOverlayKey(update(8), {
      styleId: 'classic',
      styleRevision: 2,
      position: 'top',
      textSize: 'l',
      canvasWidth: 3840,
      canvasHeight: 2160,
      outputLeg: 'recording'
    })
    expect(decideOverlayPush({ ...base, candidateKey: firstKey, pushedKey: firstKey }).action).toBe(
      'none'
    )
    expect(decideOverlayPush({ ...base, candidateKey: nextKey, pushedKey: firstKey }).action).toBe(
      'push'
    )
  })

  it('does not repush a final that has expired during silence', () => {
    expect(
      decideOverlayPush({
        ...base,
        expiredLineId: `${base.latest.sessionClientId}:${base.latest.seq}`
      }).action
    ).toBe('none')
  })

  it('REGRESSION (carry-over bug): never re-pushes the previous video at the next session start', () => {
    // Video 1 ends: overlay cleared, pushedKey null — but the previous
    // video's last line is still the newest buffer entry. Video 2 starts with
    // the floor recorded at the boundary: that line must NOT be pushed.
    const decision = decideOverlayPush({
      ...base,
      latest: update(5),
      floor: { sessionClientId: 'captions-session-a', seq: 5 },
      pushedKey: null
    })
    expect(decision.action).toBe('none')
  })

  it('clears the bar (once) when burn-in, captions, or the session stops', () => {
    expect(decideOverlayPush({ ...base, sessionActive: false, pushedKey: '5:x' }).action).toBe(
      'clear'
    )
    expect(decideOverlayPush({ ...base, burnIn: false, pushedKey: null }).action).toBe('none')
    expect(decideOverlayPush({ ...base, captionsRunning: false, pushedKey: '5:x' }).action).toBe(
      'clear'
    )
  })

  it('stays quiet while a rasterize round-trip is in flight or there is no line', () => {
    expect(decideOverlayPush({ ...base, busy: true }).action).toBe('none')
    expect(decideOverlayPush({ ...base, latest: undefined }).action).toBe('none')
  })
})

describe('captionOverlayTargetPlan', () => {
  const base = {
    recordingVideo: { width: 3840, height: 2160 },
    streamVideo: { width: 1920, height: 1080 }
  }

  it('keeps the 4K source recording clean and maps only the 1080p stream auxiliary', () => {
    expect(
      captionOverlayTargetPlan({
        ...base,
        burnTarget: 'both',
        recordEnabled: true,
        streamEnabled: true
      })
    ).toEqual([
      {
        target: 'auxiliary',
        outputLeg: 'stream',
        canvasWidth: 1920,
        canvasHeight: 1080
      }
    ])
  })

  it('uses primary for the only enabled output and ignores mismatched routing', () => {
    expect(
      captionOverlayTargetPlan({
        ...base,
        burnTarget: 'recording',
        recordEnabled: true,
        streamEnabled: false
      })
    ).toEqual([])
    expect(
      captionOverlayTargetPlan({
        ...base,
        burnTarget: 'stream',
        recordEnabled: true,
        streamEnabled: false
      })
    ).toEqual([])
    expect(
      captionOverlayTargetPlan({
        ...base,
        burnTarget: 'stream',
        recordEnabled: false,
        streamEnabled: true
      })
    ).toEqual([
      {
        target: 'primary',
        outputLeg: 'stream',
        canvasWidth: 3840,
        canvasHeight: 2160
      }
    ])
  })

  it('rasterizes a stream-only overlay at the real primary compositor canvas', () => {
    expect(
      captionOverlayTargetPlan({
        burnTarget: 'stream',
        recordEnabled: false,
        streamEnabled: true,
        recordingVideo: { width: 3840, height: 2160 },
        streamVideo: { width: 1920, height: 1080 }
      })
    ).toEqual([
      {
        target: 'primary',
        outputLeg: 'stream',
        canvasWidth: 3840,
        canvasHeight: 2160
      }
    ])
  })

  it('keeps only the live stream role when split outputs have matching dimensions', () => {
    expect(
      captionOverlayTargetPlan({
        burnTarget: 'both',
        recordEnabled: true,
        streamEnabled: true,
        recordingVideo: { width: 1920, height: 1080 },
        streamVideo: { width: 1920, height: 1080 }
      }).map((entry) => entry.target)
    ).toEqual(['auxiliary'])
  })

  it('keys current and stale style revisions independently for every role', () => {
    const line = update(9, { kind: 'final', text: 'Settled caption.' })
    const targets = captionOverlayTargetPlan({
      ...base,
      burnTarget: 'both',
      recordEnabled: true,
      streamEnabled: true
    })
    const keys = (styleRevision: number) =>
      targets.map((target) =>
        captionOverlayKey(line, {
          styleId: 'glass',
          styleRevision,
          position: 'bottom',
          textSize: 'm',
          canvasWidth: target.canvasWidth,
          canvasHeight: target.canvasHeight,
          outputLeg: target.target
        })
      )

    expect(keys(4)).not.toEqual(keys(5))
    expect(new Set(keys(5)).size).toBe(1)
  })
})

describe('LatestWinsScheduler', () => {
  it('runs the in-flight request and then only the newest queued request', async () => {
    const seen: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const scheduler = new LatestWinsScheduler<string>(async (value) => {
      seen.push(value)
      if (value === 'partial-1') await firstGate
    })

    scheduler.enqueue('partial-1')
    scheduler.enqueue('partial-2')
    scheduler.enqueue('final')
    releaseFirst?.()
    await scheduler.whenIdle()

    expect(seen).toEqual(['partial-1', 'final'])
  })

  it('continues with the latest request after a worker failure', async () => {
    const seen: string[] = []
    const scheduler = new LatestWinsScheduler<string>(async (value) => {
      seen.push(value)
      if (value === 'bad') throw new Error('render failed')
    })
    scheduler.enqueue('bad')
    scheduler.enqueue('final')
    await scheduler.whenIdle()
    expect(seen.at(-1)).toBe('final')
  })

  it('keeps primary and auxiliary in one atomic latest-wins work item', async () => {
    type Work = { label: string; outputs: Array<'primary' | 'auxiliary'> }
    const seen: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const scheduler = new LatestWinsScheduler<Work>(async (work) => {
      for (const output of work.outputs) {
        seen.push(`${work.label}-${output}`)
        if (work.label === 'partial' && output === 'primary') await firstGate
      }
    })

    scheduler.enqueue({ label: 'partial', outputs: ['primary', 'auxiliary'] })
    scheduler.enqueue({ label: 'final', outputs: ['primary', 'auxiliary'] })
    releaseFirst?.()
    await scheduler.whenIdle()

    expect(seen).toEqual([
      'partial-primary',
      'partial-auxiliary',
      'final-primary',
      'final-auxiliary'
    ])
  })
})
