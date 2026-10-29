import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import {
  assertFakeActivityTotals,
  waitForFakeActivityReceipts
} from './lib/comments-totals-probe.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Unified-comments smoke with the fake connector: drives the LiveChatCoordinator end to
// end over the real websocket protocol without any platform OAuth. Proves start → deliberately
// skewed messages → de-dupe → correlated fan-out outcomes → websocket reconnect/snapshot
// convergence → clear → stop, plus the capability/X-gate surface. The real YouTube/Twitch
// OAuth live smokes and the gated X smoke are documented in
// docs/live-chat-live-smoke-checklist.md (they need live accounts + a real stream).

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
// The reference-shaped Twitch GIF (plan 155; scripts/fixtures/stream-manager/
// twitch-chat-gif.json). The backend never fetches it; only the Stream
// Manager window would, through main's allowlisted GIF cache.
const SMOKE_TWITCH_GIF = {
  title: '[Y A Y Yes GIF]',
  imageUrl: 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif'
}

// Every Activity kind a greeting line may be written for (plan 164 S-D1).
const BUDDY_ACTIVITY_KINDS = [
  'follow',
  'sub',
  'resub',
  'sub-gift',
  'community-sub-gift',
  'membership',
  'cheer',
  'kicks',
  'super-chat',
  'super-sticker',
  'raid',
  'watch-streak',
  'power-up',
  'redemption'
]

let appProcess
let stopping = false

