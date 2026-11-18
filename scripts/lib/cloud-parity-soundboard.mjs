/** Maintained real-page waveform acceptance. Never imported by unit tests. */
import assert from 'node:assert/strict'
import { waitFor } from './cloud-managed-smoke.mjs'
import { MEDIA } from './cloud-parity-media.mjs'
import { assertSoundboardWaveforms } from './cloud-parity-soundboard-contract.mjs'

export async function exerciseSoundboard({ h, clients, captureAudio, report, sound, guests }) {
  const outcome = {
    status: 'running',
    waveforms: [],
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
  report.soundboard = outcome
  const state = () => h.eval('return window.__videorcSmokeScenePresets.roomSounds()')
  const enabled = (value) => h.eval(`return window.__videorcSmokeScenePresets.roomSounds(${value})`)
  const host = `host:${h.showId}`
  const all = [host, ...[...guests.values()].map((g) => g.identity)]
  const guest = clients.find((c) => c.name === 'guest1')
  const expected = 20 * Math.log10(MEDIA.tonePeak / Math.sqrt(2)) + sound.levelDb + sound.volumeDb
  const check = async (label, soundDb, mic = true) => {
    const captures = await captureAudio(`s3-${label}`, clients)
    assertSoundboardWaveforms(captures, { soundDb, host: mic, label })
    outcome.waveforms.push({ label, captures })
  }
  await h.rpc('sounds.settings', { monitor: false, volumeDb: 0 })
  assert.equal((await state()).enabled, false, 'Opt-in must default off')
  await enabled(true)
  await waitFor(
    async () => (await state()).state === 'published',
    'all real consumers negotiated v2'
  )
  const hostTracks = async () =>
    (await h.web.roomRpc('GetParticipant', { room: h.showId, identity: host })).tracks ?? []
  assert.equal(
    (await hostTracks()).filter((t) => t.name === 'videorc:v2:host-aux:stereo').length,
    1
  )
  // Loop gives each destination a full coherent capture window.
  await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
  await h.rpc('sounds.play', { id: sound.id })
  await check('monitor-off-screen-off', expected)
  await h.eval("return window.__videorcSmokeScenePresets.microphone('mute')")
  await check('mic-muted-aux-continues', expected, false)
  await h.eval("return window.__videorcSmokeScenePresets.microphone('unmute')")
  await h.rpc('cloud.stage.set', {
    layout: 'side-by-side',
    onStage: all.filter((id) => id !== host)
  })
  await check('host-offstage', expected, { program: false, guest1: true, guest2: true })
  await h.rpc('cloud.stage.set', { layout: 'side-by-side', onStage: all })
  await h.rpc('sounds.settings', { volumeDb: -6 })
  await check('gain-minus-six', expected - 6)
  await h.rpc('sounds.stop', { id: sound.id })
  await check('loop-stopped', null)
  await h.rpc('sounds.settings', { monitor: true, volumeDb: 0 })
  await h.rpc('sounds.update', { id: sound.id, mode: 'oneShot' })
  await Promise.all(Array.from({ length: 6 }, () => h.rpc('sounds.play', { id: sound.id })))
  await check('rapid-presses-one-copy', expected)
  // A reconnect must not replay that still-listed one-shot. Disable/re-enable
  // creates a fresh publisher epoch; browser reconnect is exercised below too.
  await enabled(false)
  await enabled(true)
  await waitFor(async () => (await state()).state === 'published', 'new publisher epoch')
  await check('no-one-shot-replay', null)
  await h.rpc('sounds.stop')
  // Stop a cold asset decode before it resolves; no late waveform may appear.
  await h.rpc('sounds.settings', { monitor: false })
  await enabled(false)
  await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
  await enabled(true)
  await waitFor(async () => (await state()).state === 'published', 'cold sink ready')
  await h.eval(`
    const original = window.fetch;
    window.__paritySoundDecode = { original, waiting: false, release: null };
    window.fetch = async (...args) => {
      if (String(args[0]).startsWith('videorc-asset://sound/')) {
        window.__paritySoundDecode.waiting = true;
        await new Promise(resolve => { window.__paritySoundDecode.release = resolve; });
      }
      return original(...args);
    };
  `)
  try {
    await h.rpc('sounds.play', { id: sound.id })
    await waitFor(
      () => h.eval('return window.__paritySoundDecode.waiting'),
      'cold asset decode blocked'
    )
    await h.rpc('sounds.stop', { id: sound.id })
  } finally {
    await h.eval(
      'window.fetch = window.__paritySoundDecode.original; window.__paritySoundDecode.release?.();'
    )
  }
  await check('stop-during-cold-decode', null)
  await h.rpc('sounds.play', { id: sound.id })
  await check('loop-before-reconnect', expected)
  await guest.page.context().setOffline(true)
  await waitFor(async () => (await state()).state === 'blocked', 'consumer heartbeat expires')
  await guest.page.context().setOffline(false)
  await waitFor(
    async () => (await state()).state === 'published',
    'consumer rejoined and renegotiated'
  )
  await check('loop-after-reconnect', expected)
  // An already loaded old page sends no v2 report, even after a deploy.
  // Suppress only capability transport, retaining its real playback path.
  await guest.page.route('**/api/guest/*/media', (route) => route.abort())
  await waitFor(
    async () => (await state()).state === 'blocked',
    'unconfirmed loaded page blocks auxiliary'
  )
  await check('legacy-consumer-blocks-aux-keeps-mic', null)
  await guest.page.unroute('**/api/guest/*/media')
  await waitFor(async () => (await state()).state === 'published', 'capable page resumes')
  await h.rpc('sounds.stop')
  await check('final-stop', null)
  await enabled(false)
  outcome.status = 'passed-local-real-pages'
}
