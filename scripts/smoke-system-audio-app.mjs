// System audio smoke (plan 069 S7): the computer's sound in recordings and
// streams, through the REAL dev app and its ScreenCaptureKit capture.
//
// macOS only. It needs the dev app's Screen Recording grant (System Settings >
// Privacy & Security > Screen & System Audio Recording), the same grant the
// real SCK screen smoke needs. Without it the smoke FAILS with the reason;
// VIDEORC_SYSTEM_AUDIO_SMOKE_ALLOW_MISSING_GRANT=1 turns that into an explicit
// SKIP (exit 0, "SKIPPED" in the output), never a silent pass.
//
// Run it in a quiet state: it plays a 1 kHz tone through the speakers with
// `afplay` (the owner's volume, mute and output device are never touched;
// capture is before the master volume) and records what the computer plays.
// A looping silent afplay keeps the output device awake for the whole run, so
// a tone starts within a few hundred ms of its request instead of up to ~2 s
// on a cold device.
// Artifact verdicts use a 1 kHz-selective measure, so music or a notification
// during a run cannot fake the tone; only energy at 1 kHz can fail a silence
// check. The Off case also requires broadband digital silence, which holds
// whatever else plays, because Off means nothing is captured.
// The clips-idle case reads the bus's window peaks instead, so it needs a
// quiet host outside its tone to prove the readings return to the floor.
//
// Sessions: a screen-only scene on the renderer's synthetic source, no
// microphone (VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE=1, so the bus writes
// paced silence for the mic slot), like smoke:record-latency. Cases a-d and
// the mid-session On case drive Record/Stop and the System audio switch
// through remote-control intents (recordStart/recordStop,
// systemAudioOn/systemAudioOff), the same renderer path a Stream Deck key or
// the phone uses. Case e starts record+stream on the backend directly to a
// local RTMP listener.
//
//   on          System audio On, tone at 3-6 s: tone in the file, silence elsewhere.
//   toggle-off  On, 6 s tone from 2 s, systemAudioOff at 5 s: tone stops at the
//               bus cutover (within 50 ms + the 5 ms ramp), silence after.
//   toggle-on   Off, 8 s tone from 2 s, systemAudioOn at 5 s: tone enters at the
//               attach cutover, not before.
//   off         System audio Off, tone at 3-6 s: no tone, digital silence, no
//               system source in the mix (the privacy gate).
//   self        On, a 1 kHz WebAudio tone played by Videorc's own renderer at
//               3-6 s must be absent; an afplay control tone at 8 s must be
//               present (self-exclusion, plan 069 decision 9 amended).
//   stream      Record + stream with System audio On, tone at 3-6 s: in the
//               file and in the stream the local RTMP listener received.
//   clips-idle  Clips on, no recording, tone at 2-5 s, Gain -6 -> -18 at
//               3.5 s: ring levels drop 12 +/- 2 dB, then return to the floor.
//
// File time and the toggle reference: all times are seconds from the file's
// first video frame (the session's video epoch; see system-audio-gates.mjs).
// The backend logs each mix cutover as a bus sample index ("System audio
// joined/left the session mix at sample N"); sample N is file time
// audioStart - videoStart + N / 48000. That is the reference for the 50 ms
// gate. The confirmed toggle (the recording.status whose mixSources changed)
// and the intent are wall-clock instants; they map to file time from the
// receipt of recording.status(recording) (file time ~0), and are reported
// next to the cutover for diagnosis only, because the bus plays out 150 ms
// behind the wall clock and event delivery adds jitter.
//
//   node scripts/smoke-system-audio-app.mjs [--cases on,toggle-off,...] [--debug]

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'

import {
  launchScreenMotionStimulus,
  stopScreenMotionStimulus,
  stimulusWindowOptionsForSource
} from './lib/screen-motion-stimulus.mjs'
import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { resolveExistingSiblingFfprobe } from './lib/ffmpeg-sibling-paths.mjs'
import {
  connectRemote,
  enableRemoteControl,
  remoteRequest,
  waitForRemoteDescribe
} from './lib/remote-control-client.mjs'
import { syntheticCompositorReady } from './lib/remote-control-smoke-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  CLIPS_IDLE_LEVEL_GATES,
  SYSTEM_AUDIO_GATES,
  analyzeSystemAudioArtifact,
  bandMaxDbfs,
  cutoverFileSeconds,
  evaluateClipsIdleCase,
  evaluateRecordAndStreamCase,
  evaluateSelfExclusionCase,
  evaluateSystemAudioOffCase,
  evaluateToggleOffCase,
  evaluateToggleOnCase,
  evaluateToneCapturedCase,
  evaluateMixedToneCapturedCase,
  evaluateStaticScreenEpoch,
  parseRecordingEpochLine,
  mixSourcesIncludeSystemAudio,
  parseSystemAudioMixCutover,
  reportDbfs,
  toneWavArgs,
  wallToFileSeconds
} from './lib/system-audio-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const ALL_CASES = ['clips-idle', 'on', 'toggle-off', 'toggle-on', 'off', 'self', 'stream']

