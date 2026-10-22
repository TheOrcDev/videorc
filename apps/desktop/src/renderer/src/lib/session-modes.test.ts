import { describe, expect, it } from 'vitest'

import { SESSION_MODES, sessionModeRecorded, sessionModeStreamed } from './session-modes'

describe('session modes (plan 174, E-1)', () => {
  it('reads the modes the backend writes', () => {
    expect(sessionModeRecorded(SESSION_MODES.record)).toBe(true)
    expect(sessionModeStreamed(SESSION_MODES.record)).toBe(false)

    expect(sessionModeRecorded(SESSION_MODES.stream)).toBe(false)
    expect(sessionModeStreamed(SESSION_MODES.stream)).toBe(true)

    expect(sessionModeRecorded(SESSION_MODES.recordAndStream)).toBe(true)
    expect(sessionModeStreamed(SESSION_MODES.recordAndStream)).toBe(true)

    expect(sessionModeRecorded(SESSION_MODES.imported)).toBe(true)
    expect(sessionModeStreamed(SESSION_MODES.imported)).toBe(false)
  })

  it('spells the backend values exactly', () => {
    expect(Object.values(SESSION_MODES)).toEqual(['record', 'stream', 'record+stream', 'imported'])
  })

  it('still reads the older spellings', () => {
    expect(sessionModeRecorded('recording')).toBe(true)
    expect(sessionModeStreamed('recording')).toBe(false)
    expect(sessionModeRecorded('streaming')).toBe(false)
    expect(sessionModeStreamed('streaming')).toBe(true)
  })

  it('reads an unknown mode as neither', () => {
    expect(sessionModeRecorded('idle')).toBe(false)
    expect(sessionModeStreamed('idle')).toBe(false)
    expect(sessionModeRecorded('')).toBe(false)
    expect(sessionModeStreamed('')).toBe(false)
  })
})
