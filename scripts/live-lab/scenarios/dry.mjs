import { stat } from 'node:fs/promises'

import { defineScenario } from '../lib/step-engine.mjs'

// Plan 178 U6 (plan 176 L2 done-when). The harness end to end with no
// YouTube: the horizontal YouTube card is seeded to a loopback RTMP sink in
// a profile of its own (profile-local), the real Go Live dialog is clicked
// over CDP, one scene switch goes through remote control, and the stream
// stops. destination 'local-sink' makes the seed refuse anything that is not
// 127.0.0.1, and the dialog driver refuses any destination it did not seed.

const LIVE_LEG = (line) => line?.legs?.some((leg) => leg.state === 'live' && leg.bitrateKbps > 0)

async function sinkBytes(ctx) {
  try {
    return (await stat(ctx.sink.outputPath)).size
  } catch {
    return 0
  }
}

export default defineScenario({
  name: 'dry',
  plannedMinutes: 10,
  estimatedQuotaUnits: 0,
  usesBundledClient: false,
  destination: 'local-sink',
  steps: [
    {
      id: 'card-up',
      title: 'Test card',
      deadlineMs: 45_000,
      run: (ctx) =>
        ctx.waitFor(
          () => {
            const pulse = ctx.card.lastPulse()
            return pulse ? { audioState: pulse.audioState, visible: pulse.visible } : null
          },
          { label: 'test card pulse' }
        )
    },
    {
      id: 'open-go-live',
      title: 'Open Go live',
      deadlineMs: 45_000,
      async run(ctx) {
        // Remote streamStart always opens the dialog (go-live-flow.ts); the
        // ack says to finish on the computer, which is the CDP click below.
        const sent = await ctx.remote.intent('streamStart')
        const dialog = await ctx.ui.waitForDialogOpen({ deadlineMs: 30_000 })
        return { accepted: sent.accepted, destinations: dialog.destinations.map((row) => row.targetId) }
      },
      expect: (evidence) => evidence.accepted || 'streamStart was not accepted'
    },
    {
      id: 'fill-details',
      title: 'Stream details',
      deadlineMs: 20_000,
      async run(ctx) {
        const title = `${ctx.run.titlePrefix}: dry ${ctx.run.runId}`
        const dialog = await ctx.ui.fillGoLive({
          title,
          description: 'Live lab dry run to a local RTMP sink. Nothing is sent to YouTube.',
          privacy: ctx.run.privacy,
          titlePrefix: ctx.run.titlePrefix
        })
        return { title: dialog.title, privacy: dialog.privacy }
      }
    },
    {
      id: 'destinations',
      title: 'Destinations',
      deadlineMs: 20_000,
      async run(ctx) {
        const dialog = await ctx.ui.ensureDestinations(['youtube'])
        return { destinations: dialog.destinations }
      },
      expect: (evidence) =>
        evidence.destinations.every((row) => row.ready) || 'the sink destination is not ready'
    },
    {
      id: 'go-live',
      title: 'Go live',
      deadlineMs: 120_000,
      async run(ctx) {
        await ctx.ui.confirmGoLive()
        return ctx.ui.readGoLiveOutcome({ deadlineMs: 100_000 })
      },
      expect: (outcome) => outcome.outcome === 'live' || `${outcome.outcome}: ${outcome.reason ?? ''}`
    },
    {
      id: 'sink-receives',
      title: 'Sink receives',
      deadlineMs: 60_000,
      async run(ctx) {
        const line = await ctx.waitFor(() => (LIVE_LEG(ctx.observe.latestJournal()) ? ctx.observe.latestJournal() : null), {
          label: 'a journal sample with a live leg'
        })
        return { bitrateKbps: line.legs.map((leg) => leg.bitrateKbps), sinkBytes: await sinkBytes(ctx) }
      },
      expect: (evidence) => evidence.sinkBytes > 0 || 'the local sink received no bytes'
    },
    {
      id: 'scene-switch',
      title: 'Scene switch',
      sceneId: 1,
      deadlineMs: 45_000,
      async run(ctx) {
        const forward = await ctx.remote.intent('sceneApply', { layoutPreset: 'screen-camera' })
        await ctx.waitFor(() => ctx.remote.state()?.layoutPreset === 'screen-camera', {
          deadlineMs: 15_000,
          label: 'scene screen-camera'
        })
        const back = await ctx.remote.intent('sceneApply', { layoutPreset: 'screen-only' })
        await ctx.waitFor(() => ctx.remote.state()?.layoutPreset === 'screen-only', {
          deadlineMs: 15_000,
          label: 'scene screen-only'
        })
        return { forward: forward.ok, back: back.ok, forwardMessage: forward.message, backMessage: back.message }
      },
      expect: (evidence) => (evidence.forward && evidence.back) || 'a sceneApply was refused'
    },
    {
      id: 'live-after-switch',
      title: 'Still live',
      deadlineMs: 30_000,
      async run(ctx) {
        const since = Date.now()
        const line = await ctx.waitFor(
          () => {
            const latest = ctx.observe.latestJournal()
            return latest && latest.tsMs >= since && latest.state === 'live' && LIVE_LEG(latest) ? latest : null
          },
          { label: 'a live journal sample after the switch' }
        )
        return { state: line.state, droppedFrames: line.legs.map((leg) => leg.droppedFrames) }
      }
    },
    {
      id: 'stop',
      title: 'Stop',
      deadlineMs: 60_000,
      async run(ctx) {
        const sent = await ctx.remote.intent('streamStop')
        await ctx.waitFor(
          () => {
            const state = ctx.remote.state()
            return state && !state.sessionActive && state.sessionState === 'idle'
          },
          { deadlineMs: 45_000, label: 'session idle after streamStop' }
        )
        return { ok: sent.ok, sinkBytes: await sinkBytes(ctx) }
      },
      expect: (evidence) => (evidence.ok && evidence.sinkBytes > 0) || 'streamStop failed or the sink got nothing'
    }
  ]
})
