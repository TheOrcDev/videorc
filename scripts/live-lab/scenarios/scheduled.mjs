import { cardUpStep, stopStreamStep } from '../lib/common-steps.mjs'
import { liveSampleStep, needsEyes, vodStep } from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite F, scheduled event (plan 178 U9, run by U14): the app
// creates a scheduled YouTube event and goes live into it (plan 045). That
// needs the lab OAuth account connected in the lab profile and a destination
// bound to the event. Params: { scheduledTargetId: 'youtube-oauth' }. Without
// the destination every step is skipped with the reason (never failed).

function skipWithout(ctx, id) {
  if (!ctx.scheduledMissing) return null
  ctx.log(`${id}: skipped (${ctx.scheduledMissing})`)
  return { skipped: true, reason: ctx.scheduledMissing }
}

const guarded = (step) => ({
  ...step,
  async run(ctx) {
    return skipWithout(ctx, step.id) ?? step.run(ctx)
  }
})

export default defineScenario({
  name: 'scheduled',
  plannedMinutes: 20,
  estimatedQuotaUnits: 500,
  usesBundledClient: false,
  usesLabYoutubeClient: true,
  destination: 'youtube',
  steps: [
    cardUpStep(),
    {
      id: 'scheduled-destination',
      title: 'Scheduled event',
      deadlineMs: 60_000,
      async run(ctx) {
        const wanted = ctx.params?.scheduledTargetId ?? 'youtube-oauth'
        await ctx.remote.intent('streamStart')
        const dialog = await ctx.ui.waitForDialogOpen({ deadlineMs: 30_000 })
        const row = (dialog.destinations ?? []).find((entry) => entry.targetId === wanted)
        if (!row) {
          ctx.scheduledMissing = `no OAuth destination "${wanted}" with a scheduled event in the lab profile (plan 178 U14)`
          await ctx.ui.cancelGoLive()
          await needsEyes(ctx, {
            id: 'scheduled-event-setup',
            question:
              'Create a scheduled YouTube event in the lab profile (Go live, Schedule) on the lab account so suite F can go live into it.'
          })
          return { skipped: true, reason: ctx.scheduledMissing }
        }
        return { ready: row.ready }
      },
      expect: (evidence) => evidence.ready || 'the scheduled destination is not ready'
    },
    guarded({
      id: 'fill-details',
      title: 'Stream details',
      deadlineMs: 20_000,
      async run(ctx) {
        const dialog = await ctx.ui.fillGoLive({
          title: `${ctx.run.titlePrefix}: scheduled event ${ctx.run.runId}`,
          description: 'Videorc live lab, going live into a scheduled event.',
          privacy: ctx.run.privacy,
          titlePrefix: ctx.run.titlePrefix
        })
        return { title: dialog.title }
      }
    }),
    guarded({
      id: 'destinations',
      title: 'Destinations',
      deadlineMs: 20_000,
      async run(ctx) {
        const dialog = await ctx.ui.ensureDestinations([
          ctx.params?.scheduledTargetId ?? 'youtube-oauth'
        ])
        return { destinations: dialog.destinations }
      },
      expect: (evidence) =>
        evidence.destinations.every((row) => row.ready) || 'a destination is not ready'
    }),
    guarded({
      id: 'go-live',
      title: 'Go live',
      deadlineMs: 180_000,
      async run(ctx) {
        await ctx.ui.confirmGoLive()
        return ctx.ui.readGoLiveOutcome({ deadlineMs: 160_000 })
      },
      expect: (outcome) =>
        outcome.outcome === 'live' || `${outcome.outcome}: ${outcome.reason ?? ''}`
    }),
    guarded(liveSampleStep()),
    guarded(stopStreamStep()),
    guarded(vodStep())
  ]
})
