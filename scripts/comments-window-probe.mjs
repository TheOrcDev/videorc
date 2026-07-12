#!/usr/bin/env node
// Comments window probe — headless verification of the detached comments window.
// Drives the detached Comments window through its real preload/main broker:
// correlated send, acknowledged + failed highlight, live/history cache
// isolation, and reopen/frame persistence. It also captures every important
// 420x640 visual state. Real-machine bound (Electron + a display).
//
//   node scripts/comments-window-probe.mjs
//
// Exits 0 when all assertions pass, 1 otherwise.

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const outputDirectory = join(tmpdir(), `videorc-comments-window-probe-${Date.now()}`)
mkdirSync(outputDirectory, { recursive: true })
const LIVE_SESSION_ID = 'comments-window-probe-live'
const NEXT_LIVE_SESSION_ID = 'comments-window-probe-next-live'
const HISTORY_SESSION_ID = 'comments-window-probe-history'
const HISTORY_MODE = {
  kind: 'history',
  sessionId: HISTORY_SESSION_ID,
  title: 'Friday launch replay',
  startedAt: '2026-07-09T18:00:00Z'
}
const LIVE_MESSAGE_IDS = {
  youtube: `${LIVE_SESSION_ID}:youtube:probe-1`,
  twitch: `${LIVE_SESSION_ID}:twitch:probe-2`,
  x: `${LIVE_SESSION_ID}:x:probe-3`
}

