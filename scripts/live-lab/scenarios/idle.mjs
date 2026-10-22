import { cardUpStep } from '../lib/common-steps.mjs'
import { idleHoldStep } from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 166 idle (plan 178 U9, D9 schedule 11:00): the app open with the
// preview on, not live, for `idleMinutes` (default 120). Idle leaks, idle CPU
// and timers are the verdict's job. Nothing is streamed, so the local-sink
// profile is used and no quota is spent.

export default defineScenario({
  name: 'idle',
  plannedMinutes: (params) => (Number(params?.idleMinutes) || 120) + 10,
  estimatedQuotaUnits: 0,
  usesBundledClient: false,
  destination: 'local-sink',
  steps: [cardUpStep(), idleHoldStep()]
})
