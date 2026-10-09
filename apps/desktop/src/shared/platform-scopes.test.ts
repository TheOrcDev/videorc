import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { LiveChatProviderState, PlatformAccount, StreamPlatform } from './backend'
import {
  KICK_MODERATION_SCOPE,
  KICK_OPTIONAL_SCOPES,
  TWITCH_AUDIENCE_SCOPES,
  TWITCH_BITS_POINTS_SCOPES,
  TWITCH_MODERATION_SCOPE,
  TWITCH_OPTIONAL_SCOPES,
  YOUTUBE_FORCE_SSL_SCOPE,
  connectOptionalScopes,
  isScopeReconnectPlatform,
  permissionReconnectOptions,
  permissionReconnectScopes,
  platformConnectOptions,
  removeMessagesReadiness,
  removeMessagesReconnectCopy,
  removeMessagesReconnectPlatforms
} from './platform-scopes'

// Plan 140, S5: "Remove messages" needs a scope on Twitch and Kick. The
// backend requests a platform's base set plus only the optional scopes it is
// passed, so every connect path must pass the whole optional union, and the
// desktop's list must be exactly what the backend offers (it refuses the
// rest, which would fail the connect outright).

const ALL_PLATFORMS: StreamPlatform[] = [
  'youtube',
  'twitch',
  'kick',
  'x',
  'tiktok',
  'instagram',
  'custom'
]

const oauthSource = readFileSync(
  new URL('../../../../crates/videorc-backend/src/oauth.rs', import.meta.url),
  'utf8'
)

/** `pub const NAME: &str = "value";` in oauth.rs, by name. */
function rustConstants(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/pub const (\w+): &str = "([^"]*)";/g)].map((match) => [match[1], match[2]])
  )
}

/** The `optional_scopes_for` table, per Rust platform variant, as scope strings. */
function rustOptionalScopes(source: string): Map<string, string[]> {
  const start = source.indexOf('pub fn optional_scopes_for(')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  const constants = rustConstants(source)
  const table = new Map<string, string[]>()
  for (const arm of body.matchAll(/StreamPlatform::(\w+) => &\[([^\]]*)\]/g)) {
    const names = arm[2]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    table.set(
      arm[1],
      names.map((name) => {
        const value = constants.get(name)
        expect(value, `oauth.rs constant ${name}`).toBeDefined()
        return value!
      })
    )
  }
  return table
}

const RUST_VARIANTS: Record<StreamPlatform, string> = {
  youtube: 'Youtube',
  twitch: 'Twitch',
  kick: 'Kick',
  x: 'X',
  tiktok: 'Tiktok',
  instagram: 'Instagram',
  custom: 'Custom'
}

function account(
  status: PlatformAccount['status'],
  scopes: readonly string[]
): Pick<PlatformAccount, 'scopes' | 'status'> {
  return { status, scopes: [...scopes] }
}