try {
  const connection = await launchAndReadConnection()
  let ws = await connectBackend(connection, timeoutMs)
  const observed = collectMessages(ws)
  const { messages } = observed
  try {
    // Capability surface: every native platform is present. X's approved native read path is
    // shipped, but an empty smoke profile has no connected X account and X remains read-only.
    const capability = await request(ws, timeoutMs, 'liveChat.capability', {})
    const platforms = capability.map((entry) => entry.platform)
    for (const platform of ['youtube', 'twitch', 'kick', 'x']) {
      if (!platforms.includes(platform)) {
        throw new Error(`liveChat.capability missing ${platform}: ${JSON.stringify(platforms)}`)
      }
    }
    const x = capability.find((entry) => entry.platform === 'x')
    if (x.state !== 'not-connected' || x.chatReadAvailable) {
      throw new Error(`X chat should be available but not connected, got ${JSON.stringify(x)}`)
    }

    // Kick reads through the web relay and sends direct; an empty profile has no account.
    const kick = capability.find((entry) => entry.platform === 'kick')
    if (
      kick.state !== 'not-connected' ||
      kick.chatReadAvailable ||
      kick.requiredScope !== 'events:subscribe'
    ) {
      throw new Error(`Kick chat should need a connected account, got ${JSON.stringify(kick)}`)
    }

    const readiness = await request(ws, timeoutMs, 'liveChat.xCommentsReadiness', {})
    if (!readiness.available || readiness.evidenceChecklist.length < 1) {
      throw new Error(`X comments read readiness is stale: ${JSON.stringify(readiness)}`)
    }

    // Start all three platforms together, including independent YouTube destinations for
    // success and timeout. Different cadences deliberately make a fast destination's later
    // sequence arrive before a slow destination's earlier sequence. Each destination also
    // replays its first id once to exercise session+target-scoped de-dupe.
    const sessionId = `smoke-live-chat-${Date.now()}`
    const fakeDestinations = [
      {
        platform: 'youtube',
        targetId: 'smoke-youtube-sent',
        send: 'sent',
        count: 60,
        intervalMs: 180,
        outOfOrder: true,
        reconnectAt: 3
      },
      {
        platform: 'twitch',
        targetId: 'smoke-twitch-failed',
        send: 'failed',
        count: 80,
        intervalMs: 135
      },
      {
        platform: 'x',
        targetId: 'smoke-x-read-only',
        count: 100,
        intervalMs: 108
      },
      {
        platform: 'youtube',
        targetId: 'smoke-youtube-timeout',
        send: 'timeout',
        count: 135,
        intervalMs: 80
      }
    ]
    const expectedMessageCount = fakeDestinations.reduce(
      (total, destination) => total + destination.count,
      0
    )
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId,
      destinations: fakeDestinations.map(({ platform, targetId }) => ({
        platform,
        targetId,
        read: 'ready',
        write: platform === 'x' ? 'read-only' : 'ready'
      })),
      fakes: fakeDestinations.map((destination) => ({
        ...destination,
        includeDuplicate: true
      }))
    })

    await waitFor(
      () =>
        fakeDestinations.every((destination) =>
          messages.some((message) => message.targetId === destination.targetId)
        ),
      timeoutMs,
      'four connected fake comment destinations'
    )

    // Send while every finite connector is live. One operation must preserve every
    // destination outcome: sent, provider failure, receive-only, and ambiguous timeout.
    const operationId = randomUUID()
    const sendOperation = await request(ws, timeoutMs, 'liveChat.send', {
      operationId,
      sessionId,
      text: 'hello chat'
    })
    if (
      sendOperation.id !== operationId ||
      sendOperation.sessionId !== sessionId ||
      !Array.isArray(sendOperation.destinations) ||
      sendOperation.destinations.length === 0
    ) {
      throw new Error(
        `liveChat.send returned no correlated destination results: ${JSON.stringify(sendOperation)}`
      )
    }
    if (sendOperation.phase !== 'partial') {
      throw new Error(
        `Mixed fake send should aggregate to partial: ${JSON.stringify(sendOperation)}`
      )
    }
    const expectedDeliveryPhases = new Map([
      ['smoke-youtube-sent', 'sent'],
      ['smoke-twitch-failed', 'failed'],
      ['smoke-x-read-only', 'read-only'],
      ['smoke-youtube-timeout', 'timed-out-unknown']
    ])
    for (const [destinationId, phase] of expectedDeliveryPhases) {
      const destination = sendOperation.destinations.find(
        (candidate) => candidate.destinationId === destinationId
      )
      if (destination?.phase !== phase) {
        throw new Error(`${destinationId} expected ${phase}, got ${JSON.stringify(destination)}`)
      }
      if (phase === 'sent' && !destination.providerMessageId) {
        throw new Error(`${destinationId} sent without a provider-confirmed message id.`)
      }
      if (phase === 'timed-out-unknown' && !/not retried/i.test(destination.reason ?? '')) {
        throw new Error(
          `${destinationId} timeout did not preserve no-retry ambiguity: ${JSON.stringify(destination)}`
        )
      }
    }
    const repeatedOperation = await request(ws, timeoutMs, 'liveChat.send', {
      operationId,
      sessionId,
      text: 'hello chat'
    })
    if (JSON.stringify(repeatedOperation) !== JSON.stringify(sendOperation)) {
      throw new Error('Repeating a send operation id did not return the persisted result.')
    }
    let sendRejected = false
    try {
      await request(ws, timeoutMs, 'liveChat.send', {
        operationId: randomUUID(),
        sessionId,
        text: ''
      })
    } catch {
      sendRejected = true
    }
    if (!sendRejected) {
      throw new Error('liveChat.send accepted an empty message.')
    }

    const status = await waitForAuthoritativeMessages(
      ws,
      sessionId,
      expectedMessageCount,
      timeoutMs
    )
    await waitFor(
      () => messages.length >= expectedMessageCount || observed.skipped > 0,
      Math.min(timeoutMs, 5000),
      'final incremental comment or lag recovery signal'
    )
    const arrivalMessages = [...messages]
    if (observed.skipped > 0) {
      // Match the renderer contract: a bounded socket may legitimately lag under a burst.
      // Replace incremental belief with the authoritative snapshot instead of waiting for
      // events the backend explicitly reported as skipped.
      messages.splice(0, messages.length, ...status.messages)
    }
    if (messages.length < expectedMessageCount) {
      throw new Error(
        `WebSocket delivered ${messages.length}/${expectedMessageCount} messages without a lag recovery signal.`
      )
    }

    const arrivalDisorderIndex = arrivalMessages.findIndex(
      (message, index) => index > 0 && arrivalMessages[index - 1].receivedAt > message.receivedAt
    )
    if (arrivalDisorderIndex < 1) {
      throw new Error(
        'Fake source did not emit the deliberate out-of-order timestamp before reconciliation.'
      )
    }

    const diagnostics = await request(ws, timeoutMs, 'liveChat.diagnostics', {})
    if (diagnostics.messagesReceived < expectedMessageCount) {
      throw new Error(
        `Expected >=${expectedMessageCount} messages received, got ${diagnostics.messagesReceived}`
      )
    }
    if (diagnostics.duplicatesSkipped < fakeDestinations.length) {
      throw new Error(
        `Expected one duplicate per destination to be skipped, got ${diagnostics.duplicatesSkipped}`
      )
    }
    if (diagnostics.reconnectCount < 1) {
      throw new Error(
        `Expected the fake reconnect to increment diagnostics, got ${diagnostics.reconnectCount}`
      )
    }

    // The streamer can read the comments from the snapshot — no platform dashboard needed.
    if (status.messages.length !== expectedMessageCount || status.sessionId !== sessionId) {
      throw new Error(
        `liveChat.status did not expose the session feed: ${JSON.stringify({
          sessionId: status.sessionId,
          count: status.messages.length
        })}`
      )
    }
    if (
      !status.messages.every((message) =>
        fakeDestinations.some(
          (destination) =>
            destination.platform === message.platform &&
            destination.targetId === message.targetId &&
            message.id.startsWith(`${sessionId}:${destination.platform}:${destination.targetId}:`)
        )
      )
    ) {
      throw new Error('Fake feed contained unexpected message shapes.')
    }
    for (const destination of fakeDestinations) {
      const count = status.messages.filter(
        (message) => message.targetId === destination.targetId
      ).length
      if (count !== destination.count) {
        throw new Error(
          `Unified feed retained ${count}/${destination.count} ${destination.targetId} messages.`
        )
      }
    }
    const messageIds = new Set(status.messages.map((message) => message.id))
    if (messageIds.size !== status.messages.length) {
      throw new Error('Unified feed retained a duplicate app message id.')
    }
    for (let index = 1; index < status.messages.length; index += 1) {
      if (status.messages[index - 1].receivedAt > status.messages[index].receivedAt) {
        throw new Error('Unified feed is not chronological.')
      }
    }
    const persistedMessages = await listPersistedMessages(
      ws,
      sessionId,
      expectedMessageCount,
      timeoutMs
    )
    if (persistedMessages.length !== status.messages.length) {
      throw new Error(
        `SQLite transcript did not match the live snapshot: ${JSON.stringify({
          persisted: persistedMessages.length,
          live: status.messages.length
        })}`
      )
    }
    const persistedIds = persistedMessages.map((message) => message.id)
    const statusIds = status.messages.map((message) => message.id)
    if (
      persistedMessages.some(
        (message, index) =>
          index > 0 && persistedMessages[index - 1].receivedAt > message.receivedAt
      ) ||
      JSON.stringify(persistedIds) !== JSON.stringify(statusIds)
    ) {
      throw new Error('SQLite and the authoritative snapshot did not converge chronologically.')
    }

    const wholeSessionTotals = await request(ws, timeoutMs, 'sessions.comments.totals', {
      sessionId
    })
    if (
      wholeSessionTotals?.status !== 'available' ||
      wholeSessionTotals.messageCount !== expectedMessageCount
    ) {
      throw new Error('Persisted whole-session row total did not match admitted fake messages.')
    }

    // Drop the event socket after the burst, reconnect to the same backend, and replace
    // incremental belief with the authoritative snapshot + persisted send operation.
    await closeWebSocket(ws)
    ws = await connectBackend(connection, timeoutMs)
    const recoveredTotals = await request(ws, timeoutMs, 'sessions.comments.totals', { sessionId })
    if (JSON.stringify(recoveredTotals) !== JSON.stringify(wholeSessionTotals)) {
      throw new Error('Reconnect changed confirmed whole-session totals.')
    }
    const reconnectedMessages = collectMessages(ws)
    const recovered = await request(ws, timeoutMs, 'liveChat.status', {})
    const recoveredIds = recovered.messages.map((message) => message.id)
    if (
      recovered.sessionId !== sessionId ||
      JSON.stringify(recoveredIds) !== JSON.stringify(statusIds)
    ) {
      throw new Error(
        `Reconnect did not converge on the authoritative snapshot: ${JSON.stringify({ before: statusIds.length, after: recoveredIds.length, sessionId: recovered.sessionId })}`
      )
    }
    if (reconnectedMessages.messages.length !== 0) {
      throw new Error('Reconnect replayed incremental comment events instead of snapshot recovery.')
    }
    const recoveredOperations = await request(ws, timeoutMs, 'liveChat.sendOperations.list', {
      sessionId
    })
    const recoveredOperation = recoveredOperations.find((operation) => operation.id === operationId)
    if (JSON.stringify(recoveredOperation) !== JSON.stringify(sendOperation)) {
      throw new Error('Reconnect did not recover the persisted terminal send operation.')
    }

    // This smoke is intentionally off-stream. The backend must reject a highlight instead of
    // claiming that viewer-facing output changed; the artifact smoke proves the live path.
    // Since Clips (plan 181) the dev app may hold a buffer-only capture session, so the refusal
    // can name that session instead of the missing livestream; either is an explicit refusal.
    const onePixelPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    let highlightError
    try {
      await request(ws, timeoutMs, 'comments.highlight.set', {
        sessionId,
        messageId: status.messages[0].id,
        pngBase64: onePixelPng,
        anchor: 'bottom-left'
      })
    } catch (error) {
      highlightError = error
    }
    if (
      !(highlightError instanceof Error) ||
      ![
        'Comment highlighting requires an active livestream.',
        'The comment belongs to a stale or different livestream session.'
      ].includes(highlightError.message)
    ) {
      throw new Error(
        `Off-stream comment highlight was not rejected explicitly: ${String(highlightError)}`
      )
    }
    const highlightStatus = await request(ws, timeoutMs, 'comments.highlight.status', {})
    if (highlightStatus.phase !== 'idle' || highlightStatus.messageId) {
      throw new Error(
        `Rejected highlight changed backend state: ${JSON.stringify(highlightStatus)}`
      )
    }

    // Clearing the local view empties the feed without ending the session.
    const cleared = await request(ws, timeoutMs, 'liveChat.clearLocal', {})
    if (cleared.messages.length !== 0) {
      throw new Error(`liveChat.clearLocal did not empty the feed: ${cleared.messages.length}`)
    }

    if (
      JSON.stringify(await request(ws, timeoutMs, 'sessions.comments.totals', { sessionId })) !==
      JSON.stringify(wholeSessionTotals)
    ) {
      throw new Error('Local clear changed persisted whole-session totals.')
    }
    const stopped = await request(ws, timeoutMs, 'liveChat.stop', {})
    if (stopped.sessionId) {
      throw new Error(
        `liveChat.stop should clear the active session: ${JSON.stringify(stopped.sessionId)}`
      )
    }

    // Stream Manager (plan 055): structured activity events end to end, and the
    // audience poller's baseline and delta, in their own short session.
    const eventsSessionId = `smoke-live-chat-events-${Date.now()}`
    // The socket was replaced above: listen on the current one.
    const eventMessages = collectMessages(ws).messages
    const audience = collectEvent(ws, 'stream.audience')
    const eventDestinations = [
      { platform: 'twitch', targetId: 'smoke-twitch-events' },
      { platform: 'youtube', targetId: 'smoke-youtube-events' },
      { platform: 'kick', targetId: 'smoke-kick-events' }
    ]
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId: eventsSessionId,
      platforms: ['twitch', 'youtube', 'kick'],
      destinations: eventDestinations.map(({ platform, targetId }) => ({
        platform,
        targetId,
        read: 'ready',
        write: 'ready'
      })),
      fakes: eventDestinations.map((destination) => ({
        ...destination,
        count: 1,
        intervalMs: 60,
        events: true,
        // Plan 155: Twitch's fake also sends one GIF Keyboard row.
        ...(destination.platform === 'twitch' ? { gif: SMOKE_TWITCH_GIF } : {})
      })),
      fakeAudience: [
        { platform: 'twitch', totals: [500, 512], intervalMs: 150 },
        { platform: 'kick', capability: 'delta-only', intervalMs: 150 }
      ]
    })
    const expectedKinds = [
      'subscription',
      'cheer',
      'raid',
      'follow',
      'super-chat',
      'super-sticker',
      'membership',
      'kicks',
      'watch-streak',
      'power-up',
      'redemption'
    ]
    const eventRows = await waitForFakeActivityReceipts({
      eventMessages,
      eventsSessionId,
      expectedKinds,
      waitFor,
      timeoutMs
    })
    const cheer = eventRows.find((message) => message.details?.kind === 'cheer')
    const raid = eventRows.find((message) => message.details?.kind === 'raid')
    const follow = eventRows.find((message) => message.details?.kind === 'follow')
    if (
      cheer?.details.bits !== 1500 ||
      raid?.details.viewerCount !== 234 ||
      follow?.eventType !== 'follow' ||
      eventRows.some((message) => 'details' in message && message.details === null)
    ) {
      throw new Error(`Activity events lost their details: ${JSON.stringify(eventRows)}`)
    }
    await waitFor(
      () =>
        audience.payloads.some((snapshot) =>
          snapshot.platforms?.some(
            (entry) => entry.platform === 'twitch' && entry.total === 512 && entry.delta === 12
          )
        ),
      timeoutMs,
      'the audience poller baseline (500) and delta (+12)'
    )
    const kickFollow = eventRows.find(
      (message) => message.platform === 'kick' && message.details?.kind === 'follow'
    )
    if (kickFollow?.authorName !== 'kick_fan' || kickFollow.targetId !== 'smoke-kick-events') {
      throw new Error(`Kick follow row missing: ${JSON.stringify(eventRows)}`)
    }
    // Plan 155: the Twitch GIF row is a plain message with one `gif`
    // fragment whose URL arrives exactly as sent (Twitch's unmodified rule).
    await waitFor(
      () =>
        eventMessages.some(
          (message) =>
            message.sessionId === eventsSessionId &&
            message.platform === 'twitch' &&
            message.fragments?.some((fragment) => fragment.type === 'gif')
        ),
      timeoutMs,
      'the fake Twitch GIF row'
    )
    const gifRow = eventMessages.find(
      (message) =>
        message.sessionId === eventsSessionId &&
        message.platform === 'twitch' &&
        message.fragments?.some((fragment) => fragment.type === 'gif')
    )
    const gifFragment = gifRow.fragments.find((fragment) => fragment.type === 'gif')
    if (
      gifRow.eventType !== 'message' ||
      gifRow.messageText !== SMOKE_TWITCH_GIF.title ||
      gifRow.fragments.length !== 1 ||
      gifFragment.text !== SMOKE_TWITCH_GIF.title ||
      gifFragment.imageUrl !== SMOKE_TWITCH_GIF.imageUrl ||
      'details' in gifRow
    ) {
      throw new Error(`Twitch GIF row lost its shape: ${JSON.stringify(gifRow)}`)
    }
    // Plan 066: a KICKs gift keeps its amount and gift name end to end.
    const kicks = eventRows.find((message) => message.details?.kind === 'kicks')
    if (
      kicks?.platform !== 'kick' ||
      kicks.details.amount !== 500 ||
      kicks.details.giftName !== 'Rage Quit' ||
      kicks.amountText !== '500 KICKs'
    ) {
      throw new Error(`Kick KICKs row missing: ${JSON.stringify(eventRows)}`)
    }
    // Plan 151: a watch streak keeps its length and the viewer's own words.
    const streak = eventRows.find((message) => message.details?.kind === 'watch-streak')
    if (
      streak?.platform !== 'twitch' ||
      streak.details.streakCount !== 20 ||
      streak.rawProviderType !== 'channel.chat.notification:watch_streak' ||
      !streak.fragments?.some((fragment) => fragment.text.includes('welcome back'))
    ) {
      throw new Error(`Twitch watch streak row missing: ${JSON.stringify(eventRows)}`)
    }
    // Plan 162: Activity-only Power-up and redemption rows keep their facts.
    const powerUp = eventRows.find((message) => message.details?.kind === 'power-up')
    const redemption = eventRows.find((message) => message.details?.kind === 'redemption')
    if (
      powerUp?.eventType !== 'power-up' ||
      powerUp.details.bits !== 300 ||
      powerUp.details.powerUp !== 'celebration' ||
      redemption?.eventType !== 'redemption' ||
      redemption.details.title !== 'Hydrate' ||
      redemption.details.channelPoints !== 500 ||
      redemption.details.pointsName !== 'Diamonds'
    ) {
      throw new Error(`Twitch Power-up or redemption row missing: ${JSON.stringify(eventRows)}`)
    }
    await waitFor(
      () =>
        audience.payloads.some((snapshot) =>
          snapshot.platforms?.some(
            (entry) =>
              entry.platform === 'kick' &&
              entry.capability === 'delta-only' &&
              entry.total === undefined
          )
        ),
      timeoutMs,
      'the Kick audience row reporting delta-only'
    )
    const audienceSnapshot = await request(ws, timeoutMs, 'stream.audience.snapshot')
    const twitchAudience = audienceSnapshot?.platforms?.find((entry) => entry.platform === 'twitch')
    if (
      audienceSnapshot?.sessionId !== eventsSessionId ||
      twitchAudience?.baseline !== 500 ||
      twitchAudience?.total !== 512
    ) {
      throw new Error(`stream.audience.snapshot disagrees: ${JSON.stringify(audienceSnapshot)}`)
    }
    const persistedEvents = await listPersistedMessages(
      ws,
      eventsSessionId,
      eventRows.length,
      timeoutMs
    )
    const persistedKinds = new Set(
      persistedEvents.filter((message) => message.details).map((message) => message.details.kind)
    )
    if (!expectedKinds.every((kind) => persistedKinds.has(kind))) {
      throw new Error(`Persisted events lost their details: ${JSON.stringify([...persistedKinds])}`)
    }
    const eventTotals = await request(ws, timeoutMs, 'sessions.comments.totals', {
      sessionId: eventsSessionId
    })
    assertFakeActivityTotals(eventTotals)
    // Reuse the same persisted session with an independent X destination. Its
    // canonical IDs cannot collide with the activity fixtures, and >5,000 rows
    // retire every paid row from the live buffer without erasing accounting.
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId: eventsSessionId,
      platforms: ['x'],
      destinations: [
        { platform: 'x', targetId: 'totals-rollover', read: 'ready', write: 'read-only' }
      ],
      fakes: [
        {
          platform: 'x',
          targetId: 'totals-rollover',
          count: 6001,
          intervalMs: 1,
          includeDuplicate: true
        }
      ]
    })
    const rolledTotals = await waitForSessionTotals(ws, eventsSessionId, 6018, timeoutMs)
    if (
      rolledTotals.supporters !== eventTotals.supporters ||
      rolledTotals.bits !== eventTotals.bits ||
      JSON.stringify(rolledTotals.tips) !== JSON.stringify(eventTotals.tips) ||
      rolledTotals.chatters !== 11
    ) {
      throw new Error(
        'Whole-session accounting changed when paid rows rolled out of the live buffer.'
      )
    }
    const rolledView = await request(ws, timeoutMs, 'liveChat.status', {})
    if (
      rolledView.messages.length !== 5000 ||
      rolledView.messages.some((message) => message.details)
    ) {
      throw new Error(
        'Rollover fixture did not retire activity rows while preserving the live cap.'
      )
    }
    await request(ws, timeoutMs, 'liveChat.clearLocal', {})
    await request(ws, timeoutMs, 'liveChat.stop', {})
    if (
      JSON.stringify(
        await request(ws, timeoutMs, 'sessions.comments.totals', { sessionId: eventsSessionId })
      ) !== JSON.stringify(rolledTotals)
    ) {
      throw new Error('Finished History accounting changed after local clear and stop.')
    }

    // Plan 211: Buddy talks only in its bubble. In Bubble, with Buddy on
    // stream and no lines of the user's own (plan 192), the fake follow's
    // built-in line and the chatters' welcomes show in the bubble one after
    // another (a burst collapses into one line), nothing is sent and the
    // report lists what was said; in Suggest one card, approved, lands as
    // exactly one send and one post; with talk `off` nothing is said or
    // sent at all.
    await assertBuddyGreetings(ws)

    console.log(
      `Unified-comments fake-provider smoke OK - ${diagnostics.messagesReceived} messages, ` +
        `${diagnostics.duplicatesSkipped} duplicate(s) skipped, sent/failed/read-only/timeout ` +
        `fan-out preserved, websocket snapshot recovered, X receive-only as "${x.message}", ` +
        `${expectedKinds.length} activity kinds with details, audience baseline and delta, ` +
        `Kick follow row and delta-only audience.`
    )
  } finally {
    ws.close()
  }
} finally {
  await stopApp()
}

