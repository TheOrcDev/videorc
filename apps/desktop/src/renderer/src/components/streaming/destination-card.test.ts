import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  OAuthProviderCredentialStatus,
  PlatformAccount,
  PlatformAccountValidation,
  StreamTargetSettings,
  XNativeLiveCapability
} from '@/lib/backend'

import { accountStatus, DestinationCard, idleDestinationBadge } from './destination-card'

// Plan 080 S5/S6: the owner's screenshot showed raw OAuth scopes, three
// statuses saying the same thing, and a full-width Disconnect. These tests pin
// the reorganized card: one account row, words only when something needs you.

function target(
  platform: StreamTargetSettings['platform'],
  patch: Partial<StreamTargetSettings> = {}
): StreamTargetSettings {
  return {
    id: platform,
    platform,
    label: platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : platform,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'oauth',
    outputOrientation: 'horizontal',
    ...patch
  } as StreamTargetSettings
}

function account(
  platform: PlatformAccount['platform'],
  patch: Partial<PlatformAccount> = {}
): PlatformAccount {
  return {
    id: `${platform}-account`,
    platform,
    accountId: 'orcdev-id',
    accountLabel: 'OrcDev',
    accountHandle: '@orcdev',
    scopes: [],
    accessTokenPresent: true,
    refreshTokenPresent: true,
    streamKeyPresent: false,
    connectedAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
    status: 'connected',
    ...patch
  }
}

function validation(
  platform: PlatformAccountValidation['platform'],
  state: PlatformAccountValidation['state'],
  message = 'Account access is valid.'
): PlatformAccountValidation {
  return { platform, state, scopes: [], message }
}

const TWITCH_SCOPES = [
  'channel:manage:broadcast',
  'channel:read:stream_key',
  'user:read:chat',
  'user:write:chat'
]
const TWITCH_ALL_SCOPES = [
  ...TWITCH_SCOPES,
  'moderator:read:followers',
  'channel:read:subscriptions'
]
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'

function render(props: {
  target: StreamTargetSettings
  account?: PlatformAccount
  validation?: PlatformAccountValidation
  credentials?: OAuthProviderCredentialStatus
  sharedAccountWith?: string
  xNativeCapability?: XNativeLiveCapability | null
  expanded?: boolean
}): string {
  return renderToStaticMarkup(
    createElement(DestinationCard, {
      disabled: false,
      enableGate: { allowed: true, reason: null } as never,
      expanded: props.expanded ?? true,
      xNativeCapability: props.xNativeCapability ?? null,
      xNativeCapabilityLoading: false,
      youtubeChannels: [],
      youtubeChannelsLoading: false,
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onPatch: vi.fn(),
      onSaveManualStreamKey: vi.fn(async () => true),
      onRestorePreviousStreamKey: vi.fn(async () => undefined),
      onRefreshYouTubeChannels: vi.fn(async () => undefined),
      onRefreshXNativeCapability: vi.fn(async () => undefined),
      onAuthorizeXLive: vi.fn(async () => undefined),
      onSelectYouTubeChannel: vi.fn(async () => undefined),
      ...props
    })
  )
}

