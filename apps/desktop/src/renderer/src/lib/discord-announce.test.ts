import { describe, expect, it } from 'vitest'

import type {
  DiscordAnnounceErrorCode,
  DiscordWebhookSnapshot,
  StreamTargetSettings
} from '@/lib/backend'
import {
  NOT_A_WEBHOOK,
  discordFailureToast,
  discordLinkTargets,
  discordWebhookFormatError,
  newestDiscordFailure,
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
    const webhook = (lastError: { code: DiscordAnnounceErrorCode; at: string }, name?: string) =>
      ({ id: '1', hint: '…/a1B2', lastError, ...(name ? { name } : {}) }) as const
    const fresh = { webhooks: [webhook({ code: 'webhook-deleted', at: '2026-10-22T18:09:00Z' })] }
    const toast = discordFailureToast(null, fresh, now)
    expect(toast).toStrictEqual({
      type: 'error',
      title: "Couldn't post to Discord",
      description: 'The webhook was deleted in Discord. Paste a new one in Livestream → Setup.',
      at: '2026-10-22T18:09:00Z'
    })
    expect(discordFailureToast(toast!.at, fresh, now)).toBeNull()
    expect(
      discordFailureToast(
        null,
        { webhooks: [webhook({ code: 'unreachable', at: '2026-10-22T17:00:00Z' })] },
        now
      )
    ).toBeNull()
    expect(discordFailureToast(null, { webhooks: [] }, now)).toBeNull()
    expect(discordFailureToast(null, { webhooks: [{ id: '1', hint: '…/a1B2' }] }, now)).toBeNull()
    expect(
      discordFailureToast(
        null,
        { webhooks: [webhook({ code: 'unreachable', at: '2026-10-22T18:09:00Z' })] },
        now
      )?.type
    ).toBe('warning')
  })

  it('toasts the newest failure across several webhooks and names it', () => {
    const now = Date.parse('2026-10-22T18:10:00Z')
    const alerts = {
      id: '1',
      name: 'Stream alerts',
      hint: '…/a1B2',
      lastError: { code: 'rejected', at: '2026-10-22T18:08:00Z' }
    } as const
    const crew = {
      id: '2',
      name: 'Crew',
      hint: '…/zzzz',
      lastError: { code: 'unreachable', at: '2026-10-22T18:09:00Z' }
    } as const
    const fine: DiscordWebhookSnapshot = { id: '3', hint: '…/ffff' }
    expect(newestDiscordFailure([alerts, crew, fine])).toStrictEqual({
      name: 'Crew',
      error: crew.lastError
    })
    expect(newestDiscordFailure([fine])).toBeNull()

    const toast = discordFailureToast(null, { webhooks: [alerts, crew, fine] }, now)
    expect(toast).toStrictEqual({
      type: 'warning',
      title: "Couldn't post to Discord",
      description: "Discord couldn't be reached for 5 minutes (Crew). Your stream is fine.",
      at: '2026-10-22T18:09:00Z'
    })
    // The same snapshot again (a settings change) is not news.
    expect(discordFailureToast(toast!.at, { webhooks: [alerts, crew, fine] }, now)).toBeNull()
    // Then the other server fails: that one is news, under its own name.
    const alertsAgain = {
      ...alerts,
      lastError: { code: 'webhook-deleted', at: '2026-10-22T18:09:30Z' }
    } as const
    expect(
      discordFailureToast(toast!.at, { webhooks: [alertsAgain, crew, fine] }, now)
    ).toMatchObject({
      type: 'error',
      description:
        'The Stream alerts webhook was deleted in Discord. Paste a new one in Livestream → Setup.',
      at: '2026-10-22T18:09:30Z'
    })
    expect(
      discordFailureToast(
        null,
        { webhooks: [{ ...alerts, lastError: { code: 'rejected', at: '2026-10-22T18:09:00Z' } }] },
        now
      )?.description
    ).toBe('Discord refused the post to Stream alerts. Check the webhook in Livestream → Setup.')
  })
})
