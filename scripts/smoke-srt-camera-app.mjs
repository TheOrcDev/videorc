// Plan 255 S7: the SRT Camera end to end through the dev app, with no real
// device. FFmpeg makes a 10-bit HEVC TS and an H.264 TS; a small test sender
// (scripts/fixtures/srt-test-sender.c, built here on the libsrt Videorc
// ships) sends them as SRT callers with the passphrase to a random free port
// (never 9000), in 1316-byte messages paced by the file's PCR. The feed must
// arrive clean: the decoded frame rate holds near the source's. With an
// isolated profile the smoke turns the SRT input on, starts the camera and
// holds:
//   - the waiting still before the first frame (dark, status Waiting);
//   - a sender that connects and leaves without data (a pairing check)
//     leaves the camera free for the next one;
//   - the picture after the first frame (bright, Receiving · HEVC);
//   - a second sender (another address) refused with exactly 1402;
//   - a sender that stalls until the camera holds keeps the camera and
//     its picture comes back by itself;
//   - the hold after the sender stops (the picture stays), then the still;
//   - recovery when a sender (H.264 this time) starts again;
//   - a wrong passphrase refused (code 10), with no picture;
//   - D18 self-healing: a sender killed without a goodbye that redials from
//     the same address is back within 1 s; a resolution change mid-stream
//     keeps the picture; a port change and a passphrase renewal while in
//     use restart the listener and the sender gets back in; ten drops in a
//     row bring the picture back each time and leave no thread or socket;
//   - a recording with the camera that passes the analyzer;
//   - the port closed when no scene uses the camera.
// Nothing goes live; traffic stays on this Mac (loopback and its own LAN
// address, never a link-local link).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  SRT_SMOKE_RESERVED_PORTS,
  classifyCameraPicture,
  libsrtCandidates,
  countLines,
  otherLocalAddress,
  pairingAccepted,
  pairingLeft,
  newSenderDecoding,
  senderPictureOnOutput,
  sameSenderDecoding,
  steadyFeed
} from './lib/srt-camera-smoke.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const skip = (reason) => {
  console.log(`SRT Camera smoke SKIP: ${reason}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('the SRT Camera works on macOS only for now (plan 255 D9).')

const repoRoot = resolve(import.meta.dirname, '..')
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const video = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }

const encoders = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
if (encoders.status !== 0) skip(`${ffmpegPath} does not run.`)
for (const encoder of ['libx265', 'libx264']) {
  if (!encoders.stdout.includes(encoder)) skip(`${ffmpegPath} has no ${encoder}.`)
}
const libsrtPath = libsrtCandidates(repoRoot).find((path) => existsSync(path))
if (!libsrtPath) skip('libsrt is missing: run pnpm libsrt:build:macos (or brew install srt).')

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-srt-camera-smoke-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-srt-camera-smoke-user-data-'))
mkdirSync(outputDirectory, { recursive: true })
const senderPath = join(outputDirectory, 'srt-test-sender')
const built = spawnSync(
  'cc',
  ['-O2', '-o', senderPath, join(repoRoot, 'scripts', 'fixtures', 'srt-test-sender.c')],
  { encoding: 'utf8' }
)
// No compiler is a reason to skip; a sender that does not compile is a failure.
if (built.error?.code === 'ENOENT') skip('no C compiler (cc)')
if (built.error || built.status !== 0) {
  throw new Error(`the test sender does not build (cc):\n${built.error?.message ?? built.stderr}`)
}

const senders = new Set()
/** How a timeout reads the SRT state for its message. */
let lastSrtState = async () => null
/** Times and counts the report quotes. */
const measured = {}
/** The last camera frame sample, for a timeout's message. */
let lastSample = null
/** The Preview oracle (`preview.debug.sample`), once the backend is up. */
let sampleProgram = async () => null
let stopApp = async () => {}
const steps = []
const step = (name, detail = {}) => {
  steps.push({ name, at: new Date().toISOString(), ...detail })
  console.log(`[srt-camera] ${name} ${JSON.stringify(detail)}`)
}

try {
  const hevc = join(outputDirectory, 'hevc-main10.ts')
  const hevcRed = join(outputDirectory, 'hevc-main10-red.ts')
  const h264 = join(outputDirectory, 'h264.ts')
  const hevcArgs = [
    '-c:v',
    'libx265',
    '-pix_fmt',
    'yuv420p10le',
    '-x265-params',
    'log-level=error:keyint=25:bframes=0',
    '-r',
    '25'
  ]
  makeFixture(hevc, hevcArgs)
  // Consecutive senders alternate tints, so the output can tell a new
  // sender's picture from the last one still held.
  makeFixture(hevcRed, hevcArgs, 'colorchannelmixer=rr=1:gg=0.25:bb=0.25')
  makeFixture(h264, ['-c:v', 'libx264', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p', '-r', '30'])
  const resolutionChange = join(outputDirectory, 'h264-resolution-change.ts')
  makeResolutionChangeFixture(resolutionChange)
  const hevcInfo = probe(hevc)
  assert.equal(hevcInfo.codec_name, 'hevc')
  assert.equal(hevcInfo.profile, 'Main 10', 'the HEVC fixture is 10-bit')

  let port = await freeUdpPort()
  step('port', { port })

  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      // The smoke owns the camera: the Studio's own preview at launch would stop it.
      VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3'),
      VIDEORC_SECRETS_PATH: join(userDataDir, 'videorc-secrets.json')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  const backend = launch.connections['backend-ready']
  const smoke = launch.connections['preview-motion-ready']
  const ws = await connectBackend(backend, timeoutMs)
  lastSrtState = () => request(ws, 2000, 'srtInput.get')
  sampleProgram = (rects) => request(ws, 5000, 'preview.debug.sample', { rects })

  const initial = await request(ws, timeoutMs, 'srtInput.get')
  assert.equal(initial.supported, true, 'the SRT input exists on macOS')
  assert.equal(initial.enabled, false, 'the SRT input is off by default')
  assert.equal(initial.port, 9000, 'the default port is 9000')
  assert.equal(initial.connection, 'wifi', 'the default Connection is Wi-Fi')
  const devicesOff = await request(ws, timeoutMs, 'devices.list')
  assert(
    !devicesOff.devices.some((device) => device.id === 'camera:srt-input'),
    'no SRT Camera while the setting is off'
  )

  const on = await request(ws, timeoutMs, 'srtInput.set', { enabled: true, port })
  assert.equal(on.enabled, true)
  assert.equal(on.port, port)
  assert.equal(on.passphrase.length, 32, 'a 32-character passphrase')
  let passphrase = on.passphrase
  const devicesOn = await request(ws, timeoutMs, 'devices.list')
  const entry = devicesOn.devices.find((device) => device.id === 'camera:srt-input')
  assert.equal(entry?.name, `SRT Camera (port ${port})`, 'the camera entry carries the port')
  assert(await udpPortIsFree(port), 'no port is open before a scene uses the camera')

  // The scene in use is one recording session with the camera, so the
  // camera runs exactly as long as the session (D16).
  const recordingDirectory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  // The session needs a camera that already delivers frames; the camera's
  // pacer publishes the still from its first tick.
  await request(ws, timeoutMs, 'preview.camera.start', {
    sources: { screenId: null, windowId: null, cameraId: 'camera:srt-input', testPattern: false },
    layout: layoutFor('camera-only'),
    video
  })
  await waitFor('the camera delivering frames', async () => {
    const camera = await request(ws, timeoutMs, 'preview.camera.status')
    return camera.state === 'live' && (camera.framesCaptured ?? 0) > 0 ? camera : null
  })
  const started = await request(ws, timeoutMs, 'session.start', {
    sources: {
      screenId: null,
      windowId: null,
      cameraId: 'camera:srt-input',
      testPattern: false
    },
    layout: layoutFor('camera-only'),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: recordingDirectory.capabilityId,
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  assert.equal(started.state, 'recording', `session.start: ${started.message ?? ''}`)
  step('recording started', { sessionId: started.sessionId })
  await waitFor('the camera listening and waiting', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.listening && state.status.signal === 'waiting' ? state : null
  })
  assert(!(await udpPortIsFree(port)), 'the port is open while a scene uses the camera')
  await expectPicture('waiting still before the first frame', 'still')

  // A pairing check: connect, send nothing, leave (a polite close). The
  // camera must have accepted it, then let it go, before the next sender.
  const pairing = startSender(null, port, passphrase, 'pairing-check', { pairing: true })
  const paired = await waitFor('the pairing check accepted', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return pairingAccepted(state.status) ? state : null
  })
  step('pairing check accepted', { detail: paired.status.detail })
  stopSender(pairing, 'SIGINT')
  await pairing.exited
  await waitFor('the pairing check gone', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return pairingLeft(state.status) ? state : null
  })
  step('pairing check left', {})

  const beforeFirst = await currentSession()
  const first = startSender(hevc, port, passphrase, 'hevc')
  const firstBack = await expectSenderPicture('the HEVC sender', first, beforeFirst, 25)
  measured.hevcFeed = firstBack.feed
  const receiving = await request(ws, timeoutMs, 'srtInput.get')
  assert.equal(receiving.status.senderConnected, true, 'the next sender is accepted')
  assert.equal(receiving.status.width, 1280)
  assert.equal(receiving.status.height, 720)
  assert.match(receiving.status.detail, /^Receiving · 1280 × 720 · \d+ fps · HEVC$/)

  // A second sender from another address is refused as busy (D14, D18).
  // From the first sender's own address it would be a redial, which takes
  // over at once (below).
  const otherAddress = otherLocalAddress(networkInterfaces())
  if (otherAddress) {
    const second = startSender(h264, port, passphrase, 'second', { host: otherAddress })
    const busyCode = await withTimeout(second.rejected, 'the second sender refused')
    await waitFor('the refusal in the status', async () => {
      const state = await request(ws, timeoutMs, 'srtInput.get')
      return state.status.refusal === 'secondSender' ? state : null
    })
    step('second sender refused', { from: otherAddress, code: busyCode })
    assert.equal(busyCode, 1402, 'the busy code is SRT_REJX_OVERLOAD (1402)')
    // A refusal never hides a feed that is arriving (soak, 2026-11-15).
    const refusedWhileReceiving = await request(ws, timeoutMs, 'srtInput.get')
    assert.match(
      refusedWhileReceiving.status.detail,
      /^Receiving · 1280 × 720 · \d+ fps · HEVC$/,
      'the receiving line stays while a second sender is refused'
    )
    stopSender(second)
    const still = await request(ws, timeoutMs, 'srtInput.get')
    assert.equal(still.status.codec, 'HEVC', 'the first sender keeps the camera')
  } else {
    step('second sender SKIP', { reason: 'this Mac has no local IPv4 address but loopback' })
  }

  // A sender that stalls until the camera holds, then goes on, is still the
  // same sender: the picture comes back by itself.
  first.process.kill('SIGSTOP')
  const stallTrail = []
  const stallStarted = Date.now()
  try {
    await waitFor('a stalled sender held', async () => {
      const state = await request(ws, timeoutMs, 'srtInput.get')
      stallTrail.push(`${Date.now() - stallStarted}:${state.status.signal}`)
      return state.status.signal === 'holding' ? state : null
    })
  } finally {
    step('stall trail', { trail: stallTrail.slice(0, 40) })
  }
  const atStall = (await request(ws, timeoutMs, 'srtInput.get')).status
  first.process.kill('SIGCONT')
  await waitFor('the stalled sender back', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return sameSenderDecoding(state.status, atStall) ? state : null
  })
  assert.equal(first.process.exitCode, null, 'the stalled sender was never dropped')
  step('stalled sender resumed', {})

  // D18: the sender dies without a goodbye (SIGKILL) and redials from the
  // same address at once. Its dead socket still looks live, so only the
  // same-address rule lets it in; it must be back within 1 s.
  stopSender(first)
  const killedAt = Date.now()
  await waitFor('the hold after the kill', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'holding' ? state : null
  })
  const beforeRedial = await currentSession()
  const redial = startSender(hevcRed, port, passphrase, 'redial')
  const redialConnectedAt = await withTimeout(redial.connected, 'the redial accepted')
  const redialBack = await expectSenderPicture('the redial', redial, beforeRedial, 25, {
    tint: 'red'
  })
  const redialMs = redialBack.pictureBackMs
  measured.redialAfterKill = { msAfterKill: redialConnectedAt - killedAt, pictureBackMs: redialMs }
  step('redial after a kill', measured.redialAfterKill)
  assert(
    redialConnectedAt - killedAt < 2000,
    'the redial came while the dead socket still looked live'
  )
  assert(redialMs < 1000, `a redial from the same address is back within 1 s (${redialMs} ms)`)

  stopSender(redial)
  await redial.exited
  const stoppedAt = Date.now()
  await waitFor('the hold', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'holding' ? state : null
  })
  await expectPicture('the held frame', 'picture')
  // Late in the hold the picture is still the held frame, not the still.
  await sleep(Math.max(0, 1400 - (Date.now() - stoppedAt)))
  const lateInHold = await cameraSample()
  assert(
    lateInHold && classifyCameraPicture(lateInHold) === 'picture',
    `the held frame stays up to the end of the hold (${Date.now() - stoppedAt} ms)`
  )
  await waitFor('the still after the hold', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'waiting' ? state : null
  })
  const holdMs = Date.now() - stoppedAt
  measured.holdMs = holdMs
  step('hold ended', { holdMs })
  // About 2 s, with room for the 250 ms status and the polling.
  assert(holdMs >= 1500 && holdMs <= 4000, `the last frame holds about 2 s (${holdMs} ms)`)
  await expectPicture('the still after the hold', 'still')
  // The picture follows the status: a preview that stays frozen past the
  // hold fails here, with room for one picture sample.
  const stillMs = Date.now() - stoppedAt
  measured.stillMs = stillMs
  assert(stillMs <= 5000, `the still replaces the held frame about 2 s in (${stillMs} ms)`)

  const beforeRecovery = await currentSession()
  const recovered = startSender(h264, port, passphrase, 'h264')
  const recoveredBack = await expectSenderPicture('the H.264 sender', recovered, beforeRecovery, 30)
  measured.h264Feed = recoveredBack.feed
  measured.h264PictureBackMs = recoveredBack.pictureBackMs
  assert.equal((await request(ws, timeoutMs, 'srtInput.get')).status.codec, 'H.264')
  stopSender(recovered)
  await recovered.exited
  await waitFor('waiting again', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'waiting' ? state : null
  })

  // D18: the sender changes resolution mid-stream; the picture stays.
  const beforeSwitch = await currentSession()
  const switching = startSender(resolutionChange, port, passphrase, 'resolution-change')
  await withTimeout(switching.connected, 'the resolution-change sender accepted')
  const firstSize = await waitFor('the picture before the change', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return newSenderDecoding(state.status, beforeSwitch) && state.status.width ? state : null
  })
  const signalsSeen = new Set()
  const changeStarted = Date.now()
  const changed = await waitFor('the picture after the change', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    signalsSeen.add(state.status.signal)
    return sameSenderDecoding(state.status, firstSize.status) &&
      state.status.width !== firstSize.status.width
      ? state
      : null
  })
  measured.resolutionChange = {
    from: `${firstSize.status.width}x${firstSize.status.height}`,
    to: `${changed.status.width}x${changed.status.height}`,
    signalsSeen: [...signalsSeen]
  }
  step('resolution changed', measured.resolutionChange)
  assert(!signalsSeen.has('waiting'), 'the picture never fell back to the still')
  assert.equal(changed.status.senderConnected, true, 'the same sender, never a reconnect')
  measured.resolutionChange.feed = await expectCleanFeed(
    'the feed after the change',
    30,
    3000,
    changed.status.senderSession
  )
  await expectPicture('the picture after the change', 'picture')
  stopSender(switching)
  await switching.exited
  await waitFor('waiting after the change', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'waiting' ? state : null
  })

  // D18: the listener restarts while the camera is in use (a new port, then
  // a new passphrase); the output keeps running and the sender redials.
  const beforePortSender = await currentSession()
  const portSender = startSender(hevc, port, passphrase, 'before-port-change')
  await expectSenderPicture('the sender before the port change', portSender, beforePortSender, 25, {
    steadyMs: 1000
  })
  const oldPort = port
  port = await freeUdpPort()
  const portChangeStarted = Date.now()
  await request(ws, timeoutMs, 'srtInput.set', { port })
  await waitFor('listening on the new port', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.listening && !(await udpPortIsFree(port)) ? state : null
  })
  const portListenMs = Date.now() - portChangeStarted
  await waitFor('the old port closed', async () => (await udpPortIsFree(oldPort)) || null)
  stopSender(portSender)
  const beforeAfterPort = await currentSession()
  const afterPort = startSender(hevcRed, port, passphrase, 'after-port-change')
  const afterPortBack = await expectSenderPicture(
    'the sender on the new port',
    afterPort,
    beforeAfterPort,
    25,
    { tint: 'red' }
  )
  measured.portChange = { listenMs: portListenMs, pictureBackMs: afterPortBack.pictureBackMs }
  step('port changed while in use', measured.portChange)

  const oldPassphrase = passphrase
  const renewStarted = Date.now()
  passphrase = (await request(ws, timeoutMs, 'srtInput.renewPassphrase')).passphrase
  await waitFor('the sender with the old passphrase gone', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.listening && !state.status.senderConnected ? state : null
  })
  const renewListenMs = Date.now() - renewStarted
  stopSender(afterPort)
  const stale = startSender(hevc, port, oldPassphrase, 'old-passphrase')
  assert.equal(
    await withTimeout(stale.rejected, 'the old passphrase refused'),
    10,
    'the old passphrase is refused as SRT_REJ_BADSECRET (10)'
  )
  await waitFor('the old passphrase refused in the status', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.refusal === 'wrongPassphrase' ? state : null
  })
  stopSender(stale)
  const beforeRenewed = await currentSession()
  const renewed = startSender(hevc, port, passphrase, 'new-passphrase')
  const renewedBack = await expectSenderPicture(
    'the sender with the new passphrase',
    renewed,
    beforeRenewed,
    25
  )
  measured.passphraseRenewal = {
    listenMs: renewListenMs,
    pictureBackMs: renewedBack.pictureBackMs
  }
  step('passphrase renewed while in use', measured.passphraseRenewal)
  stopSender(renewed)
  await renewed.exited
  await waitFor('waiting before the drops', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'waiting' ? state : null
  })

  // D18: ten drops in a row (SIGKILL, no goodbye), the picture back each
  // time, and no thread or socket left behind.
  const resourcesBefore = backendResources(backend.pid)
  const dropTimes = []
  for (let drop = 0; drop < 10; drop += 1) {
    const beforeDrop = await currentSession()
    const tint = drop % 2 === 0 ? 'red' : 'neutral'
    const dropping = startSender(tint === 'red' ? hevcRed : hevc, port, passphrase, `drop-${drop}`)
    const back = await expectSenderPicture(
      `the sender after drop ${drop}`,
      dropping,
      beforeDrop,
      25,
      { steadyMs: 1000, tint }
    )
    dropTimes.push(back.pictureBackMs)
    stopSender(dropping)
    await dropping.exited
    await waitFor(`the hold after drop ${drop}`, async () => {
      const state = await request(ws, timeoutMs, 'srtInput.get')
      return state.status.signal !== 'receiving' ? state : null
    })
  }
  await waitFor('waiting after the drops', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.signal === 'waiting' ? state : null
  })
  await sleep(3000) // libsrt frees closed sockets on its own clock.
  const resourcesAfter = backendResources(backend.pid)
  measured.drops = {
    pictureBackMs: dropTimes,
    maxMs: Math.max(...dropTimes),
    before: resourcesBefore,
    after: resourcesAfter
  }
  step('ten drops', measured.drops)
  assert(
    resourcesAfter.udpSockets <= resourcesBefore.udpSockets,
    `no UDP socket left behind (${resourcesBefore.udpSockets} -> ${resourcesAfter.udpSockets})`
  )
  assert(
    resourcesAfter.threads <= resourcesBefore.threads + 2,
    `no thread left behind (${resourcesBefore.threads} -> ${resourcesAfter.threads})`
  )

  const wrong = startSender(hevc, port, 'not-the-passphrase-0123456789', 'wrong-passphrase')
  assert.equal(
    await withTimeout(wrong.rejected, 'the wrong passphrase refused by libsrt'),
    10,
    'a wrong passphrase is refused as SRT_REJ_BADSECRET (10)'
  )
  await waitFor('the wrong passphrase refused', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.refusal === 'wrongPassphrase' ? state : null
  })
  const refused = await request(ws, timeoutMs, 'srtInput.get')
  assert.equal(refused.status.signal, 'waiting', 'a refused sender shows no picture')
  assert.equal(refused.status.detail, 'Sender refused: wrong passphrase')
  await expectPicture('no picture from a wrong passphrase', 'still')
  stopSender(wrong)

  // The take ends on a picture.
  const beforeLast = await currentSession()
  const lastSender = startSender(hevc, port, passphrase, 'last')
  await expectSenderPicture('the last sender', lastSender, beforeLast, 25, { steadyMs: 1000 })
  await sleep(4000) // Deliberate take length, not a readiness handshake.
  const stopped = await request(ws, timeoutMs, 'session.stop')
  stopSender(lastSender)
  const recordingPath = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 })
  const quality = await analyzeRecording(recordingPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    // Video only (D10): no microphone in this take.
    expectAudio: false,
    gates: { requireMotion: false }
  })
  writeFileSync(join(outputDirectory, 'recording-quality.json'), JSON.stringify(quality, null, 2))
  assert(quality.verdict.pass, `${recordingPath}: ${quality.verdict.failures.join('; ')}`)
  const lumas = recordingLumas(recordingPath)
  const bright = lumas.filter((luma) => luma > 60).length
  const dark = lumas.filter((luma) => luma < 45).length
  step('recording', { path: recordingPath, seconds: lumas.length, picture: bright, still: dark })
  assert(bright >= 3, `the recording shows the sender's picture (${bright} of ${lumas.length} s)`)
  assert(dark >= 3, `the recording shows the waiting still (${dark} of ${lumas.length} s)`)

  // D16: no scene uses the camera any more, so the port closes. The smoke
  // started the camera itself, so it stops it as the Studio would.
  await request(ws, timeoutMs, 'preview.camera.stop')
  await waitFor('the port closed', async () => (await udpPortIsFree(port)) || null)
  await waitFor('the status saying the port is closed', async () => {
    const state = await request(ws, timeoutMs, 'srtInput.get')
    return state.status.listening ? null : state
  })
  ws.close()
  writeFileSync(join(outputDirectory, 'srt-camera-steps.json'), JSON.stringify(steps, null, 2))
  console.log(`SRT Camera measured: ${JSON.stringify(measured)}`)
  console.log(`SRT Camera smoke PASS (port ${port}); evidence in ${outputDirectory}`)

  async function currentSession() {
    return (await request(ws, timeoutMs, 'srtInput.get')).status.senderSession
  }

  /**
   * "The picture is back" for a new sender: libsrt accepted it, the camera
   * decodes that sender's own frames (a newer session with frames of its
   * own) and the output shows them in that sender's tint, never the last
   * sender's picture still held. Then the feed stays steady at the
   * source's rate.
   */
  async function expectSenderPicture(
    label,
    sender,
    previousSession,
    sourceFps,
    { steadyMs = 3000, tint = 'neutral' } = {}
  ) {
    const connectedAt = await withTimeout(sender.connected, `${label} accepted`)
    const back = await waitFor(`${label}: its own frames on the output`, async () => {
      const { status } = await request(ws, timeoutMs, 'srtInput.get')
      if (!newSenderDecoding(status, previousSession)) return null
      const sample = await cameraSample()
      return senderPictureOnOutput(status, previousSession, sample, tint)
        ? { status, sample }
        : null
    })
    const pictureBackMs = Date.now() - connectedAt
    step(`${label} on the output`, {
      tint,
      meanR: Math.round(back.sample.meanR),
      meanG: Math.round(back.sample.meanG),
      meanB: Math.round(back.sample.meanB)
    })
    const session = back.status.senderSession
    const feed = await expectCleanFeed(label, sourceFps, steadyMs, session)
    return { pictureBackMs, session, feed }
  }

  /**
   * A steady stretch, all from one sender session: once the rate has a
   * second of that sender's frames behind it, status receiving the whole
   * time at the source's rate.
   */
  async function expectCleanFeed(label, sourceFps, steadyMs = 3000, session = undefined) {
    await sleep(1000) // A second of frames for the rate, not a readiness handshake.
    const samples = []
    const until = Date.now() + steadyMs
    while (Date.now() < until) {
      samples.push((await request(ws, timeoutMs, 'srtInput.get')).status)
      await sleep(250)
    }
    const fps = samples.map((status) => status.fps ?? null)
    step(`${label} clean`, { sourceFps, fps })
    assert(
      steadyFeed(samples, sourceFps),
      `${label} arrives clean: decoded at ${JSON.stringify(fps)} fps for a ${sourceFps} fps source`
    )
    if (session !== undefined) {
      assert(
        samples.every((status) => status.senderSession === session),
        `${label}: one sender session the whole stretch`
      )
    }
    return { sourceFps, fps }
  }

  async function expectPicture(label, expected) {
    const picture = await waitFor(label, async () => {
      const sample = await cameraSample()
      return sample && classifyCameraPicture(sample) === expected ? sample : null
    })
    step(label, { meanLuma: Math.round(picture.meanLuma), chroma: Math.round(picture.chroma) })
  }
} catch (error) {
  console.error(`SRT Camera smoke FAILED: ${error?.stack ?? error}`)
  writeFileSync(join(outputDirectory, 'srt-camera-steps.json'), JSON.stringify(steps, null, 2))
  process.exitCode = 1
} finally {
  for (const sender of senders) stopSender(sender)
  await stopApp()
}

