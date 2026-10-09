import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import { startCaptionAudioPump } from './lib/cohost-caption-audio.mjs'
import { startFakeApiRouter } from './lib/fake-api-router.mjs'
import { BUDDY_COMMAND_FINALS, startFakeCaptionService } from './lib/fake-caption-service.mjs'
import {
  COHOST_SPOTLIGHT_PATH,
  COHOST_TICK_PATH,
  startFakeCohostService
} from './lib/fake-cohost-service.mjs'
import { startFakeTranscriptService } from './lib/fake-transcript-service.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Buddy voice commands, end to end (plan 140 S9). Launches the real debug
// backend against isolated profiles and local fakes (Buddy's tick and
// spotlight, the caption service with scripted realtime finals, the AI
// capabilities with the cloud command parser off, and the desktop service
// flags), drives the fake chat connectors, and proves over the WebSocket:
//
//   A. Premium: highlight by name from a command split across two finals ->
//      clear -> "this one" removal of the flagged comment confirmed by voice
//      ("Removed by you") -> a removal cancelled by voice -> a missing-scope
//      removal hidden in Videorc -> "this one" highlight through the spotlight
//      -> a removal left to expire after 20 s -> the report's command counts
//      -> a voice removal left pending-confirm when the backend is killed.
//   A'. The same profile restarted with the Buddy kill switches off: the
//      restart sweep cancelled the pending removal, a spoken command does
//      nothing, a voice removal is refused `disabled`, a manual one removes.
//   B. Basic (VIDEORC_PREMIUM_FEATURES=0): cohost.start and a voice removal
//      are refused `premium-required`; manual Remove from chat still works.
//
// The comment card never goes on stream here (no stream session): the
// renderer's executor and the overlay are proven by smoke:cohost-fake and the
// comment-highlight smokes. This smoke asserts the engine's command state,
// the `source: "command"` autoHighlight it issues, and the moderation
// operations and tombstones. No production bearer, account or network.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 30_000)
const CONFIRM_WINDOW_MS = 20_000
const COMMAND_DEADLINE_MS = 6_000
const KILL_SWITCH_QUIET_MS = 4_000

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-buddy-commands-smoke-'))
const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary = join(repoRoot, 'target', 'debug', backendBinaryName)
const smokeSessionToken = `buddy-smoke-session-${randomUUID()}`
// No colons: message ids are `<session>:<platform>:<target>:<provider id>`.
const sessionId = `buddy-smoke-${Date.now()}`

const MAIN_LANE = {
  platform: 'twitch',
  targetId: 'buddy-main',
  count: 6,
  intervalMs: 250,
  send: 'sent',
  // #0 coders_x, #1 ana_dev, #2 spam_bot (flagged by the fake tick), #3
  // coders_x, #4 ana_dev, #5 spam_bot.
  authors: ['coders_x', 'ana_dev', 'spam_bot']
}
const NO_SCOPE_LANE = {
  platform: 'kick',
  targetId: 'buddy-noscope',
  count: 1,
  intervalMs: 300,
  send: 'sent',
  authors: ['kick_lurker'],
  delete: 'missing-scope'
}
const FLAG_MARKER = '#2'
const SPOTLIGHT_PHRASE = 'mechanical keyboard'

const fakeCohost = await startFakeCohostService({ smokeSessionToken, flagMarker: FLAG_MARKER })
const captionFake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken: `buddy-smoke-realtime-${randomUUID()}`,
  autoTranscript: false
})
const capabilities = await startFakeTranscriptService({ smokeSessionToken })
const serviceFlags = await startServiceFlagsServer({ version: 1 })
const router = await startFakeApiRouter({
  routes: [
    { prefix: COHOST_TICK_PATH, origin: fakeCohost.httpOrigin },
    { prefix: COHOST_SPOTLIGHT_PATH, origin: fakeCohost.httpOrigin },
    { prefix: '/api/ai/cohost/' + 'command', origin: captionFake.httpOrigin },
    { prefix: '/api/ai/captions/', origin: captionFake.httpOrigin },
    { prefix: '/api/ai/capabilities', origin: capabilities.httpOrigin },
    { prefix: '/api/desktop/service-flags', origin: serviceFlags.httpOrigin }
  ],
  fallback: fakeCohost.httpOrigin
})

const startedAt = Date.now()
const results = []
const phase = (label) =>
  console.log(`[buddy-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`)
const pass = (label) => {
  results.push(label)
  console.log(`[buddy-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] PASS ${label}`)
}
const launched = []

