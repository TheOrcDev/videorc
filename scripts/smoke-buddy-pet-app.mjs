// smoke:buddy-pet (plan 168 S-C5): the living Golem on a real recording.
//
// The dev app imports a synthetic pet pack (every cell a green silhouette
// with a unique colour tag, scripts/lib/buddy-pet-fixture.mjs) through the
// backend's own import, wears it Alive, burns the Golem into the recording and
// scripts what the animator reacts to. Then ffmpeg decodes the recorded
// frames and the tag at the pet's tag spot names the cell on screen:
//
// 1. Lively (Motion 0.45, the owner default), a record+stream session so the
//    highlight card is eligible: a fake Kick follow (expect `wave` or
//    `proud`), the card on the left (expect a gaze cell looking left), a Say
//    line (expect `talk-a` and `talk-b` alternating), and the body's box
//    moving while the follow's reaction plays.
// 2. Still (Motion 0, sleep after 30 s), a recording only: a manual `wave`
//    from `cohost.pet.react` shows its cell but the body never moves, and 30 s
//    of silence later the pet sleeps (expect `sleep`).
//
// Evidence (recordings, per-frame timelines, summaries) stays in the output
// directory printed at the end.

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  COMMENT_HIGHLIGHT_MARKER_RGB,
  commentHighlightImagePngBase64
} from './lib/comment-highlight-artifact.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  BUDDY_PET_FIXTURE_NEUTRAL,
  buddyPetBodyTravel,
  buddyPetBox,
  buddyPetMedianBox,
  buddyPetRuns,
  buddyPetTalkAlternates,
  readBuddyPetFrame,
  writeBuddyPetFixturePack
} from './lib/buddy-pet-fixture.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-buddy-pet-${Date.now()}`)
)
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const rtmpPort = Number(process.env.VIDEORC_BUDDY_PET_RTMP_PORT ?? 19781)
const listenerBindMs = 1500

const VIDEO = Object.freeze({ width: 1280, height: 720, fps: 30, bitrateKbps: 4000 })
/** The Golem on the right, big enough that its tag is ~87 px. */
const BUDDY_RECT = Object.freeze({ x: 0.7, y: 0.3, w: 0.2, h: 0.62 })
/** The card on the left, so a look at it is a look to the viewer's left. */
const CARD_RECT = Object.freeze({ x: 0.03, y: 0.3, w: 0.34, h: 0.3 })
/** The reactions must move the body's box at least this far with Motion
 * 0.45 (on a 256 px pet the wave's lift and turn measured 6 px, the tip's
 * `surprised` 14 px; breathing alone stays within 2 px) ... */
const MIN_REACTION_TRAVEL_PX = 4
/** ... and no further than compression noise with Motion 0. */
const MAX_STILL_TRAVEL_PX = 2
const SLEEP_AFTER_SECONDS = 30

mkdirSync(outputDirectory, { recursive: true })

const stateDirectory = join(outputDirectory, 'app-state')
const userDataDirectory = join(stateDirectory, 'user-data')
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_STATE_DIR: outputDirectory,
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_APP_DATA_DIR: join(stateDirectory, 'app-data'),
    VIDEORC_USER_DATA_DIR: userDataDirectory,
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1'
  }
})

let ws
const summary = { outputDirectory, runs: [] }
try {
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const smoke = launched.connections['preview-motion-ready']
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the Golem pet smoke.')
  }

  // The pack, copied where main copies an imported folder, registered
  // through the backend's own import (admin only, via main's debug bridge).
  const settings = await request(ws, timeoutMs, 'cohost.settings.get', {})
  const personaId = settings.persona.id
  const packId = randomUUID()
  const packDirectory = join(userDataDirectory, 'buddy-assets', personaId, 'pets', packId)
  const frames = writeBuddyPetFixturePack(packDirectory)
  const pack = await smokeCommand(smoke, 'backend-debug-rpc', {
    method: 'cohost.pet.import',
    params: { folderToken: `${personaId}/pets/${packId}` },
    timeoutMs: 60_000
  })
  if (pack?.packId !== packId || pack.gazeCount !== 25 || !pack.hasTalk) {
    throw new Error(`The fixture pack did not import as expected: ${JSON.stringify(pack)}`)
  }
  summary.pack = pack

  await ensureOverlayLayout(ws)

  summary.runs.push(
    await runLively(ws, smoke, { settings, packId, frames }),
    await runStill(ws, smoke, { settings, packId, frames })
  )
  writeFileSync(join(outputDirectory, 'buddy-pet-summary.json'), JSON.stringify(summary, null, 2))
  console.log(
    `Golem pet smoke PASS: the follow played ${summary.runs[0].followCell}, the card turned the gaze to ${summary.runs[0].leftGazeCell}, the Say line alternated talk-a/talk-b, the body moved ${summary.runs[0].reactionTravelPx} px while reacting at Motion 0.45 (the wave alone ${summary.runs[0].followTravelPx} px) and ${summary.runs[1].reactionTravelPx} px at Motion 0, and the pet slept ${summary.runs[1].sleepAfterReactionSeconds.toFixed(1)} s after the last activity. Evidence: ${outputDirectory}`
  )
} catch (error) {
  writeFileSync(
    join(outputDirectory, 'buddy-pet-summary.json'),
    JSON.stringify({ ...summary, error: String(error?.stack ?? error) }, null, 2)
  )
  throw error
} finally {
  ws?.close()
  await launched.stop()
}

