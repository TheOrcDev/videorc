import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import {
  captionsStep,
  chatArrivals,
  clipMarkStep,
  clipPullStep,
  liveSampleStep,
  micToggleSteps,
  needsEyes,
  recordFeature,
  recordWhileLiveSteps,
  sceneSwitchStep,
  systemAudioToggleSteps,
  takeoverSteps,
  vodStep,
  voiceCommandStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite D (plan 178 U9): scene switches, takeover BRB, record while
// live (plan 157 files beside the recording), clip mark while recording, mic
// and system audio toggles, captions from scripted speech (077/175: skipped
// while captions are dark), a Buddy voice command (140: skipped while Buddy
// is not listening; destructive phrases need params.allowDestructiveVoice),
// one viewer message put on stream (074/095). Camera stays off (policy).
// Buddy's reaction to chat and speech (164/168/172) is a needs-eyes item.

const MIN = 60_000

function singleCommentHighlightSteps() {
  return [
    {
      id: 'comment-send',
      title: 'One viewer message',
      deadlineMs: 6 * MIN,
      onFail: 'continue',
      async run(ctx) {
        if (!ctx.viewer || !ctx.observer)
          return { skipped: true, reason: 'no viewer bot or observer' }
        const liveChatId = await ctx.waitFor(() => ctx.observer.liveChatId(), {
          deadlineMs: 5 * MIN,
          label: 'liveChatId from the observer'
        })
        const text = `[lab ${ctx.run.runId}] put this comment on stream`
        const sent = await ctx.viewer.send(liveChatId, text)
        ctx.featureComment = [{ kind: 'plain', text, sentAt: sent.sentAt, id: sent.id }]
        return { sent: true }
      }
    },
    {
      id: 'comment-highlight',
      title: 'Comment on stream',
      sceneId: 9,
      deadlineMs: 3 * MIN,
      onFail: 'continue',
      async run(ctx) {
        if (!ctx.featureComment) return { skipped: true, reason: 'no viewer message was sent' }
        const arrival = await ctx.waitFor(
          () => {
            const [entry] = chatArrivals(ctx.featureComment, ctx.observe.featureEvents('chat'))
            return entry?.arrived ? entry : null
          },
          { deadlineMs: 2 * MIN, label: 'the viewer message in the app' }
        )
        const sinceMs = Date.now()
        const sent = await ctx.remote.intent('commentHighlight', {
          messageId: arrival.appMessageId
        })
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
        return { ok: true, latencyMs: arrival.latencyMs }
      },
      expect: (evidence) => evidence.ok || `commentHighlight refused: ${evidence.message ?? ''}`
    }
  ]
}

export default defineScenario({
  name: 'features',
  plannedMinutes: 35,
  // One viewer send (50) plus the observer for about 30 min.
  estimatedQuotaUnits: 50 + 80,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    ...goLiveSteps({
      description: 'Videorc live lab, on-stream features: an automated test stream.'
    }),
    liveSampleStep(),
    sceneSwitchStep({ id: 'scene-screen-camera', preset: 'screen-camera' }),
    sceneSwitchStep({ id: 'scene-side-by-side', preset: 'side-by-side' }),
    sceneSwitchStep({ id: 'scene-screen-only', preset: 'screen-only' }),
    ...takeoverSteps({ holdMinutes: 1 }),
    recordWhileLiveSteps({ minutes: 2 })[0],
    clipMarkStep(),
    ...recordWhileLiveSteps({ minutes: 2 }).slice(1),
    ...micToggleSteps(),
    ...systemAudioToggleSteps(),
    captionsStep(),
    voiceCommandStep({ id: 'voice-highlight', phraseId: 'highlight-last' }),
    ...singleCommentHighlightSteps(),
    {
      id: 'buddy-look',
      title: 'Buddy',
      deadlineMs: 10_000,
      async run(ctx) {
        await needsEyes(ctx, {
          id: 'buddy-reacts',
          question:
            'Did Buddy react to the viewer message and the scripted speech (plans 164, 168, 172)?'
        })
        return { recorded: true }
      }
    },
    clipPullStep({ id: 'clip-features', seconds: 120 }),
    stopStreamStep(),
    vodStep()
  ]
})