try {
  if (!existsSync(backendBinary)) {
    throw new Error(`target/debug/${backendBinaryName} is missing; build the debug backend first.`)
  }
  const premiumProfile = createProfile('premium')
  const pendingAtKill = await runPremiumScenario(premiumProfile)
  await runRestartAndKillSwitchScenario(premiumProfile, pendingAtKill)
  await runBasicScenario(createProfile('basic'))

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `Buddy voice commands smoke PASS in ${seconds}s\n${results.map((line) => `  ${line}`).join('\n')}`
  )
} finally {
  for (const backend of launched.reverse()) await backend.stop().catch(() => {})
  await router.close()
  await serviceFlags.close()
  await capabilities.close()
  await captionFake.close()
  await fakeCohost.close()
  rmSync(stateRoot, { force: true, recursive: true })
}

// --- A. Premium ------------------------------------------------------------------

async function runPremiumScenario(profile) {
  const backend = await launchBackend(profile)
  const { ws, admin, events } = backend
  phase('A: settings, chat session, captions and Buddy')
  const settings = await request(ws, timeoutMs, 'cohost.settings.set', {
    enabled: true,
    listen: true,
    autoHighlight: false,
    voiceHighlight: false,
    wakeWordRequired: false,
    removeConfirm: 'confirm'
  })
  expect(
    settings.enabled && settings.listen && settings.removeConfirm === 'confirm',
    `cohost.settings.set did not echo the voice command settings: ${JSON.stringify(settings)}`
  )
  expect(
    settings.wakeWordRequired === false,
    `wakeWordRequired should default off: ${JSON.stringify(settings)}`
  )
  await request(ws, timeoutMs, 'liveChat.start', {
    sessionId,
    destinations: [MAIN_LANE, NO_SCOPE_LANE].map(({ platform, targetId }) => ({
      platform,
      targetId,
      read: 'ready',
      write: 'ready'
    })),
    fakes: [MAIN_LANE, NO_SCOPE_LANE]
  })
  await request(ws, timeoutMs, 'captions.start', { language: 'en' })
  const started = await request(ws, timeoutMs, 'cohost.start', {
    sessionId,
    consentToProcessChat: true,
    streamTitle: 'Buddy commands smoke'
  })
  expect(
    started.status === 'listening' && started.sessionId === sessionId,
    `cohost.start did not listen: ${JSON.stringify(started)}`
  )
  const pump = startCaptionAudioPump({ ws: admin, request, captionFake })
  try {
    await waitUntil(
      () => captionFake.state.audioAppends > 0,
      20_000,
      'caption audio reaching the fake realtime service'
    )
    const chat = await waitUntil(
      () => {
        const main = laneMessages(events, MAIN_LANE)
        const noScope = laneMessages(events, NO_SCOPE_LANE)
        return main.length === MAIN_LANE.count && noScope.length === NO_SCOPE_LANE.count
          ? { main, noScope }
          : null
      },
      15_000,
      'every scripted chat message'
    )
    const byProvider = (lane, seq) => {
      const message = (lane === NO_SCOPE_LANE ? chat.noScope : chat.main).find((entry) =>
        entry.id.endsWith(`:fake-${seq}`)
      )
      expect(message, `Fake message ${lane.targetId} #${seq} never arrived.`)
      return message
    }
    const codersNewest = byProvider(MAIN_LANE, 3)
    const anaNewest = byProvider(MAIN_LANE, 4)
    const flagged = byProvider(MAIN_LANE, 2)
    const lurker = byProvider(NO_SCOPE_LANE, 0)
    expect(
      codersNewest.authorName === 'coders_x' &&
        anaNewest.authorName === 'ana_dev' &&
        flagged.authorName === 'spam_bot' &&
        lurker.authorName === 'kick_lurker',
      `Fake lanes did not take the scripted authors: ${JSON.stringify([codersNewest, anaNewest, flagged, lurker].map((m) => m.authorName))}`
    )
    await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === sessionId &&
        state.tickInFlight !== true &&
        state.flags?.some((flag) => flag.messageId === flagged.id),
      'the first tick flagging the marker comment',
      45_000
    )
    pass('A setup: chat from scripted authors, captions live, the tick flagged spam_bot')

    // Named point commands have a capture owner. Without a recording they
    // cannot become an Unknown moderation card or invoke the cloud parser.
    phase('A0: named and negated markers remain outside chat commands')
    const parserProbe = await fetch(router.httpOrigin + '/api/ai/cohost/' + 'command', {
      method: 'POST',
      headers: { authorization: `Bearer ${smokeSessionToken}` },
      body: '{}'
    })
    expect(parserProbe.status === 404, 'The command-parser observation probe hit the wrong fake')
    const commandRequestsBeforeMarkers = captionFake.state.commandRequests
    expect(commandRequestsBeforeMarkers > 0, 'The router did not expose command-parser requests')
    await say(events, BUDDY_COMMAND_FINALS.namedMarker)
    await say(events, BUDDY_COMMAND_FINALS.negatedMarker)
    expect(
      (await request(ws, timeoutMs, 'session.markers.list', { sessionId })).markers.length === 0,
      'A chat session without capture saved a named marker'
    )
    const markerOnlyState = await request(ws, timeoutMs, 'cohost.status', {})
    expect(!markerOnlyState.command, 'A marker command became a chat moderation card')
    expect(
      captionFake.state.commandRequests === commandRequestsBeforeMarkers,
      'Named markers invoked a cloud command parser'
    )
    pass('A0 named markers: no capture write, moderation card or cloud parser request')

    // 1. Highlight by name, one command split across two finals.
    phase('A1: "Buddy, highlight the comment" | "from coders X."')
    const highlightSince = Date.now()
    await say(events, BUDDY_COMMAND_FINALS.highlightByNameSplit)
    const highlighted = await waitForCommand(
      events,
      (command) => command.kind === 'highlight' && command.status === 'done',
      'the highlight-by-name command',
      highlightSince
    )
    expect(
      highlighted.command.target?.messageId === codersNewest.id &&
        highlighted.command.target?.authorName === 'coders_x' &&
        highlighted.command.heard === 'buddy highlight the comment from coders x',
      `Highlight by name picked the wrong comment: ${JSON.stringify(highlighted.command)}`
    )
    const autoHighlight = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.autoHighlight?.source === 'command' &&
        state.autoHighlight.messageId === codersNewest.id,
      'the autoHighlight {source: command} for coders_x',
      COMMAND_DEADLINE_MS,
      highlightSince
    )
    pass(
      `A1 highlight by name: "${highlighted.command.heard}" -> ${highlighted.command.message} ` +
        `(autoHighlight source=command generation ${autoHighlight.payload.autoHighlight.generation}, ` +
        `${highlighted.at - highlightSince} ms after the first final)`
    )

    // 2. Clear (before the 8 s apply timeout retires the unexecuted card).
    phase('A2: "Buddy, clear the highlight."')
    const clearSince = Date.now()
    await say(events, BUDDY_COMMAND_FINALS.clear)
    const cleared = await waitForCommand(
      events,
      (command) => command.kind === 'clear' && command.status === 'done',
      'the clear command',
      clearSince
    )
    expect(
      cleared.command.message === 'Cleared the highlight.',
      `Clear should take the requested card down: ${JSON.stringify(cleared.command)}`
    )
    const afterClear = await request(ws, timeoutMs, 'cohost.status', {})
    expect(
      !afterClear.autoHighlight,
      `The clear must retire the command card: ${JSON.stringify(afterClear.autoHighlight)}`
    )
    pass(`A2 clear: ${cleared.command.message}`)

    // 3. "This one" removal of the flagged comment, confirmed by voice.
    phase('A3: "This one is toxic. Remove it from our chat." then "Yes."')
    const removeSince = Date.now()
    await say(events, BUDDY_COMMAND_FINALS.removeThisOne)
    const card = await waitForCommand(
      events,
      (command) =>
        command.kind === 'remove' && command.status === 'confirm' && Boolean(command.operationId),
      'the removal card',
      removeSince
    )
    expect(
      card.command.target?.messageId === flagged.id &&
        card.command.reason === 'toxic' &&
        typeof card.command.expiresAt === 'string',
      `"This one" should target the flagged comment with the reason: ${JSON.stringify(card.command)}`
    )
    const pending = await waitForOperation(
      events,
      card.command.operationId,
      (operation) => operation.phase === 'pending-confirm',
      'the pending-confirm removal'
    )
    const confirmWindow = Date.parse(pending.confirmBy) - Date.parse(pending.createdAt)
    expect(
      pending.source === 'orcle-voice' &&
        pending.confirmMode === 'confirm' &&
        pending.messageId === flagged.id &&
        Math.abs(confirmWindow - CONFIRM_WINDOW_MS) <= 1_000,
      `The voice removal should wait 20 s for an answer: ${JSON.stringify(pending)}`
    )
    await say(events, BUDDY_COMMAND_FINALS.confirm)
    const removed = await waitForOperation(
      events,
      card.command.operationId,
      (operation) => operation.phase === 'removed',
      'the confirmed removal'
    )
    const tombstone = await waitForEvent(
      events,
      'liveChat.message',
      (message) => message.id === flagged.id && message.isDeleted === true,
      'the "Removed by you" tombstone',
      COMMAND_DEADLINE_MS
    )
    expect(
      tombstone.rawProviderType === 'videorc.removed' &&
        tombstone.messageText === 'Removed by you' &&
        tombstone.eventType === 'deleted' &&
        (tombstone.fragments ?? []).length === 0,
      `The tombstone should read "Removed by you": ${JSON.stringify(tombstone)}`
    )
    const removeDone = await waitForCommand(
      events,
      (command) => command.id === card.command.id && command.status === 'done',
      'the removal command finishing',
      removeSince
    )
    const flagResolved = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === sessionId &&
        Array.isArray(state.flags) &&
        !state.flags.some((flag) => flag.messageId === flagged.id),
      'the removed comment leaving the flags',
      COMMAND_DEADLINE_MS,
      removeSince
    )
    expect(flagResolved, 'The flag stayed after the removal.')
    pass(
      `A3 remove "this one" + voice yes: ${removed.outcome} / row "${tombstone.messageText}" / strip "${removeDone.command.message}"`
    )

    // 4. A removal cancelled by voice.
    phase('A4: "Buddy, delete the comment from ana dev." then "No."')
    const cancelSince = Date.now()
    await say(events, ['Buddy, delete the comment from ana dev.'])
    const cancelCard = await waitForCommand(
      events,
      (command) =>
        command.kind === 'remove' &&
        command.status === 'confirm' &&
        Boolean(command.operationId) &&
        command.id !== card.command.id,
      'the second removal card',
      cancelSince
    )
    expect(
      cancelCard.command.target?.messageId === anaNewest.id,
      `Removal by name should target ana_dev's newest comment: ${JSON.stringify(cancelCard.command)}`
    )
    await say(events, BUDDY_COMMAND_FINALS.cancel)
    const cancelled = await waitForOperation(
      events,
      cancelCard.command.operationId,
      (operation) => operation.phase === 'cancelled',
      'the cancelled removal'
    )
    const cancelDone = await waitForCommand(
      events,
      (command) => command.id === cancelCard.command.id && command.status === 'cancelled',
      'the cancelled command',
      cancelSince
    )
    const anaAfterCancel = laneMessages(events, MAIN_LANE).find((m) => m.id === anaNewest.id)
    expect(
      anaAfterCancel && !anaAfterCancel.isDeleted,
      'A cancelled removal must leave the message alone.'
    )
    pass(`A4 cancel by voice: ${cancelled.outcome} / strip "${cancelDone.command.message}"`)

    // 5. Missing scope: the platform cannot delete it, Videorc hides it.
    phase('A5: "Buddy, delete the comment from kick lurker." then "Yes." (missing scope)')
    const hideSince = Date.now()
    await say(events, ['Buddy, delete the comment from kick lurker.'])
    const hideCard = await waitForCommand(
      events,
      (command) =>
        command.kind === 'remove' && command.status === 'confirm' && Boolean(command.operationId),
      'the missing-scope removal card',
      hideSince
    )
    expect(
      hideCard.command.target?.messageId === lurker.id,
      `Removal by name should target kick_lurker: ${JSON.stringify(hideCard.command)}`
    )
    await say(events, BUDDY_COMMAND_FINALS.confirm)
    const hidden = await waitForOperation(
      events,
      hideCard.command.operationId,
      (operation) => operation.phase === 'hidden-locally',
      'the local hide'
    )
    expect(
      hidden.outcomeCode === 'missing-scope' &&
        /^Hidden in Videorc\. Viewers on Kick still see it\./.test(hidden.outcome ?? ''),
      `A missing scope should hide in Videorc and say so: ${JSON.stringify(hidden)}`
    )
    const hiddenRow = await waitForEvent(
      events,
      'liveChat.message',
      (message) => message.id === lurker.id && message.isDeleted === true,
      'the "Hidden in Videorc" tombstone',
      COMMAND_DEADLINE_MS
    )
    expect(
      hiddenRow.rawProviderType === 'videorc.hidden' &&
        hiddenRow.messageText === 'Hidden in Videorc',
      `The hidden row should read "Hidden in Videorc": ${JSON.stringify(hiddenRow)}`
    )
    pass(`A5 missing scope: ${hidden.outcome} / row "${hiddenRow.messageText}"`)

    // 6. "This one" highlight through the spotlight.
    phase(`A6: the spotlight finds ana_dev's comment, then "Buddy, put this one up."`)
    fakeCohost.setSpotlightMatches([
      { whenTranscriptIncludes: SPOTLIGHT_PHRASE, messageId: anaNewest.id, about: 0.95 }
    ])
    const spotlightSince = Date.now()
    await say(events, [`Somebody in chat asked about my ${SPOTLIGHT_PHRASE}, it clicks a lot.`])
    await waitForEvent(
      events,
      'cohost.state',
      (state) => state.spotlight?.messageId === anaNewest.id && state.spotlight.score >= 0.75,
      `the spotlight on ana_dev's comment`,
      10_000,
      spotlightSince
    )
    const thisOneSince = Date.now()
    await say(events, BUDDY_COMMAND_FINALS.highlightThisOne)
    const thisOne = await waitForCommand(
      events,
      (command) => command.kind === 'highlight' && command.status === 'done',
      'the "this one" highlight',
      thisOneSince
    )
    expect(
      thisOne.command.target?.messageId === anaNewest.id,
      `"This one" should be the spotlight comment: ${JSON.stringify(thisOne.command)}`
    )
    await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.autoHighlight?.source === 'command' && state.autoHighlight.messageId === anaNewest.id,
      'the autoHighlight {source: command} for the spotlight comment',
      COMMAND_DEADLINE_MS,
      thisOneSince
    )
    fakeCohost.setSpotlightMatches([])
    pass(`A6 "this one" via the spotlight: ${thisOne.command.message}`)

    // 7. Expiry: no answer in 20 s, nothing is removed.
    phase('A7: "Buddy, remove the comment from coders X." and no answer for 20 s')
    const expirySince = Date.now()
    await say(events, ['Buddy, remove the comment from coders X.'])
    const expiryCard = await waitForCommand(
      events,
      (command) =>
        command.kind === 'remove' && command.status === 'confirm' && Boolean(command.operationId),
      'the removal card left unanswered',
      expirySince
    )
    expect(
      expiryCard.command.target?.messageId === codersNewest.id,
      `Removal by name should target coders_x's newest comment: ${JSON.stringify(expiryCard.command)}`
    )
    const expired = await waitForOperation(
      events,
      expiryCard.command.operationId,
      (operation) => operation.phase === 'expired',
      'the expired removal',
      CONFIRM_WINDOW_MS + 5_000
    )
    const expiredAfterMs = Date.parse(expired.updatedAt) - Date.parse(expired.createdAt)
    const expiryDone = await waitForCommand(
      events,
      (command) => command.id === expiryCard.command.id && command.status === 'expired',
      'the expired command',
      expirySince
    )
    expect(
      expiredAfterMs >= CONFIRM_WINDOW_MS - 500 &&
        !laneMessages(events, MAIN_LANE).find((m) => m.id === codersNewest.id)?.isDeleted,
      `Expiry must come after 20 s and leave the message: ${JSON.stringify(expired)}`
    )
    pass(
      `A7 expiry: ${expired.phase} after ${(expiredAfterMs / 1000).toFixed(1)} s / strip "${expiryDone.command.message}"`
    )

    // 8. Manual Remove from chat (free): runs at once.
    phase('A8: manual Remove from chat on spam_bot #5')
    const manualTarget = byProvider(MAIN_LANE, 5)
    const manual = await request(ws, timeoutMs, 'liveChat.moderation.request', {
      operationId: randomUUID(),
      messageId: manualTarget.id,
      source: 'manual'
    })
    expect(
      manual.phase === 'removed' && manual.source === 'manual',
      `A manual removal runs at once: ${JSON.stringify(manual)}`
    )
    pass(`A8 manual removal on Premium: ${manual.outcome}`)
  } finally {
    pump.stop()
  }

  // 9. The report counts what the commands did.
  phase('A9: cohost.stop and the report')
  await request(ws, timeoutMs, 'captions.stop', {}).catch(() => {})
  const stopped = await request(ws, timeoutMs, 'cohost.stop', {})
  expect(stopped.status === 'off', `cohost.stop should report off: ${JSON.stringify(stopped)}`)
  const latest = await request(ws, timeoutMs, 'cohost.report.latest', {})
  const commands = latest?.report?.commands
  const expected = {
    highlighted: 2,
    cleared: 1,
    removed: 1,
    hiddenLocally: 1,
    cancelled: 1,
    expired: 1,
    failed: 0,
    notFound: 0
  }
  expect(
    latest?.sessionId === sessionId &&
      commands &&
      Object.entries(expected).every(([key, value]) => commands[key] === value),
    `The report should count every command once: ${JSON.stringify({ sessionId: latest?.sessionId, commands })}`
  )
  pass(`A9 report commands ${JSON.stringify(commands)}`)

  // 10. A voice removal left waiting when the backend dies.
  phase('A10: a voice removal waits for an answer, then the backend is killed')
  const survivor = laneMessages(events, MAIN_LANE).find((m) => m.id.endsWith(':fake-0'))
  const operationId = randomUUID()
  const waiting = await request(ws, timeoutMs, 'liveChat.moderation.request', {
    operationId,
    messageId: survivor.id,
    source: 'orcle-voice',
    reason: 'spam',
    confirmMode: 'confirm'
  })
  expect(
    waiting.phase === 'pending-confirm',
    `The voice removal should wait: ${JSON.stringify(waiting)}`
  )
  await backend.kill()
  pass('A10 the backend was killed with a removal pending-confirm')
  return { operationId, messageId: survivor.id }
}