async function assertBuddyGreetings(ws) {
  const settingsBefore = await request(ws, timeoutMs, 'cohost.settings.get', {})
  const layoutBefore = await request(ws, timeoutMs, 'overlays.layout.get', {})
  // Plan 192 D1: a kind without a line of the user's own speaks its built-in
  // line, so a scenario switches every kind it doesn't want off (a kind
  // whose lines are all off is off).
  const offLines = (keep) =>
    BUDDY_ACTIVITY_KINDS.filter((kind) => !keep.includes(kind)).map((kind) => ({
      id: `smoke-off-${kind}`,
      kind,
      text: 'off',
      state: 'talk',
      enabled: false
    }))
  // Plan 211 D3: `talk` is the one truth; the legacy `mode` is never sent.
  const autoChat = (talk, { welcomes = false } = {}) => ({
    talk,
    greetings: {
      enabled: true,
      ai: false,
      templates: offLines(['follow']),
      welcomes: { firstTime: { enabled: welcomes }, returning: { enabled: welcomes } }
    },
    answers: { enabled: false, cooldownSeconds: 20 },
    banter: { enabled: false, cooldownSeconds: 240 }
  })
  const startBuddySession = async (sessionId, fakes) => {
    const operations = collectEvent(ws, 'liveChat.sendOperation')
    const states = collectEvent(ws, 'cohost.state')
    const bubbles = collectEvent(ws, 'cohost.buddy.state')
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId,
      platforms: [...new Set(fakes.map((fake) => fake.platform))],
      destinations: fakes.map(({ platform, targetId }) => ({
        platform,
        targetId,
        read: 'ready',
        write: 'ready'
      })),
      fakes: fakes.map((fake) => ({ count: 1, intervalMs: 60, ...fake }))
    })
    return { operations, states, bubbles }
  }
  const terminalSends = (operations, sessionId) =>
    operations.payloads.filter(
      (operation) =>
        operation.sessionId === sessionId &&
        (operation.phase === 'sent' ||
          operation.phase === 'partial' ||
          operation.phase === 'failed')
    )
  const bubbleTexts = (bubbles) => [
    ...new Set(bubbles.payloads.map((payload) => payload?.bubble?.text).filter(Boolean))
  ]
  const setBuddyOnStream = (showOnStream) =>
    request(ws, timeoutMs, 'overlays.layout.set', {
      ...layoutBefore,
      buddy: { ...layoutBefore.buddy, showOnStream }
    })

  // Bubble (plan 211 D1, D7, D9, D11), with Buddy on stream and no lines of
  // the user's own: Kick delivers a follow (its built-in line, plan 192 D1)
  // and a KICKs row whose only line is off (counted, never said); five
  // first-time chatters across Twitch and Kick arrive within the welcome's
  // 5 s cooldown, so the first is welcomed at once and the other four
  // collapse into one line (the bubble is one shared destination). Every
  // line shows in Buddy's bubble, one after another; nothing is sent, the
  // report lists what was said and has no posts.
  await setBuddyOnStream(true)
  await request(ws, timeoutMs, 'cohost.settings.set', {
    autoChat: autoChat('bubble', { welcomes: true })
  })
  const bubbleSessionId = `smoke-buddy-bubble-${Date.now()}`
  const bubble = await startBuddySession(bubbleSessionId, [
    {
      platform: 'twitch',
      targetId: 'smoke-buddy-bubble-twitch',
      count: 3,
      authors: ['Ana', 'Cy', 'Ed']
    },
    {
      platform: 'kick',
      targetId: 'smoke-buddy-bubble-kick',
      count: 2,
      authors: ['Bo', 'Di'],
      events: true
    }
  ])
  const expectedBubbles = [
    { label: 'the first welcome', test: /^Hi [A-Za-z]+, welcome to the stream!$/ },
    {
      label: 'the collapsed welcome',
      test: /^Hi [A-Za-z]+, [A-Za-z]+, [A-Za-z]+ and 1 other, welcome to the stream!$/
    },
    { label: "the follow's built-in line", test: /^Welcome, kick_fan! Thanks for the follow\.$/ }
  ]
  // The throttle spaces the lines 5 s apart on the one bubble destination,
  // and the queue adds the bubble's own time; three lines take about 10 s.
  await waitFor(
    () =>
      expectedBubbles.every(({ test }) => bubbleTexts(bubble.bubbles).some((t) => test.test(t))),
    Math.max(timeoutMs, 40_000),
    `Buddy's ${expectedBubbles.length} bubble lines`
  )
  // Give any extra (wrong) line or send a moment to show up before counting.
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
  const said = bubbleTexts(bubble.bubbles)
  if (said.length !== expectedBubbles.length) {
    throw new Error(
      `Buddy bubbled ${said.length} lines, expected ${expectedBubbles.length}: ${JSON.stringify(said)}`
    )
  }
  const bubbleSends = bubble.operations.payloads.filter(
    (operation) => operation.sessionId === bubbleSessionId
  )
  if (bubbleSends.length !== 0) {
    throw new Error(
      `Buddy sent in Bubble: ${JSON.stringify(bubbleSends.map((operation) => operation.text))}`
    )
  }
  const bubbleState = bubble.states.payloads.at(-1)
  const bubbleUtterances = bubbleState?.utterances ?? []
  if (
    (bubbleState?.autoChatSends ?? 0) !== 0 ||
    bubbleUtterances.length !== expectedBubbles.length ||
    bubbleUtterances.some((utterance) => utterance.status !== 'bubble-only')
  ) {
    throw new Error(`cohost.state did not carry the bubble lines: ${JSON.stringify(bubbleState)}`)
  }
  const bubbleReport = (
    await request(ws, timeoutMs, 'cohost.report.get', { sessionId: bubbleSessionId })
  )?.report
  const saidRows = bubbleReport?.said ?? []
  if (
    saidRows.length !== expectedBubbles.length ||
    saidRows.some((row) => row.trigger !== 'greeting' || !said.includes(row.text)) ||
    (bubbleReport?.posts?.length ?? 0) !== 0 ||
    (bubbleReport?.greetings?.skipped?.noLine ?? 0) < 1
  ) {
    throw new Error(`The Buddy report lost what was said: ${JSON.stringify(bubbleReport)}`)
  }
  await request(ws, timeoutMs, 'liveChat.stop', {})

  // Suggest (plan 211 D2): the follow becomes a card; nothing shows or
  // sends before the click. Approving it is the one path from Buddy's lane
  // to chat: exactly one send, one post in the report, and the bubble when
  // it lands.
  await request(ws, timeoutMs, 'cohost.settings.set', { autoChat: autoChat('suggest') })
  const suggestSessionId = `smoke-buddy-suggest-${Date.now()}`
  const suggestTarget = 'smoke-buddy-suggest-kick'
  const suggest = await startBuddySession(suggestSessionId, [
    { platform: 'kick', targetId: suggestTarget, events: true }
  ])
  const proposed = () =>
    (suggest.states.payloads.at(-1)?.utterances ?? []).filter(
      (utterance) => utterance.status === 'proposed'
    )
  await waitFor(
    () => proposed().length >= 1,
    Math.max(timeoutMs, 20_000),
    "the follow's Suggest card"
  )
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
  const cards = proposed()
  if (
    cards.length !== 1 ||
    cards[0].text !== 'Welcome, kick_fan! Thanks for the follow.' ||
    bubbleTexts(suggest.bubbles).length !== 0 ||
    suggest.operations.payloads.some((operation) => operation.sessionId === suggestSessionId)
  ) {
    throw new Error(
      `Suggest showed or sent before the click: ${JSON.stringify({ cards, bubbles: bubbleTexts(suggest.bubbles) })}`
    )
  }
  await request(ws, timeoutMs, 'cohost.utterance.approve', {
    sessionId: suggestSessionId,
    utteranceId: cards[0].id
  })
  await waitFor(
    () => terminalSends(suggest.operations, suggestSessionId).length >= 1,
    Math.max(timeoutMs, 20_000),
    'the approved card to land'
  )
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))
  const approvedSends = terminalSends(suggest.operations, suggestSessionId)
  if (
    approvedSends.length !== 1 ||
    approvedSends[0].text !== cards[0].text ||
    approvedSends[0].destinations.length !== 1 ||
    approvedSends[0].destinations[0].destinationId !== suggestTarget ||
    approvedSends[0].destinations[0].phase !== 'sent'
  ) {
    throw new Error(`The approved card did not land once: ${JSON.stringify(approvedSends)}`)
  }
  await waitFor(
    () => bubbleTexts(suggest.bubbles).includes(cards[0].text),
    timeoutMs,
    'the approved card in the bubble'
  )
  const suggestReport = (
    await request(ws, timeoutMs, 'cohost.report.get', { sessionId: suggestSessionId })
  )?.report
  const approvedPosts = suggestReport?.posts ?? []
  if (
    approvedPosts.length !== 1 ||
    approvedPosts[0].result !== 'sent' ||
    approvedPosts[0].trigger !== 'greeting' ||
    approvedPosts[0].text !== cards[0].text
  ) {
    throw new Error(`The Suggest report is wrong: ${JSON.stringify(suggestReport)}`)
  }
  await request(ws, timeoutMs, 'liveChat.stop', {})

  // Off: the same rows, zero lines and zero sends.
  await request(ws, timeoutMs, 'cohost.settings.set', {
    autoChat: autoChat('off', { welcomes: true })
  })
  const offSessionId = `smoke-buddy-off-${Date.now()}`
  const off = await startBuddySession(offSessionId, [
    { platform: 'twitch', targetId: 'smoke-buddy-off-twitch', events: true },
    { platform: 'youtube', targetId: 'smoke-buddy-off-youtube', events: true },
    { platform: 'kick', targetId: 'smoke-buddy-off-kick', events: true }
  ])
  const offRows = collectMessages(ws).messages
  await waitFor(
    () =>
      offRows.filter((message) => message.sessionId === offSessionId && message.details).length >=
      13,
    timeoutMs,
    'the fake activity rows of the Buddy-off session'
  )
  await new Promise((resolveWait) => setTimeout(resolveWait, 6_000))
  const offSends = off.operations.payloads.filter(
    (operation) => operation.sessionId === offSessionId
  )
  if (offSends.length !== 0) {
    throw new Error(`Buddy sent with talk off: ${JSON.stringify(offSends.map((o) => o.text))}`)
  }
  const offState = off.states.payloads.at(-1)
  if (offState && (offState.utterances?.length ?? 0) > 0) {
    throw new Error(`Buddy proposed with talk off: ${JSON.stringify(offState.utterances)}`)
  }
  if (bubbleTexts(off.bubbles).length !== 0) {
    throw new Error(`Buddy bubbled with talk off: ${JSON.stringify(bubbleTexts(off.bubbles))}`)
  }
  await request(ws, timeoutMs, 'liveChat.stop', {})

  await request(ws, timeoutMs, 'cohost.settings.set', { autoChat: settingsBefore.autoChat })
  await request(ws, timeoutMs, 'overlays.layout.set', layoutBefore)
}

