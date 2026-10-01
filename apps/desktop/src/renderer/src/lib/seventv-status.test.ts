import { describe, expect, it } from 'vitest'

import { sevenTvStatusLine } from './seventv-status'

describe('sevenTvStatusLine', () => {
  it('says what 7TV emotes are doing, and nothing when the switch is off', () => {
    expect(sevenTvStatusLine({ state: 'off' })).toBeNull()
    expect(sevenTvStatusLine({ state: 'idle' })).toBe('Loads when you go live.')
    expect(sevenTvStatusLine({ state: 'loading' })).toBe('Loading your 7TV emotes…')
    expect(
      sevenTvStatusLine({
        state: 'linked',
        setName: 'Halloween Emotes 2026',
        emoteCount: 986,
        globalCount: 45,
        platforms: ['twitch', 'kick']
      })
    ).toBe('“Halloween Emotes 2026” · 986 emotes')
    expect(sevenTvStatusLine({ state: 'linked', setName: 'Mine', emoteCount: 1 })).toBe(
      '“Mine” · 1 emote'
    )
    expect(sevenTvStatusLine({ state: 'linked', emoteCount: 1200 })).toBe('1,200 emotes')
    expect(sevenTvStatusLine({ state: 'notLinked' })).toBe(
      'No 7TV account is linked to your Twitch, Kick or YouTube channel.'
    )
    expect(sevenTvStatusLine({ state: 'error', error: 'http 5xx' })).toBe(
      "7TV couldn't be reached. Chat works without its emotes."
    )
  })
})