// --- A'. Restart sweep and the kill switch ---------------------------------------

async function runRestartAndKillSwitchScenario(profile, pendingAtKill) {
  // The document's key stays `orcle` (plan 170 D22): the web serves it and older apps read it.
  serviceFlags.setDocument({ version: 1, orcle: { voiceCommands: false, remove: false } })
  const backend = await launchBackend(profile)
  const { ws, admin, events } = backend

  phase("A': the restart sweep")
  const operations = await request(ws, timeoutMs, 'liveChat.moderationOperations.list', {
    sessionId
  })
  const swept = operations.find((operation) => operation.operationId === pendingAtKill.operationId)
  expect(
    swept?.phase === 'cancelled' && swept.messageId === pendingAtKill.messageId,
    `The restart must cancel a removal that waited for an answer: ${JSON.stringify(swept)}`
  )
  expect(
    operations.length >= 6 && operations.every((operation) => operation.phase !== 'executing'),
    `Every operation should be listed and settled: ${JSON.stringify(operations.map((o) => [o.source, o.phase]))}`
  )
  pass(`A' restart sweep: ${swept.phase} ("${swept.outcome}")`)

  phase("A': the kill switch (service flags orcle.voiceCommands=false, remove=false)")
  const paused = await waitUntilAsync(
    async () => {
      const status = await request(ws, timeoutMs, 'cohost.status', {})
      return status.commandAvailability?.voiceCommands === 'paused' ? status : null
    },
    15_000,
    'the kill switch to arrive through the service flags'
  )
  expect(
    paused.commandAvailability.remove === 'paused' && serviceFlags.state.requests >= 1,
    `Both switches should read paused: ${JSON.stringify(paused.commandAvailability)}`
  )
  const killSessionId = `${sessionId}-killswitch`
  const lane = { ...MAIN_LANE, targetId: 'buddy-killswitch', count: 3 }
  await request(ws, timeoutMs, 'cohost.settings.set', {
    enabled: true,
    listen: true,
    autoHighlight: false,
    voiceHighlight: false
  })
  await request(ws, timeoutMs, 'liveChat.start', {
    sessionId: killSessionId,
    destinations: [
      { platform: lane.platform, targetId: lane.targetId, read: 'ready', write: 'ready' }
    ],
    fakes: [lane]
  })
  await request(ws, timeoutMs, 'captions.start', { language: 'en' })
  const started = await request(ws, timeoutMs, 'cohost.start', {
    sessionId: killSessionId,
    consentToProcessChat: true
  })
  expect(started.status === 'listening', `cohost.start: ${JSON.stringify(started)}`)
  const pump = startCaptionAudioPump({ ws: admin, request, captionFake })
  try {
    const messages = await waitUntil(
      () => {
        const list = laneMessages(events, lane)
        return list.length === lane.count ? list : null
      },
      15_000,
      'the kill-switch lane chat'
    )
    await waitUntil(() => captionFake.state.audioAppends > 0, 20_000, 'caption audio')
    const quietSince = Date.now()
    await say(events, ['Buddy, highlight the comment from coders X.'])
    // Buddy did hear it: the words reached its spotlight lane. Only the
    // command was switched off.
    await waitUntil(
      () =>
        fakeCohost.state.spotlightRequests.some(
          (record) =>
            record.at >= quietSince &&
            record.body?.transcript?.includes('highlight the comment from coders X')
        ),
      10_000,
      'Buddy hearing the paused command (its spotlight request)'
    )
    await sleep(Math.max(0, quietSince + KILL_SWITCH_QUIET_MS - Date.now()))
    const acted = events.list.filter(
      (entry) =>
        entry.at >= quietSince &&
        entry.event === 'cohost.state' &&
        (entry.payload?.command || entry.payload?.autoHighlight)
    )
    expect(
      acted.length === 0,
      `No command may act while voice commands are paused: ${JSON.stringify(acted.map((e) => e.payload.command ?? e.payload.autoHighlight))}`
    )
    const voice = await requestRaw(ws, 'liveChat.moderation.request', {
      operationId: randomUUID(),
      messageId: messages[0].id,
      source: 'orcle-voice',
      confirmMode: 'confirm'
    })
    expect(
      !voice.ok && voice.error?.code === 'disabled',
      `A voice removal must be refused while removals are paused: ${JSON.stringify(voice)}`
    )
    const manual = await request(ws, timeoutMs, 'liveChat.moderation.request', {
      operationId: randomUUID(),
      messageId: messages[1].id,
      source: 'manual'
    })
    expect(
      manual.phase === 'removed',
      `Manual removal is unaffected by the switch: ${JSON.stringify(manual)}`
    )
    pass(
      `A' kill switch: spoken command ignored for ${KILL_SWITCH_QUIET_MS / 1000} s, voice removal refused ` +
        `"${voice.error.code}", manual removal ${manual.phase}`
    )
  } finally {
    pump.stop()
    await request(ws, 5_000, 'captions.stop', {}).catch(() => {})
    await request(ws, 5_000, 'cohost.stop', {}).catch(() => {})
    await request(ws, 5_000, 'liveChat.stop', {}).catch(() => {})
  }
  await backend.stop()
}

