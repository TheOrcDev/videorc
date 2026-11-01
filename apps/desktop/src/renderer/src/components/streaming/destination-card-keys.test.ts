// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlatformAccount, StreamTargetSettings } from '@/lib/backend'

import { DestinationCard, destinationQualityTag, manualKeyGuidance } from './destination-card'

// Plan 174 S3.5a: the row anatomy (V-2, D-17), an explicit Save key (D-39),
// server URL rules (D-19), where to find a key (D-20) and the sign-in wait
// (D-16).

function target(
  platform: StreamTargetSettings['platform'],
  patch: Partial<StreamTargetSettings> = {}
): StreamTargetSettings {
  return {
    id: platform,
    platform,
    label: platform === 'twitch' ? 'Twitch' : platform === 'youtube' ? 'YouTube' : platform,
    enabled: true,
    serverUrl: 'rtmp://live.example.com/app',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'manual-rtmp',
    outputOrientation: 'horizontal',
    ...patch
  } as StreamTargetSettings
}

function account(platform: PlatformAccount['platform']): PlatformAccount {
  return {
    id: `${platform}-account`,
    platform,
    accountId: 'orcdev-id',
    accountLabel: 'OrcDev',
    scopes: [],
    accessTokenPresent: true,
    refreshTokenPresent: true,
    streamKeyPresent: false,
    connectedAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z',
    status: 'connected'
  }
}

function props(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    disabled: false,
    enableGate: { allowed: true },
    expanded: true,
    xNativeCapability: null,
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
    ...patch
  }
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

async function mount(patch: Record<string, unknown>): Promise<void> {
  await act(async () => root.render(createElement(DestinationCard, props(patch) as never)))
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === label
  )
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('destination row anatomy', () => {
  it('says 9:16 in words and keeps the switch last, whatever tags the row has', () => {
    const markup = renderToStaticMarkup(
      createElement(
        DestinationCard,
        props({
          target: target('youtube', {
            label: 'YouTube Vertical',
            outputOrientation: 'vertical',
            outputPreset: 'stream-safe-1080p60'
          }),
          expanded: false
        }) as never
      )
    )
    expect(markup).toContain('9:16 · Stream key')
    expect(markup).not.toMatch(/>9:16</)
    // The quality tag names the override, and the controls close the row.
    expect(markup).toContain('1080p · 60 fps')
    expect(markup.indexOf('data-testid="destination-quality"')).toBeLessThan(
      markup.indexOf('data-slot="destination-controls"')
    )
    expect(markup).not.toContain('Quality override')
  })

  it('tags a horizontal row with its own quality too, and none without one', () => {
    expect(destinationQualityTag({ outputPreset: 'stream-safe-1080p30' })).toBe('1080p · 30 fps')
    expect(destinationQualityTag({})).toBeNull()
    const markup = renderToStaticMarkup(
      createElement(
        DestinationCard,
        props({
          target: target('twitch', { outputPreset: 'stream-safe-1080p60' }),
          expanded: false
        }) as never
      )
    )
    expect(markup).toContain('data-testid="destination-quality"')
  })
})

describe('where to find a stream key', () => {
  it('links every platform that takes a key, and says where a custom server keeps it', () => {
    for (const platform of [
      'youtube',
      'twitch',
      'kick',
      'x',
      'facebook',
      'tiktok',
      'instagram'
    ] as const) {
      expect(manualKeyGuidance(platform).link?.url, platform).toMatch(/^https:\/\//)
    }
    expect(manualKeyGuidance('custom')).toEqual({
      copy: 'Your streaming server gives you its server URL and stream key.'
    })
  })
})

describe('stream key and server URL', () => {
  it('saves the key only with Save key or Enter, never on leaving the field', async () => {
    const onSaveManualStreamKey = vi.fn(async () => true)
    await mount({ target: target('twitch'), onSaveManualStreamKey })
    expect(button('Save key')).toBeUndefined()
    const key = container.querySelector<HTMLInputElement>('#twitch-key')!
    await type(key, 'live_123_abc')
    await act(async () => key.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onSaveManualStreamKey).not.toHaveBeenCalled()
    await act(async () => button('Save key')!.click())
    expect(onSaveManualStreamKey).toHaveBeenCalledWith('twitch', 'live_123_abc')
  })

  it('shows the saved key ending once', async () => {
    await mount({ target: target('twitch', { streamKeyPresent: true, streamKeyHint: '9f2a' }) })
    expect(container.textContent?.match(/9f2a/g)).toHaveLength(1)
    expect(container.querySelector<HTMLInputElement>('#twitch-key')!.placeholder).toBe(
      'Paste a new key to replace it'
    )
  })

  it('says a saved server URL is wrong at once, and a typed one after the field is left', async () => {
    await mount({ target: target('custom', { serverUrl: 'http://live.example.com/app' }) })
    expect(container.textContent).toContain('Server URLs start with rtmp:// or rtmps://.')
    await act(async () => root.unmount())
    root = createRoot(container)
    const onPatch = vi.fn()
    await mount({ target: target('custom'), onPatch })
    expect(container.textContent).not.toContain('Server URLs start with')
  })

  it('refuses a full URL that is not RTMP before asking to save it', async () => {
    const onSaveManualStreamKey = vi.fn(async () => true)
    await mount({
      target: target('custom', { urlMode: 'full-url', serverUrl: '' }),
      onSaveManualStreamKey
    })
    await type(container.querySelector<HTMLInputElement>('#custom-server')!, 'https://x.example/k')
    await act(async () => button('Save URL')!.click())
    expect(onSaveManualStreamKey).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Full URLs start with rtmp:// or rtmps://.')
  })
})

describe('signing in', () => {
  it('waits for the browser with a link to copy, until the account arrives', async () => {
    const onConnect = vi.fn(async () => 'https://id.twitch.tv/oauth2/authorize?x=1')
    const twitch = target('twitch', { authMode: 'oauth' })
    await mount({ target: twitch, onConnect })
    await act(async () => button('Connect Twitch')!.click())
    expect(container.textContent).toContain('Waiting for your browser…')
    expect(button('Copy link')).toBeTruthy()
    expect(button('Connect Twitch')).toBeUndefined()

    await act(async () => button('Cancel')!.click())
    expect(button('Connect Twitch')).toBeTruthy()

    await act(async () => button('Connect Twitch')!.click())
    await mount({ target: twitch, onConnect, account: account('twitch') })
    expect(container.textContent).not.toContain('Waiting for your browser…')
  })

  it('goes back to Connect when the sign-in never reached the browser', async () => {
    const onConnect = vi.fn(async () => null)
    await mount({ target: target('twitch', { authMode: 'oauth' }), onConnect })
    await act(async () => button('Connect Twitch')!.click())
    expect(container.textContent).not.toContain('Waiting for your browser…')
    expect(button('Connect Twitch')).toBeTruthy()
  })
})
