import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  message: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))

import type { CohostState } from '@/lib/backend'
import {
  cohostStatusDetail,
  cohostStatusToast,
  showStreamTargetNotice,
  showXBroadcastProblem,
  sourceSwitchFailedDescription,
  sourceSwitchFailedTitle,
  streamTargetToast
} from './studio-toasts'

// Plan 174 S2.4: the Studio's toasts, by meaning, one id per kind of news.

describe('sourceSwitchFailedTitle', () => {
  const devices = [{ id: 'cam-2', name: 'FaceTime HD Camera' }]

  it('names the device the streamer picked, else the kind of source', () => {
    expect(sourceSwitchFailedTitle({ kind: 'camera', deviceId: 'cam-2' }, devices)).toBe(
      "Couldn't switch to FaceTime HD Camera"
    )
    expect(sourceSwitchFailedTitle({ kind: 'capture', deviceId: 'screen:gone' }, devices)).toBe(
      "Couldn't switch the screen"
    )
    expect(sourceSwitchFailedTitle({ kind: 'microphone', deviceId: null }, devices)).toBe(
      "Couldn't turn off the microphone"
    )
  })

  it('keeps the reason as a sentence, then the one fix', () => {
    expect(sourceSwitchFailedDescription('Source preparation timed out')).toBe(
      'Source preparation timed out. Choose it again in Sources.'
    )
    expect(sourceSwitchFailedDescription('The display is gone.')).toBe(
      'The display is gone. Choose it again in Sources.'
    )
    expect(sourceSwitchFailedDescription('  ')).toBe('Choose it again in Sources.')
  })
})

describe('streamTargetToast', () => {
  it('gives every notice for one destination the same id, so "is back" replaces the bad news', () => {
    const stopped = streamTargetToast({
      key: 'stream-target-failed:yt-1',
      kind: 'error',
      title: 'Streaming to YouTube stopped',
      description: 'The other destinations keep streaming.'
    })
    const back = streamTargetToast({
      key: 'stream-target:yt-1',
      kind: 'success',
      title: 'YouTube is back',
      description: 'Streaming to YouTube resumed.'
    })
    expect(stopped.id).toBe('stream-target:yt-1')
    expect(back.id).toBe(stopped.id)
    expect(stopped.duration).toBe(Infinity)
    expect(back.duration).toBeUndefined()
  })

  it('shows a notice with its type', () => {
    vi.clearAllMocks()
    showStreamTargetNotice({
      key: 'stream-target:tw:1',
      kind: 'warning',
      title: 'Twitch is reconnecting',
      description: 'Viewers there see nothing until it is back.'
    })
    expect(toast.warning).toHaveBeenCalledWith('Twitch is reconnecting', {
      id: 'stream-target:tw:1',
      description: 'Viewers there see nothing until it is back.',
      duration: Infinity
    })
  })
})

describe('cohostStatusToast', () => {
  const running = {
    status: 'listening',
    reason: null,
    sessionId: 'live-1'
  } as unknown as CohostState

  it('names a new failure without the server code, with the action that fixes it', () => {
    const failed = {
      ...running,
      status: 'error',
      reason: 'premium-required',
      detail: { code: 'ai-gateway-error', message: 'denied' }
    } as unknown as CohostState
    expect(cohostStatusToast(running, failed)).toEqual({
      kind: 'error',
      title: 'Buddy stopped: Videorc Premium is required.',
      action: 'view-premium'
    })
    expect(cohostStatusDetail(failed)).toBe('ai-gateway-error: denied')
    expect(cohostStatusToast(failed, failed)).toBeNull()
  })

  it('calls a used-up quota a warning, and a stop by sign-out offers Sign in', () => {
    const paused = { ...running, status: 'error', reason: 'quota-exhausted' } as CohostState
    expect(cohostStatusToast(running, paused)?.kind).toBe('warning')
    const stopped = { ...running, status: 'off', reason: 'signed-out' } as CohostState
    expect(cohostStatusToast(running, stopped)).toEqual({
      kind: 'message',
      title: 'Buddy stopped. You signed out.',
      action: 'sign-in'
    })
    expect(cohostStatusToast(running, { ...running, status: 'off' } as CohostState)).toBeNull()
  })
})

describe('showXBroadcastProblem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('warns in the YouTube toast words, never with the raw text', () => {
    const target = { id: 'x-1', label: 'X' }
    showXBroadcastProblem('start', target, new Error('HTTP 503 {"errors":[]}'))
    expect(toast.warning).toHaveBeenLastCalledWith("Couldn't start the X broadcast", {
      id: 'x-broadcast-start:x-1',
      description: 'Try again. If it keeps happening, export a support bundle from Health.'
    })
    showXBroadcastProblem('end', target, new Error('HTTP 500'))
    expect(toast.warning).toHaveBeenLastCalledWith(
      "Couldn't end the X broadcast",
      expect.objectContaining({
        description: 'End it in X Media Studio.',
        action: expect.objectContaining({ label: 'Open Media Studio' })
      })
    )
    showXBroadcastProblem('chat', target, new Error('chat 401'))
    expect(toast.warning).toHaveBeenLastCalledWith(
      "X chat isn't connected for X",
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open Livestream' }) })
    )
  })
})