let launched
let smoke
const failures = []
const captures = []
let exitCode = 0
try {
  exitCode = await main()
} catch (error) {
  console.error(`comments window probe failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (launched) await stopProcess(launched.process)
}
process.exit(exitCode)

async function main() {
  console.log('Launching dev app for comments window probe…')
  launched = await launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_COMMENTS_WINDOW: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1'
    },
    onLine: (line) => console.log(line)
  })
  // The smoke command server announces itself under the preview-motion-ready marker.
  smoke = launched.connections['preview-motion-ready']

  const opened = await smokeCommand('comments-window-open')
  assertProbe(opened.open === true, 'open: comments window reports open', JSON.stringify(opened))
  assertProbe(
    opened.protected === true,
    'protection: comments window reports content protection enabled',
    JSON.stringify(opened)
  )

  await smokeCommand('comments-window-set-bounds', { x: 200, y: 140, width: 420, height: 640 })
  const placed = await waitFor(
    () => smokeCommand('comments-window-state'),
    (s) =>
      s.open &&
      s.bounds &&
      Math.abs(s.bounds.width - 420) <= 6 &&
      Math.abs(s.bounds.height - 640) <= 6,
    8000
  )
  assertProbe(placed.ok, 'bounds: window reports the requested size', JSON.stringify(placed.last))

  // Cold-cache edge: history may be the first view opened from Library. Back
  // to live must actively paint an empty live snapshot, never leave history stuck.
  const coldHistoryView = await smokeCommand('comments-window-push-snapshot', {
    mode: HISTORY_MODE,
    snapshot: historySnapshot()
  })
  assertProbe(
    coldHistoryView.latestSendOperation === undefined,
    'cold history: does not inherit a live send operation',
    JSON.stringify(coldHistoryView)
  )
  const coldHistory = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) => s.text.includes('History-only replay comment') && s.composerCount === 0,
    5000
  )
  assertProbe(
    coldHistory.ok,
    'cold history: first detached view renders the selected transcript',
    JSON.stringify(coldHistory.last)
  )
  const emptyLiveView = await smokeCommand('comments-window-set-view-mode', {
    mode: { kind: 'live' }
  })
  assertProbe(
    emptyLiveView?.mode?.kind === 'live' &&
      emptyLiveView.snapshot?.messages?.length === 0 &&
      emptyLiveView.latestSendOperation === undefined,
    'cold cache: Back to live returns an explicit empty live snapshot',
    JSON.stringify(emptyLiveView)
  )
  const coldLive = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.text.includes('Idle') &&
      s.composerCount === 0 &&
      !s.text.includes('History-only replay comment'),
    5000
  )
  assertProbe(
    coldLive.ok,
    'cold cache: empty live view replaces history in the detached DOM',
    JSON.stringify(coldLive.last)
  )

  // Idle is a distinct live-cache state: no transcript, no composer.
  await smokeCommand('comments-window-push-snapshot', { snapshot: idleSnapshot() })
  const idle = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) => s.open && s.messageCount === 0 && s.composerCount === 0 && s.text.includes('Idle'),
    8000
  )
  assertProbe(
    idle.ok,
    'idle: empty live cache renders without a composer',
    JSON.stringify(idle.last)
  )
  await captureState('idle', 'idle Comments window')

  await smokeCommand('comments-window-push-snapshot', { snapshot: failedLiveSnapshot() })
  const failedLive = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.text.includes('Live') &&
      s.text.includes('All providers are temporarily unavailable') &&
      s.composerCount === 1 &&
      s.composerDisabled === true &&
      s.highlightActionCount === 1 &&
      s.destinationStatus.includes('No writable destinations'),
    5000
  )
  assertProbe(
    failedLive.ok,
    'active failed providers: session stays Live with highlight action and disabled composer truth',
    JSON.stringify(failedLive.last)
  )

  // Three providers share one chronological reader; YouTube + Twitch are
  // writable while X truthfully remains receive-only.
  await smokeCommand('comments-window-push-snapshot', { snapshot: liveSnapshot() })
  const live = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.open &&
      s.messageCount === 3 &&
      s.composerCount === 1 &&
      s.text.includes('YouTube Viewer') &&
      s.text.includes('Twitch Viewer') &&
      s.text.includes('X Viewer') &&
      s.destinationStatus.includes('Sends to YouTube + Twitch') &&
      s.destinationStatus.includes('X receive-only'),
    8000
  )
  assertProbe(
    live.ok,
    'live: unified YouTube/Twitch/X feed and honest composer destinations render',
    JSON.stringify(live.last)
  )
  await captureState('live', 'unified live Comments window')

  const authority = await smokeCommand('comments-window-authority-probe')
  assertProbe(
    authority.invokeResults?.every((attempt) => attempt.exposed === false),
    'authority: detached preload omits all main-renderer mutation methods',
    JSON.stringify(authority)
  )
  assertProbe(
    authority.after?.highlight?.generation !== 999 &&
      authority.after?.view?.snapshot?.sessionId !== 'forged-comments-session' &&
      authority.after?.viewers?.total !== 999999,
    'authority: detached renderer cannot forge snapshot, viewers, or On stream state',
    JSON.stringify(authority)
  )

  // Delayed success makes the applying state observable, then proves the
  // matching broker acknowledgement owns the terminal on-stream state.
  await smokeCommand('comments-window-set-command-fixture', {
    kind: 'highlight',
    outcome: 'live',
    delayMs: 2500
  })
  const clicked = await smokeCommand('comments-window-click-message', {
    messageId: LIVE_MESSAGE_IDS.youtube
  })
  assertProbe(
    clicked.clicked === true,
    'highlight: live row click dispatched',
    JSON.stringify(clicked)
  )
  const applying = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) => s.highlightPhases?.[LIVE_MESSAGE_IDS.youtube] === 'applying',
    3000
  )
  assertProbe(
    applying.ok,
    'highlight: applying state remains visible until acknowledgement',
    JSON.stringify(applying.last)
  )
  await sleep(250)
  await captureState('highlight-applying', 'highlight applying')
  const highlighted = await waitFor(
    async () => ({
      reader: await smokeCommand('comments-window-reader-state'),
      command: await smokeCommand('comments-window-command-trace')
    }),
    (s) =>
      s.reader.highlightPhases?.[LIVE_MESSAGE_IDS.youtube] === 'live' &&
      s.command.pendingCount === 0 &&
      s.command.trace?.terminal === 'resolved',
    5000
  )
  assertProbe(
    highlighted.ok,
    'highlight: acknowledged row becomes On stream',
    JSON.stringify(highlighted.last)
  )
  assertCorrelatedTrace(highlighted.last?.command, 'highlight acknowledgement')

  // A rejected matching response must leave a visible, terminal failed state
  // instead of spinning forever or stealing the acknowledged row.
  await smokeCommand('comments-window-set-command-fixture', {
    kind: 'highlight',
    outcome: 'failed',
    delayMs: 150,
    reason: 'Probe compositor rejected this highlight.'
  })
  const failedClick = await smokeCommand('comments-window-click-message', {
    messageId: LIVE_MESSAGE_IDS.twitch
  })
  assertProbe(
    failedClick.clicked === true,
    'highlight failure: second row click dispatched',
    JSON.stringify(failedClick)
  )
  const failedHighlight = await waitFor(
    async () => ({
      reader: await smokeCommand('comments-window-reader-state'),
      command: await smokeCommand('comments-window-command-trace')
    }),
    (s) =>
      s.reader.highlightPhases?.[LIVE_MESSAGE_IDS.twitch] === 'failed' &&
      s.command.pendingCount === 0 &&
      s.command.trace?.terminal === 'rejected',
    5000
  )
  assertProbe(
    failedHighlight.ok,
    'highlight failure: terminal Failed state is visible',
    JSON.stringify(failedHighlight.last)
  )
  assertCorrelatedTrace(failedHighlight.last?.command, 'failed highlight')
  await captureState('highlight-failed', 'failed highlight')

  // The composer travels through the same correlated broker. This response is
  // intentionally partial: YouTube succeeds, Twitch fails, X is receive-only.
  const outboundText = 'Unified hello from Comments'
  await smokeCommand('comments-window-set-command-fixture', {
    kind: 'send',
    outcome: 'partial',
    delayMs: 150,
    reason: 'Twitch probe destination rejected this message.'
  })
  const submitted = await smokeCommand('comments-window-submit-message', { text: outboundText })
  assertProbe(submitted.submitted === true, 'send: composer submitted', JSON.stringify(submitted))
  const partialSend = await waitFor(
    async () => ({
      reader: await smokeCommand('comments-window-reader-state'),
      command: await smokeCommand('comments-window-command-trace')
    }),
    (s) =>
      s.reader.text.includes(`You · ${outboundText} · partial`) &&
      s.reader.text.includes('Twitch probe destination rejected this message.') &&
      s.reader.destinationStatus.includes('X receive-only') &&
      s.reader.deliveryStatus.includes('YouTube · Sent') &&
      s.reader.deliveryStatus.includes('Twitch · Failed') &&
      s.reader.deliveryStatus.includes('X · Receive-only') &&
      s.command.pendingCount === 0 &&
      s.command.trace?.terminal === 'resolved',
    5000
  )
  assertProbe(
    partialSend.ok,
    'send: partial result names Twitch failure and X receive-only state',
    JSON.stringify(partialSend.last)
  )
  assertCorrelatedTrace(partialSend.last?.command, 'send result', true)
  await captureState('partial-send-x-receive-only', 'partial send with X receive-only')

  const lateSendRoute = await smokeCommand('comments-window-route-send-result', {
    operation: lateHistorySendOperation()
  })
  assertProbe(
    lateSendRoute.routedTo === 'history' &&
      lateSendRoute.historyOperation?.text === 'Late old-session reply' &&
      lateSendRoute.liveOperation?.text === outboundText &&
      lateSendRoute.currentView?.latestSendOperation?.text === outboundText,
    'send cache: late old-session result cannot replace the current live receipt',
    JSON.stringify(lateSendRoute)
  )

  // Seed history independently, then bounce between caches after mutating live.
  const selectedHistoryView = await smokeCommand('comments-window-push-snapshot', {
    mode: HISTORY_MODE,
    snapshot: historySnapshot(),
    latestSendOperation: historySendOperation()
  })
  assertProbe(
    selectedHistoryView.latestSendOperation?.text === 'Historical host reply',
    'send cache: selected history owns its historical send operation',
    JSON.stringify(selectedHistoryView)
  )
  const history = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.composerCount === 0 &&
      s.text.includes('History-only replay comment') &&
      !s.text.includes('Live-only launch comment'),
    5000
  )
  assertProbe(
    history.ok,
    'history: persisted transcript renders without composer or live-cache leakage',
    JSON.stringify(history.last)
  )
  await captureState('history-no-composer', 'history without composer')

  await smokeCommand('comments-window-push-snapshot', { snapshot: updatedLiveSnapshot() })
  const isolatedHistoryView = await smokeCommand('comments-window-set-view-mode', {
    mode: HISTORY_MODE
  })
  assertProbe(
    isolatedHistoryView.latestSendOperation?.text === 'Historical host reply',
    'send cache: live updates do not overwrite history operations',
    JSON.stringify(isolatedHistoryView)
  )
  const historyStillIsolated = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.text.includes('History-only replay comment') &&
      !s.text.includes('Live cache update after history'),
    5000
  )
  assertProbe(
    historyStillIsolated.ok,
    'cache isolation: live update does not overwrite selected history',
    JSON.stringify(historyStillIsolated.last)
  )
  const restoredLiveView = await smokeCommand('comments-window-set-view-mode', {
    mode: { kind: 'live' }
  })
  assertProbe(
    restoredLiveView.latestSendOperation?.text === outboundText,
    'send cache: returning live restores only the live send operation',
    JSON.stringify(restoredLiveView)
  )
  const liveStillIsolated = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.composerCount === 1 &&
      s.text.includes('Live cache update after history') &&
      !s.text.includes('History-only replay comment'),
    5000
  )
  assertProbe(
    liveStillIsolated.ok,
    'cache isolation: returning live restores only the live snapshot',
    JSON.stringify(liveStillIsolated.last)
  )

  const staleSameSession = await smokeCommand('comments-window-route-send-result', {
    operation: staleLiveSendOperation(restoredLiveView.latestSendOperation)
  })
  assertProbe(
    staleSameSession.liveOperation?.id === restoredLiveView.latestSendOperation?.id &&
      staleSameSession.liveOperation?.text === outboundText,
    'send cache: older same-session operation cannot replace the latest receipt',
    JSON.stringify(staleSameSession)
  )

  const sendingProgress = await smokeCommand('comments-window-route-send-result', {
    operation: progressingLiveSendOperation('sending')
  })
  const terminalProgress = await smokeCommand('comments-window-route-send-result', {
    operation: progressingLiveSendOperation('sent')
  })
  const regressedProgress = await smokeCommand('comments-window-route-send-result', {
    operation: progressingLiveSendOperation('sending', '2099-01-01T00:00:03Z')
  })
  assertProbe(
    sendingProgress.liveOperation?.phase === 'sending' &&
      terminalProgress.liveOperation?.phase === 'sent' &&
      regressedProgress.liveOperation?.phase === 'sent',
    'send cache: same-id operation advances to terminal and never regresses',
    JSON.stringify({ sendingProgress, terminalProgress, regressedProgress })
  )

  const nextSessionView = await smokeCommand('comments-window-push-snapshot', {
    snapshot: nextLiveSessionSnapshot()
  })
  assertProbe(
    nextSessionView.snapshot?.sessionId === NEXT_LIVE_SESSION_ID &&
      nextSessionView.latestSendOperation === undefined,
    'send cache: first snapshot of a new live session clears the prior send badge',
    JSON.stringify(nextSessionView)
  )
  const nextSessionReader = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.composerCount === 1 &&
      s.text.includes('Fresh live session starts with a clean composer') &&
      !s.text.includes(outboundText),
    5000
  )
  assertProbe(
    nextSessionReader.ok,
    'send cache: new-session DOM has no prior operation receipt',
    JSON.stringify(nextSessionReader.last)
  )

  const closed = await smokeCommand('comments-window-toggle')
  assertProbe(
    closed.open === false,
    'toggle close: comments window reports closed',
    JSON.stringify(closed)
  )

  const reopened = await smokeCommand('comments-window-toggle')
  assertProbe(
    reopened.open === true,
    'toggle reopen: comments window reports open',
    JSON.stringify(reopened)
  )
  const restored = await waitFor(
    () => smokeCommand('comments-window-state'),
    (s) =>
      s.open &&
      s.bounds &&
      Math.abs(s.bounds.width - 420) <= 6 &&
      Math.abs(s.bounds.height - 640) <= 6,
    8000
  )
  assertProbe(restored.ok, 'reopen: persisted frame restored', JSON.stringify(restored.last))
  const reopenedReader = await waitFor(
    () => smokeCommand('comments-window-reader-state'),
    (s) =>
      s.text.includes('Fresh live session starts with a clean composer') && s.composerCount === 1,
    8000
  )
  assertProbe(
    reopenedReader.ok,
    'reopen: selected live cache survives renderer restart',
    JSON.stringify(reopenedReader.last)
  )

  console.log('\n=== Comments window probe summary ===')
  if (failures.length === 0) {
    console.log(
      'PASS — correlated send/highlight, terminal failure, live/history isolation, captures, toggle, and frame persistence.'
    )
    for (const capture of captures) console.log(`CAPTURE ${capture.label}: ${capture.file}`)
    return 0
  }
  for (const failure of failures) console.log(`FAIL: ${failure}`)
  return 1
}

async function captureState(name, label) {
  // Let React layout + the scroll viewport settle after badges/composer rows
  // change height. Immediate capturePage calls can otherwise catch a transient
  // compositor texture with the old scroll offset on Retina displays.
  await sleep(350)
  const capture = await smokeCommand('comments-window-capture-page', { name })
  captures.push({ ...capture, label })
  assertProbe(
    capture.size?.width === 420 && capture.size?.height === 640 && capture.headerSignal > 25,
    `capture: ${label} is a complete 420x640 frame`,
    JSON.stringify(capture)
  )
  return capture
}

function assertCorrelatedTrace(command, label, includeOperation = false) {
  const trace = command?.trace
  const correlated =
    command?.pendingCount === 0 &&
    trace?.requestId &&
    trace.requestId === trace.resolutionRequestId &&
    trace.staleResolutionAccepted === false &&
    trace.resolutionAccepted === true &&
    (!includeOperation || (trace.operationId && trace.operationId === trace.resultOperationId))
  assertProbe(correlated, `correlation: ${label} matches request ids`, JSON.stringify(command))
}

async function waitFor(fetchState, predicate, timeoutMsLocal) {
  const deadline = Date.now() + timeoutMsLocal
  let last = null
  do {
    last = await fetchState()
    if (predicate(last)) return { ok: true, last }
    await sleep(250)
  } while (Date.now() < deadline)
  return { ok: false, last }
}

async function smokeCommand(command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${smoke.capability}`
    },
    body: JSON.stringify({ command, params })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}