const { values: args } = parseArgs({
  options: {
    cases: { type: 'string', default: ALL_CASES.join(',') },
    report: { type: 'string' },
    'static-screen-id': { type: 'string' },
    'app-executable': { type: 'string' },
    microphone: { type: 'boolean', default: false },
    moving: { type: 'boolean', default: false },
    camera: { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})

const selectedCases = args.cases.split(',').map((name) => name.trim())
for (const name of selectedCases) {
  if (!ALL_CASES.includes(name)) fail(`unknown case "${name}" (known: ${ALL_CASES.join(', ')})`)
}
const staticScreenId = args['static-screen-id']
const appExecutable = args['app-executable']
const packagedCapability = appExecutable ? randomBytes(32).toString('base64url') : undefined
if (
  appExecutable &&
  (!staticScreenId || selectedCases.some((name) => ['self', 'stream', 'clips-idle'].includes(name)))
) {
  fail(
    '--app-executable requires --static-screen-id and --cases on,toggle-off,toggle-on,off; packaged setup uses the Studio UI, without eval-js'
  )
}
const debug = args.debug || process.env.VIDEORC_SYSTEM_AUDIO_SMOKE_DEBUG === '1'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const allowMissingGrant = process.env.VIDEORC_SYSTEM_AUDIO_SMOKE_ALLOW_MISSING_GRANT === '1'
const recordSeconds = 12
const idleGapMs = 1500
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-system-audio-${Date.now()}`)
)
const reportPath = resolve(args.report ?? join(outputDirectory, 'system-audio-report.json'))
// The bundled FFmpeg generates the tone and decodes the artifacts when it is
// staged; any FFmpeg with lavfi and ffprobe works.
const bundledFfmpeg = join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffmpeg')
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg')
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveExistingSiblingFfprobe(ffmpegPath) ?? 'ffprobe'
const rtmpPort = Number(process.env.VIDEORC_SYSTEM_AUDIO_SMOKE_RTMP_PORT ?? 19853)

function fail(message) {
  throw new Error(`system-audio smoke FAIL: ${message}`)
}

function log(message) {
  console.log(`system-audio: ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Buffers backend events with a monotonic receive time so a waiter registered
 * before an action never misses the event it waits for.
 */
class BackendEventRecorder {
  constructor(ws) {
    this.events = []
    this.waiters = new Set()
    this.systemAudioActiveSamples = []
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message?.event) return
      const record = { event: message.event, payload: message.payload, at: performance.now() }
      if (message.event === 'diagnostics.stats') {
        this.systemAudioActiveSamples.push({
          at: record.at,
          sessionId: message.payload?.sessionId,
          active: message.payload?.systemAudioActive === true
        })
        return
      }
      this.events.push(record)
      if (debug && message.event === 'recording.status') {
        console.log(
          `[event] recording.status ${message.payload?.state ?? ''} ${JSON.stringify(
            (message.payload?.audioTracks ?? []).map((track) => track.mixSources)
          )}`
        )
      }
      for (const waiter of this.waiters) {
        if (waiter.predicate(record)) {
          this.waiters.delete(waiter)
          waiter.resolve(record)
        }
      }
    })
  }

  waitFor(label, predicate, waitTimeoutMs = timeoutMs) {
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, resolve: null }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        rejectWait(new Error(`timed out waiting for ${label}`))
      }, waitTimeoutMs)
      waiter.resolve = (record) => {
        clearTimeout(timer)
        resolveWait(record)
      }
      this.waiters.add(waiter)
    })
  }

  between(from, to, predicate) {
    return this.events.filter((record) => record.at >= from && record.at <= to && predicate(record))
  }
}

/** Collects every `remote.ack` so an intent's ack can never be missed. */
class RemoteAcks {
  constructor(remote) {
    this.acks = new Map()
    this.waiters = new Map()
    remote.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (message.event !== 'remote.ack') return
      const intentId = message.payload?.intentId
      this.acks.set(intentId, message.payload)
      this.waiters.get(intentId)?.(message.payload)
    })
  }

  wait(intentId, label) {
    if (this.acks.has(intentId)) return Promise.resolve(this.acks.get(intentId))
    return new Promise((resolveAck, rejectAck) => {
      const timer = setTimeout(() => {
        this.waiters.delete(intentId)
        rejectAck(new Error(`timed out waiting for the ${label} ack`))
      }, timeoutMs)
      this.waiters.set(intentId, (payload) => {
        clearTimeout(timer)
        this.waiters.delete(intentId)
        resolveAck(payload)
      })
    })
  }
}

/** Mix cutovers the backend logs, with their receive time. */
const cutovers = []
const exclusionWarnings = []
const startupEpochs = []
const audioSummaries = []
const microphoneSummaries = []

function onAppLine(line) {
  const epoch = parseRecordingEpochLine(line)
  if (epoch) startupEpochs.push({ at: performance.now(), ...epoch })
  const mic =
    /Native microphone capture ended for (.+): state=([^,]+), sourceLossAfterMs=([^,]+), (\d+) frames captured, (\d+) frames dropped/.exec(
      line
    )
  if (mic)
    microphoneSummaries.push({
      at: performance.now(),
      device: mic[1],
      state: mic[2],
      sourceLoss: mic[3],
      capturedFrames: Number(mic[4]),
      droppedFrames: Number(mic[5])
    })
  const dropped = /ahead-of-cap=(\d+)/.exec(line)
  if (dropped) audioSummaries.push({ at: performance.now(), aheadCapDrops: Number(dropped[1]) })
  const cutover = parseSystemAudioMixCutover(line)
  if (cutover) cutovers.push({ ...cutover, at: performance.now() })
  if (/could not find the Videorc app to exclude|without excluding the Electron main/.test(line)) {
    exclusionWarnings.push(line.trim())
  }
  if (debug) console.log('[app]', line)
}

const players = new Set()
let keepAlive = null

/**
 * Plays digital silence for the whole run so the output device stays awake.
 * A cold device delayed afplay's first sound by up to ~1.9 s; a running one
 * starts it within a few hundred ms. Silence adds nothing to the capture.
 */
function startKeepAlive(wavPath) {
  if (keepAlive?.stopped) return
  const child = spawn('afplay', [wavPath], { stdio: 'ignore' })
  keepAlive = { child, wavPath, stopped: false }
  child.on('exit', () => {
    if (keepAlive && !keepAlive.stopped && keepAlive.child === child) startKeepAlive(wavPath)
  })
  child.on('error', (error) => log(`keep-alive afplay failed: ${error.message}`))
}

function stopKeepAlive() {
  if (!keepAlive) return
  keepAlive.stopped = true
  keepAlive.child.kill('SIGTERM')
}

/** Plays a WAV with afplay and returns the wall time of the spawn. */
function playTone(wavPath) {
  const at = performance.now()
  const child = spawn('afplay', [wavPath], { stdio: 'ignore' })
  players.add(child)
  child.on('exit', () => players.delete(child))
  child.on('error', (error) => log(`afplay failed: ${error.message}`))
  return at
}

function stopPlayers() {
  for (const child of players) child.kill('SIGTERM')
  players.clear()
}

function runFfmpeg(argsList) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, argsList, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => (stderr += text))
    child.on('error', rejectRun)
    child.on('close', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`ffmpeg failed: ${stderr.trim()}`))
    )
  })
}

async function generateTones(directory) {
  mkdirSync(directory, { recursive: true })
  const tones = {}
  for (const seconds of [2, 3, 6, 8]) {
    const path = join(directory, `tone-1k-${seconds}s.wav`)
    await runFfmpeg(toneWavArgs(path, { seconds }))
    tones[seconds] = path
  }
  tones.silence = join(directory, 'silence-60s.wav')
  await runFfmpeg([
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=8000:cl=mono',
    '-t',
    '60',
    '-c:a',
    'pcm_s16le',
    tones.silence
  ])
  return tones
}

