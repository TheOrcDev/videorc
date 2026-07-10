import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Unified-comments smoke with the fake connector: drives the LiveChatCoordinator end to
// end over the real websocket protocol without any platform OAuth. Proves start → deliberately
// skewed messages → de-dupe → correlated fan-out outcomes → websocket reconnect/snapshot
// convergence → clear → stop, plus the capability/X-gate surface. The real YouTube/Twitch
// OAuth live smokes and the gated X smoke are documented in
// docs/live-chat-live-smoke-checklist.md (they need live accounts + a real stream).

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)

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
    for (const platform of ['youtube', 'twitch', 'x']) {
      if (!platforms.includes(platform)) {
        throw new Error(`liveChat.capability missing ${platform}: ${JSON.stringify(platforms)}`)
      }
    }
    const x = capability.find((entry) => entry.platform === 'x')
    if (x.state !== 'not-connected' || x.chatReadAvailable) {
      throw new Error(`X chat should be available but not connected, got ${JSON.stringify(x)}`)
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
    const persistedMessages = await request(ws, timeoutMs, 'sessions.comments.list', {
      sessionId
    })
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

    // Drop the event socket after the burst, reconnect to the same backend, and replace
    // incremental belief with the authoritative snapshot + persisted send operation.
    await closeWebSocket(ws)
    ws = await connectBackend(connection, timeoutMs)
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
    const onePixelPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    let highlightError
    try {
      await request(ws, timeoutMs, 'comments.highlight.set', {
        sessionId,
        messageId: status.messages[0].id,
        pngBase64: onePixelPng,
        position: 'top'
      })
    } catch (error) {
      highlightError = error
    }
    if (
      !(highlightError instanceof Error) ||
      highlightError.message !== 'Comment highlighting requires an active livestream.'
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

    const stopped = await request(ws, timeoutMs, 'liveChat.stop', {})
    if (stopped.sessionId) {
      throw new Error(
        `liveChat.stop should clear the active session: ${JSON.stringify(stopped.sessionId)}`
      )
    }

    console.log(
      `Unified-comments fake-provider smoke OK - ${diagnostics.messagesReceived} messages, ` +
        `${diagnostics.duplicatesSkipped} duplicate(s) skipped, sent/failed/read-only/timeout ` +
        `fan-out preserved, websocket snapshot recovered, X receive-only as "${x.message}".`
    )
  } finally {
    ws.close()
  }
} finally {
  await stopApp()
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
