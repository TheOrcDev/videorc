import { describe, expect, it } from 'vitest'

import {
  roomAvatarDescription,
  roomGraphicsDescription,
  roomOptInTone,
  roomProgramChips,
  roomProgramSummary
} from './room-program-opt-ins'

// The owner, 2026-11-18 (0.31.1): plain words for the room's opt-ins, and an
// applied line that names only the outputs that confirmed it.
describe('room program opt-ins', () => {
  const applied = (...outputs: ('stream' | 'recording')[]) => ({
    enabled: true,
    state: 'applied',
    reason: null,
    observed: Object.fromEntries(outputs.map((output, index) => [`page-${index}`, { output }]))
  })

  it('says off, waiting, and why it was refused', () => {
    expect(roomAvatarDescription(undefined)).toBe('Not on the stream.')
    expect(roomAvatarDescription({ enabled: true, state: 'preview' })).toBe(
      'On. Waiting for the stream to confirm.'
    )
    expect(roomAvatarDescription({ enabled: true, state: 'failed', reason: 'No pack.' })).toBe(
      'No pack.'
    )
    expect(roomGraphicsDescription({ enabled: false })).toBe(
      'Banners, timers and the chat box. Not on the stream.'
    )
    // Captions and cards go out with the switch off; that is not the banners.
    expect(roomGraphicsDescription({ ...applied('stream'), enabled: false })).toBe(
      'Banners, timers and the chat box. Not on the stream.'
    )
  })

  it('names only the outputs that applied it', () => {
    expect(roomAvatarDescription(applied('stream', 'recording'))).toBe(
      'On the stream and the recording.'
    )
    expect(roomAvatarDescription(applied('recording'))).toBe('On the recording.')
    expect(roomGraphicsDescription(applied('stream'))).toBe(
      'Banners, timers and the chat box. On the stream.'
    )
    expect(roomAvatarDescription(applied())).toBe('On the program.')
  })

  it('sums both up for the Program preview', () => {
    expect(roomProgramSummary(undefined, undefined)).toBe('Avatar off · Graphics off')
    expect(roomProgramSummary({ enabled: true }, { enabled: true })).toBe('Avatar on · Graphics on')
  })

  // The owner, 2026-11-20 (0.35.0): the room's Avatar switch starts on, so the
  // avatar follows its own "on stream" switch. While that one is off the room
  // never reads as showing an avatar, and the line says where the switch is.
  it('reads an avatar that is off by its own switch as off, and says where to turn it on', () => {
    const offByItsOwnSwitch = { enabled: true, state: 'off', reason: null }
    expect(roomAvatarDescription(offByItsOwnSwitch)).toBe(
      'Your avatar is off. Turn on its “on stream” switch in Stream Manager.'
    )
    expect(roomProgramSummary(offByItsOwnSwitch, undefined)).toBe('Avatar off · Graphics off')
    expect(roomProgramChips(offByItsOwnSwitch, undefined)[0]).toEqual({
      id: 'avatar',
      label: 'Avatar off',
      on: false
    })
    expect(roomOptInTone(offByItsOwnSwitch)).toBe('neutral')
    // Hidden for this room in Guests → Room: the plain off line.
    expect(roomAvatarDescription({ enabled: false, state: 'off', reason: null })).toBe(
      'Not on the stream.'
    )
    // On its way: the room lets it through and its own switch chose an output.
    const waiting = { enabled: true, state: 'waiting', reason: null }
    expect(roomProgramSummary(waiting, undefined)).toBe('Avatar on · Graphics off')
    expect(roomProgramChips(waiting, undefined)[0].on).toBe(true)
  })
})