function statusEvent(state, sessionId) {
  return (record) =>
    record.event === 'recording.status' &&
    record.payload?.state === state &&
    (sessionId === undefined || record.payload?.sessionId === sessionId)
}

function mixEvent(sessionId, wantSystemAudio) {
  return (record) =>
    record.event === 'recording.status' &&
    record.payload?.sessionId === sessionId &&
    (record.payload?.state === 'recording' || record.payload?.state === 'streaming') &&
    mixSourcesIncludeSystemAudio(record.payload) === wantSystemAudio
}

function healthEvent(sessionId, codes) {
  return (record) =>
    record.event === 'health.event' &&
    codes.includes(record.payload?.code) &&
    (record.payload?.sessionId === undefined || record.payload?.sessionId === sessionId)
}

/** Waits for the session's mix to (not) include system audio; health failures fail fast. */
async function waitForMix(recorder, sessionId, wantSystemAudio, label) {
  const unavailable = recorder
    .waitFor(
      `${label} health`,
      healthEvent(sessionId, ['system-audio-unavailable', 'system-audio-lost']),
      15000
    )
    .then((record) => {
      fail(`${label}: ${record.payload.code}: ${record.payload.message ?? ''}`)
    })
    .catch((error) => {
      if (String(error.message).startsWith('system-audio smoke FAIL')) throw error
      return new Promise(() => {})
    })
  return Promise.race([
    recorder.waitFor(label, mixEvent(sessionId, wantSystemAudio), 15000),
    unavailable
  ])
}

async function sendIntent(remote, acks, kind) {
  const ticket = await remoteRequest(remote, 'remote.intent', { kind }, { timeoutMs })
  if (!ticket.payload?.accepted) fail(`${kind} intent was not accepted: ${JSON.stringify(ticket)}`)
  const ack = await acks.wait(ticket.payload.intentId, kind)
  if (ack.ok !== true) fail(`${kind} was refused: ${ack.message ?? JSON.stringify(ack)}`)
  return ack
}

async function waitForPublishedMp4({ ws, recorder, sessionId, idleRecord }) {
  const idlePath = idleRecord?.payload?.outputPath
  if (typeof idlePath === 'string' && idlePath.toLowerCase().endsWith('.mp4')) return idlePath
  const deadline = performance.now() + 30000
  for (;;) {
    const finalized = recorder.events.find(
      (record) =>
        record.event === 'recording.finalization' &&
        record.payload?.sessionId === sessionId &&
        (record.payload?.state === 'finalized' || record.payload?.state === 'failed')
    )
    if (finalized) {
      if (finalized.payload.state === 'failed') {
        fail(`finalization failed for ${sessionId}: ${finalized.payload.error ?? 'unknown'}`)
      }
      return finalized.payload.mp4Path
    }
    const page = await request(ws, timeoutMs, 'sessions.list', { limit: 20 })
    const item = page?.items?.find((entry) => entry.id === sessionId)
    if (item?.mp4Path) return item.mp4Path
    if (item?.finalizationState === 'failed') {
      fail(`finalization failed for ${sessionId}: ${item.finalizationError ?? 'unknown'}`)
    }
    if (performance.now() > deadline) fail(`MP4 for ${sessionId} was not published in 30 s`)
    await sleep(250)
  }
}

async function waitForBackendState(ws, method, predicate, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, method)
    if (predicate(last)) return last
    await sleep(100)
  }
  fail(`timed out waiting for ${label}; last ${method}: ${JSON.stringify(last)}`)
}

async function seedRenderer(smoke, sources) {
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const key = 'videorc.captureConfig';
        let current = {};
        try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
        // Screen-only on the synthetic source (the dev app has no camera
        // grant), with Clips on. The idle case starts with System audio On.
        const layout = { ...(current.layout ?? {}), layoutPreset: 'screen-only' };
        const audio = { ...(current.audio ?? {}), systemAudioEnabled: params.systemAudioEnabled, systemAudioGainDb: -6 };
        localStorage.setItem(key, JSON.stringify({ ...current, video: params.video, sources: params.sources ?? current.sources, layout, audio, recordEnabled: true, streamEnabled: false, replayBuffer: { enabled: true, explicit: false } }));
        setTimeout(() => location.reload(), 50);
        return true;
      `,
      sources,
      systemAudioEnabled: selectedCases[0] === 'clips-idle',
      video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
    },
    { timeoutMs }
  )
  await sleep(2500)
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `await waitFor('[data-videorc-tab-trigger="studio"]', 60000); return true;`
    },
    { timeoutMs }
  )
}

/**
 * Plays a 1 kHz WebAudio tone from Videorc's own renderer. Resolves once it
 * is audibly running, with proof it runs (context state, analyser peak).
 */
async function playRendererTone(smoke, seconds) {
  const response = await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = 1000;
        const gain = context.createGain();
        gain.gain.value = 0.5;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        oscillator.connect(gain);
        gain.connect(analyser);
        gain.connect(context.destination);
        oscillator.start();
        window.__videorcSystemAudioSmokeTone = { context, oscillator };
        setTimeout(() => {
          try { oscillator.stop(); } catch {}
          context.close().catch(() => {});
          delete window.__videorcSystemAudioSmokeTone;
        }, params.seconds * 1000);
        await sleep(150);
        const buffer = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) peak = Math.max(peak, Math.abs(value));
        return { contextState: context.state, analyserPeak: peak, sampleRate: context.sampleRate, currentTime: context.currentTime };
      `,
      seconds
    },
    { timeoutMs }
  )
  return response?.result ?? null
}

/** Best-effort: the renderer's visible start-failure copy, for diagnostics. */
async function describeRendererFailure(smoke) {
  try {
    const response = await requestSmokeCommand(
      smoke,
      'eval-js',
      {
        code: `
          const nodes = Array.from(document.querySelectorAll('[role="alert"], [data-sonner-toast], [data-videorc-start-failure]'));
          return nodes.map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 4);
        `
      },
      { timeoutMs: 5000 }
    )
    const texts = response?.result
    return Array.isArray(texts) && texts.length > 0 ? ` Renderer says: ${texts.join(' | ')}` : ''
  } catch {
    return ''
  }
}

async function setSystemAudio(ctx, enabled) {
  await sendIntent(ctx.remote, ctx.acks, enabled ? 'systemAudioOn' : 'systemAudioOff')
}

