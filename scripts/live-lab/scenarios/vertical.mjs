import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import {
  clipPullStep,
  liveHoldStep,
  liveSampleStep,
  needsEyes,
  vodStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite F, dual orientation (plan 178 U9, run by U14): the vertical
// leg streams to the second persistent key. YouTube's Dual stream toggle has
// no API; the owner turns it on for the vertical key once (U3 visit), and the
// Studio fact stays a needs-eyes item. Both legs must stay live.

export default defineScenario({
  name: 'vertical',
  plannedMinutes: 15,
  estimatedQuotaUnits: 60,
  usesBundledClient: false,
  destination: 'youtube',
  orientations: ['horizontal', 'vertical'],
  steps: [
    ...goLiveSteps({
      destinationIds: ['youtube', 'youtube-vertical'],
      description: 'Videorc live lab, dual orientation: an automated test stream.'
    }),
    {
      ...liveSampleStep(),
      expect: (evidence) =>
        evidence.legs.filter((leg) => leg.bitrateKbps > 0).length === 2 ||
        `expected two live legs, saw ${evidence.legs.length}`
    },
    youtubeHealthStep(),
    {
      id: 'dual-stream-studio',
      title: 'Dual stream in Studio',
      deadlineMs: 10_000,
      async run(ctx) {
        await needsEyes(ctx, {
          id: 'dual-stream-studio',
          question:
            'Is Dual stream on for the vertical key in YouTube Studio, and does the vertical output show the card upright?'
        })
        return { recorded: true }
      }
    },
    clipPullStep({ id: 'clip-dual', seconds: 60 }),
    liveHoldStep({ id: 'hold-live', minutes: 5 }),
    stopStreamStep(),
    vodStep()
  ]
})