function makeFixture(path, codecArgs, filter = null) {
  const made = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '8',
      ...(filter ? ['-vf', filter] : []),
      ...codecArgs,
      '-c:a',
      'aac',
      '-f',
      'mpegts',
      path
    ],
    { encoding: 'utf8' }
  )
  assert.equal(made.status, 0, `fixture ${path}: ${made.stderr}`)
}

function probe(path) {
  const probed = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,profile',
      '-of',
      'json',
      path
    ],
    { encoding: 'utf8' }
  )
  return JSON.parse(probed.stdout).streams[0]
}

/**
 * Starts the test sender: a TS file looped in real time, or (`pairing`) a
 * connection that sends nothing. `connected` resolves with the time the
 * camera accepted it; `rejected` with the reject code when it refused it.
 */
function startSender(path, port, passphrase, label, { pairing = false, host = '127.0.0.1' } = {}) {
  const args = [libsrtPath, host, String(port), passphrase, path ?? '/dev/null']
  args.push(pairing ? '--pairing' : '--loop')
  const child = spawn(senderPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const sender = { label, process: child, log: '' }
  let onConnected
  let onRejected
  sender.connected = new Promise((resolveConnected) => (onConnected = resolveConnected))
  sender.rejected = new Promise((resolveRejected) => (onRejected = resolveRejected))
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (text) => {
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      sender.log = (sender.log + line + '\n').slice(-4000)
      if (line === 'CONNECTED') onConnected(Date.now())
      const refused = /^REJECTED (\d+)$/.exec(line)
      if (refused) onRejected(Number(refused[1]))
    }
  })
  child.stderr.on('data', (text) => {
    sender.log = (sender.log + text).slice(-4000)
  })
  sender.exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  senders.add(sender)
  step(`sender ${label} started`, {})
  return sender
}

