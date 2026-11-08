import { describe, expect, it } from 'vitest'

import type { PlatformAccount, StreamingSettings, StreamTargetSettings } from '@/lib/backend'
import { DEFAULT_BASIC_ENTITLEMENTS } from '@/lib/entitlements'

import { setupDestinationsToTurnOn, type SetupPlatform } from './destinations-step'

// Plan 207 S7, D10: a sign-in started in setup switches its destination to
// Sign in and turns it on, inside the cap; nothing else is touched.

const target = (id: string, enabled = false): StreamTargetSettings =>
  ({ id, platform: id, enabled, authMode: 'manual-rtmp' }) as unknown as StreamTargetSettings

const streaming = (targets: StreamTargetSettings[]): StreamingSettings =>
  ({
    targets,
    enabledTargetIds: targets.filter((entry) => entry.enabled).map((entry) => entry.id)
  }) as unknown as StreamingSettings

const account = (platform: string, status = 'connected'): PlatformAccount =>
  ({ platform, status, accountId: `${platform}-1`, accountLabel: platform }) as PlatformAccount

const TARGETS = ['youtube', 'twitch', 'kick', 'x'].map((id) => target(id))

function turnOn(
  started: SetupPlatform[],
  accounts: PlatformAccount[],
  targets = TARGETS
): ReturnType<typeof setupDestinationsToTurnOn> {
  return setupDestinationsToTurnOn({
    started: new Set(started),
    accounts,
    streaming: streaming(targets),
    entitlements: DEFAULT_BASIC_ENTITLEMENTS
  })
}

describe('setupDestinationsToTurnOn', () => {
  it('turns on a destination whose sign-in started in setup and connected', () => {
    expect(turnOn(['twitch'], [account('twitch')])).toEqual([
      {
        platform: 'twitch',
        targetId: 'twitch',
        accountId: 'twitch-1',
        patch: { authMode: 'oauth', enabled: true }
      }
    ])
  })

  it('waits while the account is not connected yet', () => {
    expect(turnOn(['kick'], [])).toEqual([])
    expect(turnOn(['kick'], [account('kick', 'needs-reconnect')])).toEqual([])
  })

  it('never touches an account that was connected without a sign-in from setup', () => {
    expect(turnOn([], [account('youtube'), account('x')])).toEqual([])
  })

  it('keeps the switch where the cap of 5 refuses another destination', () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map((id) => target(id, true))
    expect(turnOn(['youtube'], [account('youtube')], [...full, target('youtube')])).toEqual([
      {
        platform: 'youtube',
        targetId: 'youtube',
        accountId: 'youtube-1',
        patch: { authMode: 'oauth', enabled: false }
      }
    ])
  })

  it('keeps a destination that is already on, on', () => {
    expect(turnOn(['x'], [account('x')], [target('x', true)])[0]?.patch).toEqual({
      authMode: 'oauth',
      enabled: true
    })
  })
})
