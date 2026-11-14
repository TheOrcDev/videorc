/** Plan 234 C6: real desktop web control, local TLS ingress, recovery and leaks.
 * Run: VIDEORC_APP_VERSION=0.26.0 pnpm smoke:cloud-solo-managed --repeat 10
 * Needs an already built dev backend (never builds), MediaMTX, ffmpeg/ffprobe,
 * openssl/lsof on macOS. Env: VIDEORC_APP_VERSION >= 0.26.0 (older creates are
 * refused), VIDEORC_SMOKE_OUTPUT_DIR, VIDEORC_SMOKE_{FFMPEG,FFPROBE,MEDIAMTX}_PATH.
 * VIDEORC_MANAGED_PROGRAM_RECORDING names D18's program snapshot (use {pass}
 * for repeat), with a .clock.json containing firstFrameAtMs.
 * Cannot prove real LiveKit egress, webhooks or Neon. A feed-only receiver cannot
 * prove the program page's hold-card pixels: that remains a required D18 gate.
 */
import assert from 'node:assert/strict'
import { managedHarness, OUTPUT, waitFor, holdFor } from './lib/cloud-managed-smoke.mjs'
import { assertManagedProgramHold } from './lib/cloud-managed-program.mjs'
import { managedWire as w } from './lib/fake-cloud-web-managed.mjs'

const index = process.argv.indexOf('--repeat')
const repeat = index < 0 ? 1 : Number(process.argv[index + 1])
assert.ok(Number.isInteger(repeat) && repeat > 0, '--repeat requires a positive integer')
for (let pass = 1; pass <= repeat; pass++) await run(pass)