function assertProbe(condition, label, detail) {
  if (condition) {
    console.log(`OK   ${label}`)
  } else {
    console.log(`FAIL ${label} — ${detail}`)
    failures.push(`${label} — ${detail}`)
  }
}

function idleSnapshot() {
  return {
    providers: [],
    messages: [],
    unreadCount: 0,
    updatedAt: '2026-07-10T09:00:00Z'
  }
}

function liveSnapshot() {
  return {
    sessionId: LIVE_SESSION_ID,
    providers: liveProviders(),
    messages: [
      messageFixture({
        id: LIVE_MESSAGE_IDS.youtube,
        platform: 'youtube',
        authorName: 'YouTube Viewer',
        messageText: 'Live-only launch comment from YouTube',
        at: '2026-07-10T09:00:01Z'
      }),
      messageFixture({
        id: LIVE_MESSAGE_IDS.twitch,
        platform: 'twitch',
        authorName: 'Twitch Viewer',
        messageText: 'Audio is perfectly in sync on Twitch',
        at: '2026-07-10T09:00:02Z'
      }),
      messageFixture({
        id: LIVE_MESSAGE_IDS.x,
        platform: 'x',
        authorName: 'X Viewer',
        messageText: 'Watching the unified feed from X',
        at: '2026-07-10T09:00:03Z'
      })
    ],
    unreadCount: 3,
    updatedAt: '2026-07-10T09:00:04Z'
  }
}

