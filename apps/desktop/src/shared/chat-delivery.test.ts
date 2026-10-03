import { describe, expect, it } from 'vitest'
import type { LiveChatMessage, LiveChatSnapshot } from './backend'
import {
  admitChatDelivery,
  chatDeliveryBoundary,
  chatDeliveryProgress,
  deliveryCursor,
  MAX_CHAT_DELIVERIES,
  markChatDeliveryIncomplete,
  validateChatDelivery
} from './chat-delivery'
import {
  applyCommentsSnapshotDelta as delta,
  hydrateCommentsSnapshot as hydrate,
  reconcileBrokerCommentsSnapshot as broker
} from './comments-snapshot-delta'
import {
  applyLiveChatMessage,
  applyLiveChatMessages,
  applyLiveChatSnapshot,
  reconcileLiveChatRecovery
} from '../renderer/src/lib/live-chat-view'

const row = (id: string, overrides: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
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
  ...overrides
})
const view = (
  sessionId: string | undefined = 's1',
  messages: LiveChatMessage[] = []
): LiveChatSnapshot => ({ sessionId, providers: [], messages, unreadCount: 0, updatedAt: 'now' })
const adopt = (current: LiveChatSnapshot | null, source: LiveChatSnapshot) =>
  delta(current, {
    kind: 'adopt',
    deliveryBoundary: chatDeliveryBoundary(source.delivery!),
    updatedAt: 'now'
  })
const append = (current: LiveChatSnapshot, message: LiveChatMessage) =>
  delta(current, { kind: 'message', message })

describe('bounded delivery ownership', () => {
  it('adopts before the first bootstrap session and rejects old publishers across different sessions and repeated remounts', () => {
    let main = null as LiveChatSnapshot | null
    const publishers = Array.from({ length: 4 }, () => applyLiveChatSnapshot(view()))
    for (const publisher of publishers) {
      main = adopt(main, publisher)
      main = hydrate(main, publisher)
      expect(main.delivery?.source).toMatchObject({
        ownerId: publisher.delivery!.ownerId,
        generation: publisher.delivery!.generation
      })
    }
    for (const publisher of publishers.slice(0, -1)) {
      expect(hydrate(main, publisher)).toEqual(main)
      expect(hydrate(main, { ...publisher, sessionId: 'stale-session' })).toEqual(main)
    }
  })
  it('keeps raw admissions through older incidental snapshots and converges detached deltas with broker snapshots', () => {
    const provider = applyLiveChatSnapshot(view())
    let main = hydrate(adopt(null, provider), provider)
    let detached = broker(view(undefined), main)
    const message = row('001')
    main = append(main, message)
    detached = append(detached, message)
    main = hydrate(main, provider)
    detached = broker(detached, main)
    expect(main.messages).toEqual([message])
    expect(main.delivery?.sequence).toBe(1)
    expect(detached.delivery).toEqual(main.delivery)
    expect(append(detached, message)).toBe(detached)
    expect(main.delivery?.ownerId).not.toBe(provider.delivery?.ownerId)
  })
  it('legacy hydration without adoption mints no arrivals and does not erase raw progress', () => {
    let main = hydrate(null, view('s1', [row('001')]))
    expect(main.delivery?.sequence).toBe(0)
    main = append(main, row('002'))
    main = hydrate(main, view('s1', [row('001')]))
    expect(main.messages.map((message) => message.id)).toEqual(['001', '002'])
    expect(main.delivery?.sequence).toBe(1)
  })
  it('rejects pre-clear hydration and preserves post-clear main progress when replacement hydration follows', () => {
    const provider = applyLiveChatSnapshot(view('s1', [row('001')]))
    let main = hydrate(adopt(null, provider), provider)
    const cleared = applyLiveChatSnapshot(view(), provider, true)
    main = delta(main, {
      kind: 'clear',
      sessionId: 's1',
      updatedAt: 'now',
      deliveryBoundary: chatDeliveryBoundary(cleared.delivery!)
    })
    const generation = main.delivery!.generation
    main = append(main, row('002'))
    expect(hydrate(main, provider)).toEqual(main)
    expect(hydrate(main, { ...provider, sessionId: 'stale' })).toEqual(main)
    main = hydrate(main, cleared)
    expect(main.messages.map((message) => message.id)).toEqual(['002'])
    expect(main.delivery?.generation).toBe(generation)
    expect(main.delivery?.sequence).toBe(1)
  })
  it('redacts tombstones on both raw deltas and authoritative hydration; older rows cannot resurrect them', () => {
    const provider = applyLiveChatSnapshot(view())
    let main = hydrate(adopt(null, provider), provider)
    const original = row('001', {
      details: { kind: 'super-chat', amountMicros: 100, currency: 'USD', amountDisplay: '$1' }
    })
    main = append(main, original)
    const deleted = { ...original, isDeleted: true, eventType: 'deleted' as const, messageText: '' }
    const deletedProvider = { ...provider, messages: [deleted] }
    main = hydrate(main, deletedProvider)
    expect(JSON.stringify(main.delivery)).not.toContain('Hello')
    expect(JSON.stringify(main.delivery)).not.toContain('amount')
    expect(main.delivery?.entries[0].message).toMatchObject({
      isDeleted: true,
      activity: false,
      authorName: '',
      messageText: ''
    })
    main = hydrate(main, { ...provider, messages: [original] })
    expect(main.messages[0].isDeleted).toBe(true)
    const raw = append(append(hydrate(null, view()), original), deleted)
    expect(raw.delivery?.entries[0].message).toEqual(main.delivery?.entries[0].message)
  })
  it('batch dedupe/tombstones may use independent local sequences without counting deleted admissions', () => {
    const initial = applyLiveChatSnapshot(view())
    const original = row('001')
    const deleted = { ...original, isDeleted: true, eventType: 'deleted' as const, messageText: '' }
    const provider = applyLiveChatMessages(initial, [original, deleted])
    const detached = append(append(hydrate(null, view()), original), deleted)
    for (const snapshot of [provider, detached])
      expect(
        chatDeliveryProgress(snapshot.delivery, deliveryCursor(initial.delivery), () => true).count
      ).toBe(0)
    expect(provider.delivery?.entries[0].message.isDeleted).toBe(true)
  })
  it('keeps authoritative recovery tombstones stronger than queued duplicates and admits recovery events only once', () => {
    const initial = applyLiveChatMessage(applyLiveChatSnapshot(view()), row('001'))
    const tombstone = row('001', { isDeleted: true, eventType: 'deleted', messageText: '' })
    const queued = row('002')
    const recovered = reconcileLiveChatRecovery(
      view('s1', [tombstone, queued]),
      initial,
      [queued],
      false
    )
    expect(recovered.delivery?.sequence).toBe(2)
    expect(recovered.delivery?.entries[0].message.isDeleted).toBe(true)
    expect(
      reconcileLiveChatRecovery(view('s1', [tombstone, queued]), recovered, [queued], false)
        .delivery?.sequence
    ).toBe(2)
  })
  it('reports incomplete filtered evidence after bounded overrun without guessing missing matches', () => {
    const initial = applyLiveChatSnapshot(view())
    const delivery = admitChatDelivery(
      initial,
      Array.from({ length: MAX_CHAT_DELIVERIES + 3 }, (_, index) => row(String(index)))
    )
    expect(delivery.entries).toHaveLength(MAX_CHAT_DELIVERIES)
    expect(
      chatDeliveryProgress(delivery, deliveryCursor(initial.delivery), () => false)
    ).toMatchObject({ count: 0, incomplete: true, reset: false })
    expect(chatDeliveryProgress(delivery, deliveryCursor(delivery), () => true)).toMatchObject({
      count: 0,
      incomplete: false
    })
  })
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe generation/sequence %s',
    (number) => {
      const value = applyLiveChatSnapshot(view()).delivery!
      expect(() => validateChatDelivery({ ...value, generation: number })).toThrow()
      expect(() => validateChatDelivery({ ...value, sequence: number })).toThrow()
    }
  )
  it('rejects missing owners, oversized journals, malformed sources and unredacted deletions', () => {
    const value = admitChatDelivery(applyLiveChatSnapshot(view()), [row('001')])
    expect(() => validateChatDelivery({ ...value, ownerId: '' })).toThrow()
    expect(() => validateChatDelivery({ ...value, source: null } as never)).toThrow()
    expect(() =>
      validateChatDelivery({
        ...value,
        entries: Array(MAX_CHAT_DELIVERIES + 1).fill(value.entries[0])
      })
    ).toThrow()
    expect(() =>
      validateChatDelivery({
        ...value,
        entries: [{ sequence: 1, message: { ...value.entries[0].message, isDeleted: true } }]
      })
    ).toThrow()
  })
})

