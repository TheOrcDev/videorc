/** Maintained acquisition: never imported by focused helper tests. Runs actual
 * Electron/main/preload/native system capture, room publication and real pages.
 * External afplay is a distinct process, not an app speaker-output shortcut. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { MEDIA, toneWav } from './cloud-parity-media.mjs'
import { waitFor as poll, runMedia } from './cloud-managed-smoke.mjs'
import {
  audioRoutingConfig,
  assertAudioRoutes,
  routingTable,
  assertSystemReleased,
  deriveSystemClock,
  stopOwnedRoutingPlayer
} from './cloud-parity-audio-routing-contract.mjs'
export async function exerciseAudioRouting({
  h,
  clients,
  captureAudio,
  report,
  sound,
  guests,
  output,
  config = audioRoutingConfig()
}) {
  const started = Date.now()
  const waitFor = (fn, label, ms = 30000) =>
    poll(fn, label, Math.max(1, Math.min(ms, config.deadlineMs - (Date.now() - started))))
  const deadline = () => {
    if (Date.now() - started >= config.deadlineMs)
      throw new Error('Audio routing deadline exceeded')
  }
  const outcome = (report.audioRouting = {
    status: 'running',
    revisions: report.revisions,
    artifacts: report.artifacts,
    config,
    cases: [],
    resources: [],
    rawObservations: [],
    productionQualified: false,
    unavailable: [
      'System audio carries the S13a shared clock origin; drift, latency and final A/V alignment are unmeasured.',
      'Physical microphone/AEC qualification not acquired by this routing fixture.'
    ],
    captureSurface:
      'Final real program limiter and actual guest return attachments; local LiveKit, no managed egress'
  })
  const save = () =>
    writeFileSync(
      join(output, 'audio-routing-acquisition.json'),
      JSON.stringify(outcome, null, 2) + '\n'
    )
  const state = async () => {
    const value = await h.eval('return window.__videorcSmokeScenePresets.roomAudioRouting()')
    outcome.rawObservations.push({ at: Date.now(), ...value })
    assert.ok(outcome.rawObservations.length < 2000, 'Observation bound exceeded')
    assert.equal(value.observations?.lost, 0, 'Raw system observations unavailable or dropped')
    return value
  }
  const route = async (patch) => {
    const value = await h.eval(
      `return window.__videorcSmokeScenePresets.roomAudioRouting(${JSON.stringify(patch)})`
    )
    outcome.rawObservations.push({ at: Date.now(), ...value })
    return value
  }
  // Plan 249 S24: the controller's `system` report, as the fake web keeps it
  // from `cloud.controller.desired` (the room open claimed the controller).
  outcome.controller = { reports: [] }
  const controllerSystem = async (expected, label) => {
    await waitFor(() => {
      const controller = h.web.hooks.controller(h.showId)
      return controller !== null && controller.enabled?.system === expected
    }, `controller system report ${label}`)
    const controller = h.web.hooks.controller(h.showId)
    outcome.controller.reports.push({ label, epoch: controller.epoch, system: expected })
  }
  const tone = join(output, 'external-system.wav')
  const toneBytes = toneWav(MEDIA.tones.system, config.seconds + 3)
  writeFileSync(tone, toneBytes)
  outcome.systemStimulus = {
    file: 'external-system.wav',
    hz: MEDIA.tones.system,
    sha256: createHash('sha256').update(toneBytes).digest('hex'),
    player: '/usr/bin/afplay',
    ownAppExcluded: true
  }
  let player = null,
    playerExit = null
  const stopPlayer = async () => {
    const owned = player,
      exit = playerExit
    player = null
    playerExit = null
    await stopOwnedRoutingPlayer(owned, exit)
  }
  const play = async () => {
    await stopPlayer()
    assert.equal(
      process.platform,
      'darwin',
      'External system acquisition currently requires macOS afplay; no substitute loopback is claimed'
    )
    player = spawn('/usr/bin/afplay', [tone], { stdio: 'ignore' })
    playerExit = once(player, 'exit')
    void playerExit.catch(() => {})
    await once(player, 'spawn')
  }
  const check = async (label, expected, reference = null) => {
    deadline()
    await play()
    const captures = await captureAudio(`s8-${label}`, clients)
    await stopPlayer()
    const raw = await state()
    outcome.rawObservations.push({ label, at: Date.now(), ...raw })
    outcome.cases.push({ label, captures })
    save()
    assertAudioRoutes(captures, expected, reference)
    return captures
  }
  const all = [`host:${h.showId}`, ...[...guests.values()].map((g) => g.identity)]
  const takeover = async (active) => {
    if (!active) return h.rpc('cloud.overlay.clear', { slot: 'takeover', orientation: 'h' })
    const png = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=cyan:s=64x64',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1'
    ])
    await h.rpc('cloud.overlay.set', {
      slot: 'takeover',
      orientation: 'h',
      pngBase64: png.toString('base64'),
      rect: { x: 0, y: 0, w: 1, h: 1 }
    })
  }
  let failure = null
  try {
    assert.equal((await state()).system.enabled, false, 'System opt-in must default off')
    await h.eval('return window.__videorcSmokeScenePresets.roomSounds(true)')
    await h.rpc('sounds.settings', { monitor: false, volumeDb: 0 })
    await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
    await h.rpc('sounds.play', { id: sound.id })
    await route({ system: { enabled: true } })
    await waitFor(async () => {
      const s = await state()
      if (s.systemState === 'blocked') throw Error(s.reason)
      return s.systemState === 'capturing'
    }, 'actual excluded native system capture attached')
    await controllerSystem(true, 'capturing')
    const base = await check('distinct-stems', routingTable())
    await h.rpc('sounds.settings', { monitor: true })
    const onceRoutes = routingTable()
    for (const stems of Object.values(onceRoutes)) {
      stems.system = 0
      stems.soundboard = 0
    }
    await check('monitor-still-one-copy', onceRoutes, base)
    await route({ system: { gainDb: -6 } })
    const quiet = routingTable()
    for (const stems of Object.values(quiet)) stems.system = -6
    await check('system-gain-minus-six', quiet, base)
    await route({ system: { muted: true } })
    await check('system-muted', routingTable({ system: false }))
    await route({
      system: { muted: false, gainDb: 0 },
      program: { speechGain: 0.5, auxiliaryGain: 0.5 }
    })
    const programGains = routingTable()
    for (const stem of ['host', 'guest1', 'guest2', 'system', 'soundboard'])
      programGains.program[stem] = -6.0206
    await check('independent-program-gains', programGains, base)
    await route({ program: { speechGain: 1, auxiliaryGain: 1 } })
    await takeover(true)
    await check('takeover-preserves-deliberate-aux', routingTable({ takeover: true }))
    await route({ program: { speechMuted: true } })
    await h.eval("return window.__videorcSmokeScenePresets.microphone('mute')")
    await takeover(false)
    await check('clear-retains-operator-mutes', routingTable({ host: false, programSpeech: false }))
    await h.eval("return window.__videorcSmokeScenePresets.microphone('unmute')")
    await route({ program: { speechMuted: false, auxiliaryMuted: true } })
    await check('program-aux-mute-keeps-conversation', routingTable({ programAux: false }))
    await route({ program: { auxiliaryMuted: false } })
    // S6's real guest component owns screen publication; no shadow participant.
    const owner = clients.find((c) => c.name === 'guest1')
    await owner.page.getByRole('button', { name: 'Share screen', exact: true }).click()
    await waitFor(
      async () =>
        (
          (
            await h.web.roomRpc('GetParticipant', {
              room: h.showId,
              identity: guests.get('guest1').identity
            })
          ).tracks ?? []
        ).some((t) => t.source === 'SCREEN_SHARE_AUDIO' || t.source === 4),
      'guest screen audio publication'
    )
    await h.rpc('cloud.stage.set', {
      layout: 'screen-people',
      onStage: all,
      screen: guests.get('guest1').identity
    })
    await check('guest-screen-owner-excluded', routingTable({ screenOwner: 'guest1' }))
    await h.rpc('cloud.stage.set', { layout: 'side-by-side', onStage: all, screen: null })
    await check('deselected-screen-silent', routingTable())
    await owner.page.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    // New program without the independent capability exercises PR118-compatible
    // all-program silence. Capability interception affects only this local fixture.
    const program = clients.find((c) => c.name === 'program').page
    const legacyBeacon = async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}')
      if (body.capability) delete body.capability.audioRouting
      await route.continue({ postData: JSON.stringify(body) })
    }
    await program.route('**/api/cloud/program/beacon', legacyBeacon)
    try {
      await program.reload()
      await waitFor(
        async () => (await state()).systemState === 'capturing',
        'legacy-capable auxiliary rejoin'
      )
      await takeover(true)
      const legacy = routingTable({ takeover: true })
      legacy.program.system = false
      legacy.program.soundboard = false
      await check('legacy-all-program-silence', legacy)
      await takeover(false)
    } finally {
      await program.unroute('**/api/cloud/program/beacon', legacyBeacon)
    }
    await program.reload()
    await waitFor(
      async () => (await state()).systemState === 'capturing',
      'deliberate routing consumer rejoin'
    )
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      await route({ system: { enabled: false } })
      await waitFor(async () => {
        const native = await h.eval('return window.videorc.getRoomSystemAudioResources()')
        const renderer = await state()
        outcome.resources.push({ cycle, native, renderer })
        return native.nativeSources === 0 && native.sockets === 0 && renderer.resources.length === 0
      }, 'real native and renderer source release')
      const native = await h.eval('return window.videorc.getRoomSystemAudioResources()'),
        renderer = await state()
      assertSystemReleased(native, renderer)
      await controllerSystem(false, `released-${cycle}`)
      save()
      await route({ system: { enabled: true } })
      await waitFor(
        async () => (await state()).systemState === 'capturing',
        'replacement system owner'
      )
      await check(`reopen-${cycle}`, routingTable())
    }
    const native = await h.eval('return window.videorc.getRoomSystemAudioResources()')
    outcome.resources.push({ phase: 'last-active', native, renderer: await state() })
    // S13a: every reopen is its own generation on the one backend anchor.
    outcome.clock = deriveSystemClock(outcome.rawObservations)
    assert.ok(
      outcome.clock.generations.length >= config.cycles + 1,
      'System clock observations missing for a capture generation'
    )
    if (outcome.clock.commonClockOrigin !== 'available')
      outcome.unavailable.push('Shared system clock origin unavailable in this run.')
    outcome.status = 'passed-local-routing-only'
  } catch (error) {
    outcome.status = 'failed'
    outcome.failure = 'Acquisition assertion failed; consult the redacted parent report'
    failure = error
  }
  // Cleanup always runs; the acquisition's own failure is reported first,
  // never hidden by a cleanup failure that followed it.
  {
    let playerFailure = null
    try {
      await stopPlayer()
    } catch (error) {
      playerFailure = error
    }
    await takeover(false).catch(() => {})
    try {
      await route({ system: { enabled: false } })
      await h.rpc('sounds.stop')
      await h.eval('return window.__videorcSmokeScenePresets.roomSounds(false)')
      await poll(
        async () => {
          const native = await h.eval('return window.videorc.getRoomSystemAudioResources()'),
            renderer = await state()
          outcome.resources.push({ phase: 'final-cleanup', native, renderer })
          return (
            native.nativeSources === 0 &&
            native.sockets === 0 &&
            native.ipcRequests === 0 &&
            renderer.resources.length === 0
          )
        },
        'final actual system resource release',
        10000
      )
      assertSystemReleased(
        await h.eval('return window.videorc.getRoomSystemAudioResources()'),
        await state()
      )
    } catch (cleanupError) {
      outcome.status = 'failed'
      outcome.unavailable.push('Final native/renderer cleanup confirmation unavailable.')
      failure ??= cleanupError
    }
    if (playerFailure) {
      outcome.status = 'failed'
      outcome.unavailable.push('Owned external tone player cleanup unconfirmed.')
      failure ??= playerFailure
    }
    save()
  }
  if (failure) throw failure
}
/** Browser fixture input only. The real guest UI owns publication and cleanup. */
export function installRoutingGuestScreen({ hz = 1760, peak = 0.125 } = {}) {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const draw = () => {
      const c = canvas.getContext('2d')
      c.fillStyle = 'cyan'
      c.fillRect(0, 0, 640, 360)
    }
    draw()
    const timer = setInterval(draw, 33),
      stream = canvas.captureStream(30)
    const context = new AudioContext({ sampleRate: 48000 }),
      tone = context.createOscillator(),
      gain = context.createGain(),
      output = context.createMediaStreamDestination()
    tone.frequency.value = hz
    gain.gain.value = peak
    tone.connect(gain).connect(output)
    tone.start()
    await context.resume()
    stream.addTrack(output.stream.getAudioTracks()[0])
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track)
      track.stop = () => {
        clearInterval(timer)
        void context.close()
        stop()
      }
    }
    return stream
  }
}
