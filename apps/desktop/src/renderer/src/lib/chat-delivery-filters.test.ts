import { expect, it } from 'vitest'
import type { LiveChatEventDetails, LiveChatMessage } from '@/lib/backend'
import { admitChatDelivery, chatDeliveryActivityMatches } from '../../../shared/chat-delivery'
import { applyLiveChatSnapshot } from './live-chat-view'
import { chatPaneMessages, type ChatPaneFilter } from './stream-manager-chat'
import { activityItems } from './stream-activity'

const row = (
  id: string,
  details?: LiveChatEventDetails,
  override: Partial<LiveChatMessage> = {}
): LiveChatMessage => ({
  id,
  providerMessageId: id,
  sessionId: 's1',
  platform: 'twitch',
  authorName: 'Viewer',
  authorBadges: [],
  authorRoles: [],
  publishedAt: id,
  receivedAt: id,
  messageText: `Hello @orc ${id}`,
  fragments: [],
  eventType: 'message',
  isDeleted: false,
  details,
  ...override
})
const journal = (messages: LiveChatMessage[]) =>
  admitChatDelivery(
    applyLiveChatSnapshot({
      sessionId: 's1',
      providers: [],
      messages: [],
      unreadCount: 0,
      updatedAt: 'now'
    }),
    messages
  ).entries.map((entry) => entry.message)

it('reduced delivery facts match all production chat filter selectors without retaining fragments or paid detail values', () => {
  const messages = [
    row('one'),
    row('two', undefined, {
      platform: 'youtube',
      messageText: 'other words',
      authorName: 'Search Name'
    }),
    row('three', { kind: 'follow' }, { eventType: 'follow' })
  ]
  const facts = journal(messages)
  const context = { questionMessageIds: new Set(['one']), mentionNames: ['orc'] }
  const base: ChatPaneFilter = { platform: 'all', questions: false, mentions: false, search: '' }
  for (const filter of [
    base,
    { ...base, platform: 'youtube' as const },
    { ...base, questions: true },
    { ...base, mentions: true },
    { ...base, search: 'search name' },
    { ...base, search: 'hello', mentions: true, questions: true }
  ]) {
    expect(chatPaneMessages(facts, filter, context).map((message) => message.id)).toEqual(
      chatPaneMessages(messages, filter, context).map((message) => message.id)
    )
  }
  expect(JSON.stringify(facts)).not.toContain('fragments')
})

it('reduced Activity facts cover every detail kind and suppress community gift singles exactly like painted Activity', () => {
  const details: LiveChatEventDetails[] = [
    { kind: 'follow' },
    { kind: 'membership', membership: 'new' },
    { kind: 'subscription', subscription: 'resub', isPrime: false },
    {
      kind: 'subscription',
      subscription: 'community-sub-gift',
      communityGiftId: 'g',
      isPrime: false
    },
    { kind: 'subscription', subscription: 'sub-gift', communityGiftId: 'g', isPrime: false },
    { kind: 'subscription', subscription: 'sub-gift', isPrime: false },
    { kind: 'cheer', bits: 10 },
    { kind: 'kicks', amount: 10 },
    { kind: 'super-chat', amountMicros: 10, currency: 'USD', amountDisplay: '$1' },
    { kind: 'super-sticker', amountMicros: 10, currency: 'USD', amountDisplay: '$1' },
    { kind: 'raid', viewerCount: 10 },
    { kind: 'announcement' }
  ]
  const messages = details.map((detail, index) => row(String(index), detail))
  messages.push(row('plain'))
  const facts = journal(messages)
  const expected = activityItems(messages, [], null)
    .map((item) => item.messageId)
    .sort()
  expect(
    facts
      .filter((message) => chatDeliveryActivityMatches(message, new Set(['g'])))
      .map((message) => message.id)
      .sort()
  ).toEqual(expected)
  const serialized = JSON.stringify(facts)
  for (const field of [
    'amountMicros',
    'amountDisplay',
    'currency',
    'bits',
    'viewerCount',
    'details'
  ])
    expect(serialized).not.toContain(field)
})
