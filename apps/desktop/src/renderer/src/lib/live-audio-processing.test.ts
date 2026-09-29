import { describe, expect, it } from 'vitest'

import {
  activeAudioProcessingUpdateParams,
  LatestWinsLiveAudioProcessingQueue,
  liveAudioProcessingSessionSyncDecision,
  mergeAudioProcessingParams,
  rejectedLiveAudioProcessingUpdate,
  systemAudioProcessingDelta
} from './live-audio-processing'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function appliedResult(
  microphoneGainDb: number,
  microphoneMuted = false
): import('@/lib/backend').AudioProcessingUpdateResult {
  return {
    applied: true,
    sessionId: 'session-1',
    microphoneGainDb,
    microphoneMuted
  }
}

describe('activeAudioProcessingUpdateParams', () => {
  it.each(['recording', 'streaming'] as const)(
    'maps shared mic controls to the active %s session',
    (state) => {
      expect(
        activeAudioProcessingUpdateParams(
          { state, sessionId: 'session-1' },
          { microphoneGainDb: 6, microphoneMuted: true }
        )
      ).toEqual({
        sessionId: 'session-1',
        microphoneGainDb: 6,
        microphoneMuted: true
      })
    }
  )

  it.each(['idle', 'starting', 'stopping', 'failed'] as const)(
    'does not target a %s session',
    (state) => {
      expect(
        activeAudioProcessingUpdateParams(
          { state, sessionId: 'session-1' },
          { microphoneGainDb: 6, microphoneMuted: false }
        )
      ).toBeNull()
    }
  )

  it('requires a backend session id so delayed updates cannot cross capture boundaries', () => {
    expect(
      activeAudioProcessingUpdateParams(
        { state: 'streaming' },
        { microphoneGainDb: -3, microphoneMuted: true }
      )
    ).toBeNull()
  })

  it('restores the last applied values and disables live edits when native audio is unavailable', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'native-audio-unavailable'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toEqual({
      rollback: { microphoneGainDb: -2, microphoneMuted: false },
      disableForSession: true,
      message:
        'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
    })
  })

  it('disables live edits when the active capture has no live audio control target', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'live-audio-control-unavailable'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toEqual({
      rollback: { microphoneGainDb: -2, microphoneMuted: false },
      disableForSession: true,
      message:
        'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
    })
  })

  it('does not claim restoration when FFmpeg could not confirm the captured audio state', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'live-audio-control-state-unknown'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toEqual({
      rollback: { microphoneGainDb: -2, microphoneMuted: false },
      disableForSession: true,
      message:
        'The live microphone change could not be confirmed, and the captured audio state may differ from the controls shown. Stop and restart this capture before relying on microphone gain or mute.'
    })
  })

  it('leaves terminal capture failure reporting authoritative when the session ended', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'session-ended'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })

  it('ignores a stale non-controller rejection after the user has made a newer mic edit', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 3, microphoneMuted: false },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true,
          reasonCode: 'stale-session'
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })

  it('prefers backend-confirmed rollback truth when an overlapping newer edit is visible', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 12, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: false
        },
        result: {
          applied: false,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: false,
          reasonCode: 'live-audio-control-unavailable',
          confirmedMicrophoneGainDb: 3,
          confirmedMicrophoneMuted: false
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: true }
      })
    ).toEqual({
      rollback: { microphoneGainDb: 3, microphoneMuted: false },
      disableForSession: true,
      message:
        'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
    })
  })

  it('does not roll back a live change the backend applied', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'recording', sessionId: 'session-1' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        result: {
          applied: true,
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })

  it.each(['recording', 'streaming'] as const)(
    'reports unknown state for a current %s-session edit when transport rejects after possible apply',
    (state) => {
      expect(
        rejectedLiveAudioProcessingUpdate({
          recording: { state, sessionId: 'session-1' },
          current: { microphoneGainDb: 8, microphoneMuted: true },
          requested: {
            sessionId: 'session-1',
            microphoneGainDb: 8,
            microphoneMuted: true
          },
          lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
        })
      ).toEqual({
        rollback: { microphoneGainDb: -2, microphoneMuted: false },
        disableForSession: true,
        message:
          'The live microphone change could not be confirmed, and the captured audio state may differ from the controls shown. Stop and restart this capture before relying on microphone gain or mute.'
      })
    }
  )

  it('ignores a rejected request after the active session changes', () => {
    expect(
      rejectedLiveAudioProcessingUpdate({
        recording: { state: 'streaming', sessionId: 'session-2' },
        current: { microphoneGainDb: 8, microphoneMuted: true },
        requested: {
          sessionId: 'session-1',
          microphoneGainDb: 8,
          microphoneMuted: true
        },
        lastApplied: { microphoneGainDb: -2, microphoneMuted: false }
      })
    ).toBeNull()
  })
})

