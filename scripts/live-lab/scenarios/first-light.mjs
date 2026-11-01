import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import {
  OUTPUT_PROFILES,
  clipPullStep,
  liveHoldStep,
  liveSampleStep,
  outputProfileStep,
  vodStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite A (plan 178 U9). Manual RTMP key, one output profile, N
// minutes live, stop. Params: { profile: '1080p30'|'720p30'|'1080p60'|'4k30',
// minutes: 10 }. YouTube side: ingest good, resolution and fps match (or
// needs-eyes when the key reports "variable"), VOD exists. Clips (when the
// policy allows them): no freeze over 1 s, no audio gap over 100 ms, A/V
// offset under 150 ms. The verdict's bitrate rule uses the profile's target.

const minutesOf = (params) => Number(params?.minutes) || 10

export default defineScenario({
  name: 'first-light',
  plannedMinutes: (params) => minutesOf(params) + 12,
  // Observer: 4 units every 2 min while live, plus the VOD polls.
  estimatedQuotaUnits: (params) => Math.ceil((minutesOf(params) + 6) / 2) * 4 + 12,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    {
      ...outputProfileStep(),
      expect: (evidence) =>
        (evidence.applied && Boolean(OUTPUT_PROFILES[evidence.profile])) ||
        'the output profile was not applied'
    },
    ...goLiveSteps({ description: 'Videorc live lab, first light: an automated test stream.' }),
    liveSampleStep(),
    youtubeHealthStep(),
    clipPullStep({ id: 'clip-early', seconds: 120 }),
    liveHoldStep({ id: 'hold-live', minutes: (params) => minutesOf(params) }),
    clipPullStep({ id: 'clip-late', seconds: 120 }),
    stopStreamStep(),
    vodStep()
  ]
})
