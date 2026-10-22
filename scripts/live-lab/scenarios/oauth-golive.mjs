import { cardUpStep, stopStreamStep } from '../lib/common-steps.mjs'
import {
  liveHoldStep,
  liveSampleStep,
  needsEyes,
  recordFeature,
  vodStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite B (plan 178 U9, run by U14). Go Live through the app's own
// YouTube connection on the lab Google project (usesLabYoutubeClient passes
// VIDEORC_YOUTUBE_CLIENT_ID/_SECRET at launch): the broadcast is created,
// waits for ingest, goes live, chat attaches; stop completes it; a second Go
// Live reuses the stream. The YouTube account is connected once by the owner
// in the lab profile (U3 visit); without it every step here is skipped with
// that reason, never failed. Params: { oauthTargetId: 'youtube-oauth' }.

const MIN = 60_000

function skipWithout(ctx, id) {
  if (!ctx.oauthMissing) return null
  ctx.log(`${id}: skipped (${ctx.oauthMissing})`)
  return { skipped: true, reason: ctx.oauthMissing }
}

function oauthGoLive(suffix) {
  return [
    {
      id: `open-go-live${suffix}`,
      title: 'Open Go live',
      deadlineMs: 45_000,
      async run(ctx) {
        const skip = skipWithout(ctx, `open-go-live${suffix}`)
        if (skip) return skip
        const sent = await ctx.remote.intent('streamStart')
        const dialog = await ctx.ui.waitForDialogOpen({ deadlineMs: 30_000 })
        const wanted = ctx.params?.oauthTargetId ?? 'youtube-oauth'
        const row = (dialog.destinations ?? []).find((entry) => entry.targetId === wanted)
        if (!row) {
          ctx.oauthMissing = `no OAuth YouTube destination "${wanted}" in the lab profile (owner connects once, plan 178 U14)`
          await ctx.ui.cancelGoLive()
          await needsEyes(ctx, {
            id: 'oauth-account',
            question:
              'Connect the lab YouTube account in the lab profile once (Settings, YouTube) so suite B can run.'
          })
          return { skipped: true, reason: ctx.oauthMissing }
        }
        return { accepted: sent.accepted, ready: row.ready }
      },
      expect: (evidence) => evidence.accepted || 'streamStart was not accepted'
    },
    {
      id: `fill-details${suffix}`,
      title: 'Stream details',
      deadlineMs: 20_000,
      async run(ctx) {
        const skip = skipWithout(ctx, `fill-details${suffix}`)
        if (skip) return skip
        const dialog = await ctx.ui.fillGoLive({
          title: `${ctx.run.titlePrefix}: oauth go live ${ctx.run.runId}`,
          description: 'Videorc live lab, OAuth Go Live on the lab Google project.',
          privacy: ctx.run.privacy,
          titlePrefix: ctx.run.titlePrefix
        })
        return { title: dialog.title, privacy: dialog.privacy }
      }
    },
    {
      id: `destinations${suffix}`,
      title: 'Destinations',
      deadlineMs: 20_000,
      async run(ctx) {
        const skip = skipWithout(ctx, `destinations${suffix}`)
        if (skip) return skip
        const dialog = await ctx.ui.ensureDestinations([
          ctx.params?.oauthTargetId ?? 'youtube-oauth'
        ])
        return { destinations: dialog.destinations }
      },
      expect: (evidence) =>
        evidence.destinations.every((row) => row.ready) || 'the OAuth destination is not ready'
    },
    {
      id: `go-live${suffix}`,
      title: 'Go live',
      deadlineMs: 180_000,
      async run(ctx) {
        const skip = skipWithout(ctx, `go-live${suffix}`)
        if (skip) return skip
        const confirmedAt = Date.now()
        await ctx.ui.confirmGoLive()
        const outcome = await ctx.ui.readGoLiveOutcome({ deadlineMs: 160_000 })
        await recordFeature(ctx, {
          id: `go-live${suffix}`,
          kind: 'go-live',
          via: 'oauth',
          liveAfterMs: Date.now() - confirmedAt
        })
        return { ...outcome, liveAfterMs: Date.now() - confirmedAt }
      },
      expect: (outcome) =>
        outcome.outcome === 'live' || `${outcome.outcome}: ${outcome.reason ?? ''}`
    }
  ]
}

function guarded(step) {
  return {
    ...step,
    async run(ctx) {
      return skipWithout(ctx, step.id) ?? step.run(ctx)
    }
  }
}

export default defineScenario({
  name: 'oauth-golive',
  plannedMinutes: 25,
  // Two OAuth Go Lives (about 300 units each on the lab project) plus the observer.
  estimatedQuotaUnits: 700,
  usesBundledClient: false,
  usesLabYoutubeClient: true,
  destination: 'youtube',
  steps: [
    cardUpStep(),
    ...oauthGoLive(''),
    guarded(liveSampleStep()),
    guarded(youtubeHealthStep()),
    guarded(liveHoldStep({ id: 'hold-live', minutes: 3 })),
    guarded(stopStreamStep()),
    guarded(vodStep()),
    ...oauthGoLive('-again'),
    guarded(liveSampleStep({ id: 'live-sample-again' })),
    guarded(stopStreamStep({ id: 'stop-again' })),
    guarded(vodStep({ id: 'vod-again' })),
    {
      id: 'quota-counter',
      title: 'Quota counter',
      deadlineMs: 10_000,
      async run(ctx) {
        const skip = skipWithout(ctx, 'quota-counter')
        if (skip) return skip
        await needsEyes(ctx, {
          id: 'oauth-quota-console',
          question:
            "Does the lab project's Cloud Console quota graph match this run's quota.json (about 600 units for two Go Lives)?"
        })
        return { recorded: true }
      }
    }
  ]
})