/**
 * One renderer-driven session: Record via the remote intent, run the case's
 * timeline against file time ~0 = recording.status(recording), Stop, and
 * return the published MP4 with the session's events.
 */
async function recordRendererSession(ctx, { name, systemAudioAtStart, timeline }) {
  const { recorder, remote, acks, renderer } = ctx
  await setSystemAudio(ctx, systemAudioAtStart)
  if (ctx.microphone) {
    await request(renderer, timeoutMs, 'audio.mic.arm', {
      microphoneId: ctx.microphone.id,
      microphoneGainDb: 0,
      microphoneMuted: false
    })
  }
  if (staticScreenId && !args.moving) {
    const ready = await waitForBackendState(
      renderer,
      'diagnostics.stats',
      (stats) =>
        stats.previewScreenFrameAgeMs >= 10000 && stats.previewScreenCaptureCallbackAgeMs < 500,
      'a real static screen held for 10s with live capture callbacks'
    )
    log(
      `static screen ready: content age ${ready.previewScreenFrameAgeMs}ms, callback age ${ready.previewScreenCaptureCallbackAgeMs}ms`
    )
  }
  const recordingPromise = recorder.waitFor(
    `${name} recording.status(recording)`,
    (record) =>
      record.event === 'recording.status' &&
      (record.payload?.state === 'recording' || record.payload?.state === 'streaming') &&
      typeof record.payload?.sessionId === 'string'
  )
  const clickAt = performance.now()
  const startTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'recordStart' },
    {
      timeoutMs
    }
  )
  if (!startTicket.payload?.accepted) fail(`${name}: recordStart was not accepted`)
  // A refused start acks ok=false without ever publishing `recording`.
  const startAckPromise = acks.wait(startTicket.payload.intentId, 'recordStart')
  const recording = await Promise.race([
    recordingPromise,
    startAckPromise.then((ack) => {
      if (ack.ok !== true) {
        return describeRendererFailure(ctx.smoke).then((detail) =>
          fail(`${name}: recordStart was refused: ${ack.message ?? 'no message'}.${detail}`)
        )
      }
      return recordingPromise
    })
  ])
  const startAck = await startAckPromise
  if (startAck.ok !== true) fail(`${name}: recordStart refused: ${startAck.message ?? ''}`)
  const sessionId = recording.payload.sessionId
  const epochAt = recording.at
  const at = (seconds) => sleep(epochAt + seconds * 1000 - performance.now())
  const marks = {}
  if (systemAudioAtStart) {
    const attached = await waitForMix(recorder, sessionId, true, `${name} attach at start`)
    marks.attachConfirmedAt = attached.at
  }
  await timeline({ at, marks, sessionId })
  await at(recordSeconds)
  const terminalPromise = recorder.waitFor(
    `${name} terminal status`,
    (record) =>
      record.event === 'recording.status' &&
      record.payload?.sessionId === sessionId &&
      (record.payload?.state === 'idle' || record.payload?.state === 'failed')
  )
  const stopAt = performance.now()
  const stopTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'recordStop' },
    {
      timeoutMs
    }
  )
  if (!stopTicket.payload?.accepted) fail(`${name}: recordStop was not accepted`)
  const terminal = await terminalPromise
  if (terminal.payload.state !== 'idle') {
    fail(`${name}: session ended ${terminal.payload.state}: ${terminal.payload.message ?? ''}`)
  }
  await acks.wait(stopTicket.payload.intentId, 'recordStop')
  const mp4Path = await waitForPublishedMp4({
    ws: renderer,
    recorder,
    sessionId,
    idleRecord: terminal
  })
  return { sessionId, clickAt, epochAt, stopAt, endAt: terminal.at, mp4Path, marks }
}

function sessionWindow(recorder, session) {
  const inSession = (record) =>
    record.payload?.sessionId === undefined || record.payload?.sessionId === session.sessionId
  const statuses = recorder.between(
    session.clickAt,
    session.endAt,
    (record) => record.event === 'recording.status' && inSession(record)
  )
  return {
    mixedStatusCount: statuses.filter((record) => mixSourcesIncludeSystemAudio(record.payload))
      .length,
    health: recorder
      .between(
        session.clickAt,
        session.endAt,
        (record) =>
          record.event === 'health.event' &&
          /^(system-audio|microphone-input-lost|microphone-timeline-lost)/.test(
            String(record.payload?.code ?? '')
          ) &&
          inSession(record)
      )
      .map((record) => record.payload.code),
    // Plan 181 (redesign R2): the clip ring runs by default and Record hands
    // over from it, so the ring's own diagnostics (a system-audio source the
    // previous case left on) still arrive just after the click; only this
    // session's samples count.
    systemAudioActiveSamples: recorder.systemAudioActiveSamples.filter(
      (sample) =>
        sample.at >= session.clickAt &&
        sample.at <= session.endAt &&
        sample.active &&
        (sample.sessionId === undefined || sample.sessionId === session.sessionId)
    ).length
  }
}

function cutoverAfter(kind, fromAt, toAt) {
  return cutovers.find((entry) => entry.kind === kind && entry.at >= fromAt && entry.at <= toAt)
}

async function analyzeArtifact(path, label) {
  if (!path || !existsSync(path)) fail(`${label}: artifact missing: ${path}`)
  const analysis = await analyzeSystemAudioArtifact(path, { ffmpegPath, ffprobePath })
  const { audio, video } = analysis.probe
  if (audio.sampleRate !== 48000 || audio.channels !== 2) {
    fail(`${label}: audio is ${audio.sampleRate} Hz x${audio.channels}, expected 48000 Hz stereo`)
  }
  if (!video) fail(`${label}: no video stream`)
  return analysis
}

function artifactEvidence(analysis, path) {
  return {
    path,
    audioCodec: analysis.probe.audio.codec,
    videoCodec: analysis.probe.video.codec,
    durationSeconds: round(analysis.probe.durationSeconds),
    audioOffsetSeconds: round(analysis.timeOffsetSeconds),
    broadbandPeakDbfs: reportDbfs(analysis.broadbandPeak),
    bandMaxDbfs: reportDbfs(bandMaxDbfs(analysis.envelope))
  }
}

function checkDuration(analysis, label, failures) {
  const seconds = analysis.probe.durationSeconds
  if (!(seconds >= recordSeconds - 1.5 && seconds <= recordSeconds + 2.5)) {
    failures.push(
      `${label}: the file is ${seconds.toFixed(2)} s long, expected ~${recordSeconds} s`
    )
  }
}

