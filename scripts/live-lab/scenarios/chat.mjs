import { goLiveSteps, stopStreamStep } from '../lib/common-steps.mjs'
import { chatSteps, clipPullStep, liveSampleStep, vodStep } from '../lib/scenario-steps.mjs'
import { defineScenario } from '../lib/step-engine.mjs'
import { scriptCost } from '../lib/viewer-bot.mjs'

// Plan 176 suite C (plan 178 U9). The viewer bot (D3 account) posts plain
// text, emoji, a link, a 200-character message and a burst of 10; each must
// arrive in the app (delay measured); the app replies and the observer sees
// the reply on YouTube; one arrived message goes on stream (commentHighlight,
// frame-checked, plus a needs-eyes look); the viewer deletes a message; the
// link row's menu is a needs-eyes item. Params: { slowModeSeconds: 30 }.

export default defineScenario({
  name: 'chat',
  plannedMinutes: 30,
  // 14 sends + 1 delete (750) + the app's reply read by the observer + polls.
  estimatedQuotaUnits: scriptCost('run') + 120,
  usesBundledClient: false,
  destination: 'youtube',
  steps: [
    ...goLiveSteps({ description: 'Videorc live lab, chat suite: an automated test stream.' }),
    liveSampleStep(),
    ...chatSteps(),
    clipPullStep({ id: 'clip-highlight', seconds: 60 }),
    stopStreamStep(),
    vodStep()
  ]
})