/** SIGKILL by default: the sender dies without a goodbye. */
function stopSender(sender, signal = 'SIGKILL') {
  sender.process.kill(signal)
  senders.delete(sender)
}

async function withTimeout(promise, label, limitMs = 10_000) {
  let timer
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimeout(() => rejectTimeout(new Error(`Timed out waiting for ${label}`)), limitMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The program frame (the camera fills it) over a 4 x 4 grid of cells. */
async function cameraSample() {
  const rects = []
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      rects.push({ x: column / 4, y: row / 4, w: 0.25, h: 0.25 })
    }
  }
  const frame = await sampleProgram(rects).catch((error) => ({ error: String(error) }))
  if (!Array.isArray(frame?.samples)) {
    lastSample = frame
    return null
  }
  lastSample = gridStats(frame.samples)
  return lastSample
}

function gridStats(samples) {
  let [luma, chroma, red, green, blue] = [0, 0, 0, 0, 0]
  for (const { r, g, b } of samples) {
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    chroma += Math.max(r, g, b) - Math.min(r, g, b)
    red += r
    green += g
    blue += b
  }
  const n = samples.length
  return {
    meanLuma: luma / n,
    chroma: chroma / n,
    meanR: red / n,
    meanG: green / n,
    meanB: blue / n
  }
}

