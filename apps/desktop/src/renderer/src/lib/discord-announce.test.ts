import { describe, expect, it } from 'vitest'

import type { StreamTargetSettings } from '@/lib/backend'
import {
  NOT_A_WEBHOOK,
  discordFailureToast,
  discordLinkTargets,
  discordWebhookFormatError,
  nextExcludedTargetIds,
  postAsFromKey,
  postAsKey
} from '@/lib/discord-announce'

describe('Discord go-live announcement (plan 187)', () => {
  it('accepts Discord webhook URLs as they are pasted', () => {
    for (const url of [
      'https://discord.com/api/webhooks/123456789/AbC-def_123',
      '  https://discordapp.com/api/webhooks/1/x  ',
      'https://ptb.discord.com/api/v10/webhooks/1/x?wait=true',
      'https://canary.discord.com/api/webhooks/1/x/',
      ''
    ]) {
      expect(discordWebhookFormatError(url), url).toBeNull()
    }
  })

  it('refuses anything that is not one', () => {
    for (const url of [
      'discord.com/api/webhooks/1/x',
      'http://discord.com/api/webhooks/1/x',
      'https://evil.com/api/webhooks/1/x',
      'https://discord.com/api/webhooks/abc/x',
      'https://discord.com/api/webhooks/1',
      'https://discord.com:8443/api/webhooks/1/x',
      'https://discord.com/channels/1/2'
    ]) {
      expect(discordWebhookFormatError(url), url).toBe(NOT_A_WEBHOOK)
    }
  })

  it('sends destinations without their keys or empty fields', () => {
    const target = {
      id: 'yt',
      platform: 'youtube',
      label: 'YouTube',
      enabled: true,
      serverUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamKey: 'live_secret',
      streamKeyPresent: true,
      authMode: 'oauth',
      accountId: 'acct-1',
      platformBroadcastId: 'abc',
      createdAt: '',
      updatedAt: ''
    } as StreamTargetSettings
    expect(discordLinkTargets([target])).toStrictEqual([
      {
        id: 'yt',
        platform: 'youtube',
        label: 'YouTube',
        authMode: 'oauth',
        accountId: 'acct-1',
        platformBroadcastId: 'abc'
      }
    ])
  })

  it('round-trips Post as choices through the select', () => {
    for (const postAs of [
      { kind: 'automatic' },
      { kind: 'platform', accountId: 'acct:1' },
      { kind: 'videorc' },
      { kind: 'webhook' }
    ] as const) {
      expect(postAsFromKey(postAsKey(postAs))).toStrictEqual(postAs)
    }
  })

  it('stores unticked destinations as exclusions', () => {
    expect(nextExcludedTargetIds([], 'tw', false)).toStrictEqual(['tw'])
    expect(nextExcludedTargetIds(['tw', 'kick'], 'tw', true)).toStrictEqual(['kick'])
    expect(nextExcludedTargetIds(['tw'], 'tw', false)).toStrictEqual(['tw'])
  })

  it('toasts each fresh failure once and never an old one', () => {
    const now = Date.parse('2026-10-22T18:10:00Z')
    const fresh = { lastError: { code: 'webhook-deleted', at: '2026-10-22T18:09:00Z' } } as const
    const toast = discordFailureToast(null, fresh, now)
    expect(toast).toMatchObject({
      type: 'error',
      title: "Couldn't post to Discord",
      at: '2026-10-22T18:09:00Z'
    })
    expect(discordFailureToast(toast!.at, fresh, now)).toBeNull()
    expect(
      discordFailureToast(
        null,
        { lastError: { code: 'unreachable', at: '2026-10-22T17:00:00Z' } },
        now
      )
    ).toBeNull()
    expect(discordFailureToast(null, {}, now)).toBeNull()
    expect(
      discordFailureToast(null, { lastError: { code: 'unreachable', at: fresh.lastError.at } }, now)
        ?.type
    ).toBe('warning')
  })
})
