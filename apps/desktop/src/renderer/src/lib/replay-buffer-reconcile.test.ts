import { describe, expect, it } from 'vitest'

import {
  REPLAY_SILENT_CAMERA_RETRY_LIMIT,
  replayAfterSourcesNotReady,
  replayCameraDelivers,
  replayCameraRecovers,
  replaySilentCameraRetryDelayMs,
  replaySourcesNotReadyStep
} from './replay-buffer-camera-wait'
import {
  REPLAY_CAMERA_WAIT_NONE,
  REPLAY_START_RETRY_LIMIT,
  replayBufferReconcileAction,
  replayBufferShouldRestartForSources,
  replayShouldRearmAfterError,
  replayStartRetryDelayMs,
  roomHoldsTheCamera,
  type ReplayReconcileInput
} from './replay-buffer-reconcile'

const idle: ReplayReconcileInput = {
  armed: true,
  replayState: 'off',
  replayOnlyBuffer: false,
  recordingState: 'idle',
  recordingReplayOnly: false,
  startPending: false,
  stopPending: false,
  replayStartInFlight: false,
  failedStarts: 0
}

describe('replayBufferReconcileAction (plan 181 S4)', () => {
  it('starts the buffer-only session when the switch is on and nothing runs', () => {
    expect(replayBufferReconcileAction(idle)).toBe('start')
  })

  it('waits for the camera after a not-ready refusal, without spending a strike', () => {
    // Launch: the ring is asked for before the camera preview delivers.
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: true })).toBeNull()
    expect(
      replayBufferReconcileAction({ ...idle, waitingForCamera: true, failedStarts: 2 })
    ).toBeNull()
    // The camera's live edge clears the wait; the count was never touched.
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: false })).toBe('start')
    // Turning the switch off still stops a running ring.
    expect(
      replayBufferReconcileAction({
        ...idle,
        armed: false,
        waitingForCamera: true,
        replayState: 'on',
        replayOnlyBuffer: true,
        recordingReplayOnly: true,
        recordingState: 'recording'
      })
    ).toBe('stop')
  })

  it('steps the buffer-only ring aside while a talk show room holds the camera', () => {
    // 2026-11-15: Clips on (the default) made every Open the room fail; the
    // backend refused it beside the ring, which runs between sessions.
    const ring: ReplayReconcileInput = {
      ...idle,
      replayState: 'on',
      replayOnlyBuffer: true,
      recordingReplayOnly: true,
      recordingState: 'recording'
    }
    expect(replayBufferReconcileAction({ ...ring, roomHoldsCamera: true })).toBe('stop')
    expect(
      replayBufferReconcileAction({ ...ring, roomHoldsCamera: true, replayState: 'starting' })
    ).toBe('stop')
    // Never a second stop over one in flight.
    expect(
      replayBufferReconcileAction({ ...ring, roomHoldsCamera: true, replayStartInFlight: true })
    ).toBeNull()
    // No start while the room holds the camera, armed or not.
    expect(replayBufferReconcileAction({ ...idle, roomHoldsCamera: true })).toBeNull()
    expect(
      replayBufferReconcileAction({ ...idle, roomHoldsCamera: true, failedStarts: 5 })
    ).toBeNull()
    // A ring riding a recording is not the room's to stop.
    expect(
      replayBufferReconcileAction({
        ...ring,
        roomHoldsCamera: true,
        replayOnlyBuffer: false,
        recordingReplayOnly: false
      })
    ).toBeNull()
    // The room closed: the switch brings the ring back.
    expect(replayBufferReconcileAction({ ...idle, roomHoldsCamera: false })).toBe('start')
  })

  it('reads the room as holding the camera in every phase but closed', () => {
    expect(roomHoldsTheCamera(null)).toBe(false)
    expect(roomHoldsTheCamera(undefined)).toBe(false)
    expect(roomHoldsTheCamera({ phase: 'closed' })).toBe(false)
    expect(roomHoldsTheCamera({ phase: 'opening' })).toBe(true)
    expect(roomHoldsTheCamera({ phase: 'open' })).toBe(true)
    expect(roomHoldsTheCamera({ phase: 'closing' })).toBe(true)
  })

  it('waits while a Record or Go Live is in flight: the backend hands over itself', () => {
    expect(replayBufferReconcileAction({ ...idle, startPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, stopPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, replayStartInFlight: true })).toBeNull()
  })

  it('leaves a buffer that is on, starting or riding a recording alone', () => {
    expect(replayBufferReconcileAction({ ...idle, replayState: 'on' })).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, replayState: 'starting' })).toBeNull()
    expect(
      replayBufferReconcileAction({ ...idle, replayState: 'on', recordingState: 'recording' })
    ).toBeNull()
    // Armed during a recording with no ring: it attaches at the next start.
    expect(replayBufferReconcileAction({ ...idle, recordingState: 'recording' })).toBeNull()
  })

  it('re-arms after a recording ends and after a failed start, up to the limit', () => {
    // The recording's terminal status: idle, ring off, switch still on.
    expect(replayBufferReconcileAction({ ...idle, failedStarts: 1 })).toBe('start')
    expect(
      replayBufferReconcileAction({ ...idle, failedStarts: REPLAY_START_RETRY_LIMIT - 1 })
    ).toBe('start')
    expect(replayBufferReconcileAction({ ...idle, failedStarts: REPLAY_START_RETRY_LIMIT })).toBe(
      'give-up'
    )
  })

  it('restarts a ring that died with its session only once something arms it again', () => {
    // The event handler disarms on the error, so the dead session is not retried in a loop.
    expect(replayBufferReconcileAction({ ...idle, armed: false, replayState: 'error' })).toBeNull()
    // The switch, a source change or a session's end armed it again: start as from off.
    expect(replayBufferReconcileAction({ ...idle, replayState: 'error' })).toBe('start')
    // The ring's own session ends 'failed', not 'idle': that is over too.
    expect(
      replayBufferReconcileAction({
        ...idle,
        replayState: 'error',
        recordingState: 'failed',
        recordingReplayOnly: true
      })
    ).toBe('start')
    expect(
      replayBufferReconcileAction({ ...idle, replayState: 'error', recordingState: 'recording' })
    ).toBeNull()
  })

  it('re-arms after an error only while the switch is on and nothing refused it', () => {
    const dead = { armed: false, replayState: 'error' as const, switchOn: true, blocked: false }
    expect(replayShouldRearmAfterError(dead)).toBe(true)
    expect(replayShouldRearmAfterError({ ...dead, armed: true })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, replayState: 'off' })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, switchOn: false })).toBe(false)
    expect(replayShouldRearmAfterError({ ...dead, blocked: true })).toBe(false)
  })

  it('stops the buffer-only session when the switch goes off', () => {
    const on: ReplayReconcileInput = {
      ...idle,
      armed: false,
      replayState: 'on',
      replayOnlyBuffer: true,
      recordingState: 'recording',
      recordingReplayOnly: true
    }
    expect(replayBufferReconcileAction(on)).toBe('stop')
    expect(replayBufferReconcileAction({ ...on, replayState: 'starting' })).toBe('stop')
    expect(replayBufferReconcileAction({ ...on, stopPending: true })).toBeNull()
    expect(replayBufferReconcileAction({ ...on, startPending: true })).toBeNull()
  })

  it('never stops a recording that carries the ring: the switch decides what comes after', () => {
    expect(
      replayBufferReconcileAction({
        ...idle,
        armed: false,
        replayState: 'on',
        replayOnlyBuffer: false,
        recordingState: 'recording',
        recordingReplayOnly: false
      })
    ).toBeNull()
    expect(replayBufferReconcileAction({ ...idle, armed: false })).toBeNull()
  })

  it('restarts a buffer-only session when sources change, never a recording', () => {
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'recording'
      })
    ).toBe(true)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'starting'
      })
    ).toBe(true)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: false,
        recordingState: 'recording'
      })
    ).toBe(false)
    expect(
      replayBufferShouldRestartForSources({
        recordingReplayOnly: true,
        recordingState: 'idle'
      })
    ).toBe(false)
  })

  it('backs off between failed starts', () => {
    expect(replayStartRetryDelayMs(0)).toBe(500)
    expect(replayStartRetryDelayMs(1)).toBe(500)
    expect(replayStartRetryDelayMs(2)).toBe(1000)
    expect(replayStartRetryDelayMs(3)).toBe(2000)
    expect(replayStartRetryDelayMs(9)).toBe(4000)
  })
})

