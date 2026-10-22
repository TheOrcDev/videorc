// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PlatformAccount,
  PlatformAccountValidation,
  StreamTargetSettings
} from '@/lib/backend'

import { DestinationCard } from './destination-card'

// Plan 174 S0.3 (D-16): Disconnect signs the account out at once, and for
// YouTube it takes YouTube Vertical with it, so it asks and says so.

function target(platform: StreamTargetSettings['platform']): StreamTargetSettings {
  return {
    id: platform,
    platform,
    label: platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : platform,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'oauth',
    outputOrientation: 'horizontal'
  } as StreamTargetSettings
}

function account(platform: PlatformAccount['platform']): PlatformAccount {
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
    status: 'connected'
  }
}

function validation(platform: PlatformAccountValidation['platform']): PlatformAccountValidation {
  return { platform, state: 'valid', scopes: [], message: 'Account access is valid.' }
}

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
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function render(platform: 'twitch' | 'youtube'): Promise<ReturnType<typeof vi.fn>> {
  const onDisconnect = vi.fn()
  await act(async () =>
    root.render(
      createElement(DestinationCard, {
        target: target(platform),
        account: account(platform),
        validation: validation(platform),
        disabled: false,
        enableGate: { allowed: true, reason: null } as never,
        expanded: true,
        xNativeCapability: null,
        xNativeCapabilityLoading: false,
        youtubeChannels: [],
        youtubeChannelsLoading: false,
        onConnect: vi.fn(),
        onDisconnect,
        onPatch: vi.fn(),
        onSaveManualStreamKey: vi.fn(async () => true),
        onRestorePreviousStreamKey: vi.fn(async () => undefined),
        onRefreshYouTubeChannels: vi.fn(async () => undefined),
        onRefreshXNativeCapability: vi.fn(async () => undefined),
        onAuthorizeXLive: vi.fn(async () => undefined),
        onSelectYouTubeChannel: vi.fn(async () => undefined)
      } as never)
    )
  )
  return onDisconnect
}

function disconnectButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Disconnect'
  )
  expect(found).toBeTruthy()
  return found!
}

describe('DestinationCard Disconnect', () => {
  it('asks first, keeps the account on Cancel, and signs out on confirm', async () => {
    const onDisconnect = await render('twitch')
    await act(async () => disconnectButton().click())
    const dialog = byTestId('account-disconnect-dialog')
    expect(dialog?.textContent).toContain('Disconnect Twitch?')
    expect(dialog?.textContent).toContain('Videorc signs out of Twitch.')
    await act(async () => byTestId('account-disconnect-cancel')!.click())
    expect(onDisconnect).not.toHaveBeenCalled()
    await act(async () => disconnectButton().click())
    await act(async () => byTestId('account-disconnect-confirm')!.click())
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith('twitch')
  })

  it('names YouTube and YouTube Vertical, which share the account', async () => {
    await render('youtube')
    await act(async () => disconnectButton().click())
    const dialog = byTestId('account-disconnect-dialog')
    expect(dialog?.textContent).toContain('Disconnect YouTube?')
    expect(dialog?.textContent).toContain('Videorc signs out of YouTube and YouTube Vertical.')
    expect(byTestId('account-disconnect-confirm')?.textContent).toBe('Disconnect YouTube')
  })
})
