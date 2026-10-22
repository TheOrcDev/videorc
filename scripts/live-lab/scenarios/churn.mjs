import { cardUpStep, goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import { churnCyclesStep } from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 166 churn (plan 178 U9, D9 schedule 04:30): `cycles` (default 40) x
// go live through the real dialog, 90 s live, stop, 20 s idle. Finds leaks
// per session, teardown leftovers and start latency creeping up (the verdict
// reads the per-cycle liveAfterMs from features.ndjson).

const cyclesOf = (params) => Number(params?.cycles) || 40

export default defineScenario({
  name: 'churn',
  plannedMinutes: (params) => Math.ceil(cyclesOf(params) * 2.5) + 10,
  // Each cycle is about 2.5 min: one or two observer polls at 4 units.
  estimatedQuotaUnits: (params) => cyclesOf(params) * 8 + 20,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [cardUpStep(), churnCyclesStep({ goLiveSteps, stopStreamStep })]
})
