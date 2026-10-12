import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import { buildFaultsScenario } from '../lib/faults-scenario.mjs'
import { liveSampleStep } from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 178 U13 (plan 166 S9): network loss 30 s, throttle 1 Mbit/s 30 s,
// ffmpeg SIGSTOP 0.5 s and 6 s, each gated by policy.faults. The steps and
// their expectations live in lib/faults-scenario.mjs (tested with a stub
// step engine); this file binds them to U6's defineScenario and, since U9,
// takes the stream live first and ends it after (plan 178 U9).

export default buildFaultsScenario({
  defineScenario,
  goLiveSteps: [...goLiveSteps(), liveSampleStep()],
  stopSteps: [stopStreamStep()]
})
