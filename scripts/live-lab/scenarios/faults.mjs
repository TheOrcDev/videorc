import { defineScenario } from '../lib/step-engine.mjs'

import { buildFaultsScenario } from '../lib/faults-scenario.mjs'

// Plan 178 U13 (plan 166 S9): network loss 30 s, throttle 1 Mbit/s 30 s,
// ffmpeg SIGSTOP 0.5 s and 6 s, each gated by policy.faults. The steps and
// their expectations live in lib/faults-scenario.mjs (tested with a stub
// step engine); this file only binds them to U6's defineScenario.

export default buildFaultsScenario({ defineScenario })
