import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import {
  chatArrivals,
  liveHoldStep,
  liveSampleStep,
  needsEyes,
  outputProfileStep,
  recordFeature,
  sceneSwitchStep,
  takeoverSteps,
  vodStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 L6 release suite (plan 178 U15): 20 min, Unlisted, on the
// candidate: first light 1080p30, 5 chat messages both ways, one scene
// switch, one takeover, one comment highlight, stop, VOD check. The OAuth Go
// Live on the BUNDLED client (about 300 shared units) runs only when the
// owner's policy raises quota.bundledClientMaxUnitsPerDay; with the cap at 0
// that step is skipped with the reason and the suite stays on manual RTMP.

const MIN = 60_000

const releaseChatSteps = () => [
  {
    id: 'chat-five',
    title: 'Five viewer messages',
    deadlineMs: 8 * MIN,
    onFail: 'continue',
    async run(ctx) {
      if (!ctx.viewer || !ctx.observer)
        return { skipped: true, reason: 'no viewer bot or observer' }
      const liveChatId = await ctx.waitFor(() => ctx.observer.liveChatId(), {
        deadlineMs: 5 * MIN,
        label: 'liveChatId from the observer'
      })
      const sent = []
      for (let index = 1; index <= 5; index += 1) {
        if (index > 1) {
          const until = Date.now() + (Number(ctx.params?.slowModeSeconds) || 30) * 1000 + 1500
          await ctx
            .waitFor(() => Date.now() >= until || null, {
              deadlineMs: 60_000,
              label: 'slow mode spacing'
            })
            .catch(() => null)
        }
        const text = `[lab ${ctx.run.runId}] release check ${index} of 5`
        const result = await ctx.viewer.send(liveChatId, text)
        sent.push({ kind: `release-${index}`, text, sentAt: result.sentAt, id: result.id })
      }
      ctx.releaseChat = sent
      return { sent: sent.length }
    }
  },
  {
    id: 'chat-arrival',
    title: 'Messages arrive',
    deadlineMs: 3 * MIN,
    async run(ctx) {
      const sent = ctx.releaseChat ?? []
      if (sent.length === 0) return { skipped: true, reason: 'nothing was sent' }
      const arrivals = await ctx
        .waitFor(
          () => {
            const now = chatArrivals(sent, ctx.observe.featureEvents('chat'))
            return now.every((entry) => entry.arrived) ? now : null
          },
          { deadlineMs: 2 * MIN, label: 'every release message in the app' }
        )
        .catch(() => chatArrivals(sent, ctx.observe.featureEvents('chat')))
      ctx.releaseArrivals = arrivals
      const missing = arrivals.filter((entry) => !entry.arrived).map((entry) => entry.kind)
      await recordFeature(ctx, {
        id: 'chat-arrival',
        kind: 'chat-arrival',
        sent: sent.length,
        arrived: sent.length - missing.length,
        missing
      })
      return { sent: sent.length, missing }
    },
    expect: (evidence) =>
      evidence.missing.length === 0 || `never arrived: ${evidence.missing.join(', ')}`
  },
  {
    id: 'comment-highlight',
    title: 'Comment on stream',
    sceneId: 9,
    deadlineMs: 2 * MIN,
    onFail: 'continue',
    async run(ctx) {
      const target = (ctx.releaseArrivals ?? []).find((entry) => entry.arrived)
      if (!target) return { skipped: true, reason: 'no arrived message to put on stream' }
      const sinceMs = Date.now()
      const sent = await ctx.remote.intent('commentHighlight', { messageId: target.appMessageId })
      if (!sent.ok) return { ok: false, message: sent.message }
      const live = await ctx.waitFor(
        () =>
          ctx.observe
            .featureEvents('highlight')
            .find((event) => Date.parse(event.ts) >= sinceMs && event.phase === 'live') ?? null,
        { deadlineMs: 45_000, label: 'highlight live' }
      )
      await recordFeature(ctx, {
        id: 'comment-highlight',
        kind: 'highlight',
        via: 'click',
        at: live.ts
      })
      await needsEyes(ctx, {
        id: 'highlight-card-look',
        question: 'Does the highlight card look right on the stream?',
        frameHint: 'comment-highlight'
      })
      return { ok: true }
    },
    expect: (evidence) => evidence.ok || `commentHighlight refused: ${evidence.message ?? ''}`
  }
]

export default defineScenario({
  name: 'release',
  plannedMinutes: 25,
  // 5 viewer sends (250) + observer polls; the bundled client is not lab quota.
  estimatedQuotaUnits: 250 + 80,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    outputProfileStep(),
    ...goLiveSteps({ description: 'Videorc live lab, release suite: an automated test stream.' }),
    liveSampleStep(),
    youtubeHealthStep(),
    ...releaseChatSteps(),
    sceneSwitchStep({ id: 'scene-screen-camera', preset: 'screen-camera' }),
    sceneSwitchStep({ id: 'scene-screen-only', preset: 'screen-only' }),
    ...takeoverSteps({ holdMinutes: 1 }),
    liveHoldStep({ id: 'hold-live', minutes: 5 }),
    stopStreamStep(),
    vodStep(),
    {
      id: 'bundled-oauth-golive',
      title: 'Bundled client Go Live',
      deadlineMs: 10_000,
      async run(ctx) {
        const cap = ctx.policy?.quota?.bundledClientMaxUnitsPerDay ?? 0
        if (cap <= 0) {
          ctx.log('bundled-oauth-golive: skipped (policy quota.bundledClientMaxUnitsPerDay is 0)')
          return { skipped: true, reason: 'policy quota.bundledClientMaxUnitsPerDay is 0' }
        }
        // The bundled-client path needs a run launched without the lab client
        // override and a scenario flagged usesBundledClient (plan 178 U15).
        await needsEyes(ctx, {
          id: 'bundled-client-run',
          question: `The policy allows ${cap} bundled units: run the oauth-golive scenario with usesBundledClient (U15) on this candidate.`
        })
        return { skipped: true, reason: 'bundled-client Go Live runs as its own U15 scenario' }
      }
    }
  ]
})
