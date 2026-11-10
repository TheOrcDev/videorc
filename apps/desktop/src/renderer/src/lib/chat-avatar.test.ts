import { describe, expect, it } from 'vitest'

import { monogramInitials } from './chat-avatar'

describe('monogramInitials', () => {
  it('takes the first letters of up to two words, uppercased', () => {
    expect(monogramInitials('Orc Dev')).toBe('OD')
    expect(monogramInitials('viewer')).toBe('V')
    expect(monogramInitials('three word name')).toBe('TW')
  })

  it('survives emptiness, whitespace, and multi-byte glyphs', () => {
    expect(monogramInitials('')).toBe('?')
    expect(monogramInitials('   ')).toBe('?')
    expect(monogramInitials('🦊 fox')).toBe('🦊F')
  })

  it('skips a leading symbol, like the @ of a YouTube handle', () => {
    expect(monogramInitials('@ramxcodes')).toBe('R')
    expect(monogramInitials('@Arvindkumar-c8m')).toBe('A')
    expect(monogramInitials('_orc_ dev')).toBe('OD')
    expect(monogramInitials('@@@')).toBe('@')
  })
})
