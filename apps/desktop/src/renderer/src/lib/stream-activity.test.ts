import { describe, expect, it } from 'vitest'

import type { LiveChatEventDetails, LiveChatMessage, StreamPlatform } from '@/lib/backend'

import {
  activityItems,
  activityTotals,
  chatActivity,
  filterActivity,
  formatActivitySummary,
  formatTipsValue,
  thankYouDraft
} from './stream-activity'

// Rows as the backend normalizes the plan 055 S0 fixtures
// (scripts/fixtures/stream-manager/*.json; Rust tests pin the same details).
let sequence = 0
function row(
  platform: StreamPlatform,
  authorName: string,
  eventType: LiveChatMessage['eventType'],
  details: LiveChatEventDetails | undefined,
  messageText = '',
  receivedAt = `2026-09-24T10:00:${String(sequence).padStart(2, '0')}Z`
): LiveChatMessage {
  sequence += 1
  return {
    id: `s:${platform}:${sequence}`,
    providerMessageId: String(sequence),
    platform,
    sessionId: 's',
    authorId: `${authorName}-id`,
    authorName,
    authorBadges: [],
    authorRoles: [],
    publishedAt: receivedAt,
    receivedAt,
    messageText,
    fragments: [],
    eventType,
    isDeleted: false,
    ...(details ? { details } : {})
  }
}

const fixtures = {
  resub: row(
    'twitch',
    'morgaesis',
    'membership',
    {
      kind: 'subscription',
      subscription: 'resub',
      tier: '1000',
      isPrime: false,
      months: 3,
      streakMonths: 2
    },
    "morgaesis subscribed at Tier 1. They've subscribed for 3 months!"
  ),
  primeSub: row('twitch', 'primer', 'membership', {
    kind: 'subscription',
    subscription: 'sub',
    isPrime: true
  }),
  community: row('twitch', 'generous', 'membership', {
    kind: 'subscription',
    subscription: 'community-sub-gift',
    tier: '1000',
    isPrime: false,
    giftCount: 5,
    communityGiftId: 'gift-batch-1'
  }),
  communitySingle: row('twitch', 'generous', 'membership', {
    kind: 'subscription',
    subscription: 'sub-gift',
    tier: '1000',
    isPrime: false,
    giftCount: 1,
    recipientName: 'LuckyViewer',
    communityGiftId: 'gift-batch-1'
  }),
  anonymousGift: row('twitch', 'Anonymous', 'membership', {
    kind: 'subscription',
    subscription: 'sub-gift',
    tier: '1000',
    isPrime: false,
    giftCount: 1,
    recipientName: 'LuckyViewer'
  }),
  raid: row(
    'twitch',
    'Raider42',
    'system',
    { kind: 'raid', viewerCount: 234 },
    '234 raiders from Raider42 have joined!'
  ),
  announcement: row(
    'twitch',
    'streamer',
    'system',
    { kind: 'announcement', color: 'PURPLE' },
    'Giveaway at the top of the hour'
  ),
  cheer: row(
    'twitch',
    'sarzdotmd',
    'paid',
    { kind: 'cheer', bits: 1500 },
    'Cheer1500 amazing setup'
  ),
  superChat: row(
    'youtube',
    'Maria',
    'paid',
    {
      kind: 'super-chat',
      amountMicros: 5_000_000,
      currency: 'USD',
      amountDisplay: '$5.00',
      tier: 2
    },
    'Great stream!'
  ),
  superSticker: row('youtube', 'Jonas', 'paid', {
    kind: 'super-sticker',
    amountMicros: 2_000_000,
    currency: 'EUR',
    amountDisplay: '€2.00',
    altText: 'Party hat'
  }),
  secondSuperChat: row('youtube', 'Lee', 'paid', {
    kind: 'super-chat',
    amountMicros: 10_000_000,
    currency: 'USD',
    amountDisplay: '$10.00'
  }),
  newMember: row('youtube', 'Newbie', 'membership', {
    kind: 'membership',
    membership: 'upgrade',
    levelName: 'Gold'
  }),
  milestone: row(
    'youtube',
    'Loyal',
    'membership',
    { kind: 'membership', membership: 'milestone', months: 12, levelName: 'Gold' },
    'A year already!'
  ),
  memberGift: row('youtube', 'Gifter', 'membership', {
    kind: 'membership',
    membership: 'gift',
    giftCount: 5
  }),
  giftReceived: row('youtube', 'Lucky', 'membership', {
    kind: 'membership',
    membership: 'gift-received',
    levelName: 'Gold'
  }),
  follow: row('twitch', 'Cool_User', 'follow', { kind: 'follow' }, 'Cool_User followed'),
  chat: row('twitch', 'chatty', 'message', undefined, 'hello')
}
const all = Object.values(fixtures)

