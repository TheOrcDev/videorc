import { describe, expect, it, vi } from 'vitest'

import { BackendRequestError } from '@/backendClient'
import {
  SOUND_ACTION_COPY,
  SOUND_COUNT_LIMIT_REASON,
  SOUND_MODE_LABELS,
  SOUND_TOTAL_LIMIT_REASON,
  formatSoundDuration,
  isSoundLimitRefusal,
  missingStarterSlugs,
  runSoundAction,
  soundActionContext,
  soundActionError,
  soundImportBlockedReason,
  soundOrderAfterMove,
  soundPadLabel,
  soundRefusal,
  SOUNDS_CANT_REACH_SESSION,
  soundboardDescription,
  soundsSectionDescription
} from './sounds'
import { OFFLINE_REASON, UserFacingError, userErrorMessage } from './user-error'

// Plan 189: the soundboard's words and rules, as the Copy table has them.

describe('soundboard copy (plan 189)', () => {
  it('names the modes and says where a press goes', () => {
    expect(Object.values(SOUND_MODE_LABELS)).toEqual([
      'Play once',
      'Play/stop',
      'Loop',
      'While held'
    ])
    expect(soundboardDescription(false, true)).toBe(
      'Only you hear sounds until you record or go live.'
    )
    expect(soundboardDescription(false, false)).toBe(
      'Only you hear sounds until you record or go live.'
    )
    expect(soundboardDescription(true, true)).toBe('Sounds play in your recording and stream.')
    expect(soundboardDescription(true, false)).toBe(
      "Sounds play in your recording and stream. You don't hear them yourself."
    )
    // Release test 147, plan 0001: never claim a session sounds can't reach.
    for (const monitor of [true, false]) {
      expect(soundboardDescription(true, monitor, true)).toBe(SOUNDS_CANT_REACH_SESSION)
    }
    expect(soundboardDescription(false, true, true)).toBe(
      'Only you hear sounds until you record or go live.'
    )
    expect(soundsSectionDescription(12)).toBe(
      '12 sounds · up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
    )
    expect(soundsSectionDescription(1)).toBe(
      '1 sound · up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
    )
    expect(soundsSectionDescription(null)).toBe(
      'Sounds up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
    )
    expect(formatSoundDuration(1610)).toBe('1.6 s')
    expect(formatSoundDuration(30_000)).toBe('30.0 s')
    expect(soundPadLabel('Airhorn', false)).toBe('Play Airhorn')
    expect(soundPadLabel('Applause', true)).toBe('Stop Applause')
  })
})

describe('soundboard refusals', () => {
  it('reads the backend sentences, through the IPC wrapper too, as warnings', () => {
    const wrapped = new Error(
      "Error invoking remote method 'x': Error: Sounds can be up to 30 seconds. Trim this one and try again."
    )
    expect(soundRefusal(wrapped)).toBe(
      'Sounds can be up to 30 seconds. Trim this one and try again.'
    )
    expect(
      soundRefusal(new BackendRequestError('sound-import-failed', 'This file is silent.'))
    ).toBe('This file is silent.')
    expect(soundRefusal(new Error('ffmpeg exited 1'))).toBeNull()
    const copy = userErrorMessage(
      soundActionError(new Error(SOUND_COUNT_LIMIT_REASON)),
      soundActionContext('play')
    )
    expect(copy).toMatchObject({ tone: 'warning', description: SOUND_COUNT_LIMIT_REASON })
    const raw = new Error('voice table poisoned')
    expect(soundActionError(raw)).toBe(raw)
    expect(soundActionError(new Error(SOUND_ACTION_COPY.missing))).toBeInstanceOf(UserFacingError)
    // The backend's own words for an id it no longer has, and its 50 MB cap.
    expect(
      userErrorMessage(
        soundActionError(new BackendRequestError('sound-play-failed', 'Sound not found.')),
        soundActionContext('play')
      )
    ).toMatchObject({ tone: 'warning', description: SOUND_ACTION_COPY.missing })
    expect(
      soundRefusal(
        new BackendRequestError(
          'sound-import-failed',
          'This file is too large. Use one under 50 MB.'
        )
      )
    ).toBe('This file is too large. Use one under 50 MB.')
    expect(isSoundLimitRefusal(SOUND_TOTAL_LIMIT_REASON)).toBe(true)
    expect(isSoundLimitRefusal('This file is silent.')).toBe(false)
    expect(isSoundLimitRefusal(null)).toBe(false)
    expect(soundActionContext('stopAll')).toEqual({ action: 'stop', object: 'the sounds' })
    expect(soundActionContext('press')).toEqual({ action: 'play', object: 'the sound' })
  })
})

describe('runSoundAction', () => {
  it('runs each action as its RPC and says why not in plain words', async () => {
    const request = vi.fn(async () => ({}))
    const client = { request } as never
    const sounds = [{ id: 'a' }]
    expect(await runSoundAction(client, { action: 'play', id: 'a' }, sounds)).toEqual({ ok: true })
    expect(await runSoundAction(client, { action: 'press', id: 'a' }, sounds)).toEqual({ ok: true })
    expect(await runSoundAction(client, { action: 'stop', id: 'a' }, sounds)).toEqual({ ok: true })
    expect(await runSoundAction(client, { action: 'stopAll' }, sounds)).toEqual({ ok: true })
    expect(request.mock.calls).toEqual([
      ['sounds.play', { id: 'a' }],
      ['sounds.press', { id: 'a' }],
      ['sounds.stop', { id: 'a' }],
      ['sounds.stop', {}]
    ])
    expect(await runSoundAction(client, { action: 'play', id: 'gone' }, sounds)).toEqual({
      ok: false,
      message: SOUND_ACTION_COPY.missing
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    request.mockRejectedValueOnce(new Error('bus thread gone'))
    expect(await runSoundAction(client, { action: 'stopAll' }, sounds)).toEqual({
      ok: false,
      message: "Couldn't stop the sounds."
    })
  })
})

describe('soundboard rules', () => {
  it('blocks Import while offline, mid-import or at 24 sounds, never for a session', () => {
    expect(soundImportBlockedReason({ offline: true, phase: 'idle', count: 0 })).toBe(
      OFFLINE_REASON
    )
    expect(soundImportBlockedReason({ offline: false, phase: 'importing', count: 0 })).toBe(
      'Wait for this import to finish.'
    )
    expect(soundImportBlockedReason({ offline: false, phase: 'idle', count: 24 })).toBe(
      SOUND_COUNT_LIMIT_REASON
    )
    expect(soundImportBlockedReason({ offline: false, phase: 'idle', count: 23 })).toBeNull()
  })

  it('moves a sound in board order, and finds the starters the board lost', () => {
    const sounds = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(soundOrderAfterMove(sounds, 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(soundOrderAfterMove(sounds, 'a', 9)).toEqual(['b', 'c', 'a'])
    expect(soundOrderAfterMove(sounds, 'a', 0)).toBeNull()
    expect(soundOrderAfterMove(sounds, 'x', 1)).toBeNull()
    expect(
      missingStarterSlugs(
        [{ slug: 'airhorn' }, { slug: 'applause' }, { slug: 'laugh' }],
        [{ starter: 'applause' }, {}]
      )
    ).toEqual(['airhorn', 'laugh'])
  })
})
