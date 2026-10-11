// Plan 178 U6. Steps every live scenario shares, in the step-engine format.
// U9 scenarios (and U13's faults, which assumes a live stream) compose them:
//
//   steps: [...goLiveSteps({ destinationIds: ['youtube'] }), ...ownSteps, stopStreamStep()]

export const CARD_UP_DEADLINE_MS = 45_000

export function cardUpStep() {
  return {
    id: 'card-up',
    title: 'Test card',
    deadlineMs: CARD_UP_DEADLINE_MS,
    run: (ctx) =>
      ctx.waitFor(
        () => {
          const pulse = ctx.card.lastPulse()
          return pulse ? { audioState: pulse.audioState, visible: pulse.visible } : null
        },
        { label: 'test card pulse' }
      )
  }
}

/**
 * Opens the real Go Live dialog (remote streamStart always opens it, see
 * go-live-flow.ts), fills title (policy prefix first), description and
 * privacy, checks the destinations are exactly `destinationIds`, clicks Go
 * live and waits for the outcome.
 */
export function goLiveSteps({
  destinationIds = ['youtube'],
  description = 'Videorc live lab: an automated test stream.',
  titleSuffix = (ctx) => `${ctx.run.scenario} ${ctx.run.runId}`
} = {}) {
  return [
    cardUpStep(),
    {
      id: 'open-go-live',
      title: 'Open Go live',
      deadlineMs: 45_000,
      async run(ctx) {
        const sent = await ctx.remote.intent('streamStart')
        const dialog = await ctx.ui.waitForDialogOpen({ deadlineMs: 30_000 })
        return {
          accepted: sent.accepted,
          destinations: dialog.destinations.map((row) => row.targetId)
        }
      },
      expect: (evidence) => evidence.accepted || 'streamStart was not accepted'
    },
    {
      id: 'fill-details',
      title: 'Stream details',
      deadlineMs: 20_000,
      async run(ctx) {
        const dialog = await ctx.ui.fillGoLive({
          title: `${ctx.run.titlePrefix}: ${titleSuffix(ctx)}`,
          description,
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
        const dialog = await ctx.ui.ensureDestinations(destinationIds)
        return { destinations: dialog.destinations }
      },
      expect: (evidence) =>
        evidence.destinations.every((row) => row.ready) || 'a destination is not ready'
    },
    {
      id: 'go-live',
      title: 'Go live',
      deadlineMs: 120_000,
      async run(ctx) {
        await ctx.ui.confirmGoLive()
        return ctx.ui.readGoLiveOutcome({ deadlineMs: 100_000 })
      },
      expect: (outcome) =>
        outcome.outcome === 'live' || `${outcome.outcome}: ${outcome.reason ?? ''}`
    }
  ]
}

/** Ends the stream through remote control and waits for idle. */
export function stopStreamStep({ id = 'stop', extra = async () => ({}) } = {}) {
  return {
    id,
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
      return { ok: sent.ok, ...(await extra(ctx)) }
    },
    expect: (evidence) => evidence.ok || 'streamStop failed'
  }
}
