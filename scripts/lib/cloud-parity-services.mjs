/** Plan 249 S18 `services` acceptance runner. Heavy: never import it from a
 * unit test. It drives the real dev app over the managed fake web and the
 * local fake YouTube API: a room Go Live attaches comments to the show, the
 * host is killed while chat keeps arriving, a relaunch + Resume reattaches the
 * same readers with their history, a leg fails, and a remote End (state the
 * web sends, not an RPC from this computer) releases them. No real provider,
 * credential, chat send, broadcast or paid call is ever reached.
 *
 * Then `assertServicesContinuity` judges the evidence. Focused fake-provider
 * Rust tests for what a single app cannot show here (owner replacement, X
 * reattach, stale End vs successor, durable reply ids, a process killed
 * between consuming a command and planning its reply) run first.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { managedHarness, OUTPUT, waitFor, holdFor } from './cloud-managed-smoke.mjs'
import {
  assertServicesContinuity,
  attributeReplies,
  replyAuthor,
  SERVICES_REPLY as REPLY,
  SERVICES_YOUTUBE_TARGET as YOUTUBE_TARGET
} from './cloud-parity-services-contract.mjs'

/** Fake-provider unit tests for the S18 decisions (source-level evidence). */
export const SERVICES_RUST_FILTERS = Object.freeze([
  'cloud_services::tests',
  'live_chat::tests::a_resume_keeps_history_dedupe_chatters_and_the_history_fence',
  'live_chat::tests::a_relaunch_resume_seeds_dedupe_from_persisted_history_only_for_its_show',
  'buddy_act::tests::a_live_room_reads_live_for_the_planner_and_the_spoken_stop',
  'chat_commands::tests::reply_operations_are_stable_per_trigger_destination_and_part',
  'chat_commands::tests::the_restart_checkpoint_',
  'chat_commands::tests::a_command_consumed_but_never_planned_is_answered_once_after_a_relaunch',
  'chat_commands::tests::an_interrupted_reply_is_reported_unknown_and_a_stale_command_expires'
])