describe('optional scope union (plan 140, S5)', () => {
  it('asks for every optional scope on every Twitch connect', () => {
    expect(TWITCH_OPTIONAL_SCOPES).toEqual([
      'moderator:read:followers',
      'channel:read:subscriptions',
      'moderator:manage:chat_messages',
      'bits:read',
      'channel:read:redemptions'
    ])
    expect(KICK_OPTIONAL_SCOPES).toEqual(['moderation:chat_message:manage'])
    // No Twitch connect path can drop the audience or the moderation grant.
    for (const scope of [
      ...TWITCH_AUDIENCE_SCOPES,
      TWITCH_MODERATION_SCOPE,
      ...TWITCH_BITS_POINTS_SCOPES
    ]) {
      expect(connectOptionalScopes('twitch')).toContain(scope)
      expect(platformConnectOptions('twitch')?.optionalScopes).toContain(scope)
      expect(permissionReconnectOptions('twitch')?.optionalScopes).toContain(scope)
    }
    expect(platformConnectOptions('twitch')).toEqual({ optionalScopes: TWITCH_OPTIONAL_SCOPES })
    expect(permissionReconnectOptions('twitch')).toEqual({
      optionalScopes: TWITCH_OPTIONAL_SCOPES
    })
  })

  it('asks for Kick moderation only from its permission row', () => {
    // Kick can refuse a scope its app settings don't enable; asking on every
    // connect would fail every Kick connect until the app enables it.
    expect(connectOptionalScopes('kick')).toEqual([])
    expect(platformConnectOptions('kick')).toBeUndefined()
    expect(permissionReconnectScopes('kick')).toEqual([KICK_MODERATION_SCOPE])
    expect(permissionReconnectOptions('kick')).toEqual({ optionalScopes: [KICK_MODERATION_SCOPE] })
  })

  it('passes nothing extra where a platform has no optional scope', () => {
    for (const platform of ['youtube', 'x', 'tiktok', 'instagram', 'custom'] as const) {
      expect(connectOptionalScopes(platform)).toEqual([])
      expect(platformConnectOptions(platform)).toBeUndefined()
      expect(permissionReconnectScopes(platform)).toEqual([])
      expect(permissionReconnectOptions(platform)).toBeUndefined()
    }
  })

  it('matches the backend optional_scopes_for table exactly', () => {
    const table = rustOptionalScopes(oauthSource)
    // Every arm the backend declares is a platform the desktop knows.
    const known = new Set(Object.values(RUST_VARIANTS))
    for (const variant of table.keys()) expect(known).toContain(variant)
    for (const platform of ALL_PLATFORMS) {
      expect(permissionReconnectScopes(platform), platform).toEqual(
        table.get(RUST_VARIANTS[platform]) ?? []
      )
    }
  })

  it('names the same scope strings as the backend constants', () => {
    const constants = rustConstants(oauthSource)
    expect(constants.get('TWITCH_MODERATION_SCOPE')).toBe(TWITCH_MODERATION_SCOPE)
    expect(constants.get('KICK_MODERATION_SCOPE')).toBe(KICK_MODERATION_SCOPE)
    expect(constants.get('TWITCH_FOLLOWERS_SCOPE')).toBe(TWITCH_AUDIENCE_SCOPES[0])
    expect(constants.get('TWITCH_SUBSCRIPTIONS_SCOPE')).toBe(TWITCH_AUDIENCE_SCOPES[1])
    expect(constants.get('TWITCH_BITS_SCOPE')).toBe(TWITCH_BITS_POINTS_SCOPES[0])
    expect(constants.get('TWITCH_REDEMPTIONS_SCOPE')).toBe(TWITCH_BITS_POINTS_SCOPES[1])
    expect(oauthSource).toContain(`"${YOUTUBE_FORCE_SSL_SCOPE}"`)
  })
})