function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolveClose) => {
    const timer = setTimeout(resolveClose, 2000)
    ws.addEventListener(
      'close',
      () => {
        clearTimeout(timer)
        resolveClose()
      },
      { once: true }
    )
    ws.close()
  })
}

function collectEvent(ws, name) {
  const collection = { payloads: [] }
  ws.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data)
      if (parsed.event === name) collection.payloads.push(parsed.payload)
    } catch {
      // Not JSON: not ours.
    }
  })
  return collection
}

function collectMessages(ws) {
  const collection = { messages: [], skipped: 0 }
  ws.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed.event === 'liveChat.message') {
      collection.messages.push(parsed.payload)
    } else if (parsed.event === 'events.lagged') {
      collection.skipped += Number(parsed.payload?.skipped ?? 0)
    }
  })
  return collection
}

async function waitForAuthoritativeMessages(ws, sessionId, expectedCount, deadlineMs) {
  const startedAt = Date.now()
  let latest
  while (Date.now() - startedAt <= deadlineMs) {
    latest = await request(ws, deadlineMs, 'liveChat.status', {})
    if (latest.sessionId === sessionId && latest.messages.length >= expectedCount) {
      return latest
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(
    `Timed out waiting for authoritative fake chat snapshot: ${JSON.stringify({
      sessionId: latest?.sessionId,
      received: latest?.messages?.length ?? 0,
      expected: expectedCount
    })}`
  )
}

async function waitForSessionTotals(ws, sessionId, expectedCount, deadlineMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= deadlineMs) {
    const totals = await request(ws, deadlineMs, 'sessions.comments.totals', { sessionId })
    if (totals?.status === 'available' && totals.messageCount === expectedCount) return totals
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('Timed out waiting for confirmed whole-session rollover accounting.')
}

async function listPersistedMessages(ws, sessionId, expectedCount, deadlineMs) {
  let cursor
  let messages = []
  const seenCursors = new Set()
  const maxPages = Math.ceil(expectedCount / 200) + 1

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await request(ws, deadlineMs, 'sessions.comments.list', {
      sessionId,
      cursor,
      limit: Math.min(200, Math.max(1, expectedCount - messages.length))
    })
    if (!page || !Array.isArray(page.messages)) {
      throw new Error(`Invalid persisted comments page: ${JSON.stringify(page)}`)
    }
    // Pages are fetched newest-to-oldest while every page is chronological.
    // Prepending each older page reconstructs the complete chronological feed.
    messages = [...page.messages, ...messages]
    if (!page.nextCursor) {
      return messages
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Persisted comments pagination repeated a cursor.')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(
    `Persisted comments pagination exceeded ${maxPages} pages for ${expectedCount} expected messages.`
  )
}

function waitFor(predicate, deadlineMs, label) {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) {
        resolveWait()
        return
      }
      if (Date.now() - startedAt > deadlineMs) {
        rejectWait(new Error(`Timed out waiting for ${label}.`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

function launchAndReadConnection() {
  return new Promise((resolveConnection, rejectConnection) => {
    const timer = setTimeout(() => {
      rejectConnection(new Error(`Timed out waiting for dev backend READY after ${timeoutMs}ms.`))
    }, timeoutMs)

    appProcess = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      detached: true,
      env: smokeAppEnv({
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.stderr.on('data', (text) => handleAppOutput(text, resolveConnection, timer))
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnection(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnection(
        new Error(
          `Dev app exited before the live-chat smoke completed: code=${code} signal=${signal}`
        )
      )
    })
  })
}

function handleAppOutput(text, resolveConnection, timer) {
  for (const line of text.split(/\r?\n/)) {
    const marker = '[smoke] backend-ready '
    const index = line.indexOf(marker)
    if (line.trim() && !stopping) {
      console.log(
        index === -1 ? line : `${line.slice(0, index)}${marker}[ephemeral connection redacted]`
      )
    }
    if (index === -1) {
      continue
    }
    clearTimeout(timer)
    resolveConnection(JSON.parse(line.slice(index + marker.length)))
  }
}

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    return
  }
  stopping = true
  await stopProcess(appProcess)
}