describe('stream activity', () => {
  it('turns every structured event into one row with the right line', () => {
    const lines = Object.fromEntries(
      activityItems(all).map((item) => [item.name, [item.line, item.message]])
    )
    expect(lines).toMatchObject({
      morgaesis: ['Resubscribed for 3 months at Tier 1', undefined],
      primer: ['Subscribed with Prime', undefined],
      generous: ['Gifted 5 subs', undefined],
      Anonymous: ['Gifted a Tier 1 sub to LuckyViewer', undefined],
      Raider42: ['Raided with 234 viewers', undefined],
      streamer: ['Announcement', 'Giveaway at the top of the hour'],
      sarzdotmd: ['Cheered 1,500 bits', 'amazing setup'],
      Maria: ['Super Chat · $5.00', 'Great stream!'],
      Jonas: ['Super Sticker · €2.00', 'Party hat'],
      Newbie: ['Upgraded to Gold', undefined],
      Loyal: ['Member for 12 months', 'A year already!'],
      Gifter: ['Gifted 5 memberships', undefined],
      Lucky: ['Received a gifted membership', undefined],
      Cool_User: ['Followed', undefined]
    })
    // Plain chat is not activity.
    expect(activityItems(all).some((item) => item.name === 'chatty')).toBe(false)
  })

  it("counts a community gift once, not again through Twitch's single gifts", () => {
    const generous = activityItems(all).filter((item) => item.name === 'generous')
    expect(generous).toHaveLength(1)
    // Without its community notice, a single gift still shows.
    expect(activityItems([fixtures.communitySingle])).toHaveLength(1)
  })

  it('totals supporters, bits and tips per currency', () => {
    const totals = activityTotals(all)
    // resub 1 + prime 1 + community 5 + anonymous gift 1 + upgrade 1 +
    // milestone 1 + member gift 5; a received gift is its gifter's.
    expect(totals.supporters).toBe(15)
    expect(totals.follows).toBe(1)
    expect(totals.bits).toBe(1500)
    expect(totals.raids).toBe(1)
    expect(totals.tips).toEqual([
      { currency: 'USD', amountMicros: 15_000_000 },
      { currency: 'EUR', amountMicros: 2_000_000 }
    ])
    expect(formatTipsValue(totals)).toMatch(/^1,500 bits · \$15\.00 · €2\.00$/)
    expect(formatActivitySummary(totals)).toBe(
      `1 follow · 15 subs · 1,500 bits · ${formatTipsValue({ ...totals, bits: 0 })} · 1 raid`
    )
    expect(formatTipsValue(activityTotals([fixtures.chat]))).toBeNull()
  })

  it('projects destination failures and recoveries, newest first', () => {
    const items = activityItems(
      [],
      [
        {
          id: 'a',
          kind: 'failed',
          targetId: 'twitch',
          platform: 'twitch',
          label: 'Twitch',
          message: 'Connection dropped.',
          at: '2026-09-24T10:00:02Z'
        },
        {
          id: 'b',
          kind: 'recovered',
          targetId: 'twitch',
          platform: 'twitch',
          label: 'Twitch',
          at: '2026-09-24T10:00:09Z'
        }
      ]
    )
    expect(items.map((item) => [item.kind, item.line, item.message])).toEqual([
      ['destination-recovered', 'Back on air', undefined],
      ['destination-failed', 'Destination failed', 'Connection dropped.']
    ])
  })

  it('filters by kind and platform; announcements show only under All', () => {
    const items = activityItems(all)
    expect(filterActivity(items, 'tips').map((item) => item.name)).toEqual(
      expect.arrayContaining(['sarzdotmd', 'Maria', 'Jonas', 'Lee'])
    )
    expect(filterActivity(items, 'tips', 'youtube').every((i) => i.platform === 'youtube')).toBe(
      true
    )
    expect(filterActivity(items, 'raids').map((item) => item.name)).toEqual(['Raider42'])
    expect(
      ['follows', 'support', 'tips', 'raids', 'destinations'].some((filter) =>
        filterActivity(items, filter as never).some((item) => item.kind === 'announcement')
      )
    ).toBe(false)
    expect(filterActivity(items, 'all').some((item) => item.kind === 'announcement')).toBe(true)
  })

  it('measures chat pace from viewer messages only', () => {
    const now = Date.parse('2026-09-24T10:01:00Z')
    const recent = row('youtube', 'a', 'message', undefined, 'x', '2026-09-24T10:00:30Z')
    const old = row('youtube', 'b', 'message', undefined, 'x', '2026-09-24T09:50:00Z')
    const sameAuthor = row('youtube', 'a', 'message', undefined, 'y', '2026-09-24T10:00:40Z')
    expect(chatActivity([recent, old, sameAuthor, fixtures.follow, fixtures.raid], now)).toEqual({
      perMinute: 2,
      chatters: 2
    })
  })

  it('drafts a thank-you per kind, never for destinations', () => {
    const [raid] = activityItems([fixtures.raid])
    expect(thankYouDraft(raid)).toBe('Thanks for the raid, @Raider42! Welcome in, everyone!')
    const [failed] = activityItems(
      [],
      [
        {
          id: 'x',
          kind: 'failed',
          targetId: 't',
          platform: 'x',
          label: 'X',
          at: '2026-09-24T10:00:00Z'
        }
      ]
    )
    expect(thankYouDraft(failed)).toBe('')
  })
})
