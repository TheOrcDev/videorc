import { describe, expect, it } from 'vitest'

import { TWITCH_AUDIENCE_SCOPES, twitchAudienceScopesByDefault } from './platform-scopes'

// Plan 071, S2: which optional scopes a connect asks for when the caller
// named none.
describe('twitchAudienceScopesByDefault', () => {
  const twitch = (scopes: string[]) => ({ platform: 'twitch', scopes })

  it('asks a first Twitch connection for the follow and sub permissions', () => {
    expect(twitchAudienceScopesByDefault('twitch', [])).toEqual(TWITCH_AUDIENCE_SCOPES)
    expect(twitchAudienceScopesByDefault('twitch', [{ platform: 'x', scopes: [] }])).toEqual(
      TWITCH_AUDIENCE_SCOPES
    )
  })

  it('keeps them on a reconnect that already had them, and never forces them on others', () => {
    expect(
      twitchAudienceScopesByDefault('twitch', [
        twitch(['user:read:chat', ...TWITCH_AUDIENCE_SCOPES])
      ])
    ).toEqual(TWITCH_AUDIENCE_SCOPES)
    expect(twitchAudienceScopesByDefault('twitch', [twitch(['user:read:chat'])])).toEqual([])
  })

  it('leaves other platforms alone', () => {
    expect(twitchAudienceScopesByDefault('youtube', [])).toEqual([])
    expect(twitchAudienceScopesByDefault('kick', [])).toEqual([])
  })
})
