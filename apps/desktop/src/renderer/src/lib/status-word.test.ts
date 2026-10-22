import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertStatusWord, isRawStatusValue, statusWordFromValue } from './status-word'

// Plan 174 S1.3 (A-6): status primitives show words, never machine values.

describe('isRawStatusValue', () => {
  it('flags lower-case, hyphenated machine values', () => {
    for (const value of ['connected', 'waiting', 'device-missing', 'permission-needed', 'live']) {
      expect(isRawStatusValue(value)).toBe(true)
    }
  })

  it('passes words, numbers and units', () => {
    for (const value of [
      'Ready',
      'Needs permission',
      'Checked on first use',
      'On air',
      'Videorc is reconnecting…',
      '2',
      '30.0 fps',
      '1.02x',
      '3 failed',
      'Fallback (JPEG)',
      '4K'
    ]) {
      expect(isRawStatusValue(value)).toBe(false)
    }
  })
})

describe('statusWordFromValue', () => {
  it('turns an unmapped value into a sentence-case word', () => {
    expect(statusWordFromValue('device-missing')).toBe('Device missing')
    expect(statusWordFromValue('paused')).toBe('Paused')
    expect(statusWordFromValue('needs_review')).toBe('Needs review')
    expect(statusWordFromValue('')).toBe('')
  })

  it('never returns a raw value', () => {
    for (const value of ['idle', 'source-missing', 'a-b-c']) {
      expect(isRawStatusValue(statusWordFromValue(value))).toBe(false)
    }
  })
})

describe('assertStatusWord', () => {
  afterEach(() => vi.restoreAllMocks())

  it('throws under test for a raw value, naming the component', () => {
    expect(() => assertStatusWord('device-missing', 'StatusBadge')).toThrow(
      /StatusBadge got the raw status value "device-missing"/
    )
  })

  it('accepts words and an absent label', () => {
    expect(() => assertStatusWord('Needs permission', 'StatusBadge')).not.toThrow()
    expect(() => assertStatusWord(undefined, 'StatusDot')).not.toThrow()
    expect(() => assertStatusWord('', 'StatusDot')).not.toThrow()
  })
})
