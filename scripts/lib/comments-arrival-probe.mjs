import { randomUUID } from 'node:crypto'

/** Deterministic fixture traffic through the broker's maintained dev commands.
 * Snapshots hydrate; only explicit raw deltas establish new-message evidence.
 * Readiness is bounded by the caller's maintained observation helper. */
export async function probeCommentsArrivals({ command, waitFor, assert, sessionId }) {
  const baseMs = Date.parse('2099-01-01T00:00:00Z')
  const message = (index) => ({
    id: `${sessionId}:twitch:rollover-${index}`,
    providerMessageId: String(index),
    sessionId,
    platform: 'twitch',
    authorName: 'Fixture Viewer',
    authorBadges: [],
    authorRoles: [],
    publishedAt: new Date(baseMs + index * 1000).toISOString(),
    receivedAt: new Date(baseMs + index * 1000).toISOString(),
    messageText: `Equal-height fixture ${String(index).padStart(4, '0')}`,
    fragments: [],
    eventType: 'message',
    isDeleted: false
  })
  const delivery = { ownerId: randomUUID(), generation: 0, sequence: 0, entries: [] }
  const snapshot = {
    sessionId,
    providers: [],
    messages: Array.from({ length: 2000 }, (_, index) => message(index)),
    unreadCount: 0,
    updatedAt: '2099-01-01T00:00:00Z',
    delivery
  }
  await command('comments-window-push-delta', {
    delta: {
      kind: 'adopt',
      deliveryBoundary: { ownerId: delivery.ownerId, generation: delivery.generation },
      updatedAt: snapshot.updatedAt
    }
  })
  await command('comments-window-push-snapshot', { snapshot })
  const observe = async (predicate, label) => {
    const observed = await waitFor(() => command('comments-window-reader-state'), predicate, 8000)
    assert(observed.ok, label, JSON.stringify(observed.last))
    if (!observed.ok) throw new Error(`Comments arrival observation failed: ${label}`)
  }
  await observe(
    (state) => state.lastMessageId === message(1999).id && state.chatAtBottom,
    'full chat: pinned at newest fixture'
  )
  for (let index = 2000; index < 2003; index++) {
    await command('comments-window-push-delta', {
      delta: { kind: 'message', message: message(index) }
    })
    await observe(
      (state) => state.lastMessageId === message(index).id && state.chatAtBottom,
      'rollover: pinned follows unchanged-height newest identity'
    )
  }
  await command('comments-window-reader-state', { chatAction: 'back' })
  for (let index = 2003; index < 2006; index++)
    await command('comments-window-push-delta', {
      delta: { kind: 'message', message: message(index) }
    })
  // Incidental older hydration must not erase raw admissions or count rows again.
  await command('comments-window-push-snapshot', { snapshot })
  await observe(
    (state) => /3 new/.test(state.pausedChat ?? ''),
    'rollover: three new matching deliveries while reading back'
  )
  await command('comments-window-reader-state', { chatAction: 'latest' })
  await observe(
    (state) =>
      state.pausedChat === null && state.lastMessageId === message(2005).id && state.chatAtBottom,
    'jump: clears unread and reaches newest'
  )
  await command('comments-window-close')
  await command('comments-window-open')
  await observe(
    (state) =>
      state.pausedChat === null && state.lastMessageId === message(2005).id && state.chatAtBottom,
    'reopen: current broker snapshot is the baseline'
  )
}
