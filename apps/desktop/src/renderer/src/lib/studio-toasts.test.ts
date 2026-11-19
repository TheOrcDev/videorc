import { describe, expect, it, vi } from 'vitest'

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
  sourceSwitchFailedDescription,
  sourceSwitchFailedTitle
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
    expect(
      sourceSwitchFailedDescription(
        'The running capture adapter does not support session source transactions.'
      )
    ).toBe(
      'This source cannot change until you stop, pick a new one, then start again. Choose it again in Sources.'
    )
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
      title: 'Sidekick stopped: Videorc Premium is required.',
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
      title: 'Sidekick stopped. You signed out.',
      action: 'sign-in'
    })
    expect(cohostStatusToast(running, { ...running, status: 'off' } as CohostState)).toBeNull()
  })
})
