#!/usr/bin/env node
// Soundboard app smoke (plan 189 S8): a soundboard press in recordings,
// through the REAL dev app.
//
// macOS only (the dev app's synthetic screen and remote control). No camera
// or microphone: the bus writes paced silence for the mic slot, so the file
// carries only what the soundboard (and, in one case, System audio) mixes in.
// The fixture sound is a 600 ms 1 kHz tone imported through the real
// `sounds.import` (a smoke-authorized capability, the picker's exchange), and
// every press is a `soundPlay` remote intent, the path a Stream Deck key, the
// phone and the renderer's executor take.
//
//   idle          no session: the press is acknowledged and `sounds.playback`
//                 lists the voice with onAir false (the monitor only).
//   on-air        Record, press at 3 s, Stop at 7 s: exactly one 600 ms tone,
//                 starting at the press (wall-clock mapping, see
//                 soundboard-gates.mjs); nothing else at 1 kHz.
//   system-audio  the same with System audio on and the monitor playing: the
//                 tone is in the file once, the same length and level as
//                 on-air (the monitor never comes back through the capture).
//                 Needs the dev app's Screen Recording grant; without it the
//                 case SKIPS with the reason, never a silent pass.
//
// The precise placement gate (one chunk plus 5 ms) is
// `pnpm smoke:soundboard-fixture`.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

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
  SOUNDBOARD_GATES,
  evaluateIdlePress,
  evaluateNotDoubled,
  evaluatePressedTone
} from './lib/soundboard-gates.mjs'
import {
  analyzeSystemAudioArtifact,
  mixSourcesIncludeSystemAudio,
  toneWavArgs,
  wallToFileSeconds
} from './lib/system-audio-gates.mjs'
import { RELOAD_KEEPING_SEED_JS } from './lib/renderer-profile-seed.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const ALL_CASES = ['idle', 'on-air', 'system-audio']
const { values: args } = parseArgs({
  options: {
    cases: { type: 'string', default: ALL_CASES.join(',') },
    report: { type: 'string' },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})
const selectedCases = args.cases.split(',').map((name) => name.trim())
for (const name of selectedCases) {
  if (!ALL_CASES.includes(name)) fail(`unknown case "${name}" (known: ${ALL_CASES.join(', ')})`)
}
const debug = args.debug || process.env.VIDEORC_SOUNDBOARD_SMOKE_DEBUG === '1'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const recordSeconds = 7
const pressSeconds = 3
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-soundboard-${Date.now()}`)
)
const reportPath = resolve(args.report ?? join(outputDirectory, 'soundboard-report.json'))
const bundledFfmpeg = join(repoRoot, 'vendor', 'ffmpeg', 'current', 'bin', 'ffmpeg')
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg')
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveExistingSiblingFfprobe(ffmpegPath) ?? 'ffprobe'

function fail(message) {
  throw new Error(`soundboard smoke FAIL: ${message}`)
}

function log(message) {
  console.log(`soundboard: ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))
}

function runFfmpeg(argsList) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(ffmpegPath, argsList, (error, _stdout, stderr) => {
      if (error) rejectRun(new Error(`ffmpeg failed: ${stderr || error.message}`))
      else resolveRun()
    })
  })
}

