import { describe, expect, it } from 'vitest'

import { monogramInitials, reportChatImageFailure } from './chat-avatar'

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

describe('reportChatImageFailure (plan 220 S1.6a)', () => {
  const route = `http://127.0.0.1:4321/chat-images/${'0'.repeat(32)}.png?key=${'a'.repeat(32)}`

  it('resolves every chat image again when a route image fails, at most once per 5 s', () => {
    const start = 1_000_000_000
    expect(reportChatImageFailure(route, start)).toBe(true)
    expect(reportChatImageFailure(route, start + 4_999)).toBe(false)
    expect(reportChatImageFailure(route, start + 5_000)).toBe(true)
  })

  it('ignores every image that is not from the backend route', () => {
    const later = 2_000_000_000
    for (const other of [
      'https://yt3.ggpht.com/a.png',
      'videorc-asset://buddy/a.png',
      `http://127.0.0.1:4321/sessions/x/poster?token=${'a'.repeat(32)}`,
      '',
      null,
      undefined
    ]) {
      expect(reportChatImageFailure(other, later)).toBe(false)
    }
  })
})