describe('a camera that says live and sends no frame (2026-11-23)', () => {
  const silent = { state: 'live', cameraId: 'cam-1', framesCaptured: 0 }

  it('backs off 1, 2, 4, 8 s, then stops asking and waits for the first frame', () => {
    const delays: number[] = []
    for (let refusals = 1; refusals < REPLAY_SILENT_CAMERA_RETRY_LIMIT; refusals += 1) {
      const next = replayAfterSourcesNotReady({ camera: silent, chosenCameraId: 'cam-1', refusals })
      expect(next.kind).toBe('retry')
      if (next.kind === 'retry') delays.push(next.delayMs)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000])
    expect(
      replayAfterSourcesNotReady({
        camera: silent,
        chosenCameraId: 'cam-1',
        refusals: REPLAY_SILENT_CAMERA_RETRY_LIMIT
      })
    ).toEqual({ kind: 'wait-for-frames' })
    expect(replaySilentCameraRetryDelayMs(20)).toBe(8000)
  })

  it('asks a bounded number of times over ten minutes, where it used to ask every half second', () => {
    // The Studio's loop: start, refused, decide, wait, reconcile. Waiting for
    // frames sets waitingForCamera, which holds every later start.
    let refusals = 0
    let waiting = false
    let starts = 0
    let now = 0
    while (now < 10 * 60_000) {
      const action = replayBufferReconcileAction({ ...idle, waitingForCamera: waiting })
      if (action !== 'start') break
      starts += 1
      refusals += 1
      const next = replayAfterSourcesNotReady({ camera: silent, chosenCameraId: 'cam-1', refusals })
      if (next.kind === 'retry') now += next.delayMs
      else if (next.kind === 'wait-for-frames') waiting = true
      else throw new Error(`unexpected ${next.kind}`)
    }
    expect(starts).toBe(REPLAY_SILENT_CAMERA_RETRY_LIMIT)
    expect(now).toBe(15_000)
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: true })).toBeNull()
  })

  it('waits for frames at once when the backend already says the camera sends no video', () => {
    expect(
      replayAfterSourcesNotReady({
        camera: { ...silent, noVideo: true },
        chosenCameraId: 'cam-1',
        refusals: 1
      })
    ).toEqual({ kind: 'wait-for-frames' })
  })

  it('recovers on the first frame: the wait ends and the ring starts', () => {
    expect(replayCameraDelivers(silent)).toBe(false)
    expect(replayCameraDelivers({ ...silent, framesCaptured: 3, noVideo: true })).toBe(false)
    expect(replayCameraDelivers({ ...silent, state: 'starting', framesCaptured: 3 })).toBe(false)
    const delivering = { ...silent, framesCaptured: 1 }
    expect(replayCameraDelivers(delivering)).toBe(true)
    // The Studio clears the wait on that edge and reconciles.
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: false })).toBe('start')
  })

  it('keeps the launch wait for a camera that is still starting or being switched', () => {
    for (const camera of [
      { state: 'starting', cameraId: 'cam-1', framesCaptured: 0 },
      { state: 'failed', cameraId: 'cam-0', framesCaptured: 0 },
      { state: 'disconnected', cameraId: null, framesCaptured: 0 }
    ]) {
      expect(replayAfterSourcesNotReady({ camera, chosenCameraId: 'cam-1', refusals: 0 })).toEqual({
        kind: 'wait-for-live'
      })
    }
  })

  it('counts a failed, missing or denied camera as a failed start', () => {
    for (const state of ['failed', 'device-missing', 'permission-needed']) {
      expect(
        replayAfterSourcesNotReady({
          camera: { state, cameraId: 'cam-1', framesCaptured: 0 },
          chosenCameraId: 'cam-1',
          refusals: 0
        })
      ).toEqual({ kind: 'failed' })
    }
  })
})

