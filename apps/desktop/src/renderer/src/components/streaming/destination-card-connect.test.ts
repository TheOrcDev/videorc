// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PlatformAccount,
  PlatformAccountValidation,
  StreamTargetSettings
} from '@/lib/backend'

import { KICK_OPTIONAL_SCOPES, TWITCH_OPTIONAL_SCOPES } from '../../../../shared/platform-scopes'
import { DestinationCard } from './destination-card'

// Plan 140, S5: the backend requests a platform's base scopes plus only the
// optional ones it is passed. Every button on the card that starts a connect
// must pass the whole optional union, or a reconnect would never grant the
// follow, sub or moderation permission it lacks. These click every path.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const TWITCH_BASE = [
  'channel:manage:broadcast',
  'channel:read:stream_key',
  'user:read:chat',
  'user:write:chat'
]
const KICK_BASE = ['user:read', 'chat:write', 'events:subscribe']

function target(platform: StreamTargetSettings['platform']): StreamTargetSettings {
  return {
    id: platform,
    platform,
    label: platform,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'oauth',
    outputOrientation: 'horizontal'
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
    connectedAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
    status: 'connected',
    ...patch
  }
}

async function render(props: {
  target: StreamTargetSettings
  account?: PlatformAccount
  validation?: PlatformAccountValidation
}): Promise<ReturnType<typeof vi.fn>> {
  const onConnect = vi.fn()
  await act(async () =>
    root.render(
      createElement(DestinationCard, {
        disabled: false,
        enableGate: { allowed: true, reason: null } as never,
        expanded: true,
        xNativeCapability: null,
        xNativeCapabilityLoading: false,
        youtubeChannels: [],
        youtubeChannelsLoading: false,
        onConnect,
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
  )
  return onConnect
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter(
    (candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === label
  )
}

async function click(label: string): Promise<void> {
  const [button, ...others] = buttons(label)
  expect(button, label).toBeTruthy()
  expect(others, `one ${label} button`).toHaveLength(0)
  await act(async () => button.click())
}

describe('DestinationCard connect paths (plan 140, S5)', () => {
  it('Connect Twitch asks for every optional Twitch permission', async () => {
    const onConnect = await render({ target: target('twitch') })
    await click('Connect Twitch')
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onConnect).toHaveBeenCalledWith('twitch', { optionalScopes: TWITCH_OPTIONAL_SCOPES })
  })

  it('Connect Kick asks for nothing extra', async () => {
    // Kick's moderation permission is asked for only from the Remove messages
    // row: Kick can refuse a scope its app settings don't enable.
    const onConnect = await render({ target: target('kick') })
    await click('Connect Kick')
    expect(onConnect).toHaveBeenCalledWith('kick', undefined)
  })

  it('Connect X asks for nothing extra', async () => {
    const onConnect = await render({ target: target('x') })
    await click('Connect X')
    expect(onConnect).toHaveBeenCalledWith('x', undefined)
  })

  it('the Remove messages row reconnects Twitch with the whole union', async () => {
    const onConnect = await render({
      target: target('twitch'),
      account: account('twitch', { scopes: TWITCH_BASE })
    })
    await click('Reconnect')
    expect(onConnect).toHaveBeenCalledWith('twitch', { optionalScopes: TWITCH_OPTIONAL_SCOPES })
  })

  it('the follow alerts row no longer asks for a subset', async () => {
    // It used to pass only the audience scopes: a Reconnect there could never
    // add the moderation permission.
    const onConnect = await render({
      target: target('twitch'),
      account: account('twitch', { scopes: [...TWITCH_BASE, 'moderator:manage:chat_messages'] })
    })
    await click('Reconnect Twitch')
    expect(onConnect).toHaveBeenCalledWith('twitch', { optionalScopes: TWITCH_OPTIONAL_SCOPES })
  })

  it('a lost Twitch account reconnects with the whole union', async () => {
    const onConnect = await render({
      target: target('twitch'),
      account: account('twitch', { scopes: TWITCH_BASE, status: 'needs-reconnect' })
    })
    await click('Reconnect')
    expect(onConnect).toHaveBeenCalledWith('twitch', { optionalScopes: TWITCH_OPTIONAL_SCOPES })
  })

  it('the Remove messages row reconnects Kick with its moderation permission', async () => {
    const onConnect = await render({
      target: target('kick'),
      account: account('kick', { scopes: KICK_BASE })
    })
    await click('Reconnect')
    expect(onConnect).toHaveBeenCalledWith('kick', { optionalScopes: KICK_OPTIONAL_SCOPES })
  })
})