const cases = {
  async 'clips-idle'(ctx) {
    await setSystemAudio(ctx, true)
    const ring = await waitForBackendState(
      ctx.renderer,
      'replay.status',
      (status) => status?.state === 'on' && status?.replayOnly === true,
      'clips-idle ring on without recording'
    )
    const ringStatus = (record) =>
      statusEvent('recording', ring.sessionId)(record) && record.payload?.replayOnly === true
    const ready =
      ctx.recorder.events.findLast(ringStatus) ??
      (await ctx.recorder.waitFor('clips-idle recording.status(replayOnly: true)', ringStatus))
    const configureGain = async (gainDb) => {
      const response = await requestSmokeCommand(
        ctx.smoke,
        'eval-js',
        {
          code: `
          const harness = window.__videorcSmokeScenePresets;
          if (!harness) throw new Error('renderer configure smoke hook unavailable');
          const current = harness.streamingState().captureConfig;
          harness.configure({ audio: { ...current.audio, systemAudioGainDb: params.gainDb } });
          return true;
        `,
          gainDb
        },
        { timeoutMs }
      )
      if (response?.result !== true) fail('clips-idle: renderer gain update failed')
    }
    await configureGain(-6)
    const startedAt = performance.now()
    const at = (seconds) => sleep(startedAt + seconds * 1000 - performance.now())
    try {
      await at(2)
      const toneStartAt = playTone(ctx.tones[3])
      await at(3.5)
      const gainChangedAt = performance.now()
      await configureGain(-18)
      await at(7)
      const endedAt = performance.now()
      const levels = ctx.recorder.between(
        startedAt,
        endedAt,
        (record) => record.event === 'audio.levels'
      )
      const result = evaluateClipsIdleCase({
        levels,
        sessionId: ready.payload.sessionId,
        toneStartAt,
        gainChangedAt,
        toneEndAt: toneStartAt + 3000
      })
      const statuses = ctx.recorder.between(
        startedAt,
        endedAt,
        (record) => record.event === 'recording.status'
      )
      if (
        statuses.some(
          ({ payload }) =>
            payload?.sessionId !== ring.sessionId ||
            payload?.replayOnly !== true ||
            payload?.state !== 'recording'
        )
      ) {
        result.failures.push('clips-idle: the ring stopped, restarted, or became a recording')
      }
      return finish(result, { replayOnly: true })
    } finally {
      await configureGain(-6)
    }
  },

  async on(ctx) {
    let playAt
    const session = await recordRendererSession(ctx, {
      name: 'on',
      systemAudioAtStart: true,
      timeline: async ({ at }) => {
        await at(3)
        playAt = playTone(ctx.tones[3])
      }
    })
    const analysis = await analyzeArtifact(session.mp4Path, 'on')
    const anchor = { wallMs: session.epochAt }
    const start = wallToFileSeconds(playAt, anchor)
    const result = (args.microphone ? evaluateMixedToneCapturedCase : evaluateToneCapturedCase)({
      envelope: analysis.envelope,
      regions: analysis.regions,
      expectedPlay: { start, end: start + 3 }
    })
    checkDuration(analysis, 'on', result.failures)
    const window = sessionWindow(ctx.recorder, session)
    if (window.mixedStatusCount === 0) result.failures.push('on: no status listed system-audio')
    if (window.health.length) result.failures.push(`on: health ${window.health.join(', ')}`)
    const epochs = startupEpochs.filter(
      (entry) => entry.at >= session.clickAt && entry.at <= session.endAt
    )
    const summaries = audioSummaries.filter(
      (entry) => entry.at >= session.clickAt && entry.at <= session.endAt
    )
    window.startupEpochs = epochs.map(({ at, ...entry }) => entry)
    window.microphones = microphoneSummaries
      .filter((entry) => entry.at >= session.clickAt && entry.at <= session.endAt)
      .map(({ at, ...entry }) => entry)
    if (
      ctx.microphone &&
      !window.microphones.some(
        (entry) =>
          entry.device === ctx.microphone.name &&
          entry.capturedFrames > 48000 &&
          entry.sourceLoss === 'none'
      )
    )
      result.failures.push('on: expected native microphone did not deliver usable captured audio')
    window.aheadCapDrops = summaries.reduce((sum, entry) => sum + entry.aheadCapDrops, 0)
    if (staticScreenId && !args.moving && !args.camera) {
      const epochResult = evaluateStaticScreenEpoch({
        ...epochs[0],
        aheadCapDrops: window.aheadCapDrops
      })
      result.failures.push(...epochResult.failures)
    }
    if (window.aheadCapDrops > 0) result.failures.push('on: ahead-of-cap audio drops')
    return finish(result, { artifact: artifactEvidence(analysis, session.mp4Path), ...window })
  },

  async 'toggle-off'(ctx) {
    let playAt
    let offSentAt
    let offConfirmedAt
    const session = await recordRendererSession(ctx, {
      name: 'toggle-off',
      systemAudioAtStart: true,
      timeline: async ({ at, sessionId }) => {
        await at(2)
        playAt = playTone(ctx.tones[6])
        await at(5)
        const detached = waitForMix(ctx.recorder, sessionId, false, 'toggle-off detach')
        offSentAt = performance.now()
        await setSystemAudio(ctx, false)
        offConfirmedAt = (await detached).at
      }
    })
    const analysis = await analyzeArtifact(session.mp4Path, 'toggle-off')
    const detach = cutoverAfter('detach', offSentAt, session.endAt)
    const cutoverSeconds = detach
      ? cutoverFileSeconds(detach.sample, {
          audioStartSeconds: analysis.probe.audio.startSeconds,
          videoStartSeconds: analysis.probe.video.startSeconds
        })
      : null
    const anchor = { wallMs: session.epochAt }
    const start = wallToFileSeconds(playAt, anchor)
    const result = evaluateToggleOffCase({
      envelope: analysis.envelope,
      regions: analysis.regions,
      expectedPlay: { start, end: start + 6 },
      cutoverSeconds
    })
    checkDuration(analysis, 'toggle-off', result.failures)
    const window = sessionWindow(ctx.recorder, session)
    if (window.health.length) result.failures.push(`toggle-off: health ${window.health.join(', ')}`)
    return finish(result, {
      artifact: artifactEvidence(analysis, session.mp4Path),
      cutoverSample: detach?.sample ?? null,
      wall: wallEvidence(anchor, { offSentAt, offConfirmedAt }),
      confirmToStopMs: wallDelta(result.evidence.regions[0]?.end, anchor, offConfirmedAt),
      ...window
    })
  },

  async 'toggle-on'(ctx) {
    let playAt
    let onSentAt
    let onConfirmedAt
    const session = await recordRendererSession(ctx, {
      name: 'toggle-on',
      systemAudioAtStart: false,
      timeline: async ({ at, sessionId }) => {
        await at(2)
        playAt = playTone(ctx.tones[8])
        await at(5)
        const attached = waitForMix(ctx.recorder, sessionId, true, 'toggle-on attach')
        onSentAt = performance.now()
        await setSystemAudio(ctx, true)
        onConfirmedAt = (await attached).at
      }
    })
    const analysis = await analyzeArtifact(session.mp4Path, 'toggle-on')
    const attach = cutoverAfter('attach', onSentAt, session.endAt)
    const cutoverSeconds = attach
      ? cutoverFileSeconds(attach.sample, {
          audioStartSeconds: analysis.probe.audio.startSeconds,
          videoStartSeconds: analysis.probe.video.startSeconds
        })
      : null
    const anchor = { wallMs: session.epochAt }
    const start = wallToFileSeconds(playAt, anchor)
    const result = evaluateToggleOnCase({
      envelope: analysis.envelope,
      regions: analysis.regions,
      expectedPlay: { start, end: start + 8 },
      cutoverSeconds
    })
    checkDuration(analysis, 'toggle-on', result.failures)
    const window = sessionWindow(ctx.recorder, session)
    if (window.health.length) result.failures.push(`toggle-on: health ${window.health.join(', ')}`)
    return finish(result, {
      artifact: artifactEvidence(analysis, session.mp4Path),
      cutoverSample: attach?.sample ?? null,
      wall: wallEvidence(anchor, { onSentAt, onConfirmedAt }),
      confirmToStartMs: wallDelta(result.evidence.regions[0]?.start, anchor, onConfirmedAt),
      ...window
    })
  },

  async off(ctx) {
    const session = await recordRendererSession(ctx, {
      name: 'off',
      systemAudioAtStart: false,
      timeline: async ({ at }) => {
        await at(3)
        playTone(ctx.tones[3])
      }
    })
    const analysis = await analyzeArtifact(session.mp4Path, 'off')
    const window = sessionWindow(ctx.recorder, session)
    const result = evaluateSystemAudioOffCase({
      envelope: analysis.envelope,
      regions: analysis.regions,
      broadbandPeak: analysis.broadbandPeak,
      mixedStatusCount: window.mixedStatusCount
    })
    checkDuration(analysis, 'off', result.failures)
    if (window.systemAudioActiveSamples > 0) {
      result.failures.push(
        `off: diagnostics reported an active system-audio source ${window.systemAudioActiveSamples} time(s)`
      )
    }
    if (cutoverAfter('attach', session.clickAt, session.endAt)) {
      result.failures.push('off: the backend attached a system-audio source')
    }
    return finish(result, { artifact: artifactEvidence(analysis, session.mp4Path), ...window })
  },

  async self(ctx) {
    let rendererAt
    let renderer
    let controlAt
    const session = await recordRendererSession(ctx, {
      name: 'self',
      systemAudioAtStart: true,
      timeline: async ({ at }) => {
        await at(3)
        rendererAt = performance.now()
        renderer = await playRendererTone(ctx.smoke, 3)
        await at(8)
        controlAt = playTone(ctx.tones[2])
      }
    })
    const analysis = await analyzeArtifact(session.mp4Path, 'self')
    const anchor = { wallMs: session.epochAt }
    const rendererStart = wallToFileSeconds(rendererAt, anchor)
    const controlStart = wallToFileSeconds(controlAt, anchor)
    const result = evaluateSelfExclusionCase({
      envelope: analysis.envelope,
      regions: analysis.regions,
      rendererPlay: { start: rendererStart, end: rendererStart + 3 },
      controlPlay: { start: controlStart, end: controlStart + 2 },
      renderer
    })
    checkDuration(analysis, 'self', result.failures)
    const window = sessionWindow(ctx.recorder, session)
    if (window.health.length) result.failures.push(`self: health ${window.health.join(', ')}`)
    return finish(result, {
      artifact: artifactEvidence(analysis, session.mp4Path),
      exclusionWarnings: [...exclusionWarnings],
      ...window
    })
  },

  async stream(ctx) {
    const { renderer, recorder, smoke } = ctx
    // The renderer shows the switch the backend session uses.
    await setSystemAudio(ctx, true)
    const receivedPath = join(outputDirectory, `system-audio-stream-${Date.now()}.flv`)
    const streamKey = 'system-audio'
    const listener = spawnRtmpListener(
      `rtmp://127.0.0.1:${rtmpPort}/live/${streamKey}`,
      receivedPath
    )
    let started
    let playAt
    let stopped
    try {
      await sleep(1200)
      if (listener.process.exitCode !== null) {
        fail(`local RTMP listener exited: ${listener.stderr.join('').trim()}`)
      }
      const authorization = await requestSmokeCommand(
        smoke,
        'authorize-smoke-resource',
        { kind: 'output-directory', path: outputDirectory },
        { timeoutMs }
      )
      const clickAt = performance.now()
      started = await request(renderer, timeoutMs, 'session.start', {
        sources: ctx.realSources ?? { testPattern: true },
        layout: {
          layoutPreset: 'screen-only',
          cameraTransformMode: 'preset',
          cameraTransform: null,
          cameraCorner: 'bottom-right',
          cameraSize: 'medium',
          cameraShape: 'rectangle',
          cameraCornerRadiusPct: 12,
          cameraAspect: 'source',
          cameraMargin: 32,
          cameraFit: 'fill',
          cameraMirror: false,
          cameraZoom: 100,
          cameraOffsetX: 0,
          cameraOffsetY: 0,
          sideBySideSplit: '70-30',
          sideBySideCameraSide: 'right'
        },
        output: {
          recordEnabled: true,
          streamEnabled: true,
          outputDirectoryCapability: authorization.capabilityId,
          video: { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 3000 },
          rtmp: {
            preset: 'custom',
            serverUrl: `rtmp://127.0.0.1:${rtmpPort}/live`,
            streamKey
          }
        },
        audio: {
          microphoneGainDb: 0,
          microphoneMuted: false,
          microphoneSyncOffsetMs: 0,
          systemAudioEnabled: true,
          systemAudioGainDb: -6
        }
      })
      if (!started?.sessionId) fail(`stream: session.start returned ${JSON.stringify(started)}`)
      const epochAt = performance.now()
      await waitForMix(recorder, started.sessionId, true, 'stream attach')
      await sleep(epochAt + 3000 - performance.now())
      playAt = playTone(ctx.tones[3])
      await sleep(epochAt + 10000 - performance.now())
      const terminal = recorder.waitFor(
        'stream terminal status',
        (record) =>
          record.event === 'recording.status' &&
          record.payload?.sessionId === started.sessionId &&
          (record.payload?.state === 'idle' || record.payload?.state === 'failed')
      )
      stopped = await request(renderer, timeoutMs, 'session.stop', {})
      const terminalRecord = await terminal
      if (terminalRecord.payload.state !== 'idle') {
        fail(`stream: session ended ${terminalRecord.payload.state}`)
      }
      await stopRtmpListener(listener)
      const mp4Path = await waitForPublishedMp4({
        ws: renderer,
        recorder,
        sessionId: started.sessionId,
        idleRecord: terminalRecord
      })
      const file = await analyzeArtifact(mp4Path, 'stream file')
      const stream = await analyzeArtifact(receivedPath, 'stream capture')
      const anchor = { wallMs: epochAt }
      const start = wallToFileSeconds(playAt, anchor)
      const result = evaluateRecordAndStreamCase({
        file,
        stream,
        expectedPlay: { start, end: start + 3 }
      })
      const window = sessionWindow(recorder, {
        sessionId: started.sessionId,
        clickAt,
        endAt: terminalRecord.at
      })
      if (window.health.length) result.failures.push(`stream: health ${window.health.join(', ')}`)
      return finish(result, {
        file: artifactEvidence(file, mp4Path),
        stream: artifactEvidence(stream, receivedPath),
        stopped: stopped?.state ?? null,
        ...window
      })
    } finally {
      await stopRtmpListener(listener)
    }
  }
}

