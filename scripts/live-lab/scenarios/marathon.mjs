import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import {
  liveSampleStep,
  marathonTimelineStep,
  vodStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 166 marathon (plan 178 U9, D9 schedule 06:00). `marathonHours` live
// (4 for the first two weeks, then 8; under YouTube's 12 h archive limit so
// the run keeps a VOD): a scene switch every 10 min, local recording for 20
// min every 2 h, mic toggles every hour, a clip pull every 30 min when the
// policy allows. Leaks, drift, encoder speed loss and dropped frames are the
// verdict's job (verdict.mjs over census.csv and journal.ndjson).

const hoursOf = (params) => Number(params?.marathonHours) || 8

export default defineScenario({
  name: 'marathon',
  plannedMinutes: (params) => hoursOf(params) * 60 + 15,
  // Observer: 4 units every 2 min, 120 an hour.
  estimatedQuotaUnits: (params) => hoursOf(params) * 120 + 30,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    ...goLiveSteps({ description: 'Videorc live lab, marathon soak: an automated test stream.' }),
    liveSampleStep(),
    youtubeHealthStep(),
    marathonTimelineStep(),
    stopStreamStep(),
    vodStep()
  ]
})