function rgbStats(bytes) {
  let luma = 0
  let chroma = 0
  const pixels = bytes.length / 3
  for (let i = 0; i < bytes.length; i += 3) {
    const [r, g, b] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    chroma += Math.max(r, g, b) - Math.min(r, g, b)
  }
  return { meanLuma: luma / pixels, chroma: chroma / pixels }
}

/** The backend's threads and UDP sockets, to catch a leak across drops. */
function backendResources(pid) {
  const threads = spawnSync('ps', ['-M', '-p', String(pid)], { encoding: 'utf8' })
  const udp = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-i', 'UDP'], {
    encoding: 'utf8'
  })
  const counts = {
    threads: countLines(threads.stdout ?? ''),
    udpSockets: countLines(udp.stdout ?? '')
  }
  // Both samples come while the port listens: a count of 0 is a failed probe.
  assert(threads.status === 0 && counts.threads > 0, `ps read the backend's threads`)
  assert(udp.status === 0 && counts.udpSockets > 0, `lsof read the listening UDP socket`)
  return counts
}

/** H.264 at 1280 x 720 for 4 s, then 960 x 540 for 4 s, in one TS. */
function makeResolutionChangeFixture(path) {
  const parts = [
    [join(outputDirectory, 'part-720.ts'), '1280x720'],
    [join(outputDirectory, 'part-540.ts'), '960x540']
  ]
  for (const [part, size] of parts) {
    const made = spawnSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30`,
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-bf',
        '0',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'mpegts',
        part
      ],
      { encoding: 'utf8' }
    )
    assert.equal(made.status, 0, `fixture ${part}: ${made.stderr}`)
  }
  const list = join(outputDirectory, 'resolution-change.txt')
  writeFileSync(list, parts.map(([part]) => `file '${part}'`).join('\n'))
  const joined = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      '-f',
      'mpegts',
      path
    ],
    { encoding: 'utf8' }
  )
  assert.equal(joined.status, 0, `fixture ${path}: ${joined.stderr}`)
}

/** Mean luma of one frame per second of the recording. */
function recordingLumas(path) {
  const raw = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      'fps=1,scale=32:18',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ],
    { maxBuffer: 1 << 24 }
  )
  if (raw.status !== 0) return []
  const frame = 32 * 18 * 3
  const lumas = []
  for (let offset = 0; offset + frame <= raw.stdout.length; offset += frame) {
    lumas.push(Math.round(rgbStats(raw.stdout.subarray(offset, offset + frame)).meanLuma))
  }
  return lumas
}

async function freeUdpPort() {
  for (;;) {
    const port = await new Promise((resolvePort, rejectPort) => {
      const socket = createSocket('udp4')
      socket.once('error', rejectPort)
      socket.bind(0, () => {
        const chosen = socket.address().port
        socket.close(() => resolvePort(chosen))
      })
    })
    if (!SRT_SMOKE_RESERVED_PORTS.includes(port)) return port
  }
}

function udpPortIsFree(port) {
  return new Promise((resolveFree) => {
    const socket = createSocket('udp4')
    socket.once('error', () => resolveFree(false))
    socket.bind(port, '0.0.0.0', () => socket.close(() => resolveFree(true)))
  })
}

async function waitFor(label, probeOnce, limitMs = 20_000) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const value = await probeOnce()
    if (value) return value
    if (Date.now() > deadline) {
      const state = await lastSrtState().catch(() => null)
      throw new Error(
        `Timed out waiting for ${label}: ${JSON.stringify(state?.status ?? null)}, last camera sample ${JSON.stringify(lastSample)}`
      )
    }
    await sleep(100)
  }
}

function layoutFor(layoutPreset) {
  return {
    layoutPreset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
