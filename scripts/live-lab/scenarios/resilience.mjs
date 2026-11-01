import { goLiveSteps } from '../lib/common-steps.mjs'
import {
  liveHoldStep,
  liveSampleStep,
  quitWhileLiveStep,
  studioEndedStep,
  youtubeHealthStep
} from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'

// Plan 176 suite E minus the injected faults (those are the `faults`
// scenario, U13). Ending the stream from YouTube Studio needs the owner at
// Studio: unattended it is recorded as needs-eyes and skipped
// (params.attended: true waits for it). Then the app is quit while live: the
// teardown must find a clean ledger (orphans are the verdict's signal). The
// quit replaces the stop step; the session is gone with the app, so the quit
// step tells the bus the session is idle before teardown runs.

export default defineScenario({
  name: 'resilience',
  plannedMinutes: 15,
  estimatedQuotaUnits: 40,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    ...goLiveSteps({ description: 'Videorc live lab, resilience: an automated test stream.' }),
    liveSampleStep(),
    youtubeHealthStep(),
    studioEndedStep(),
    liveHoldStep({ id: 'hold-live', minutes: 1 }),
    {
      ...quitWhileLiveStep(),
      async run(ctx) {
        const result = await quitWhileLiveStep().run(ctx)
        // The app is gone: tell the teardown there is no session to stop.
        const last = ctx.remote.state() ?? {}
        ctx.events?.emit('remote.state', {
          ...last,
          sessionActive: false,
          sessionState: 'idle',
          appQuit: true
        })
        return result
      }
    }
  ]
})