/** Visible text only: a raw provider message may live in a title, never inline. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('DestinationCard header', () => {
  it('is a keyboard-reachable row that says Stream key in key mode', () => {
    const markup = render({ target: target('kick', { authMode: 'manual-rtmp' }), expanded: false })
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('>Stream key<')
  })

  it('stays quiet when a destination is ready, and says Needs setup when it is not', () => {
    const ready = target('twitch')
    const signedIn = account('twitch')
    expect(idleDestinationBadge(ready, signedIn)).toBeNull()
    expect(idleDestinationBadge(ready, undefined)).toEqual({
      tone: 'warning',
      label: 'Needs setup'
    })
    expect(idleDestinationBadge({ ...ready, enabled: false }, undefined)).toBeNull()
    expect(
      idleDestinationBadge(
        { ...ready, status: { state: 'ready' } } as StreamTargetSettings,
        signedIn
      )
    ).toEqual({ tone: 'success', label: 'Prepared' })
    // The old header said "Idle" for every idle card.
    expect(render({ target: ready, account: signedIn, expanded: false })).not.toContain('>Idle<')
  })
})

describe('DestinationCard connection mode', () => {
  it('offers Sign in / Stream key as a segmented control', () => {
    const markup = render({ target: target('twitch'), account: account('twitch') })
    expect(markup).toContain('Connect with')
    expect(markup).toContain('>Sign in<')
    expect(markup).toContain('>Stream key<')
    expect(markup).toContain('data-slot="tabs-list"')
    expect(markup).not.toContain('Auth mode')
    expect(markup).not.toContain('OAuth')
    expect(markup).not.toContain('Manual RTMP')
  })

  it('shows no switch for a key-only platform, just one line and where to find the key', () => {
    const markup = render({ target: target('tiktok', { authMode: 'manual-rtmp' }) })
    expect(markup).not.toContain('Connect with')
    expect(markup).toContain('TikTok uses a stream key.')
    expect(markup).toContain('TikTok LIVE Center')
    expect(markup).toContain('>Server URL<')
    expect(markup).toContain('>Stream key<')
  })

  it('shows Kick key guidance only in Stream key mode', () => {
    expect(render({ target: target('kick'), account: account('kick') })).not.toContain(
      'Creator Dashboard'
    )
    expect(render({ target: target('kick', { authMode: 'manual-rtmp' }) })).toContain(
      'Creator Dashboard'
    )
  })

  it('falls back to a stream key without developer words when sign-in is not bundled', () => {
    const markup = render({
      target: target('kick', { authMode: 'manual-rtmp' }),
      credentials: {
        platform: 'kick',
        ready: false,
        clientIdPresent: false,
        clientSecretPresent: false,
        clientIdSource: 'missing',
        pkce: true,
        message: 'Kick OAuth client ID is missing from this build.'
      }
    })
    expect(markup).toContain('Signing in to Kick isn&#x27;t available in this build.')
    expect(markup).not.toContain('client ID')
    expect(markup).not.toContain('Missing client ID')
  })
})

describe('DestinationCard signed-in account', () => {
  it('reads as one row: no scopes, no nested status box, a small Disconnect', () => {
    const markup = render({
      target: target('twitch'),
      account: account('twitch', { scopes: TWITCH_ALL_SCOPES }),
      validation: validation('twitch', 'valid')
    })
    for (const scope of TWITCH_ALL_SCOPES) expect(markup).not.toContain(scope)
    expect(markup).not.toContain('Validated')
    expect(visibleText(markup)).not.toContain('Account access is valid.')
    expect(markup).toContain('title="Account access is valid."')
    expect(markup).toContain('aria-label="Connected"')
    expect(visibleText(markup)).toContain('Disconnect')
    expect(markup).not.toContain('Needs reconnect')
  })

  it('never shows a Google scope URL', () => {
    const markup = render({
      target: target('youtube'),
      account: account('youtube', { scopes: [YOUTUBE_SCOPE] }),
      validation: validation('youtube', 'refreshed', 'Token refreshed and account access is valid.')
    })
    expect(markup).not.toContain('googleapis.com/auth')
    expect(markup).toContain('>Channel<')
    expect(markup).toContain('aria-label="Refresh channels"')
    expect(markup).not.toContain('Switching channels clears prepared')
  })

  it('names a lost account in plain words and keeps the raw error on hover', () => {
    const raw =
      'Account validation failed: 401 Unauthorized; token refresh retry failed: invalid_grant'
    const markup = render({
      target: target('youtube'),
      account: account('youtube', { status: 'needs-reconnect' }),
      validation: validation('youtube', 'needs-reconnect', raw)
    })
    expect(markup).toContain('Needs reconnect')
    expect(markup).toContain(
      'Videorc lost access to this account. Reconnect to keep streaming here.'
    )
    expect(markup).toContain('>Reconnect<')
    expect(visibleText(markup)).not.toContain('invalid_grant')
    expect(markup).toContain('invalid_grant')
  })

  it('shows no status dot before the account was checked', () => {
    const markup = render({ target: target('kick'), account: account('kick') })
    expect(markup).not.toContain('aria-label="Connected"')
    expect(markup).not.toContain('Not checked')
  })

  it('keeps the Twitch follower permission prompt, in fewer words', () => {
    const markup = render({
      target: target('twitch'),
      account: account('twitch', { scopes: TWITCH_SCOPES }),
      validation: validation('twitch', 'valid')
    })
    expect(markup).toContain('Follow alerts and sub count need one more Twitch permission.')
    expect(markup).toContain('Reconnect Twitch')
    expect(
      render({
        target: target('twitch'),
        account: account('twitch', { scopes: TWITCH_ALL_SCOPES })
      })
    ).not.toContain('Reconnect Twitch')
  })

  it('points YouTube Vertical at the YouTube card instead of repeating channel and Disconnect', () => {
    const markup = render({
      target: target('youtube', { id: 'youtube-vertical', label: 'YouTube Vertical' }),
      account: account('youtube'),
      sharedAccountWith: 'YouTube'
    })
    expect(markup).toContain('Same account and channel as YouTube.')
    expect(markup).not.toContain('>Channel<')
    expect(markup).not.toContain('Disconnect')
  })

  it('offers X Live authorization and an explicit stream-key fallback', () => {
    const markup = render({
      target: target('x', { label: 'X / Twitter' }),
      account: account('x'),
      xNativeCapability: {
        state: 'needs-authorization',
        nativeAvailable: false,
        message: 'Approve live broadcasting for this account on x.com.',
        docsUrl: 'https://docs.x.com/producer',
        apiOverviewUrl: 'https://docs.x.com/api'
      } as XNativeLiveCapability
    })
    expect(markup).toContain('Authorization needed')
    expect(markup).toContain('Authorize X Live')
    expect(markup).toContain('Use a stream key instead')
    expect(markup).toContain('X Producer docs')
    expect(markup).not.toContain('Manual RTMP')
  })
})

describe('DestinationCard not signed in', () => {
  it('says what signing in does, with one Connect button and no credential jargon', () => {
    const markup = render({
      target: target('twitch'),
      credentials: {
        platform: 'twitch',
        ready: true,
        clientIdPresent: true,
        clientSecretPresent: false,
        clientIdSource: 'bundled',
        pkce: true,
        message: 'Uses bundled Twitch client credentials.'
      }
    })
    expect(markup).toContain('Videorc sets your title and gets the stream key for you.')
    expect(markup).toContain('Connect Twitch')
    expect(markup).not.toContain('Bundled default')
    expect(markup).not.toContain('Uses backend provider credentials.')
    expect(markup).not.toContain('No account connected')
  })

  it('names an environment override only in a developer build', () => {
    const credentials: OAuthProviderCredentialStatus = {
      platform: 'twitch',
      ready: true,
      clientIdPresent: true,
      clientSecretPresent: false,
      clientIdSource: 'environment',
      pkce: true,
      message: 'Uses VIDEORC_TWITCH_CLIENT_ID.'
    }
    vi.stubEnv('DEV', true)
    expect(render({ target: target('twitch'), credentials })).toContain('Environment override')
    vi.stubEnv('DEV', false)
    expect(render({ target: target('twitch'), credentials })).not.toContain('Environment override')
  })
})

describe('accountStatus', () => {
  it('folds account and validation into one status', () => {
    expect(accountStatus(account('kick'), validation('kick', 'valid'))).toBe('ok')
    expect(accountStatus(account('kick'), validation('kick', 'refreshed'))).toBe('ok')
    expect(accountStatus(account('kick'), undefined)).toBe('unchecked')
    expect(accountStatus(account('kick'), validation('kick', 'missing'))).toBe('unchecked')
    expect(accountStatus(account('kick'), validation('kick', 'needs-reconnect'))).toBe('reconnect')
    expect(accountStatus(account('kick', { status: 'needs-reconnect' }), undefined)).toBe(
      'reconnect'
    )
  })
})