function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Services fixture failed: ${command}, exit ${code}, signal ${signal}`))
    })
  })
}

const revision = (cwd) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()

export async function runServices({ desktopRoot, webRoot }) {
  await run(desktopRoot, process.execPath, [
    '--test',
    'scripts/lib/cloud-parity-services-contract.test.mjs'
  ])
  for (const filter of SERVICES_RUST_FILTERS)
    await run(desktopRoot, 'cargo', ['test', '-p', 'videorc-backend', filter])

  const h = await managedHarness('talk', 1, { youtube: true })
  const output = join(h.root, 'parity')
  mkdirSync(output, { recursive: true })
  const report = {
    slice: 'S18',
    case: 'services',
    revisions: { desktop: revision(desktopRoot), web: revision(webRoot) },
    steps: []
  }
  const step = (name, detail = {}) => report.steps.push({ name, atMs: Date.now(), ...detail })
  const writeReport = () =>
    writeFileSync(join(output, 'services.json'), JSON.stringify(report, null, 2) + '\n')
  const owner = 'host'
  const triggers = []
  const youtube = () => h.youtube
  const ask = (author) => {
    const message = youtube().postChat('!parity', author)
    triggers.push({ id: message.id, author })
    return message
  }
  const replies = (author) =>
    youtube().chat.sent.filter(
      (m) =>
        m.snippet.textMessageDetails.messageText.includes(REPLY) &&
        replyAuthor(m.snippet.textMessageDetails.messageText) === author
    ).length
  const chat = () => h.rpc('liveChat.status')
  const showsAll = async (ids) => {
    const snapshot = await chat()
    const have = new Set(snapshot.messages.map((m) => m.providerMessageId))
    return snapshot.sessionId === h.showId && ids.every((id) => have.has(id))
  }
  try {
    writeReport()
    await h.destinations(1)
    await h.launch()
    await h.addYouTube()
    await h.rpc('chatCommands.save', {
      name: 'parity',
      description: 'Plan 249 S18 services',
      reply: REPLY,
      enabled: true
    })
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Plan 249 services',
      platforms: []
    })
    h.showId = opened.show.id
    await h.status((s) => s.room?.client === 'connected', 'desktop publisher joins')
    // The renderer's own Go Live prepares the fake YouTube broadcast and hands
    // the room its destinations, as a streamer's click does.
    await h.configureStudio()
    await h.eval('await window.__videorcSmokeScenePresets.start(); return true')
    await waitFor(
      () => h.eval('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
      'Go Live confirmation'
    )
    await h.eval('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
    await h.status((s) => s.room?.live, 'the room is on air', 60000)
    await waitFor(
      async () => {
        const snapshot = await chat()
        return (
          snapshot.sessionId === h.showId &&
          snapshot.providers.some((p) => p.platform === 'youtube' && p.state === 'connected')
        )
      },
      'YouTube comments attach to the show',
      45000
    )
    step('live', { showId: '(show)' })

    const hello = youtube().postChat('hello before resume', 'viewer_a')
    ask('viewer_b')
    await waitFor(() => showsAll([hello.id]), 'chat reaches the show transcript')
    await waitFor(() => replies('viewer_b') === 1, 'the command is answered once')
    step('answered-before-resume')

    // Kill the host; relaunch; chat arrives while nothing reads it; Resume.
    await h.kill()
    await h.launch()
    await h.status((s) => s.show?.id === h.showId, 'the relaunched app holds the show', 45000)
    const away = youtube().postChat('hello while detached', 'viewer_c')
    ask('viewer_d')
    await h.rpc('cloud.room.resume')
    await h.status((s) => s.room?.client === 'connected', 'host reconnected')
    await waitFor(
      () => showsAll([hello.id, away.id]),
      'Resume reattaches with history and the gap',
      45000
    )
    await waitFor(() => replies('viewer_d') === 1, 'the gap command is answered once', 30000)
    // The provider redelivers its whole backlog to a fresh reader: nothing
    // may be answered, greeted or delivered twice.
    await holdFor(
      () => replies('viewer_b') === 1 && replies('viewer_d') === 1,
      'no duplicate reply after the redelivery',
      8000
    )
    // Every viewer row (the streamer's own reply echoes are not viewers').
    const viewerRows = () =>
      youtube().chat.messages.filter((m) => m.authorDetails?.displayName !== 'videorc_streamer')
    await waitFor(
      () => showsAll(viewerRows().map((m) => m.id)),
      'every viewer row is in the transcript once'
    )
    const resumed = await chat()
    step('resumed', { providers: resumed.providers.map((p) => [p.platform, p.state]) })

    // A failed leg reaches the desktop as the actual destination fact.
    h.web.hooks.failLeg(h.showId, YOUTUBE_TARGET)
    await h.status(
      (s) => s.legs?.some((l) => l.targetId === YOUTUBE_TARGET && l.state === 'failed'),
      'the failed cloud leg reaches the desktop'
    )
    step('leg-failed')

    // Remote End: the web confirms the interval ended (no RPC from here).
    const endedAt = new Date().toISOString()
    h.web.hooks.patch(h.showId, (state) => {
      state.legs = []
      state.liveInterval = {
        id: 'services-interval',
        requestedAt: endedAt,
        endedAt
      }
    })
    await waitFor(
      async () => (await chat()).sessionId !== h.showId,
      'a remote End releases only this show’s readers',
      30000
    )
    const ended = await chat()
    const late = ask('viewer_f')
    await holdFor(() => replies('viewer_f') === 0, 'no reader answers after the remote End', 6000)
    step('remote-end', { lateTrigger: late.id })

    const evidence = {
      providerMessages: viewerRows()
        .filter((m) => m.id !== late.id)
        .map((m) => ({ id: m.id })),
      transcript: resumed.messages.map((m) => ({ id: m.providerMessageId })),
      commandReplies: attributeReplies(youtube().chat.sent, triggers, owner),
      expectedReplies: triggers
        .filter((t) => t.id !== late.id)
        .map((t) => ({ triggerId: t.id, destinationId: YOUTUBE_TARGET })),
      // Sidekick is not started here (its AI needs Premium and a paid call);
      // its failed-leg guard and live lock are covered by SERVICES_RUST_FILTERS.
      automaticSends: [],
      failedDestinations: [YOUTUBE_TARGET],
      readers: ended.providers.map((p) => ({
        owner,
        destinationId: p.id,
        active: !['ended', 'disabled', 'unsupported', 'failed'].includes(p.state)
      })),
      currentOwner: owner,
      afterEndReplies: replies('viewer_f')
    }
    report.evidence = evidence
    assertServicesContinuity(evidence)
    report.result = 'passed'
  } catch (error) {
    report.result = 'failed'
    report.error = String(error?.stack ?? error)
    throw error
  } finally {
    writeReport()
    await h.close?.()
  }
  return { output }
}
