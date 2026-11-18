import { describe, expect, it } from 'vitest'

import {
  roomAvatarDescription,
  roomGraphicsDescription,
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
})