describe('removeMessagesReadiness (plan 140, S5)', () => {
  it('YouTube is ready with youtube.force-ssl on a connected account', () => {
    expect(
      removeMessagesReadiness('youtube', account('connected', [YOUTUBE_FORCE_SSL_SCOPE]))
    ).toBe('ready')
    expect(removeMessagesReadiness('youtube', account('connected', []))).toBe('missing-scope')
  })

  it('Twitch is ready only with the moderation scope', () => {
    const base = ['user:read:chat', 'user:write:chat']
    expect(
      removeMessagesReadiness('twitch', account('connected', [...base, TWITCH_MODERATION_SCOPE]))
    ).toBe('ready')
    // The audience scopes are not enough, and neither is Kick's scope.
    expect(
      removeMessagesReadiness('twitch', account('connected', [...base, ...TWITCH_AUDIENCE_SCOPES]))
    ).toBe('missing-scope')
    expect(
      removeMessagesReadiness('twitch', account('connected', [...base, KICK_MODERATION_SCOPE]))
    ).toBe('missing-scope')
  })

  it('Kick is ready only with its moderation scope', () => {
    const base = ['user:read', 'chat:write', 'events:subscribe']
    expect(
      removeMessagesReadiness('kick', account('connected', [...base, KICK_MODERATION_SCOPE]))
    ).toBe('ready')
    expect(removeMessagesReadiness('kick', account('connected', base))).toBe('missing-scope')
    expect(
      removeMessagesReadiness('kick', account('connected', [...base, TWITCH_MODERATION_SCOPE]))
    ).toBe('missing-scope')
  })

  it('X is ready once X Live is authorized for a connected account, whatever its scopes', () => {
    const scopes = ['tweet.read', 'users.read', 'offline.access']
    expect(
      removeMessagesReadiness('x', account('connected', scopes), { xLiveAuthorized: true })
    ).toBe('ready')
    expect(removeMessagesReadiness('x', account('connected', scopes))).toBe('missing-scope')
    expect(
      removeMessagesReadiness('x', account('connected', scopes), { xLiveAuthorized: false })
    ).toBe('missing-scope')
    expect(removeMessagesReadiness('x', account('connected', [TWITCH_MODERATION_SCOPE]), {})).toBe(
      'missing-scope'
    )
  })

  it('an account that is not connected needs a reconnect, scopes or not', () => {
    const held = {
      youtube: [YOUTUBE_FORCE_SSL_SCOPE],
      twitch: [TWITCH_MODERATION_SCOPE],
      kick: [KICK_MODERATION_SCOPE],
      x: []
    }
    for (const [platform, scopes] of Object.entries(held) as [StreamPlatform, string[]][]) {
      for (const status of ['needs-reconnect', 'disconnected'] as const) {
        expect(
          removeMessagesReadiness(platform, account(status, scopes), { xLiveAuthorized: true }),
          `${platform} ${status}`
        ).toBe('missing-scope')
      }
      expect(removeMessagesReadiness(platform, undefined, { xLiveAuthorized: true })).toBe(
        'missing-scope'
      )
      expect(removeMessagesReadiness(platform, null)).toBe('missing-scope')
    }
  })

  it('platforms without a delete API are unsupported, whatever the account holds', () => {
    const everything = account('connected', [
      YOUTUBE_FORCE_SSL_SCOPE,
      TWITCH_MODERATION_SCOPE,
      KICK_MODERATION_SCOPE
    ])
    for (const platform of ['tiktok', 'instagram', 'custom'] as const) {
      expect(removeMessagesReadiness(platform, everything, { xLiveAuthorized: true })).toBe(
        'unsupported'
      )
      expect(removeMessagesReadiness(platform, undefined)).toBe('unsupported')
    }
  })
})

describe('Stream Manager reconnect rows (plan 140, S5)', () => {
  const provider = (
    platform: StreamPlatform,
    moderate?: string,
    id = `${platform}-destination`
  ): LiveChatProviderState =>
    ({
      id,
      platform,
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: '',
      ...(moderate === undefined ? {} : { moderate })
    }) as LiveChatProviderState

  it('only Twitch and Kick reconnect from the Stream Manager', () => {
    expect(isScopeReconnectPlatform('twitch')).toBe(true)
    expect(isScopeReconnectPlatform('kick')).toBe(true)
    for (const value of ['youtube', 'x', 'tiktok', 'Twitch', '', null, undefined, 7, {}]) {
      expect(isScopeReconnectPlatform(value)).toBe(false)
    }
  })

  it('lists each Twitch or Kick chat missing the scope once, in provider order', () => {
    expect(
      removeMessagesReconnectPlatforms([
        provider('kick', 'missing-scope'),
        provider('youtube', 'missing-scope'),
        provider('twitch', 'missing-scope'),
        provider('x', 'missing-scope'),
        provider('twitch', 'missing-scope', 'twitch-vertical')
      ])
    ).toEqual(['kick', 'twitch'])
  })

  it('stays empty when nothing is missing or the backend has not said', () => {
    expect(
      removeMessagesReconnectPlatforms([
        provider('twitch', 'ready'),
        provider('kick', 'paused'),
        provider('twitch', 'unsupported'),
        provider('kick')
      ])
    ).toEqual([])
    expect(removeMessagesReconnectPlatforms([])).toEqual([])
  })

  it('says Reconnect and names Buddy, in plain words', () => {
    expect(removeMessagesReconnectCopy('twitch')).toBe(
      'Reconnect Twitch to let Buddy remove messages.'
    )
    expect(removeMessagesReconnectCopy('kick')).toBe('Reconnect Kick to let Buddy remove messages.')
    for (const platform of ['twitch', 'kick'] as const) {
      expect(removeMessagesReconnectCopy(platform)).not.toMatch(/—|co-host/i)
    }
  })
})