function failedLiveSnapshot() {
  const sessionId = 'comments-window-probe-failed-live'
  return {
    sessionId,
    providers: liveProviders().map((provider) => ({
      ...provider,
      read: 'failed',
      write: provider.platform === 'x' ? 'read-only' : 'failed',
      state: 'failed',
      message: `${provider.platform} comments failed in the probe.`
    })),
    messages: [
      messageFixture({
        id: `${sessionId}:youtube:failed-1`,
        platform: 'youtube',
        sessionId,
        authorName: 'Waiting Viewer',
        messageText: 'All providers are temporarily unavailable',
        at: '2026-07-10T09:00:00Z'
      })
    ],
    unreadCount: 1,
    updatedAt: '2026-07-10T09:00:00Z'
  }
}

function updatedLiveSnapshot() {
  const snapshot = liveSnapshot()
  return {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      messageFixture({
        id: `${LIVE_SESSION_ID}:youtube:probe-4`,
        platform: 'youtube',
        authorName: 'YouTube Viewer',
        messageText: 'Live cache update after history',
        at: '2026-07-10T09:00:05Z'
      })
    ],
    unreadCount: 4,
    updatedAt: '2026-07-10T09:00:06Z'
  }
}

function nextLiveSessionSnapshot() {
  return {
    sessionId: NEXT_LIVE_SESSION_ID,
    providers: liveProviders(),
    messages: [
      messageFixture({
        id: `${NEXT_LIVE_SESSION_ID}:youtube:probe-1`,
        platform: 'youtube',
        sessionId: NEXT_LIVE_SESSION_ID,
        authorName: 'Next Session Viewer',
        messageText: 'Fresh live session starts with a clean composer',
        at: '2026-07-10T10:00:01Z'
      })
    ],
    unreadCount: 1,
    updatedAt: '2026-07-10T10:00:02Z'
  }
}