describe('liveAudioProcessingSessionSyncDecision', () => {
  it('queues the latest controls after start when they differ from the exact start snapshot', () => {
    expect(
      liveAudioProcessingSessionSyncDecision(
        {
          sessionId: 'session-1',
          microphoneGainDb: 6,
          microphoneMuted: true
        },
        {
          sessionId: 'session-1',
          microphoneGainDb: 0,
          microphoneMuted: false
        }
      )
    ).toEqual({
      lastApplied: { microphoneGainDb: 0, microphoneMuted: false },
      enqueueDesired: true
    })
  })

  it('does not seed a new session from a prior session snapshot', () => {
    expect(
      liveAudioProcessingSessionSyncDecision(
        {
          sessionId: 'session-2',
          microphoneGainDb: 4,
          microphoneMuted: false
        },
        {
          sessionId: 'session-1',
          microphoneGainDb: -12,
          microphoneMuted: true
        }
      )
    ).toEqual({
      lastApplied: { microphoneGainDb: 4, microphoneMuted: false },
      enqueueDesired: true
    })
  })
})

describe('LatestWinsLiveAudioProcessingQueue', () => {
  it('coalesces a drag flood to one in-flight command plus the newest complete state', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const second = deferred<ReturnType<typeof appliedResult>>()
    const sent: Array<{ microphoneGainDb: number; microphoneMuted: boolean }> = []
    const settled: number[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params)
        return sent.length === 1 ? first.promise : second.promise
      },
      ({ result }) => {
        if (result) settled.push(result.microphoneGainDb)
        return true
      }
    )

    queue.enqueue({
      sessionId: 'session-1',
      microphoneGainDb: 1,
      microphoneMuted: false
    })
    await Promise.resolve()
    for (let gain = 2; gain <= 40; gain += 1) {
      queue.enqueue({
        sessionId: 'session-1',
        microphoneGainDb: gain,
        microphoneMuted: gain === 40
      })
    }

    expect(sent).toEqual([{ sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false }])
    first.resolve(appliedResult(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([
      { sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false },
      { sessionId: 'session-1', microphoneGainDb: 40, microphoneMuted: true }
    ])

    second.resolve(appliedResult(40, true))
    await queue.waitForIdle()
    expect(settled).toEqual([1, 40])
  })

  it('drops a flooded pending tail and ignores the in-flight reply at the stop boundary', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const sent: number[] = []
    const settled: number[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params.microphoneGainDb)
        return first.promise
      },
      ({ result }) => {
        if (result) settled.push(result.microphoneGainDb)
        return true
      }
    )

    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false })
    await Promise.resolve()
    for (let gain = 2; gain <= 40; gain += 1) {
      queue.enqueue({ sessionId: 'session-1', microphoneGainDb: gain, microphoneMuted: false })
    }
    queue.stop()
    first.resolve(appliedResult(1))
    await queue.waitForIdle()

    expect(sent).toEqual([1])
    expect(settled).toEqual([])
    expect(queue.hasOutstandingWork).toBe(false)
  })

  it('stops before dispatching a pending latest value when settlement marks the controller unhealthy', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const sent: number[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params.microphoneGainDb)
        return first.promise
      },
      () => false
    )

    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false })
    await Promise.resolve()
    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 24, microphoneMuted: true })
    first.resolve(appliedResult(1))
    await queue.waitForIdle()

    expect(sent).toEqual([1])
  })

  it('treats sender rejection after a possible apply as unknown captured state', async () => {
    let rejection: ReturnType<typeof rejectedLiveAudioProcessingUpdate> = null
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async () => {
        throw new Error('socket closed before the response arrived')
      },
      ({ requested, result }) => {
        rejection = rejectedLiveAudioProcessingUpdate({
          recording: { state: 'recording', sessionId: 'session-1' },
          current: { microphoneGainDb: 6, microphoneMuted: false },
          requested,
          result,
          lastApplied: { microphoneGainDb: 0, microphoneMuted: false }
        })
        return !rejection?.disableForSession
      }
    )

    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 6, microphoneMuted: false })
    await queue.waitForIdle()

    expect(rejection).toEqual({
      rollback: { microphoneGainDb: 0, microphoneMuted: false },
      disableForSession: true,
      message:
        'The live microphone change could not be confirmed, and the captured audio state may differ from the controls shown. Stop and restart this capture before relying on microphone gain or mute.'
    })
  })
})