// --- B. Basic --------------------------------------------------------------------

async function runBasicScenario(profile) {
  serviceFlags.setDocument({ version: 1 })
  const backend = await launchBackend(profile, { basic: true })
  const { ws, events } = backend
  phase('B: Basic account (VIDEORC_PREMIUM_FEATURES=0)')
  const basicSessionId = `${sessionId}-basic`
  const lane = { ...MAIN_LANE, targetId: 'buddy-basic', count: 3 }
  await request(ws, timeoutMs, 'cohost.settings.set', { enabled: true, listen: true })
  await request(ws, timeoutMs, 'liveChat.start', {
    sessionId: basicSessionId,
    destinations: [
      { platform: lane.platform, targetId: lane.targetId, read: 'ready', write: 'ready' }
    ],
    fakes: [lane]
  })
  const messages = await waitUntil(
    () => {
      const list = laneMessages(events, lane)
      return list.length === lane.count ? list : null
    },
    15_000,
    'the Basic lane chat'
  )
  const start = await requestRaw(ws, 'cohost.start', {
    sessionId: basicSessionId,
    consentToProcessChat: true
  })
  expect(
    !start.ok && start.error?.code === 'premium-required',
    `A Basic account must not start Buddy: ${JSON.stringify(start)}`
  )
  const voice = await requestRaw(ws, 'liveChat.moderation.request', {
    operationId: randomUUID(),
    messageId: messages[0].id,
    source: 'orcle-voice',
    confirmMode: 'confirm'
  })
  expect(
    !voice.ok && voice.error?.code === 'premium-required',
    `A Basic account gets no voice removal: ${JSON.stringify(voice)}`
  )
  const manual = await request(ws, timeoutMs, 'liveChat.moderation.request', {
    operationId: randomUUID(),
    messageId: messages[2].id,
    source: 'manual'
  })
  expect(manual.phase === 'removed', `Manual removal is free: ${JSON.stringify(manual)}`)
  const tombstone = await waitForEvent(
    events,
    'liveChat.message',
    (message) => message.id === messages[2].id && message.isDeleted === true,
    'the Basic manual tombstone',
    COMMAND_DEADLINE_MS
  )
  expect(
    tombstone.messageText === 'Removed by you',
    `The Basic removal should read "Removed by you": ${JSON.stringify(tombstone)}`
  )
  pass(
    `B Basic: cohost.start "${start.error.code}", voice removal "${voice.error.code}", manual Remove from chat ${manual.phase} ("${tombstone.messageText}")`
  )
  await request(ws, 5_000, 'liveChat.stop', {}).catch(() => {})
  await backend.stop()
}

