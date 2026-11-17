/** Plan 249 S24 `handoff` acceptance phase. Heavy: never import it from a unit
 * test. It runs inside the real-page baseline (`runBaseline({ handoff: true })`)
 * after the avatar phase: the opening computer controls the show and a program
 * page applied its avatar, which the cloud kept (D9). Then the exact owned
 * backend PID is killed, another fixture computer resumes (an explicit
 * takeover), stale commands of the old controller are refused, the kept
 * avatar returns under the new controller's envelope, and no bubble or other
 * one-shot is ever replayed. Fake web and local fixtures only: no provider,
 * credential, broadcast or paid call.
 */
import assert from 'node:assert/strict'
import { holdFor, waitFor } from './cloud-managed-smoke.mjs'

/** Rust and web tests for what one run cannot show (races, retention, D9). */
export const HANDOFF_RUST_FILTERS = Object.freeze(['cloud_controller::tests'])
export const HANDOFF_WEB_TESTS = Object.freeze(['tests/cloud-controller-handoff.test.ts'])

const ONE_SHOTS = new Set(['bubble', 'highlight'])

/** Pure: kept views must hold no one-shot layer (D9). */
export function assertNothingReplayable(views, label = 'kept presentation') {
  for (const view of views)
    for (const layer of view.kept ?? view.layers ?? [])
      assert.ok(
        !ONE_SHOTS.has(layer.kind),
        `${label}: a ${layer.kind} was kept for ${view.topic}/${view.output}/${view.orientation}`
      )
}

const keptAvatar = (h, epoch) =>
  h.web.hooks
    .presentation(h.showId)
    .filter((view) => view.topic === 'avatar' && (epoch === undefined || view.epoch === epoch))

export async function exerciseHandoff({ h, report, clients }) {
  const showId = h.showId
  const program = clients.find((client) => client.name === 'program').page
  const startedAt = Date.now()
  await waitFor(
    () => h.web.hooks.controller(showId)?.epoch === 1,
    'the opening computer controls the show'
  )
  await waitFor(
    () =>
      ['stream', 'recording'].every((output) =>
        keptAvatar(h).some(
          (view) => view.output === output && view.kept.some((layer) => layer.kind === 'avatar')
        )
      ),
    'the applied avatar is kept for both outputs',
    45000
  )
  assertNothingReplayable(h.web.hooks.presentation(showId))
  const firstDevice = h.web.hooks.controller(showId).deviceId

  // The host computer is lost: its exact backend PID, nothing by name.
  const killed = await h.killOwnedHost()
  // The supported host-loss policy (D9 here): while no controller publishes,
  // the program keeps what it applied only for its transport lease, then
  // clears it. Observed before anyone resumes, so this clear is never
  // counted as a layer that stayed on air.
  const lostAt = Date.now()
  await waitFor(
    async () => (await program.locator('img[data-avatar-layer="avatar"]').count()) === 0,
    'the program clears the avatar after its transport lease while no computer controls the show',
    45000
  )
  const programClearedAfterMs = Date.now() - lostAt
  // Another fixture controller resumes: Continue here is the explicit takeover.
  await h.freshComputer()
  const resumed = await h.rpc('cloud.room.resume')
  const controller = resumed.controller ?? (await h.rpc('cloud.status')).controller
  assert.equal(controller?.controllerEpoch, 2, 'the resume took the show over atomically')
  assert.equal(controller.takenOverFrom, 'another-device')
  const held = h.web.hooks.controller(showId)
  assert.notEqual(held.deviceId, firstDevice, 'the new computer controls the show')
  // What captured on the lost computer starts off here, and says so.
  await waitFor(
    () => h.eval(`return document.body.innerText.includes('You control this show here now')`),
    'the new controller is told its camera and microphone stay off'
  )

  // The old controller's commands are refused, End included; the show and
  // its broadcasts carry on.
  // Leaving the epoch out (a desktop from before S24) is refused the same.
  for (const [name, body] of [
    ['stage', { layout: 'solo', onStage: [] }],
    ['legsEnd', {}],
    ['end', {}]
  ]) {
    for (const [epoch, code] of [
      [1, 'cloud-controller-stale'],
      [null, 'cloud-controller-required']
    ]) {
      const answer = await h.controllerRequest(name, body, epoch)
      assert.equal(
        answer.status,
        409,
        `a ${epoch === null ? 'headerless' : 'stale'} ${name} is refused`
      )
      assert.equal(answer.body.error.code, code)
    }
  }
  assert.equal(h.web.snapshot(showId).show.endedAt ?? null, null, 'a stale End never ends it')
  h.assertNoPlatformEnd(startedAt)

  // The kept avatar is back on the program under the new envelope; no
  // bubble is replayed, even one that had not expired yet.
  await waitFor(
    async () => (await program.locator('img[data-avatar-layer="avatar"]').count()) > 0,
    'the kept avatar is back on the program after the takeover',
    60000
  )
  await holdFor(
    async () => (await program.locator('img[data-avatar-layer="bubble"]').count()) === 0,
    'no bubble is replayed after the takeover',
    6000
  )
  // The new controller's own applied view is kept under its own epoch.
  await waitFor(
    () => keptAvatar(h, 2).length > 0,
    "the new controller's own applied view is kept under its epoch",
    45000
  )
  assertNothingReplayable(h.web.hooks.presentation(showId), 'after the takeover')
  report.handoff = {
    killedBackendPid: killed.pid,
    hostLoss: {
      policy: 'successor-restore',
      programClearedAfterMs,
      preservedThroughGap: false
    },
    controllerEpochs: h.web.hooks.controllerLog().map((entry) => entry.epoch),
    staleRefusals: h.web.hooks.controllerRefusals().map((entry) => entry.route),
    needsEnable: controller.needsEnable,
    keptViews: h.web.hooks.presentation(showId).map((view) => ({
      topic: view.topic,
      output: view.output,
      orientation: view.orientation,
      epoch: view.epoch,
      kept: view.kept.map((layer) => layer.kind)
    })),
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
}