function historySnapshot() {
  return {
    sessionId: HISTORY_SESSION_ID,
    providers: liveProviders().map((provider) => ({
      ...provider,
      read: 'ended',
      state: 'ended',
      message: 'Livestream ended.'
    })),
    messages: [
      messageFixture({
        id: `${HISTORY_SESSION_ID}:youtube:history-1`,
        platform: 'youtube',
        sessionId: HISTORY_SESSION_ID,
        authorName: 'Replay Viewer',
        messageText: 'History-only replay comment',
        at: '2026-07-09T18:03:00Z'
      })
    ],
    unreadCount: 0,
    updatedAt: '2026-07-09T18:30:00Z'
  }
}

function historySendOperation() {
  return {
    id: 'history-send-operation',
    sessionId: HISTORY_SESSION_ID,
    text: 'Historical host reply',
    phase: 'sent',
    destinations: [
      {
        destinationId: 'comments-probe-youtube',
        platform: 'youtube',
        phase: 'sent'
      }
    ],
    createdAt: '2026-07-09T18:06:00Z',
    updatedAt: '2026-07-09T18:06:01Z'
  }
}

function lateHistorySendOperation() {
  return {
    ...historySendOperation(),
    id: 'late-history-send-operation',
    text: 'Late old-session reply',
    createdAt: '2026-07-09T18:05:00Z',
    updatedAt: '2026-07-10T09:04:00Z'
  }
}