function wallEvidence(anchor, marks) {
  return Object.fromEntries(
    Object.entries(marks).map(([key, value]) => [
      key,
      Number.isFinite(value) ? round(wallToFileSeconds(value, anchor)) : null
    ])
  )
}

/** File-time edge minus the wall-mapped confirmation, in ms (diagnostic). */
function wallDelta(edgeSeconds, anchor, confirmedAt) {
  if (!Number.isFinite(edgeSeconds) || !Number.isFinite(confirmedAt)) return null
  return Math.round((edgeSeconds - wallToFileSeconds(confirmedAt, anchor)) * 1000)
}

function finish(result, extra) {
  return {
    pass: result.failures.length === 0,
    failures: result.failures,
    evidence: { ...result.evidence, ...extra }
  }
}

function spawnRtmpListener(listenUrl, receivedPath) {
  const stderr = []
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      receivedPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => stderr.push(text))
  return { process: child, stderr }
}

async function stopRtmpListener(listener) {
  const child = listener?.process
  if (!child?.pid || child.exitCode !== null) return
  await waitForExit(child, 5000)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 1500)
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForExit(child, 1000)
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeout)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

function printCase(name, result) {
  const ev = result.evidence
  const regions = (ev.regions ?? ev.fileRegions ?? [])
    .map((region) => `${region.start}-${region.end}s@${region.medianDbfs}dBFS`)
    .join(' ')
  const extras = [
    name === 'clips-idle'
      ? `session ${ev.sessionId} · readings ${ev.systemAudioReadingCount}/${ev.levelEventCount} · peak ${round(ev.beforeDbfs)} -> ${round(ev.afterDbfs)} dBFS · drop ${round(ev.dropDb)} dB · floor ${ev.floorPeakDbfs} dBFS`
      : null,
    ev.stopDeltaMs !== undefined ? `stop vs cutover ${ev.stopDeltaMs} ms` : null,
    ev.startDeltaMs !== undefined && name === 'toggle-on'
      ? `start vs cutover ${ev.startDeltaMs} ms`
      : null,
    ev.confirmToStopMs != null ? `stop vs wall-confirmed ${ev.confirmToStopMs} ms` : null,
    ev.confirmToStartMs != null ? `start vs wall-confirmed ${ev.confirmToStartMs} ms` : null,
    ev.rendererBandDbfs !== undefined ? `renderer-window band ${ev.rendererBandDbfs} dBFS` : null,
    ev.broadbandPeakDbfs !== undefined ? `broadband peak ${ev.broadbandPeakDbfs} dBFS` : null,
    ev.streamRegions
      ? `stream ${ev.streamRegions.map((region) => `${region.start}-${region.end}s@${region.medianDbfs}dBFS`).join(' ')}`
      : null
  ].filter(Boolean)
  log(
    `${result.pass ? 'PASS' : 'FAIL'} ${name}: ${name === 'clips-idle' ? extras.join(' · ') : `tone ${regions || 'none'}${extras.length ? ` · ${extras.join(' · ')}` : ''}`}`
  )
  for (const failure of result.failures) log(`  - ${failure}`)
}