/** The Golem and the card on both outputs, at the smoke's rects. The Studio
 * renderer pushes its own copy of the layout while it starts (the captions
 * switch seed), which can land after a write made too early, so the layout
 * is written until it reads back the same twice in a row, and again right
 * before every session (the leg plan is read at session start). */
async function ensureOverlayLayout(ws) {
  const wanted = (layout) => ({
    ...layout,
    buddy: { ...layout.buddy, horizontal: BUDDY_RECT, showOnStream: true, showInRecording: true },
    highlight: {
      ...layout.highlight,
      horizontal: CARD_RECT,
      showOnStream: true,
      showInRecording: true
    }
  })
  const sameRect = (a, b) => ['x', 'y', 'w', 'h'].every((key) => a?.[key] === b?.[key])
  const holds = (item, rect) =>
    sameRect(item?.horizontal, rect) && item.showOnStream === true && item.showInRecording === true
  const matches = (layout) =>
    holds(layout?.buddy, BUDDY_RECT) && holds(layout?.highlight, CARD_RECT)
  let steady = 0
  let last = null
  for (let attempt = 0; attempt < 20 && steady < 2; attempt += 1) {
    last = await request(ws, timeoutMs, 'overlays.layout.get', {})
    if (matches(last)) {
      steady += 1
    } else {
      steady = 0
      await request(ws, timeoutMs, 'overlays.layout.set', wanted(last))
    }
    await sleep(750)
  }
  if (steady < 2) {
    throw new Error(
      `The overlay layout would not hold the Golem's switches: ${JSON.stringify(last)}`
    )
  }
}

/** Wear the pack with these motion settings (the whole persona is the
 * patch), and read it back. */
async function wear(ws, settings, packId, motion) {
  await request(ws, timeoutMs, 'cohost.settings.set', {
    persona: {
      ...settings.persona,
      avatar: { kind: 'alive', packId },
      motion
    }
  })
  const worn = (await request(ws, timeoutMs, 'cohost.settings.get', {})).persona
  if (
    worn?.avatar?.kind !== 'alive' ||
    worn.avatar.packId !== packId ||
    ['intensity', 'sleepAfterSeconds', 'breathing'].some(
      (key) => worn.motion?.[key] !== motion[key]
    )
  ) {
    throw new Error(`The persona did not keep the pack and motion: ${JSON.stringify(worn)}`)
  }
}