// --- Backend lifecycle -----------------------------------------------------------

function createProfile(name) {
  const root = join(stateRoot, name)
  const appDataDir = join(root, 'app-data')
  mkdirSync(appDataDir, { recursive: true })
  const secretsPath = join(appDataDir, 'videorc-secrets.json')
  writeFileSync(
    secretsPath,
    JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
  )
  chmodSync(secretsPath, 0o600)
  return { root, appDataDir, secretsPath }
}

async function launchBackend(profile, { basic = false } = {}) {
  const env = { ...process.env }
  // The env override is downgrade-only (forces Basic). A developer shell must
  // not turn the Premium scenarios Basic, and only B asks for it.
  delete env.VIDEORC_PREMIUM_FEATURES
  if (basic) env.VIDEORC_PREMIUM_FEATURES = '0'
  const child = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...env,
        VIDEORC_API_BASE_URL: router.httpOrigin,
        VIDEORC_ENABLE_SMOKE_RPC: '1',
        // Debug-only caption seam: captions run without a microphone and take
        // injected audio (never in release).
        VIDEORC_CAPTION_CONTRACT_TEST: '1',
        VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE: '1',
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_APP_DATA_DIR: profile.appDataDir,
        VIDEORC_DATABASE_PATH: join(profile.appDataDir, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: profile.secretsPath,
        VIDEORC_SMOKE_STATE_DIR: profile.root
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let ws
  let admin
  let events
  const handle = {
    get ws() {
      return ws
    },
    get admin() {
      return admin
    },
    get events() {
      return events
    },
    async stop() {
      events?.close()
      ws?.close()
      admin?.close()
      await stopProcess(child).catch(() => {})
    },
    // A crash, not a shutdown: SIGKILL to the backend's own process group
    // (its recorded pid; devAppSpawnOptions makes it a group leader).
    async kill() {
      events?.close()
      ws?.close()
      admin?.close()
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      await exited
    }
  }
  launched.push(handle)
  const ready = await waitForBackendReady(child, timeoutMs)
  ws = await connectBackend({ ...ready, adminToken: undefined }, timeoutMs)
  admin = await connectBackend(
    { ...ready, token: ready.adminToken, adminToken: undefined },
    timeoutMs
  )
  events = collectEvents(ws)
  return handle
}

function waitForBackendReady(child, deadlineMs) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error('Backend did not print READY in time.')),
      deadlineMs
    )
    let stdout = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      try {
        finish(resolveReady, JSON.parse(line.slice('READY '.length)))
      } catch {
        finish(rejectReady, new Error('Backend printed an invalid READY payload.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (/ERROR|panicked/.test(line)) console.log(`[backend stderr] ${line}`)
      }
    })
    child.on('error', (error) => finish(rejectReady, error))
    child.on('exit', (code, signal) =>
      finish(rejectReady, new Error(`Backend exited before READY: code=${code} signal=${signal}`))
    )
  })
}