it('a tombstone whose row is trimmed still redacts an older same-sequence broker journal and cannot resurrect via hydration', () => {
  const initial = applyLiveChatSnapshot(
    view(
      's1',
      Array.from({ length: 2000 }, (_, index) => row(String(index).padStart(5, '0')))
    )
  )
  const late = row('-late', { receivedAt: '-late' })
  const admitted = applyLiveChatMessage(initial, late)
  const deleted = applyLiveChatMessage(admitted, {
    ...late,
    isDeleted: true,
    eventType: 'deleted',
    messageText: ''
  })
  expect(deleted.messages.some((message) => message.id === late.id)).toBe(false)
  const reconciled = broker(deleted, admitted)
  expect(reconciled.delivery?.entries[0].message.isDeleted).toBe(true)
  expect(JSON.stringify(reconciled.delivery)).not.toContain('Hello')
  const resurrect = broker(reconciled, { ...admitted, messages: [...admitted.messages, late] })
  expect(resurrect.messages.some((message) => message.id === late.id && !message.isDeleted)).toBe(
    false
  )
})

it('queue loss advances uncertainty once per cursor, survives older same-generation hydration, and resets on clear', () => {
  const initial = applyLiveChatSnapshot(view())
  const lost = markChatDeliveryIncomplete(initial)
  expect(lost.delivery?.sequence).toBe(0)
  expect(
    chatDeliveryProgress(lost.delivery, deliveryCursor(initial.delivery), () => false)
  ).toMatchObject({ count: 0, incomplete: true })
  expect(deliveryCursor(lost.delivery)?.lossRevision).toBe(1)
  expect(
    chatDeliveryProgress(lost.delivery, deliveryCursor(lost.delivery), () => true)
  ).toMatchObject({ count: 0, incomplete: false })
  expect(applyLiveChatSnapshot(initial, lost).delivery?.lossRevision).toBe(1)
  const clear = applyLiveChatSnapshot(view(), lost, true)
  expect(clear.delivery?.lossRevision ?? 0).toBe(0)
  for (const lossRevision of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    expect(() => validateChatDelivery({ ...initial.delivery!, lossRevision })).toThrow()
})