describe('system audio on the latest-wins queue (plan 069)', () => {
  it('merges per field: newest wins, untouched optional fields stay omitted', () => {
    const micOnly = { sessionId: 'session-1', microphoneGainDb: 2, microphoneMuted: false }
    expect(mergeAudioProcessingParams(micOnly, { ...micOnly, microphoneGainDb: 4 })).toStrictEqual({
      sessionId: 'session-1',
      microphoneGainDb: 4,
      microphoneMuted: false
    })
    expect(
      mergeAudioProcessingParams(
        { ...micOnly, systemAudioEnabled: true, systemAudioGainDb: -6 },
        { ...micOnly, microphoneMuted: true, systemAudioGainDb: -12 }
      )
    ).toStrictEqual({
      sessionId: 'session-1',
      microphoneGainDb: 2,
      microphoneMuted: true,
      systemAudioEnabled: true,
      systemAudioGainDb: -12
    })
    expect(
      mergeAudioProcessingParams(
        { ...micOnly, systemAudioEnabled: true },
        { ...micOnly, systemAudioEnabled: false }
      )
    ).toStrictEqual({ ...micOnly, systemAudioEnabled: false })
  })

  it('keeps a pending system-audio toggle when a later mic-only edit replaces it', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const sent: unknown[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params)
        return sent.length === 1 ? first.promise : appliedResult(5)
      },
      () => true
    )

    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false })
    await Promise.resolve()
    queue.enqueue({
      sessionId: 'session-1',
      microphoneGainDb: 1,
      microphoneMuted: false,
      systemAudioEnabled: true
    })
    queue.enqueue({
      sessionId: 'session-1',
      microphoneGainDb: 3,
      microphoneMuted: false,
      systemAudioGainDb: -9
    })
    queue.enqueue({ sessionId: 'session-1', microphoneGainDb: 5, microphoneMuted: false })

    first.resolve(appliedResult(1))
    await queue.waitForIdle()
    expect(sent).toStrictEqual([
      { sessionId: 'session-1', microphoneGainDb: 1, microphoneMuted: false },
      {
        sessionId: 'session-1',
        microphoneGainDb: 5,
        microphoneMuted: false,
        systemAudioEnabled: true,
        systemAudioGainDb: -9
      }
    ])
  })

  it('sends a system-audio-only change even when the mic state is unchanged', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const sent: unknown[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params)
        return sent.length === 1 ? first.promise : appliedResult(0)
      },
      () => true
    )
    const mic = { sessionId: 'session-1', microphoneGainDb: 0, microphoneMuted: false }

    queue.enqueue(mic)
    await Promise.resolve()
    // A mic-only repeat of the in-flight state adds nothing.
    queue.enqueue(mic)
    // The same mic state plus a system-audio toggle is a real change.
    queue.enqueue({ ...mic, systemAudioEnabled: true })
    // Repeating it while it waits adds nothing either.
    queue.enqueue({ ...mic, systemAudioEnabled: true })
    first.resolve(appliedResult(0))
    await queue.waitForIdle()

    expect(sent).toStrictEqual([mic, { ...mic, systemAudioEnabled: true }])
  })

  it('does not re-send a pending request that a newer request leaves unchanged', async () => {
    const first = deferred<ReturnType<typeof appliedResult>>()
    const sent: unknown[] = []
    const queue = new LatestWinsLiveAudioProcessingQueue(
      'session-1',
      async (params) => {
        sent.push(params)
        return sent.length === 1 ? first.promise : appliedResult(2)
      },
      () => true
    )
    const mic = { sessionId: 'session-1', microphoneGainDb: 2, microphoneMuted: false }

    queue.enqueue({ ...mic, microphoneGainDb: 1 })
    await Promise.resolve()
    queue.enqueue({ ...mic, systemAudioEnabled: true, systemAudioGainDb: -3 })
    queue.enqueue(mic)
    queue.enqueue({ ...mic, systemAudioGainDb: -3 })
    first.resolve(appliedResult(1))
    await queue.waitForIdle()

    expect(sent).toStrictEqual([
      { ...mic, microphoneGainDb: 1 },
      { ...mic, systemAudioEnabled: true, systemAudioGainDb: -3 }
    ])
  })
})

describe('systemAudioProcessingDelta (plan 069)', () => {
  const off = { systemAudioEnabled: false, systemAudioGainDb: -6 }

  it('sends nothing when the session already holds the state', () => {
    expect(systemAudioProcessingDelta(off, off)).toStrictEqual({})
  })

  it('sends only the fields that changed', () => {
    expect(systemAudioProcessingDelta({ ...off, systemAudioEnabled: true }, off)).toStrictEqual({
      systemAudioEnabled: true
    })
    expect(systemAudioProcessingDelta({ ...off, systemAudioGainDb: -12 }, off)).toStrictEqual({
      systemAudioGainDb: -12
    })
  })

  it('sends every field when the session state is unknown', () => {
    expect(systemAudioProcessingDelta(off, null)).toStrictEqual({
      ...off,
      systemAudioEchoGuard: true
    })
  })

  it('sends the echo guard only when it changes, and absent means On (plan 076)', () => {
    expect(systemAudioProcessingDelta({ ...off, systemAudioEchoGuard: true }, off)).toStrictEqual(
      {}
    )
    expect(systemAudioProcessingDelta({ ...off, systemAudioEchoGuard: false }, off)).toStrictEqual({
      systemAudioEchoGuard: false
    })
    expect(systemAudioProcessingDelta(off, { ...off, systemAudioEchoGuard: false })).toStrictEqual({
      systemAudioEchoGuard: true
    })
  })
})