/** Every backend event with its receive time, so no waiter misses one. */
class BackendEventRecorder {
  constructor(ws) {
    this.events = []
    this.waiters = new Set()
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message?.event || message.event === 'diagnostics.stats') return
      const record = { event: message.event, payload: message.payload, at: performance.now() }
      this.events.push(record)
      if (debug && message.event.startsWith('sounds.')) {
        console.log(`[event] ${message.event} ${JSON.stringify(message.payload)}`)
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
    const seen = this.events.find(predicate)
    if (seen) return Promise.resolve(seen)
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
}

/** Every `remote.ack`, so an intent's ack is never missed. */
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

async function sendIntent(ctx, intent) {
  const sentAt = performance.now()
  const ticket = await remoteRequest(ctx.remote, 'remote.intent', intent, { timeoutMs })
  if (!ticket.payload?.accepted) fail(`${intent.kind} was not accepted: ${JSON.stringify(ticket)}`)
  const ack = await ctx.acks.wait(ticket.payload.intentId, intent.kind)
  if (ack.ok !== true) fail(`${intent.kind} was refused: ${ack.message ?? JSON.stringify(ack)}`)
  return { ack, sentAt }
}

async function seedRenderer(smoke) {
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const key = 'videorc.captureConfig';
        let current = {};
        try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
        // Screen-only on the synthetic source (the dev app has no camera
        // grant), record only, System audio Off until a case turns it on.
        const layout = { ...(current.layout ?? {}), layoutPreset: 'screen-only' };
        const audio = { ...(current.audio ?? {}), systemAudioEnabled: false, systemAudioGainDb: -6 };
        localStorage.setItem(key, JSON.stringify({ ...current, video: params.video, layout, audio, recordEnabled: true, streamEnabled: false }));
        ${RELOAD_KEEPING_SEED_JS}
        return true;
      `,
      video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
    },
    { timeoutMs }
  )
  await sleep(2500)
  await requestSmokeCommand(
    smoke,
    'eval-js',
    { code: `await waitFor('[data-videorc-tab-trigger="studio"]', 60000); return true;` },
    { timeoutMs }
  )
}

async function importFixtureSound(ctx, path) {
  const capability = await requestSmokeCommand(
    ctx.smoke,
    'authorize-smoke-resource',
    { path, kind: 'input-file' },
    { timeoutMs }
  )
  const sound = await request(ctx.renderer, timeoutMs, 'sounds.import', {
    sourceCapability: capability.capabilityId
  })
  if (!sound?.id) fail(`sounds.import returned ${JSON.stringify(sound)}`)
  // A tone has no silence to trim: the stored sound is the tone.
  if (Math.abs(sound.durationMs - SOUNDBOARD_GATES.toneSeconds * 1000) > 20) {
    fail(`the imported tone is ${sound.durationMs} ms, expected ~600 ms`)
  }
  return sound
}

async function waitForPublishedMp4(ctx, sessionId, terminal) {
  const idlePath = terminal?.payload?.outputPath
  if (typeof idlePath === 'string' && idlePath.toLowerCase().endsWith('.mp4')) return idlePath
  const deadline = performance.now() + 30000
  for (;;) {
    const page = await request(ctx.renderer, timeoutMs, 'sessions.list', { limit: 20 })
    const item = page?.items?.find((entry) => entry.id === sessionId)
    if (item?.mp4Path) return item.mp4Path
    if (item?.finalizationState === 'failed') {
      fail(`finalization failed for ${sessionId}: ${item.finalizationError ?? 'unknown'}`)
    }
    if (performance.now() > deadline) fail(`MP4 for ${sessionId} was not published in 30 s`)
    await sleep(250)
  }
}

/** Record, press once at `pressSeconds`, Stop: the press's file time and the MP4. */
async function recordWithPress(ctx, { name, systemAudio }) {
  await sendIntent(ctx, { kind: systemAudio ? 'systemAudioOn' : 'systemAudioOff' })
  const recordingPromise = ctx.recorder.waitFor(
    `${name} recording.status(recording)`,
    (record) =>
      record.event === 'recording.status' &&
      record.payload?.state === 'recording' &&
      typeof record.payload?.sessionId === 'string' &&
      record.at > ctx.since
  )
  await sendIntent(ctx, { kind: 'recordStart' })
  const recording = await recordingPromise
  const sessionId = recording.payload.sessionId
  const anchor = { wallMs: recording.at, fileSeconds: 0 }
  if (systemAudio) {
    await ctx.recorder.waitFor(
      `${name} System audio in the mix`,
      (record) =>
        record.event === 'recording.status' &&
        record.payload?.sessionId === sessionId &&
        mixSourcesIncludeSystemAudio(record.payload),
      15000
    )
  }
  await sleep(anchor.wallMs + pressSeconds * 1000 - performance.now())
  const { sentAt, ack } = await sendIntent(ctx, { kind: 'soundPlay', soundId: ctx.sound.id })
  const playback = await ctx.recorder.waitFor(
    `${name} sounds.playback`,
    (record) =>
      record.event === 'sounds.playback' &&
      record.at >= sentAt &&
      record.payload?.voices?.some((voice) => voice.soundId === ctx.sound.id)
  )
  const onAir = playback.payload.voices.find((voice) => voice.soundId === ctx.sound.id)?.onAir
  if (onAir !== true) fail(`${name}: the press during a recording was not on air`)
  await sleep(anchor.wallMs + recordSeconds * 1000 - performance.now())
  const terminalPromise = ctx.recorder.waitFor(
    `${name} terminal status`,
    (record) =>
      record.event === 'recording.status' &&
      record.payload?.sessionId === sessionId &&
      (record.payload?.state === 'idle' || record.payload?.state === 'failed')
  )
  await sendIntent(ctx, { kind: 'recordStop' })
  const terminal = await terminalPromise
  if (terminal.payload.state !== 'idle') {
    fail(`${name}: the session ended ${terminal.payload.state}: ${terminal.payload.message ?? ''}`)
  }
  ctx.since = terminal.at
  const mp4Path = await waitForPublishedMp4(ctx, sessionId, terminal)
  return {
    mp4Path,
    pressFileSeconds: wallToFileSeconds(sentAt, anchor),
    ackMessage: ack.message ?? null
  }
}

async function judgeRecording(ctx, name, systemAudio) {
  const run = await recordWithPress(ctx, { name, systemAudio })
  const analysis = await analyzeSystemAudioArtifact(run.mp4Path, { ffmpegPath, ffprobePath })
  const verdict = evaluatePressedTone({
    regions: analysis.regions,
    pressFileSeconds: run.pressFileSeconds,
    label: name
  })
  return { ...verdict, evidence: { path: run.mp4Path, pressFileSeconds: run.pressFileSeconds } }
}

const cases = {
  async idle(ctx) {
    const { sentAt } = await sendIntent(ctx, { kind: 'soundPlay', soundId: ctx.sound.id })
    const playback = await ctx.recorder.waitFor(
      'idle sounds.playback',
      (record) =>
        record.event === 'sounds.playback' &&
        record.at >= sentAt &&
        record.payload?.voices?.some((voice) => voice.soundId === ctx.sound.id)
    )
    await sleep(SOUNDBOARD_GATES.toneSeconds * 1000 + 300)
    return {
      ...evaluateIdlePress({ playback: playback.payload, soundId: ctx.sound.id }),
      evidence: {}
    }
  },
  async 'on-air'(ctx) {
    const result = await judgeRecording(ctx, 'on-air', false)
    ctx.reference = result
    return result
  },
  async 'system-audio'(ctx) {
    const devices = await request(ctx.renderer, timeoutMs, 'devices.list', {})
    const device = (devices?.devices ?? []).find((entry) => entry.id === 'system-audio:default')
    if (device?.status !== 'available') {
      return {
        pass: true,
        skipped: `System audio device is ${device?.status ?? 'missing'}; the dev app needs the Screen Recording grant.`,
        failures: [],
        evidence: {}
      }
    }
    const reference = ctx.reference ?? (await judgeRecording(ctx, 'on-air (reference)', false))
    const withSystemAudio = await judgeRecording(ctx, 'system-audio', true)
    return {
      ...evaluateNotDoubled({ withSystemAudio, reference }),
      evidence: withSystemAudio.evidence
    }
  }
}

let stopApp = async () => {}
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-soundboard-user-data-'))
try {
  if (process.platform !== 'darwin') {
    log('SKIPPED: the soundboard app smoke is macOS only; the fixture smoke runs everywhere.')
  } else {
    mkdirSync(outputDirectory, { recursive: true })
    const tonePath = join(outputDirectory, 'tone-1k-600ms.wav')
    await runFfmpeg(
      toneWavArgs(tonePath, {
        seconds: SOUNDBOARD_GATES.toneSeconds,
        amplitude: SOUNDBOARD_GATES.toneAmplitude
      })
    )
    const launch = await launchDevApp({
      env: {
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_PREVIEW_MOTION: '1',
        VIDEORC_SMOKE_STATE_DIR: outputDirectory,
        VIDEORC_USER_DATA_DIR: userDataDir,
        VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '1'
      },
      timeoutMs,
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      onLine: (line) => {
        if (debug) console.log('[app]', line)
      }
    })
    stopApp = launch.stop
    const renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)
    const smoke = launch.connections['preview-motion-ready']
    const recorder = new BackendEventRecorder(renderer)
    const health = await request(renderer, timeoutMs, 'health.ping', {})
    if (!health?.ffmpeg?.available) fail(health?.ffmpeg?.message ?? 'FFmpeg is unavailable.')
    await seedRenderer(smoke)
    await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
    await requestSmokeCommand(
      smoke,
      'select-layout-preset',
      { preset: 'screen-only', settleMs: 600 },
      { timeoutMs }
    )
    const deadline = Date.now() + timeoutMs
    while (!syntheticCompositorReady(await request(renderer, timeoutMs, 'compositor.status'))) {
      if (Date.now() > deadline) fail('the synthetic screen-only scene never went live')
      await sleep(200)
    }
    const { discovery } = await enableRemoteControl(renderer, { timeoutMs })
    const remote = await connectRemote(discovery.host, discovery.port, discovery.token, {
      timeoutMs
    })
    const acks = new RemoteAcks(remote)
    await waitForRemoteDescribe(remote, { timeoutMs })
    const ctx = { renderer, smoke, recorder, remote, acks, since: performance.now() }
    ctx.sound = await importFixtureSound(ctx, tonePath)
    log(`app ready; fixture sound ${ctx.sound.id}; running ${selectedCases.join(', ')}`)

    const results = {}
    for (const name of selectedCases) {
      try {
        results[name] = await cases[name](ctx)
      } catch (error) {
        results[name] = { pass: false, failures: [error.message], evidence: {} }
      }
      const result = results[name]
      log(
        `${result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL'} ${name}${result.skipped ? `: ${result.skipped}` : ''}`
      )
      for (const failure of result.failures) log(`  - ${failure}`)
    }
    const pass = Object.values(results).every((result) => result.pass)
    writeFileSync(
      reportPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), gates: SOUNDBOARD_GATES, ffmpegPath, pass, cases: results }, null, 2)}\n`
    )
    log(`report written to ${reportPath}`)
    if (!pass)
      fail(`${Object.values(results).filter((result) => !result.pass).length} case(s) failed`)
    log('PASS')
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  try {
    await stopApp()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
