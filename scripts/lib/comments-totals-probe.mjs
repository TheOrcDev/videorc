import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export async function waitForFakeActivityReceipts({
  eventMessages,
  eventsSessionId,
  expectedKinds,
  waitFor,
  timeoutMs
}) {
  const distinctOwnedReceipts = () =>
    new Set(
      eventMessages
        .filter(
          (message) =>
            message.sessionId === eventsSessionId &&
            typeof message.id === 'string' &&
            message.id.length > 0
        )
        .map((message) => message.id)
    ).size
  const eventKinds = () =>
    new Set(
      eventMessages
        .filter((message) => message.sessionId === eventsSessionId && message.details)
        .map((message) => message.details.kind)
    )
  await waitFor(
    () => distinctOwnedReceipts() >= 16 && expectedKinds.every((kind) => eventKinds().has(kind)),
    timeoutMs,
    `every activity kind (${expectedKinds.join(', ')})`
  )
  return eventMessages.filter((message) => message.sessionId === eventsSessionId)
}

export function assertFakeActivityTotals(eventTotals) {
  if (
    eventTotals?.status !== 'available' ||
    eventTotals.messageCount !== 16 ||
    eventTotals.supporters !== 7 ||
    eventTotals.bits !== 1800 ||
    eventTotals.follows !== 2 ||
    eventTotals.raids !== 1 ||
    eventTotals.chatters !== 7 ||
    !isDeepStrictEqual(eventTotals.tips, [
      { currency: 'USD', amountMicros: 5_000_000 },
      { currency: 'EUR', amountMicros: 2_000_000 }
    ])
  ) {
    throw new Error('Confirmed fake activity accounting disagreed with the normalized fixture.')
  }
}

/** Confirmed reduced accounting, with every paid row outside the 2,000-row
 * fixture window. SQLite correctness is exercised independently by the fake
 * provider smoke; this phase verifies the real detached renderer consumes it. */
export async function probeCommentsTotals({ command, waitFor, assert, layoutAt, sessionId }) {
  const at = '2100-01-01T00:00:00.000Z'
  const ownerId = randomUUID()
  const snapshot = {
    sessionId,
    providers: [],
    unreadCount: 0,
    updatedAt: at,
    delivery: { ownerId, generation: 0, sequence: 0, entries: [] },
    messages: Array.from({ length: 2000 }, (_, index) => ({
      id: `${sessionId}:x:totals-${index}`,
      providerMessageId: `totals-${index}`,
      sessionId,
      platform: 'x',
      authorName: `Fixture ${index}`,
      authorBadges: [],
      authorRoles: [],
      publishedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
      receivedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
      messageText: 'Retained ordinary fixture',
      fragments: [],
      eventType: 'message',
      isDeleted: false
    }))
  }
  const chatTotals = {
    status: 'available',
    sessionId,
    revision: 6003,
    messageCount: 6003,
    chatters: 6002,
    platforms: ['twitch', 'youtube', 'x'],
    follows: 0,
    supporters: 1,
    bits: 0,
    tips: [{ currency: 'USD', amountMicros: 20_000_000 }],
    raids: 0
  }
  const dashboard = {
    sessionId,
    session: { state: 'live', startedAt: at },
    viewers: { latest: null, peak: null, history: [] },
    audience: null,
    health: null,
    targets: [],
    destinationEvents: [],
    chatTotals,
    updatedAt: at
  }
  await command('comments-window-push-delta', {
    delta: { kind: 'adopt', deliveryBoundary: { ownerId, generation: 0 }, updatedAt: at }
  })
  await command('comments-window-push-snapshot', { snapshot })
  await command('comments-window-seed-dashboard', { state: dashboard })
  const observe = async (history, label) => {
    const result = await waitFor(
      () => layoutAt(1280),
      (metrics) => {
        const value = (id) => metrics.stats?.find((stat) => stat.id === id)?.text
        return (
          value('supporters') === '1' &&
          value('tips') === '$20' &&
          (!history || value('chat') === '6,003')
        )
      },
      8000
    )
    assert(
      result.ok,
      label,
      JSON.stringify(result.last?.stats?.map(({ id, text }) => ({ id, text })))
    )
    if (!result.ok) throw new Error(`Comments accounting observation failed: ${label}`)
  }
  await observe(false, 'totals: live stats retain evicted-platform support and tips')
  await command('comments-window-close')
  await command('comments-window-open')
  await observe(false, 'totals: reopened renderer preserves confirmed accounting')
  await command('comments-window-push-snapshot', {
    snapshot,
    mode: { kind: 'history', sessionId, title: 'Whole-session fixture', startedAt: at }
  })
  // The same confirmed session update refreshes its existing History cache.
  await command('comments-window-seed-dashboard', { state: dashboard })
  await observe(true, 'totals: History shows whole-session rows with identical support and tips')
}