let stopApp = async () => {}
let staticStimulus
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-system-audio-user-data-'))
try {
  if (process.platform !== 'darwin') {
    log('SKIPPED: the system-audio smoke is macOS only (Windows is plan 069 S8).')
  } else {
    mkdirSync(outputDirectory, { recursive: true })
    const tones = await generateTones(join(outputDirectory, 'tones'))
    startKeepAlive(tones.silence)
    const launch = await launchDevApp({
      env: {
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_PREVIEW_MOTION: staticScreenId ? '0' : '1',
        VIDEORC_SMOKE_STATE_DIR: outputDirectory,
        VIDEORC_USER_DATA_DIR: userDataDir,
        // No microphone: the bus writes paced silence for the mic slot, so
        // the file carries only what System audio mixes in.
        VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: args.microphone ? '0' : '1',
        ...(appExecutable
          ? {
              VIDEORC_SMOKE_PACKAGED_APP: '1',
              VIDEORC_PACKAGED_SMOKE_TEST: '1',
              VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedCapability,
              VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
            }
          : {})
      },
      packagedSmokeCommandCapability: packagedCapability,
      spawnSpec: appExecutable ? { command: resolve(appExecutable), args: [] } : undefined,
      timeoutMs,
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      onLine: onAppLine
    })
    stopApp = launch.stop
    const renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)
    const smoke = launch.connections['preview-motion-ready']
    const recorder = new BackendEventRecorder(renderer)

    const health = await request(renderer, timeoutMs, 'health.ping', {})
    if (!health?.ffmpeg?.available) fail(health?.ffmpeg?.message ?? 'FFmpeg is unavailable.')

    const devices = await request(renderer, timeoutMs, 'devices.list', {})
    const device = (devices?.devices ?? []).find((entry) => entry.id === 'system-audio:default')
    if (device?.status !== 'available') {
      const reason = `System audio device is ${device?.status ?? 'missing'}; the dev app needs the Screen Recording grant (System Settings > Privacy & Security > Screen & System Audio Recording).`
      if (allowMissingGrant) {
        log(`SKIPPED (VIDEORC_SYSTEM_AUDIO_SMOKE_ALLOW_MISSING_GRANT=1): ${reason}`)
        process.exitCode = 0
        throw Object.assign(new Error('skip'), { skip: true })
      }
      fail(reason)
    }

    const microphone = args.microphone
      ? devices.devices.find(
          (entry) =>
            entry.kind === 'microphone' &&
            entry.status === 'available' &&
            /MacBook.*Microphone/.test(entry.name)
        )
      : null
    if (args.microphone && !microphone) fail('No native microphone available')
    const realSources = staticScreenId
      ? {
          screenId: staticScreenId,
          ...(microphone ? { microphoneId: microphone.id } : {}),
          testPattern: false
        }
      : undefined
    if (appExecutable) {
      log(
        `Packaged candidate ready for Studio setup: select screen ${staticScreenId}, Screen only, Record enabled, Stream disabled${args.microphone ? ', and the built-in microphone' : ''}. Waiting for the confirmed native scene.`
      )
      log(
        'After Studio setup and the automatic performance check finish, enter ready on stdin to start the acceptance run.'
      )
      const input = createInterface({ input: process.stdin })
      try {
        await new Promise((resolveReady, rejectReady) => {
          const timer = setTimeout(
            () => rejectReady(new Error('Packaged Studio setup was not confirmed')),
            timeoutMs
          )
          input.once('line', (line) => {
            clearTimeout(timer)
            line.trim() === 'ready'
              ? resolveReady()
              : rejectReady(new Error('Expected ready after Studio setup'))
          })
          input.once('close', () => {
            clearTimeout(timer)
            rejectReady(new Error('Packaged setup requires interactive stdin'))
          })
        })
      } finally {
        input.close()
      }
    } else {
      await seedRenderer(smoke, realSources)
      if (!staticScreenId)
        await requestSmokeCommand(
          smoke,
          'enable-synthetic-source',
          { settleMs: 500 },
          { timeoutMs }
        )
      await requestSmokeCommand(
        smoke,
        'select-layout-preset',
        { preset: 'screen-only', settleMs: 600 },
        { timeoutMs }
      )
      // A seeded source does not survive the device refresh; pin the display.
      if (staticScreenId)
        await requestSmokeCommand(
          smoke,
          'select-screen-device',
          { sourceId: staticScreenId, settleMs: 1000 },
          { timeoutMs }
        )
    }
    await waitForBackendState(
      renderer,
      'compositor.status',
      (compositor) =>
        (staticScreenId
          ? compositor.state === 'live' &&
            (compositor.sources ?? []).some(
              (source) => source.sourceId === staticScreenId && source.state === 'live'
            )
          : syntheticCompositorReady(compositor)) &&
        (args.camera ||
          !(compositor.sceneSources ?? []).some(
            (source) => source?.visible && source?.kind === 'camera'
          )),
      'a screen-only scene with no visible camera'
    )
    if (microphone) {
      await request(renderer, timeoutMs, 'audio.mic.arm', {
        microphoneId: microphone.id,
        microphoneGainDb: 0,
        microphoneMuted: false
      })
      log(`Native microphone warmed: ${microphone.name}`)
    }
    if (staticScreenId) {
      const source = devices.devices.find((entry) => entry.id === staticScreenId)
      if (!source) fail(`Native screen ${staticScreenId} is unavailable`)
      const bounds = stimulusWindowOptionsForSource(source)
      if (!bounds) fail(`Cannot locate display ${staticScreenId}`)
      staticStimulus = await launchScreenMotionStimulus({
        screenSource: source,
        freeze: !args.moving,
        driver: 'native',
        x: bounds.x - 16,
        y: bounds.y - 16,
        width: bounds.width + 32,
        height: bounds.height + 32
      })
      log(
        `${args.moving ? 'Moving' : 'Static'} fixture covers the selected display until the run finishes.`
      )
    }
    const { discovery } = await enableRemoteControl(renderer, { timeoutMs })
    const remote = await connectRemote(discovery.host, discovery.port, discovery.token, {
      timeoutMs
    })
    const acks = new RemoteAcks(remote)
    const described = await waitForRemoteDescribe(remote, { timeoutMs })
    if (described.state?.systemAudioAvailable !== true) {
      fail(`remote.state says System audio is not available: ${JSON.stringify(described.state)}`)
    }
    log(`app ready; running ${selectedCases.join(', ')} (ffmpeg ${ffmpegPath})`)

    const ctx = { renderer, smoke, recorder, remote, acks, tones, realSources, microphone }
    const results = {}
    for (const [index, name] of selectedCases.entries()) {
      const caseKey = results[name] ? `${name}-${index + 1}` : name
      if (index > 0) await sleep(idleGapMs)
      try {
        results[caseKey] = await cases[name](ctx)
      } catch (error) {
        results[caseKey] = { pass: false, failures: [error.message], evidence: {} }
      } finally {
        stopPlayers()
      }
      printCase(name, results[caseKey])
    }

    const pass = Object.values(results).every((result) => result.pass)
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          gates: SYSTEM_AUDIO_GATES,
          clipsIdleLevelGates: CLIPS_IDLE_LEVEL_GATES,
          ffmpegPath,
          pass,
          cases: results,
          cutovers: cutovers.map(({ kind, sample }) => ({ kind, sample }))
        },
        null,
        2
      )}\n`
    )
    log(`report written to ${reportPath}`)
    if (!pass)
      fail(`${Object.values(results).filter((result) => !result.pass).length} case(s) failed`)
    log('PASS')
  }
} catch (error) {
  if (!error?.skip) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  }
} finally {
  stopPlayers()
  stopKeepAlive()
  if (staticStimulus) await stopScreenMotionStimulus(staticStimulus)
  try {
    await stopApp()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