async function runLively(ws, smoke, { settings, packId, frames }) {
  const label = 'lively'
  const directory = join(outputDirectory, label)
  mkdirSync(directory, { recursive: true })
  await wear(ws, settings, packId, { intensity: 0.45, sleepAfterSeconds: 180, breathing: true })
  const streamKey = `buddy-pet-${Date.now()}`
  const target = {
    id: 'buddy-pet-stream',
    platform: 'custom',
    label: 'Local Golem pet stream',
    serverUrl: `rtmp://127.0.0.1:${rtmpPort}/live`,
    streamKey,
    listenUrl: `rtmp://127.0.0.1:${rtmpPort}/live/${streamKey}`,
    receivedPath: join(directory, 'stream-received.flv')
  }
  const listener = spawnRtmpListener(target)
  let sessionActive = false
  let sessionId = null
  try {
    await sleep(listenerBindMs)
    if (listener.process.exitCode !== null) {
      throw new Error(`The local RTMP listener exited: ${listener.stderr.join('').trim()}`)
    }
    const started = await startSession(ws, smoke, directory, { stream: target })
    sessionActive = true
    sessionId = started.sessionId
    const startedAt = Date.now()
    await sleep(1500)

    // A YouTube comment (for the card) and a Kick follow (then a KICKs tip).
    const commentTarget = 'buddy-pet-youtube'
    const kickTarget = 'buddy-pet-kick'
    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId,
      destinations: [
        { targetId: commentTarget, platform: 'youtube', read: 'ready', write: 'ready' },
        { targetId: kickTarget, platform: 'kick', read: 'ready', write: 'ready' }
      ],
      fakes: [
        { platform: 'youtube', targetId: commentTarget, count: 1, intervalMs: 25 },
        { platform: 'kick', targetId: kickTarget, count: 0, intervalMs: 1200, events: true }
      ]
    })
    const marks = { follow: (Date.now() - startedAt) / 1000 + 1.2 }
    const comment = await waitForFakeComment(ws, sessionId, commentTarget)

    await sleepUntil(startedAt + 5000)
    const highlight = await request(ws, timeoutMs, 'comments.highlight.set', {
      sessionId,
      messageId: comment.id,
      pngBase64: commentHighlightImagePngBase64({
        width: 420,
        height: 160,
        rgb: COMMENT_HIGHLIGHT_MARKER_RGB
      }),
      anchor: 'bottom-left',
      rect: CARD_RECT
    })
    if (highlight?.phase !== 'live') {
      throw new Error(`[${label}] the card did not go live: ${JSON.stringify(highlight)}`)
    }
    marks.highlight = (Date.now() - startedAt) / 1000

    await sleepUntil(startedAt + 8500)
    await request(ws, timeoutMs, 'cohost.utterance.say', {
      text: 'Welcome in, everyone. Grab a seat and stay a while!'
    })
    marks.say = (Date.now() - startedAt) / 1000

    await sleepUntil(startedAt + 12500)
    const stopped = await request(ws, timeoutMs, 'session.stop', {})
    sessionActive = false
    await stopRtmpListener(listener)
    const recordingPath = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 })
    assertArtifactFile(label, recordingPath)
    const timeline = await readRecording(recordingPath, { frames })
    writeFileSync(join(directory, 'buddy-pet-timeline.json'), JSON.stringify({ marks, timeline }))

    const runs = buddyPetRuns(timeline)
    const shown = timeline.filter((sample) => sample.id)
    if (shown.length < timeline.length * 0.8) {
      throw new Error(
        `[${label}] the pet's tag read in only ${shown.length} of ${timeline.length} frames (${describe(runs)})`
      )
    }
    const follow = runs.find((run) => (run.id === 'wave' || run.id === 'proud') && run.frames >= 5)
    if (!follow) {
      throw new Error(`[${label}] the follow played no wave or proud: ${describe(runs)}`)
    }
    const left = runs.find(
      (run) => run.start > follow.start && sampleGaze(timeline, run)?.[0] < 0 && run.frames >= 5
    )
    if (!left) {
      throw new Error(
        `[${label}] the card on the left never turned the gaze left: ${describe(runs)}`
      )
    }
    const talk = timeline.filter((sample) => sample.t > left.end)
    if (!buddyPetTalkAlternates(talk, 4)) {
      throw new Error(`[${label}] the Say line did not alternate talk-a/talk-b: ${describe(runs)}`)
    }
    // The reactions (the follow's, then the KICKs tip's `surprised`) play
    // between the follow and the look at the card: the body's box moves.
    const rest = buddyPetMedianBox(
      timeline.filter(
        (sample) => sample.id === BUDDY_PET_FIXTURE_NEUTRAL && sample.t < follow.start
      )
    )
    const reacting = timeline.filter((sample) => sample.t >= follow.start && sample.t < left.start)
    const travel = buddyPetBodyTravel(reacting, rest)
    const followTravel = buddyPetBodyTravel(
      reacting.filter((sample) => sample.t <= follow.end),
      rest
    )
    if (!rest || travel < MIN_REACTION_TRAVEL_PX) {
      throw new Error(
        `[${label}] the body moved ${travel} px while the reactions played (rest ${JSON.stringify(rest)}); expected >= ${MIN_REACTION_TRAVEL_PX}`
      )
    }
    console.log(`[${label}] ${describe(runs)}`)
    return {
      label,
      recordingPath,
      marks,
      followCell: follow.id,
      leftGazeCell: left.id,
      reactionTravelPx: travel,
      followTravelPx: followTravel,
      runs: runs.length
    }
  } finally {
    if (sessionActive) await requestSafe(ws, 'session.stop', {})
    if (sessionId) await requestSafe(ws, 'comments.highlight.clear', { sessionId })
    await requestSafe(ws, 'liveChat.stop', {})
    await stopRtmpListener(listener)
  }
}