// --- Speech, events and waits ----------------------------------------------------

/** Speak: scripted realtime finals, each confirmed as a caption final. */
async function say(collection, texts) {
  for (const [index, text] of texts.entries()) {
    if (index > 0) await sleep(600)
    const since = Date.now()
    const reached = await captionFake.emitRealtimeFinal(text)
    expect(reached > 0, `No realtime caption client heard "${text}".`)
    await waitForEvent(
      collection,
      'captions.update',
      (update) => update.kind === 'final' && update.text === text,
      `the caption final "${text}"`,
      5_000,
      since
    )
  }
}

function waitForCommand(collection, predicate, label, since, deadlineMs = COMMAND_DEADLINE_MS) {
  return waitForEvent(
    collection,
    'cohost.state',
    (state) => state.sessionId === sessionId && state.command && predicate(state.command),
    label,
    deadlineMs,
    since
  ).then((entry) => ({ command: entry.payload.command, at: entry.at }))
}

function waitForOperation(
  collection,
  operationId,
  predicate,
  label,
  deadlineMs = COMMAND_DEADLINE_MS
) {
  return waitForEvent(
    collection,
    'liveChat.moderationOperation',
    (operation) => operation.operationId === operationId && predicate(operation),
    label,
    deadlineMs
  )
}