function staleLiveSendOperation(current) {
  return {
    ...current,
    id: 'stale-live-send-operation',
    sessionId: LIVE_SESSION_ID,
    text: 'Stale same-session reply',
    phase: 'sent',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: '2099-01-01T00:00:00Z'
  }
}

function progressingLiveSendOperation(phase, updatedAt = '2099-01-01T00:00:02Z') {
  return {
    id: 'progressing-live-send-operation',
    sessionId: LIVE_SESSION_ID,
    text: 'Monotonic progression probe',
    phase,
    destinations: [
      {
        destinationId: 'comments-probe-youtube',
        platform: 'youtube',
        phase: phase === 'sending' ? 'pending' : 'sent'
      }
    ],
    createdAt: '2099-01-01T00:00:01Z',
    updatedAt
  }
}

function liveProviders() {
  return [
    providerFixture('youtube', 'ready'),
    providerFixture('twitch', 'ready'),
    providerFixture('x', 'read-only')
  ]
}

function providerFixture(platform, write) {
  return {
    id: `comments-probe-${platform}`,
    targetId: `probe-${platform}`,
    platform,
    read: 'ready',
    write,
    state: 'connected',
    message: `${platform} comments connected.`,
    lastConnectedAt: '2026-07-10T09:00:00Z'
  }
}

function messageFixture({
  id,
  platform,
  authorName,
  messageText,
  at,
  sessionId = LIVE_SESSION_ID
}) {
  return {
    id,
    providerMessageId: id.split(':').at(-1),
    platform,
    targetId: `probe-${platform}`,
    sessionId,
    authorName,
    authorBadges: [],
    authorRoles: [],
    publishedAt: at,
    receivedAt: at,
    messageText,
    fragments: [{ type: 'text', text: messageText }],
    eventType: 'message',
    isDeleted: false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