async function runStill(ws, smoke, { settings, packId, frames }) {
  const label = 'still'
  const directory = join(outputDirectory, label)
  mkdirSync(directory, { recursive: true })
  await wear(ws, settings, packId, {
    intensity: 0,
    sleepAfterSeconds: SLEEP_AFTER_SECONDS,
    breathing: true
  })
  let sessionActive = false
  try {
    const started = await startSession(ws, smoke, directory, {})
    sessionActive = true
    const startedAt = Date.now()
    await sleep(1500)
    await request(ws, timeoutMs, 'cohost.pet.react', { reaction: 'wave' })
    const reactedAt = (Date.now() - startedAt) / 1000
    await sleepUntil(startedAt + (reactedAt + SLEEP_AFTER_SECONDS + 4) * 1000)
    const stopped = await request(ws, timeoutMs, 'session.stop', {})
    sessionActive = false
    const recordingPath = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 })
    assertArtifactFile(label, recordingPath)
    const timeline = await readRecording(recordingPath, { frames })
    writeFileSync(
      join(directory, 'buddy-pet-timeline.json'),
      JSON.stringify({ reactedAt, timeline })
    )

    const runs = buddyPetRuns(timeline)
    const wave = runs.find((run) => run.id === 'wave' && run.frames >= 5)
    if (!wave) {
      throw new Error(`[${label}] the manual wave never showed: ${describe(runs)}`)
    }
    const rest = buddyPetMedianBox(
      timeline.filter((sample) => sample.id === BUDDY_PET_FIXTURE_NEUTRAL && sample.t < wave.start)
    )
    const travel = buddyPetBodyTravel(
      timeline.filter((sample) => sample.t >= wave.start && sample.t <= wave.end),
      rest
    )
    if (!rest || travel > MAX_STILL_TRAVEL_PX) {
      throw new Error(
        `[${label}] with Motion 0 the body moved ${travel} px during the wave (rest ${JSON.stringify(rest)}); expected <= ${MAX_STILL_TRAVEL_PX}`
      )
    }
    const asleep = runs.find((run) => run.id === 'sleep' && run.frames >= 15)
    if (!asleep) {
      throw new Error(`[${label}] the pet never fell asleep: ${describe(runs)}`)
    }
    const sleepAfterReactionSeconds = asleep.start - wave.start
    if (sleepAfterReactionSeconds < SLEEP_AFTER_SECONDS - 1) {
      throw new Error(
        `[${label}] the pet slept ${sleepAfterReactionSeconds.toFixed(1)} s after the wave; expected about ${SLEEP_AFTER_SECONDS} s`
      )
    }
    console.log(`[${label}] ${describe(runs)}`)
    return {
      label,
      recordingPath,
      reactedAt,
      reactionTravelPx: travel,
      sleepAfterReactionSeconds,
      runs: runs.length
    }
  } finally {
    if (sessionActive) await requestSafe(ws, 'session.stop', {})
  }
}

async function startSession(ws, smoke, directory, { stream }) {
  await ensureOverlayLayout(ws)
  const outputAuthorization = await smokeCommand(smoke, 'authorize-smoke-resource', {
    kind: 'output-directory',
    path: directory
  })
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({ outputDirectoryCapability: outputAuthorization.capabilityId, stream })
  )
  if (!['recording', 'streaming'].includes(started.state) || !started.sessionId) {
    throw new Error(`Expected an active session, got ${JSON.stringify(started)}`)
  }
  return started
}