function laneMessages(collection, lane) {
  const byId = new Map()
  for (const entry of collection.list) {
    if (entry.event !== 'liveChat.message') continue
    const message = entry.payload
    if (message?.platform !== lane.platform || message.targetId !== lane.targetId) continue
    byId.set(message.id, message)
  }
  return [...byId.values()]
}

function collectEvents(ws) {
  const collection = { list: [], waiters: [] }
  const onMessage = (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (typeof parsed.event !== 'string') return
    const entry = { event: parsed.event, payload: parsed.payload, at: Date.now() }
    collection.list.push(entry)
    for (const waiter of [...collection.waiters]) waiter(entry)
  }
  ws.addEventListener('message', onMessage)
  collection.close = () => ws.removeEventListener('message', onMessage)
  return collection
}

// Resolves with the payload; `since` narrows to events at or after a time and
// then resolves with the whole entry ({ event, payload, at }).
function waitForEvent(collection, name, predicate, label, deadlineMs, since) {
  const matches = (entry) =>
    entry.event === name && (since === undefined || entry.at >= since) && predicate(entry.payload)
  const shape = (entry) => (since === undefined ? entry.payload : entry)
  const existing = collection.list.find(matches)
  if (existing) return Promise.resolve(shape(existing))
  return new Promise((resolveWait, rejectWait) => {
    const onEntry = (entry) => {
      if (!matches(entry)) return
      clearTimeout(timer)
      collection.waiters.splice(collection.waiters.indexOf(onEntry), 1)
      resolveWait(shape(entry))
    }
    const timer = setTimeout(() => {
      collection.waiters.splice(collection.waiters.indexOf(onEntry), 1)
      const lastCommand = [...collection.list]
        .reverse()
        .find((entry) => entry.event === 'cohost.state' && entry.payload?.command)
      rejectWait(
        new Error(
          `Timed out after ${deadlineMs}ms waiting for ${label}. Last command: ${JSON.stringify(lastCommand?.payload.command ?? null)}`
        )
      )
    }, deadlineMs)
    collection.waiters.push(onEntry)
  })
}