async function run(pass) {
  const h = await managedHarness('solo', pass)
  const blockers = []
  const step = async (name, fn) => {
    await fn()
    console.log(`[managed solo ${pass}/${repeat}] ${name}`)
  }
  try {
    const targets = await h.destinations(3)
    await h.launch()
    await step('Test cloud uses web state/end and reaches the TLS ingress', async () => {
      const at = Date.now()
      await h.rpc('cloud.selftest.run', { outputs: [OUTPUT] })
      await h.status((s) => s.test?.phase === 'done', 'Test cloud result', 90000)
      const created = h.calls('create', at)[0]
      assert.equal(created.body.kind, 'test')
      const s = [...h.web.shows.values()].find((s) => s.show.kind === 'test')
      assert.ok(s.state.phase === w.phases.at(-1))
      assert.ok(s.firstFrameAt)
      assert.equal(h.calls('end', at).length, 1)
      h.assertNoDirect()
    })
    h.web.hooks.refuseDestination(targets[2].id, w.destinationRefusals.codes[1])
    await step(
      'Go Live has two accepted destinations, one refusal, web control and no runner socket',
      async () => {
        const at = Date.now()
        await h.rpc('session.start', await h.sessionParams())
        const s = await h.status(
          (s) => s.show?.id && s.legs?.length === 3,
          'three destination rows'
        )
        h.showId = s.show.id
        await waitFor(() => h.feedFrames.some((f) => f.atMs >= at), 'decoded TLS feed')
        const state = h.web.snapshot(h.showId).state
        assert.equal(state.legs.filter((l) => l.state === w.legs.states[1]).length, 2)
        assert.equal(state.legs.filter((l) => l.state === w.legs.states[3]).length, 1)
        assert.equal(h.calls('destinations', at)[0].body.destinations.length, 3)
        await h.assertNoControlSocket()
        h.assertNoDirect()
      }
    )
    await step(
      'feed cut reaches hold, lost is reported at 20 s, feed returns on the same ingress',
      async () => {
        const cut = Date.now(),
          count = h.feedFrames.length
        await h.cut()
        await h.status((s) => s.phase === 'hold', 'hold from observed feed stall', 15000)
        await waitFor(() => h.calls('lost', cut).length, '20 s lost report', 45000)
        const holdMs = Date.parse(h.web.snapshot(h.showId).state.hold.since)
        const lost = h.calls('lost', cut)[0]
        assert.ok(
          lost.atMs - cut >= w.timers.lostFeedDownSeconds * 1000 - 1500,
          'lost was reported too soon'
        )
        assert.ok(lost.atMs - cut < 40000, 'lost was unbounded')
        assert.ok(
          h.calls('current', cut).some((c) => c.atMs <= lost.atMs),
          'lost must first ask current'
        )
        await h.forward()
        await waitFor(
          () => h.feedFrames.length > count && h.feedFrames.at(-1).atMs > lost.atMs,
          'feed decoded after return',
          45000
        )
        await h.status((s) => s.phase === 'live', 'return to live', 15000)
        h.assertNoDirect()
        const liveMs = Date.now()
        await holdFor(
          async () => (await h.rpc('cloud.status')).phase === 'live',
          'returned picture stays live',
          4000
        )
        try {
          assertManagedProgramHold(h, { holdMs, liveMs, endMs: Date.now() }, pass)
        } catch (error) {
          blockers.push(error.message)
        }
      }
    )
    await step(
      'SIGKILL then Resume keeps ingress with no destination resend while egress lives',
      async () => {
        const ingress = structuredClone(h.web.shows.get(h.showId).ingest)
        await h.kill()
        await h.launch()
        await h.status((s) => s.show?.resumable, 'resumable show')
        const at = Date.now()
        await h.rpc('cloud.show.resume', await h.sessionParams())
        await h.status((s) => s.show?.id === h.showId && s.phase === 'live', 'resumed show', 45000)
        await holdFor(
          () => h.calls('destinations', at).length === 0,
          'unnecessary destination resend',
          3000
        )
        assert.deepEqual(h.web.shows.get(h.showId).ingest, ingress)
        h.assertNoDirect()
      }
    )
    await step('dead egress resends the full list and a stale state is dropped once', async () => {
      const stale = h.web.snapshot(h.showId)
      stale.state.destinationsSet = false
      const at = Date.now()
      h.web.hooks.egressDied(h.showId)
      await waitFor(
        () => h.calls('destinations', at).some((c) => c.status === 200),
        'full egress recovery'
      )
      assert.equal(h.calls('destinations', at)[0].body.destinations.length, 3)
      const total = h.calls('destinations').length
      const queuedAt = Date.now()
      h.web.hooks.answerNext('state', stale)
      h.web.hooks.patch(h.showId, (s) => {
        s.liveSeconds++
      })
      await waitFor(
        () => h.calls('state', queuedAt).some((c) => c.rev === stale.rev),
        'stale state delivered'
      )
      await holdFor(
        () => h.calls('destinations').length === total,
        'stale state restarted healthy egress',
        4000
      )
      assert.equal(h.calls('state', queuedAt).filter((c) => c.rev === stale.rev).length, 1)
      h.assertNoDirect()
    })
    await step('one failed leg Reconnect resends only that destination', async () => {
      h.web.hooks.failLeg(h.showId, targets[0].id)
      await h.status(
        (s) => s.legs?.some((l) => l.targetId === targets[0].id && l.state === 'failed'),
        'failed leg'
      )
      const at = Date.now()
      await h.rpc('cloud.show.reconnectDestination', { targetId: targets[0].id })
      await waitFor(
        () => h.calls('destinations', at).some((c) => c.status === 200),
        'Reconnect request'
      )
      assert.equal(h.calls('destinations', at)[0].body.destinations.length, 1)
      h.assertNoDirect()
    })
    await step(
      'poll failures back off and ask current from the second failure; mismatch recovers',
      async () => {
        const at = Date.now()
        h.web.hooks.failNext('state', 3, 503)
        h.web.hooks.patch(h.showId, (s) => {
          s.liveSeconds++
        })
        await waitFor(
          () => h.calls('state', at).filter((c) => c.status === 503).length === 3,
          'three poll failures',
          45000
        )
        const failed = h.calls('state', at).filter((c) => c.status === 503)
        for (let i = 1; i < 3; i++)
          assert.ok(
            failed[i].atMs - failed[i - 1].answeredAtMs >=
              w.state.backoffSeconds[i - 1] * 1000 - 150
          )
        assert.ok(h.calls('current', at).some((c) => c.atMs >= failed[1].atMs))
        await h.status((s) => s.connected, 'poll restored', 20000)
        const mismatch = w.errors.common.find((e) => e.code.endsWith('mismatch'))
        const mismatchAt = Date.now()
        h.web.hooks.failNext('state', 1, mismatch.status, mismatch.code)
        h.web.hooks.patch(h.showId, (s) => {
          s.liveSeconds++
        })
        await waitFor(() => h.calls('current', mismatchAt).length, 'mismatch current', 45000)
      }
    )
    await step('401 halts polling and sign-in refresh restores it', async () => {
      const at = Date.now()
      h.web.hooks.failNext('state', 1, 401)
      h.web.hooks.patch(h.showId, (s) => {
        s.liveSeconds++
      })
      await waitFor(() => h.calls('state', at).some((c) => c.status === 401), '401 poll', 45000)
      await h.status((s) => !s.connected, 'control signed out')
      const count = h.calls('state').length
      await holdFor(() => h.calls('state').length === count, '401 kept polling', 2500)
      await h.rpc('account.refresh')
      await h.status((s) => s.connected, 'sign-in control recovery')
    })
    await step(
      'Stop sends one POST end and leaves no output; stream keys leak nowhere',
      async () => {
        const at = Date.now()
        await h.rpc('session.stop')
        assert.equal(h.calls('end', at).length, 1)
        assert.ok(h.web.shows.get(h.showId).show.endedAt)
        h.assertNoDirect()
        h.scanLeaks()
      }
    )
    await step('resend works when only one destination exists', async () => {
      await h.rpc('session.start', await h.sessionParams(targets.slice(0, 1)))
      const status = await h.status(
        (s) => s.show?.id && s.show.id !== h.showId,
        'new single-target show'
      )
      h.showId = status.show.id
      const at = Date.now()
      h.web.hooks.resend(h.showId, targets[0].id)
      await waitFor(() => h.calls('destinations', at).length, 'single-target resend', 45000)
      assert.equal(h.calls('destinations', at)[0].body.destinations.length, 1)
      await h.rpc('session.stop')
      h.assertNoDirect()
    })
    await step('unknown control kind ends cloud before direct streaming', async () => {
      h.web.hooks.controlKind('future-smoke-kind')
      const at = Date.now()
      await h.rpc('session.start', await h.sessionParams(targets.slice(0, 1)))
      await waitFor(() => h.directConnections.some((c) => c.atMs >= at), 'direct fallback socket')
      const ended = h.calls('end', at)[0]
      assert.equal(ended?.status, 200)
      assert.ok(h.directConnections.find((c) => c.atMs >= at).atMs >= ended.answeredAtMs)
      await h.rpc('session.stop')
      h.scanLeaks()
    })
    assert.deepEqual(
      blockers,
      [],
      `Required managed-media coverage is blocked: ${blockers.join(' ')}`
    )
  } finally {
    await h.close()
  }
}