function sessionParams({ outputDirectoryCapability, stream }) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  return {
    sources: { testPattern: true },
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
      streamEnabled: Boolean(stream),
      outputDirectoryCapability,
      video: { preset: 'custom', ...VIDEO },
      rtmp: {
        preset: 'custom',
        serverUrl: stream?.serverUrl ?? '',
        streamKey: stream?.streamKey ?? ''
      }
    },
    ...(stream
      ? {
          streaming: {
            enabled: true,
            mode: 'single',
            targets: [
              {
                id: stream.id,
                platform: stream.platform,
                label: stream.label,
                enabled: true,
                serverUrl: stream.serverUrl,
                urlMode: 'server-and-key',
                streamKey: stream.streamKey,
                streamKeyPresent: true,
                authMode: 'manual-rtmp',
                outputPreset: 'stream-safe-1080p30',
                outputBitrateKbps: 6000,
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ],
            selectedTargetId: stream.id,
            defaultOutputPreset: 'stream-safe-1080p30',
            defaultBitrateKbps: 6000,
            enabledTargetIds: [stream.id]
          }
        }
      : {}),
    captions: { burnTarget: 'off', position: 'bottom', textSize: 'm' },
    audio: { microphoneGainDb: 0, microphoneMuted: true, microphoneSyncOffsetMs: 0 }
  }
}

/** Decode the recording around the pet, frame by frame, and read each one. */
async function readRecording(path, { frames }) {
  const size = probeVideoSize(path)
  if (size?.width !== VIDEO.width || size?.height !== VIDEO.height) {
    throw new Error(
      `The recording is ${JSON.stringify(size)}, expected ${VIDEO.width}x${VIDEO.height}`
    )
  }
  const box = buddyPetBox(BUDDY_RECT, size.width, size.height)
  const margin = Math.round(box[2] * 0.2)
  const crop = {
    x: Math.max(0, box[0] - margin),
    y: Math.max(0, box[1] - margin),
    width: Math.min(size.width, box[0] + box[2] + margin) - Math.max(0, box[0] - margin),
    height: Math.min(size.height, box[1] + box[3] + margin) - Math.max(0, box[1] - margin)
  }
  const frameBytes = crop.width * crop.height * 3
  const timeline = []
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-an',
    '-vf',
    `fps=${VIDEO.fps},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=rgb24`,
    '-f',
    'rawvideo',
    'pipe:1'
  ]
  await new Promise((resolveDecode, rejectDecode) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = Buffer.alloc(0)
    const stderr = []
    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes)
        pending = pending.subarray(frameBytes)
        const read = readBuddyPetFrame(frame, crop.width, crop.height, {
          box,
          origin: [crop.x, crop.y],
          frames
        })
        timeline.push({ t: timeline.length / VIDEO.fps, ...read })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => stderr.push(text))
    child.on('error', rejectDecode)
    child.on('exit', (code, signal) => {
      if (code === 0) resolveDecode()
      else
        rejectDecode(
          new Error(`ffmpeg decode failed: code=${code} signal=${signal} ${stderr.join('').trim()}`)
        )
    })
  })
  return timeline
}

function sampleGaze(timeline, run) {
  return timeline.find((sample) => sample.t === run.start)?.gaze ?? null
}

function describe(runs) {
  return runs
    .filter((run) => run.frames >= 2)
    .map((run) => `${run.id ?? '?'}@${run.start.toFixed(2)}x${run.frames}`)
    .join(' ')
}

async function waitForFakeComment(ws, sessionId, targetId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'liveChat.status', {})
    const message = (last.messages ?? []).find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.eventType === 'message' &&
        candidate.targetId === targetId
    )
    if (message) return message
    await sleep(50)
  }
  throw new Error(`Timed out waiting for the fake comment: ${JSON.stringify(last)}`)
}

function probeVideoSize(path) {
  const probe = spawnSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      path
    ],
    { encoding: 'utf8' }
  )
  const match = /^(\d+)x(\d+)/.exec(String(probe.stdout).trim())
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

function spawnRtmpListener(target) {
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
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.receivedPath
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
  await waitForExit(child, 1500)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 1000)
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

function assertArtifactFile(label, path) {
  const size = path && existsSync(path) ? statSync(path).size : 0
  if (size <= 0) {
    throw new Error(`[${label}] the recording is missing or empty: ${path ?? 'no path'}`)
  }
}

async function requestSafe(ws, method, params) {
  try {
    return await request(ws, timeoutMs, method, params)
  } catch {
    return null
  }
}

async function smokeCommand(smoke, command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${smoke.capability}`
    },
    body: JSON.stringify({ command, params }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))
}

function sleepUntil(at) {
  return sleep(at - Date.now())
}