describe('the Studio taking a silent-camera refusal (replaySourcesNotReadyStep)', () => {
  const silent = { state: 'live', cameraId: 'cam-1', framesCaptured: 0 }
  function studio() {
    const scheduled: number[] = []
    const notices: string[] = []
    return {
      scheduled,
      notices,
      wait: { current: REPLAY_CAMERA_WAIT_NONE },
      waitingForLive: { current: false },
      notified: { current: false },
      take(camera: typeof silent) {
        return replaySourcesNotReadyStep({
          wait: this.wait,
          waitingForLive: this.waitingForLive,
          notified: this.notified,
          camera,
          chosenCameraId: 'cam-1',
          schedule: (delayMs) => scheduled.push(delayMs),
          notify: (reason) => notices.push(reason)
        })
      }
    }
  }

  it('schedules the backoff, then holds starts and says so once behind the bell', () => {
    const s = studio()
    for (let i = 0; i < REPLAY_SILENT_CAMERA_RETRY_LIMIT; i += 1) expect(s.take(silent)).toBe(true)
    expect(s.scheduled).toEqual([1000, 2000, 4000, 8000])
    expect(s.waitingForLive.current).toBe(true)
    expect(s.wait.current).toEqual({ refusals: 5, frames: true })
    expect(s.notices).toHaveLength(1)
    // A later refusal (the camera restarted, still silent) waits again, quietly.
    s.waitingForLive.current = false
    expect(s.take(silent)).toBe(true)
    expect(s.scheduled).toHaveLength(4)
    expect(s.waitingForLive.current).toBe(true)
    expect(s.notices).toHaveLength(1)
  })

  it("never notifies past the Studio's other Clips notice", () => {
    const s = studio()
    s.notified.current = true
    for (let i = 0; i < REPLAY_SILENT_CAMERA_RETRY_LIMIT; i += 1) s.take(silent)
    expect(s.notices).toHaveLength(0)
  })

  it('waits for the live edge without counting, and hands a failed camera back', () => {
    const s = studio()
    expect(s.take({ state: 'starting', cameraId: 'cam-1', framesCaptured: 0 })).toBe(true)
    expect(s.waitingForLive.current).toBe(true)
    expect(s.wait.current.refusals).toBe(0)
    expect(s.take({ state: 'failed', cameraId: 'cam-1', framesCaptured: 0 })).toBe(false)
  })

  it('recovers on the first frame: the count clears and starts are allowed again', () => {
    const s = studio()
    for (let i = 0; i < REPLAY_SILENT_CAMERA_RETRY_LIMIT; i += 1) s.take(silent)
    expect(replayCameraRecovers(s.wait, s.waitingForLive, silent)).toBe(false)
    expect(s.waitingForLive.current).toBe(true)
    expect(replayCameraRecovers(s.wait, s.waitingForLive, { ...silent, framesCaptured: 2 })).toBe(
      true
    )
    expect(s.waitingForLive.current).toBe(false)
    expect(s.wait.current).toEqual(REPLAY_CAMERA_WAIT_NONE)
    expect(replayBufferReconcileAction({ ...idle, waitingForCamera: false })).toBe('start')
    // A camera that delivered during the backoff only clears the count.
    const t = studio()
    t.take(silent)
    expect(replayCameraRecovers(t.wait, t.waitingForLive, { ...silent, framesCaptured: 1 })).toBe(
      false
    )
    expect(t.wait.current.refusals).toBe(0)
  })
})