async function waitUntil(probe, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${deadlineMs}ms waiting for ${label}.`)
    await sleep(100)
  }
}

async function waitUntilAsync(probe, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${deadlineMs}ms waiting for ${label}.`)
    await sleep(250)
  }
}

/** Like `request`, but resolves the whole envelope so error codes are visible. */
function requestRaw(socket, method, params) {
  const id = `buddy-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      rejectRequest(new Error(`Timed out waiting for ${method}.`))
    }, timeoutMs)
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      resolveRequest(message)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function expect(condition, message) {
  if (!condition) throw new Error(`[buddy-smoke] ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// The desktop service flags (contract part D) from a local origin. The
// backend reads them once at startup (then every 30 minutes), so a scenario
// sets the document before it launches its backend.
async function startServiceFlagsServer(initialDocument) {
  const state = { document: initialDocument, requests: 0 }
  const server = createServer((req, res) => {
    req.resume()
    if (req.method !== 'GET' || !req.url?.startsWith('/api/desktop/service-flags')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
      return
    }
    state.requests += 1
    const body = JSON.stringify(state.document)
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      .end(body)
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const { port } = server.address()
  return {
    httpOrigin: `http://127.0.0.1:${port}`,
    state,
    setDocument(document) {
      state.document = document
      state.requests = 0
    },
    close() {
      return new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    }
  }
}
