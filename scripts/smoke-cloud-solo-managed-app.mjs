/** Plan 234 C6: real desktop web control, local TLS ingress, recovery and leaks.
 * Run: pnpm smoke:cloud-solo-managed --repeat 10
 * Needs an already built dev backend (never builds), MediaMTX, ffmpeg/ffprobe,
 * openssl/lsof on macOS. Env: VIDEORC_SMOKE_OUTPUT_DIR,
 * VIDEORC_SMOKE_{FFMPEG,FFPROBE,MEDIAMTX}_PATH. The fake web takes this build's
 * own version (apps/desktop/package.json) as web-control ready; any other
 * version keeps the 0.26.0 rule, since main always reports app.getVersion().
 * VIDEORC_MANAGED_PROGRAM_RECORDING names D18's program snapshot (use {pass}
 * for repeat), with a .clock.json containing firstFrameAtMs; without it the
 * program-receiver hold card is a named SKIP on every pass.
 * Cannot prove real LiveKit egress, webhooks or Neon. A feed-only receiver cannot
 * prove the program page's hold-card pixels: that remains a required D18 gate.
 */
import assert from 'node:assert/strict'
import { managedHarness, OUTPUT, waitFor, holdFor, playable } from './lib/cloud-managed-smoke.mjs'
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
        // The card is drawn by the program page inside LiveKit's egress, which
        // only the D18 Docker stack runs. Without its receiver snapshot this is a
        // named SKIP on every pass, never a silent pass; with it, a failure blocks.
        if (!process.env.VIDEORC_MANAGED_PROGRAM_RECORDING)
          console.log(
            `[managed solo ${pass}/${repeat}] SKIP program-receiver hold card and continuity: needs the D18 egress stack (VIDEORC_MANAGED_PROGRAM_RECORDING); a feed-only receiver cannot see the program page's card`
          )
        else
          try {
            assertManagedProgramHold(h, { holdMs, liveMs, endMs: Date.now() }, pass)
          } catch (error) {
            blockers.push(error.message)
          }
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
      'SIGKILL then Resume keeps ingress, retains live legs and rebuilds reconnect candidates',
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
        // Plan 243 D3: this profile still owns its saved keys. Resume
        // retains the live leg ids and sends a candidate only on Reconnect.
        await h.rpc('cloud.show.reconnectDestination', { targetId: targets[0].id })
        assert.equal(h.calls('destinations', at).length, 1)
        assert.equal(h.calls('destinations', at)[0].body.destinations[0].id, targets[0].id)
        h.assertNoDirect()
      }
    )
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
      await h.refreshSignIn()
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
    // Plan 243 C6: these are product actions, including the renderer's
    // broadcast owner. A bare backend start would make the complete check vacuous.
    const continuationAt = Date.now()
    let continuedRecording
    const followsProfile = async () => {
      const enabled = await h.eval(
        'return window.__videorcSmokeScenePresets.streamingState().captureConfig.recordEnabled'
      )
      const recording = await h.rpc('recording.status')
      assert.equal(
        recording.state,
        enabled ? 'recording' : 'streaming',
        "the continuing session must follow this profile's record setting"
      )
      if (enabled) {
        const frames = h.feedFrames.length
        await waitFor(
          () => h.feedFrames.length >= frames + 45,
          'continuing recording contains decoded frames'
        )
      }
      return recording
    }
    const savedRecording = async (recording) => {
      if (recording.state !== 'recording') return
      const saved = await waitFor(
        async () => {
          const page = await h.rpc('sessions.list', { limit: 100 })
          return page.items.find(
            (item) => item.id === recording.sessionId && item.mp4Path && item.status === 'completed'
          )
        },
        'continuing recording finalized in Library',
        90000
      )
      playable(h, saved.mp4Path)
    }
    await step(
      'hand off through the dialog preserves YouTube and saves the recording',
      async () => {
        await h.addYouTube()
        const started = await h.startUiLive()
        h.showId = started.show.id
        const recording = await h.rpc('recording.status')
        assert.equal(recording.state, 'recording')
        assert.ok(
          [...h.youtube.broadcasts.values()].some((b) => b.status.lifeCycleStatus === 'live'),
          'renderer must own a live prepared YouTube broadcast'
        )
        assert.ok(
          h.web
            .snapshot(h.showId)
            .state.legs.some((l) => l.platform === 'youtube' && l.broadcastId),
          'broadcastId must reach cloud legs'
        )
        const frames = h.feedFrames.length
        await waitFor(() => h.feedFrames.length >= frames + 45, 'recording contains decoded frames')
        const at = Date.now()
        await h.handOffUi()
        await waitFor(
          async () => (await h.rpc('recording.status')).state === 'idle',
          'hand-off terminal status'
        )
        await h.status(
          (s) => s.stoppedBy === 'hand-off' && s.show?.resumable && s.onAir?.waiting,
          'waiting after hand-off'
        )
        assert.equal(h.calls('handOff', at).length, 1)
        h.assertStopOrder(at, 'hand-off')
        h.assertNoPlatformEnd(at)
        const saved = await waitFor(
          async () => {
            const page = await h.rpc('sessions.list', { limit: 100 })
            return page.items.find(
              (item) =>
                item.id === recording.sessionId && item.mp4Path && item.status === 'completed'
            )
          },
          'handed-off recording finalized in Library',
          90000
        )
        playable(h, saved.mp4Path)
        assert.ok(
          await h.eval(
            `return Boolean(document.querySelector('[data-testid=cloud-continue-pointer]')?.textContent?.includes('videorc.com/live/continue'))`
          ),
          'phone pointer missing'
        )
        h.scanLeaks()
      }
    )
    await step(
      'Continue here on the same computer keeps ingress and follows its record setting',
      async () => {
        const before = structuredClone(h.web.shows.get(h.showId).ingest)
        const at = Date.now()
        await h.continueUi()
        await h.status(
          (s) => s.sessionId && s.onAir?.thisDevice && !s.onAir.waiting,
          'same computer continued',
          45000
        )
        continuedRecording = await followsProfile()
        assert.deepEqual(h.web.shows.get(h.showId).ingest, before)
        assert.ok(
          h.calls('onAir', at).some((c) => c.body.source === 'feed' && c.body.step === 'prepare')
        )
        assert.equal(h.calls('destinations', at).length, 0)
        h.assertNoPlatformEnd(at)
      }
    )
    await step(
      'a fake phone takes over within three seconds, names it and never ends a platform',
      async () => {
        const phone = h.newDevice()
        assert.equal(
          (await h.webRequest('on-air', { device: phone, source: 'camera', step: 'prepare' }))
            .status,
          200
        )
        h.web.hooks.camera(h.showId, phone.id, true)
        const at = Date.now()
        assert.equal(
          (await h.webRequest('on-air', { device: phone, source: 'camera', step: 'go' })).status,
          200
        )
        await waitFor(
          async () => (await h.rpc('recording.status')).state === 'idle',
          'phone takeover stop',
          3000
        )
        const status = await h.status(
          (s) => s.stoppedBy === 'taken-over' && s.show?.resumable && s.onAir?.kind === 'phone',
          'phone takeover notice'
        )
        assert.ok(status.onAir.name === 'Smoke phone')
        const terminal = h.events.find(
          (e) => e.atMs >= at && e.event === 'recording.status' && e.payload.state === 'idle'
        )
        assert.ok(terminal && terminal.atMs - at <= 3000, 'taken-over stop exceeded three seconds')
        h.assertStopOrder(at, 'taken-over')
        await savedRecording(continuedRecording)
        h.assertNoPlatformEnd(at)
        assert.ok(
          await h.eval(
            `return document.body.textContent.includes('Your show continues on Smoke phone.')`
          ),
          'neutral takeover toast missing'
        )
        await waitFor(
          () =>
            h.eval(
              `return document.querySelector('[data-testid=cloud-resume-notice]')?.textContent.includes('Your show is live from Smoke phone.')`
            ),
          'notice names the phone'
        )
      }
    )
    await step(
      'a fresh computer continues with rotation, matching-key reconnect and changed-key refusal',
      async () => {
        const oldDevice = h.deviceId
        const oldIngress = structuredClone(h.web.shows.get(h.showId).ingest[0])
        const liveLeg = h.web.snapshot(h.showId).state.legs.find((l) => l.platform === 'custom')
        const at = Date.now()
        await h.freshComputer()
        assert.ok(h.deviceId !== oldDevice, 'computer B needs a new identity')
        await h.status(
          (s) => s.show?.id === h.showId && s.show.resumable && s.onAir?.kind === 'phone',
          'computer B discovers current show'
        )
        assert.equal(h.calls('create', at).length, 0)
        await h.continueUi()
        await h.status(
          (s) => s.onAir?.thisDevice && s.onAir.source === 'feed' && s.sessionId,
          'computer B on air',
          60000
        )
        assert.ok(
          h.web.shows.get(h.showId).ingest[0].streamKey !== oldIngress.streamKey,
          'computer B must rotate the ingress'
        )
        assert.ok(
          h.calls('onAir', at).some((c) => c.body.step === 'go' && c.body.source === 'feed'),
          'camera to feed needs go'
        )
        await h.assertRetiredIngress(oldIngress)
        const bRecording = await followsProfile()
        assert.equal(h.calls('destinations', at).length, 0, 'Resume must retain platform legs')
        h.web.hooks.failLeg(h.showId, liveLeg.id)
        const reconnectAt = Date.now()
        await h.rpc('cloud.show.reconnectDestination', { targetId: liveLeg.id })
        const sent = h.calls('destinations', reconnectAt)[0]
        assert.equal(sent.status, 200)
        assert.equal(sent.body.destinations.length, 1)
        assert.equal(sent.body.destinations[0].id, liveLeg.id)
        assert.ok(
          h.targets.every((t) => t.id !== liveLeg.id),
          'candidate must use the live leg id rather than B target ids'
        )
        assert.equal(sent.body.replace, undefined)
        // A new resume reads B's changed local key. It may never reconnect a
        // different platform stream under this show's existing leg.
        await h.handOffUi()
        await h.status((s) => s.stoppedBy === 'hand-off' && s.show?.resumable, 'B hand-off')
        await savedRecording(bRecording)
        await h.replaceSavedKey(h.targets.find((t) => t.label === liveLeg.label).id)
        await h.continueUi()
        await h.status(
          (s) => s.sessionId && s.onAir?.thisDevice,
          'B resumes with changed local key',
          45000
        )
        const refusalAt = Date.now()
        await assert.rejects(
          h.rpc('cloud.show.reconnectDestination', { targetId: liveLeg.id }),
          /does not match|destination-changed/
        )
        assert.ok(
          h.calls('destinations', refusalAt).some((c) => c.status === 422),
          'different saved key must be refused'
        )
        h.assertNoPlatformEnd(continuationAt)
        h.assertNoDirect()
        h.scanLeaks()
        await h.rpc('session.stop')
      }
    )
    await step('unknown control kind ends cloud before direct streaming', async () => {
      h.web.hooks.controlKind('future-smoke-kind')
      const at = Date.now()
      await h.rpc('session.start', await h.sessionParams(h.targets.slice(0, 1)))
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
