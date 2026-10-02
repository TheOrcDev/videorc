import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  COMMENT_HIGHLIGHT_AVATAR_RGB,
  COMMENT_HIGHLIGHT_EMOTE_RGB,
  analyzeCommentHighlightArtifact,
  captionStimulusPngBase64,
  classifyCommentHighlightResult,
  commentHighlightImagePngBase64,
  formatCommentHighlightArtifactSummary
} from './lib/comment-highlight-artifact.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-comment-highlight-stream-${Date.now()}`)
)
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const captureMs = Number(process.env.VIDEORC_COMMENT_HIGHLIGHT_CAPTURE_MS ?? 4500)
const listenerBindMs = Number(process.env.VIDEORC_COMMENT_HIGHLIGHT_LISTENER_BIND_MS ?? 1500)
const basePort = Number(process.env.VIDEORC_COMMENT_HIGHLIGHT_RTMP_PORT ?? 19721)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
// The fake chatter's avatar and emote (plan 095). The URLs are on allowlisted
// CDN hosts so main's `avatars:cache` accepts them, but they are never
// fetched: the smoke seeds the app's avatar cache with flat-colour PNGs under
// the file names main derives from the URLs, exactly as a chat row would have
// cached them. The card then has to read those bytes back over `avatars:read`
// and paint them, and the analyzer looks for each colour on the card. The
// emote is a Kick-shaped URL (no `/1.0` for the card to swap for `/3.0`) and
// wide, like a 7TV banner emote.
const smokeChatImages = Object.freeze({
  avatar: {
    url: 'https://yt3.ggpht.com/videorc-smoke/comment-highlight-avatar.png',
    pngBase64: commentHighlightImagePngBase64({ rgb: COMMENT_HIGHLIGHT_AVATAR_RGB })
  },
  emote: {
    text: 'smokeHYPE',
    url: 'https://files.kick.com/emotes/videorc-smoke-comment-highlight/fullsize',
    pngBase64: commentHighlightImagePngBase64({
      width: 256,
      height: 128,
      rgb: COMMENT_HIGHLIGHT_EMOTE_RGB
    })
  }
})

const streamSafe1080p30 = Object.freeze({
  preset: 'stream-safe-1080p30',
  width: 1920,
  bitrateKbps: 6000
})

const modernScenarios = [
  {
    label: 'stream-only',
    // The default corner, as a fresh install ships it: same edge as the
    // bottom caption bar, so this also proves captions step above the card.
    anchor: 'bottom-left',
    recordEnabled: false,
    fps: 30,
    streamProfile: streamSafe1080p30,
    allowHighlightUnavailable: false
  },
  {
    label: 'split-record-stream',
    // A non-default pick on the opposite edge and side: proves the pick
    // reaches the compositor.
    anchor: 'top-right',
    recordEnabled: true,
    fps: 30,
    streamProfile: streamSafe1080p30,
    allowHighlightUnavailable: false
  },
  {
    label: 'dual-orientation-record-stream',
    // Plan 074 regression (owner live stream 2026-09-28): with a vertical
    // simulcast leg the backend said "On stream" while the card reached NO
    // output. Both the horizontal destination and the vertical destination
    // must now carry it. Simulcast refuses stream-burned captions, so this
    // scenario proves the card alone.
    anchor: 'bottom-left',
    recordEnabled: true,
    fps: 30,
    streamProfile: streamSafe1080p30,
    verticalLeg: { width: 720, height: 1280 },
    // The recording shares the primary leg with the horizontal stream here
    // (highlight_overlay_leg_plan), so the card and its images must be in
    // the recording too (plan 095).
    expectHighlightInRecording: true,
    allowHighlightUnavailable: false
  }
]
const legacyScenario = {
  label: 'legacy-stream-only-60fps',
  anchor: 'bottom-left',
  recordEnabled: false,
  fps: 60,
  expectedStreamFps: 30,
  streamProfile: streamSafe1080p30,
  allowHighlightUnavailable: true
}

mkdirSync(outputDirectory, { recursive: true })

await runScenarioGroup({
  label: 'modern',
  scenarios: modernScenarios,
  indexOffset: 0
})
await runScenarioGroup({
  label: 'legacy',
  scenarios: [legacyScenario],
  indexOffset: modernScenarios.length
})

console.log(
  `Comment-highlight stream smoke PASS — stream-only and split stream artifacts contain coexisting highlight/caption pixels with the chatter's avatar and emote on the card; both legs of a dual-orientation stream and its recording carry the card; legacy output was visible or explicitly unavailable. Evidence: ${outputDirectory}`
)

async function runScenarioGroup({ label, scenarios, indexOffset, env = {} }) {
  const groupStateDirectory = join(outputDirectory, `${label}-app-state`)
  const userDataDirectory = join(groupStateDirectory, 'user-data')
  for (const image of Object.values(smokeChatImages)) {
    seedCachedChatImage(userDataDirectory, image)
  }
  const launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(groupStateDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: userDataDirectory,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_COMMENTS_WINDOW: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      ...env
    }
  })
  let ws
  try {
    ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
    const smoke = launched.connections['preview-motion-ready']
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(
        health?.ffmpeg?.message ?? 'FFmpeg is unavailable for comment-highlight stream smoke.'
      )
    }
    const commentsWindow = await smokeCommand(smoke, 'comments-window-open')
    if (!commentsWindow?.open) {
      throw new Error(`Detached Comments window did not open: ${JSON.stringify(commentsWindow)}`)
    }
    for (const [index, scenario] of scenarios.entries()) {
      await runScenario(ws, smoke, scenario, indexOffset + index)
    }
  } finally {
    ws?.close()
    await launched.stop()
  }
}

async function runScenario(ws, smoke, scenario, index) {
  if (scenario.allowHighlightUnavailable && scenario.fps <= 30) {
    throw new Error(
      `[${scenario.label}] legacy compatibility must be exercised above 30fps, got ${scenario.fps}`
    )
  }
  const scenarioDirectory = join(outputDirectory, scenario.label)
  mkdirSync(scenarioDirectory, { recursive: true })
  const anchored = await smokeCommand(smoke, 'comments-window-set-highlight-anchor', {
    anchor: scenario.anchor
  })
  if (anchored?.highlightAnchor !== scenario.anchor) {
    throw new Error(
      `[${scenario.label}] highlight anchor did not apply: ${JSON.stringify(anchored)}`
    )
  }
  const port = basePort + index
  const targetId = `comment-highlight-${scenario.label}`
  const streamKey = `comment-highlight-${index}`
  const target = {
    id: targetId,
    platform: 'custom',
    label: `Local ${scenario.label}`,
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    streamKey,
    listenUrl: `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    receivedPath: join(scenarioDirectory, 'stream-received.flv')
  }
  const verticalTarget = scenario.verticalLeg
    ? {
        id: `${targetId}-vertical`,
        platform: 'custom',
        label: `Local ${scenario.label} vertical`,
        serverUrl: `rtmp://127.0.0.1:${port + 50}/live`,
        streamKey: `${streamKey}-vertical`,
        listenUrl: `rtmp://127.0.0.1:${port + 50}/live/${streamKey}-vertical`,
        receivedPath: join(scenarioDirectory, 'stream-received-vertical.flv')
      }
    : null
  // Stream-burned captions are refused beside a vertical leg.
  const requireCaption = !verticalTarget
  const listener = spawnRtmpListener(target)
  const verticalListener = verticalTarget ? spawnRtmpListener(verticalTarget) : null
  let sessionActive = false
  let sessionId = null
  let stopCaptionStimulus = null

  try {
    await sleep(listenerBindMs)
    for (const candidate of [listener, verticalListener].filter(Boolean)) {
      if (candidate.process.exitCode !== null) {
        throw new Error(
          `[${scenario.label}] local RTMP listener exited before session start: ${candidate.stderr.join('').trim()}`
        )
      }
    }

    const outputAuthorization = await smokeCommand(smoke, 'authorize-smoke-resource', {
      kind: 'output-directory',
      path: scenarioDirectory
    })
    const started = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams({
        scenario,
        outputDirectoryCapability: outputAuthorization.capabilityId,
        target,
        verticalTarget
      })
    )
    if (!['recording', 'streaming'].includes(started.state) || !started.sessionId) {
      throw new Error(
        `[${scenario.label}] expected an active stream session, got ${JSON.stringify(started)}`
      )
    }
    sessionActive = true
    sessionId = started.sessionId

    await request(ws, timeoutMs, 'liveChat.start', {
      sessionId,
      platforms: ['youtube'],
      destinations: [{ targetId, platform: 'youtube', read: 'ready', write: 'ready' }],
      fake: {
        platform: 'youtube',
        targetId,
        count: 1,
        intervalMs: 25,
        includeDuplicate: false,
        avatarUrl: smokeChatImages.avatar.url,
        emote: { text: smokeChatImages.emote.text, imageUrl: smokeChatImages.emote.url }
      }
    })
    const message = await waitForFakeComment(ws, sessionId, targetId)
    await waitForDetachedComment(smoke, message)

    const highlight = await selectAndWaitForHighlight(ws, smoke, {
      sessionId,
      messageId: message.id
    })
    if (highlight.disposition === 'highlight-unavailable' && !scenario.allowHighlightUnavailable) {
      throw new Error(`[${scenario.label}] modern stream path returned highlight-unavailable`)
    }

    // Install the deterministic caption marker after the UI-driven highlight. The Studio
    // renderer owns overlay reconciliation and may still be settling while the Comments IPC
    // request rasterizes the card; this order proves the two final viewer-facing slots coexist.
    await sleep(1500)
    if (requireCaption) {
      // Caption bars are output-sized raster overlays and the compositor never scales
      // them. Use the resolved viewer-facing stream width even for stream-only sessions,
      // whose 640x360 recording placeholder is normalized to this provider profile.
      const captionStimulusWidth = scenario.streamProfile.width
      const captionStimulus = startCaptionOverlayStimulus(ws, {
        width: captionStimulusWidth,
        height: Math.round(captionStimulusWidth * (140 / 1920)),
        intervalMs: 250
      })
      stopCaptionStimulus = captionStimulus.stop
      const captionSet = await captionStimulus.first
      if (!captionSet?.active) {
        throw new Error(
          `[${scenario.label}] caption marker did not install: ${JSON.stringify(captionSet)}`
        )
      }
    }

    await sleep(captureMs)
    await stopCaptionStimulus?.()
    stopCaptionStimulus = null
    const highlightBeforeStop = await detailedRequest(
      ws,
      timeoutMs,
      'comments.highlight.status',
      {}
    )
    if (
      highlight.disposition === 'live' &&
      (highlightBeforeStop.phase !== 'live' || highlightBeforeStop.messageId !== message.id)
    ) {
      throw new Error(
        `[${scenario.label}] backend highlight left live before capture completed: ${JSON.stringify(highlightBeforeStop)}`
      )
    }
    const stopped = await request(ws, timeoutMs, 'session.stop', {})
    sessionActive = false
    await stopRtmpListener(listener)
    await stopRtmpListener(verticalListener)

    assertArtifactFile(scenario.label, target.receivedPath, 'RTMP-received stream')
    const quality = await analyzeRecording(target.receivedPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: scenario.expectedStreamFps ?? scenario.fps,
      expectAudio: false,
      gates: {
        requireMotion: false,
        frameCountTolerance: Number.POSITIVE_INFINITY,
        maxDurationStretchRatio: Number.POSITIVE_INFINITY,
        avSyncTargetMs: Number.POSITIVE_INFINITY,
        avSyncHardFailMs: Number.POSITIVE_INFINITY
      }
    })
    const qualityPaths = writeReports(quality, { outDir: scenarioDirectory })
    if (!quality.verdict.pass) {
      throw new Error(
        `[${scenario.label}] received stream quality failed: ${quality.verdict.failures.join('; ')} (report: ${qualityPaths.mdPath})`
      )
    }

    const artifact = await analyzeCommentHighlightArtifact(target.receivedPath, {
      ffmpegPath,
      highlightDisposition: highlight.disposition,
      allowHighlightUnavailable: scenario.allowHighlightUnavailable,
      requireCaption,
      requireAvatar: true,
      requireEmote: true,
      anchor: scenario.anchor
    })
    const artifactPath = join(scenarioDirectory, 'comment-highlight-artifact.json')
    writeFileSync(artifactPath, JSON.stringify({ scenario, highlight, artifact }, null, 2))
    console.log(`[${scenario.label}] ${formatCommentHighlightArtifactSummary(artifact)}`)
    if (!artifact.pass) {
      throw new Error(
        `[${scenario.label}] comment-highlight artifact gate failed: ${artifact.failures.join('; ')} (report: ${artifactPath})`
      )
    }

    if (verticalTarget) {
      assertArtifactFile(
        scenario.label,
        verticalTarget.receivedPath,
        'RTMP-received vertical stream'
      )
      // The vertical destination must receive the PORTRAIT leg, not the program.
      const size = probeVideoSize(verticalTarget.receivedPath)
      if (
        size?.width !== scenario.verticalLeg.width ||
        size?.height !== scenario.verticalLeg.height
      ) {
        throw new Error(
          `[${scenario.label}] vertical destination received ${JSON.stringify(size)}, expected ${scenario.verticalLeg.width}x${scenario.verticalLeg.height}`
        )
      }
      const verticalArtifact = await analyzeCommentHighlightArtifact(verticalTarget.receivedPath, {
        ffmpegPath,
        highlightDisposition: highlight.disposition,
        requireCaption: false,
        requireAvatar: true,
        requireEmote: true,
        anchor: scenario.anchor,
        // Native portrait size: the card's ~27 px text blurs out of the text
        // classifier when downscaled.
        sampleWidth: scenario.verticalLeg.width,
        sampleHeight: scenario.verticalLeg.height
      })
      const verticalArtifactPath = join(
        scenarioDirectory,
        'comment-highlight-artifact-vertical.json'
      )
      writeFileSync(
        verticalArtifactPath,
        JSON.stringify({ scenario, highlight, artifact: verticalArtifact }, null, 2)
      )
      console.log(
        `[${scenario.label}:vertical] ${formatCommentHighlightArtifactSummary(verticalArtifact)}`
      )
      if (!verticalArtifact.pass) {
        throw new Error(
          `[${scenario.label}] vertical comment-highlight artifact gate failed: ${verticalArtifact.failures.join('; ')} (report: ${verticalArtifactPath})`
        )
      }
    }

    if (scenario.recordEnabled) {
      const recordingPath = await resolveFinalRecordingPath({
        started,
        stopped,
        timeoutMs: 120_000
      })
      assertArtifactFile(scenario.label, recordingPath, 'local recording')
      const recordingQuality = await analyzeRecording(recordingPath, {
        ffmpegPath,
        ffprobePath,
        intendedFps: scenario.fps,
        expectAudio: false,
        gates: {
          requireMotion: false,
          avSyncTargetMs: Number.POSITIVE_INFINITY,
          avSyncHardFailMs: Number.POSITIVE_INFINITY
        }
      })
      const recordingPaths = writeReports(recordingQuality, { outDir: scenarioDirectory })
      if (!recordingQuality.verdict.pass) {
        throw new Error(
          `[${scenario.label}] local recording quality failed: ${recordingQuality.verdict.failures.join('; ')} (report: ${recordingPaths.mdPath})`
        )
      }
      if (scenario.expectHighlightInRecording) {
        const recordingArtifact = await analyzeCommentHighlightArtifact(recordingPath, {
          ffmpegPath,
          highlightDisposition: highlight.disposition,
          requireCaption: false,
          requireAvatar: true,
          requireEmote: true,
          anchor: scenario.anchor
        })
        const recordingArtifactPath = join(
          scenarioDirectory,
          'comment-highlight-artifact-recording.json'
        )
        writeFileSync(
          recordingArtifactPath,
          JSON.stringify({ scenario, highlight, artifact: recordingArtifact }, null, 2)
        )
        console.log(
          `[${scenario.label}:recording] ${formatCommentHighlightArtifactSummary(recordingArtifact)}`
        )
        if (!recordingArtifact.pass) {
          throw new Error(
            `[${scenario.label}] recording comment-highlight artifact gate failed: ${recordingArtifact.failures.join('; ')} (report: ${recordingArtifactPath})`
          )
        }
      }
    }
  } finally {
    await stopCaptionStimulus?.()
    if (sessionActive) {
      await requestSafe(ws, 'session.stop', {})
    }
    await requestSafe(ws, 'comments.highlight.clear', { sessionId })
    await requestSafe(ws, 'captions.overlay.clear', {})
    await requestSafe(ws, 'liveChat.stop', {})
    await stopRtmpListener(listener)
    await stopRtmpListener(verticalListener)
  }
}

/** Mirrors `avatarCacheFileName` in apps/desktop/src/main/avatar-cache.ts:
 * sha256(url) (32 hex) plus the extension from the URL path, `.img` otherwise. */
function cachedChatImageFileName(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32)
  const path = new URL(url).pathname.toLowerCase()
  const extension = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].find((candidate) =>
    path.endsWith(candidate)
  )
  return `${hash}${extension ?? '.img'}`
}

function seedCachedChatImage(userDataDirectory, { url, pngBase64 }) {
  const directory = join(userDataDirectory, 'avatar-cache')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, cachedChatImageFileName(url)), Buffer.from(pngBase64, 'base64'))
}

function startCaptionOverlayStimulus(ws, { width, height, intervalMs }) {
  const pngBase64 = captionStimulusPngBase64({ width, height })
  let stopped = false
  let failure = null
  let pending = Promise.resolve(null)
  const push = () => {
    if (stopped) return pending
    pending = request(ws, timeoutMs, 'captions.overlay.set', {
      pngBase64,
      position: 'bottom'
    }).catch((error) => {
      failure ??= error
      return null
    })
    return pending
  }
  const first = push()
  const interval = setInterval(() => void push(), Math.max(250, intervalMs))
  return {
    first,
    stop: async () => {
      stopped = true
      clearInterval(interval)
      await pending
      if (failure) throw failure
    }
  }
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
        (!candidate.targetId || candidate.targetId === targetId)
    )
    if (message) return message
    await sleep(50)
  }
  throw new Error(
    `Timed out waiting for fake comment in session ${sessionId}: ${JSON.stringify(last)}`
  )
}

async function waitForDetachedComment(smoke, message) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await smokeCommand(smoke, 'comments-window-reader-state')
    // An emote fragment renders as an image, so only the text fragments are
    // expected in the window's innerText.
    const expectedText = (message.fragments ?? []).some((fragment) => fragment.imageUrl)
      ? message.fragments
          .filter((fragment) => !fragment.imageUrl)
          .map((fragment) => fragment.text)
          .join('')
          .trim()
      : message.messageText
    if (
      Object.hasOwn(last.highlightPhases ?? {}, message.id) &&
      last.text?.includes(message.authorName) &&
      last.text?.includes(expectedText)
    ) {
      return last
    }
    await sleep(50)
  }
  throw new Error(
    `Timed out waiting for ${message.id} in the detached Comments window: ${JSON.stringify(last)}`
  )
}

async function selectAndWaitForHighlight(ws, smoke, params) {
  const clicked = await smokeCommand(smoke, 'comments-window-click-message', {
    messageId: params.messageId
  })
  if (!clicked?.clicked) {
    throw new Error(
      `Detached Comments window did not dispatch ${params.messageId}: ${JSON.stringify(clicked)}`
    )
  }

  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const [state, reader, command] = await Promise.all([
      detailedRequest(ws, timeoutMs, 'comments.highlight.status', {}),
      smokeCommand(smoke, 'comments-window-reader-state'),
      smokeCommand(smoke, 'comments-window-command-trace')
    ])
    const rowPhase = reader.highlightPhases?.[params.messageId]
    const disposition = classifyCommentHighlightResult(state)
    last = { state, reader, command, clicked }

    if (
      disposition === 'live' &&
      state.sessionId === params.sessionId &&
      state.messageId === params.messageId &&
      rowPhase === 'live' &&
      command.pendingCount === 0
    ) {
      return { disposition, state, ipc: { clicked, rowPhase, pendingCount: 0 } }
    }

    if (rowPhase === 'failed' && command.pendingCount === 0) {
      const reason = reader.highlightReasons?.[params.messageId]
      if (/unavailable for this livestream output path/i.test(reason ?? '')) {
        return {
          disposition: 'highlight-unavailable',
          state: { phase: 'failed', code: 'highlight-unavailable', reason },
          ipc: { clicked, rowPhase, pendingCount: 0 }
        }
      }
      throw new Error(
        `Detached Comments highlight failed without typed unavailability: ${JSON.stringify({ reason, state })}`
      )
    }
    await sleep(75)
  }
  throw new Error(
    `Timed out waiting for detached-IPC highlight to reach backend live: ${JSON.stringify(last)}`
  )
}

function sessionParams({ scenario, outputDirectoryCapability, target, verticalTarget }) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const params = baseSessionParams({ scenario, outputDirectoryCapability, target, timestamp })
  if (!verticalTarget) {
    return params
  }
  // Dual orientation: horizontal destinations share the session profile (one
  // horizontal encode), the vertical destination consumes the portrait leg.
  const video = { ...params.output.video, width: 1280, height: 720 }
  const targetEntry = (entry, extra = {}) => ({
    id: entry.id,
    platform: entry.platform,
    label: entry.label,
    enabled: true,
    serverUrl: entry.serverUrl,
    urlMode: 'server-and-key',
    streamKey: entry.streamKey,
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra
  })
  return {
    ...params,
    output: { ...params.output, video },
    streaming: {
      ...params.streaming,
      mode: 'multi',
      targets: [
        targetEntry(target),
        targetEntry(verticalTarget, { outputOrientation: 'vertical' })
      ],
      enabledTargetIds: [target.id, verticalTarget.id]
    },
    captions: { ...params.captions, burnTarget: 'off' },
    simulcast: {
      layout: {
        ...params.layout,
        layoutPreset: 'vertical-camera-bottom',
        verticalScreenFraming: 'fit'
      },
      video: { ...video, ...scenario.verticalLeg }
    }
  }
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

function baseSessionParams({ scenario, outputDirectoryCapability, target, timestamp }) {
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
      recordEnabled: scenario.recordEnabled,
      streamEnabled: true,
      outputDirectoryCapability,
      video: {
        preset: 'custom',
        width: 640,
        height: 360,
        fps: scenario.fps,
        bitrateKbps: 2000
      },
      rtmp: {
        preset: 'custom',
        serverUrl: target.serverUrl,
        streamKey: target.streamKey
      }
    },
    streaming: {
      enabled: true,
      mode: 'single',
      targets: [
        {
          id: target.id,
          platform: target.platform,
          label: target.label,
          enabled: true,
          serverUrl: target.serverUrl,
          urlMode: 'server-and-key',
          streamKey: target.streamKey,
          streamKeyPresent: true,
          authMode: 'manual-rtmp',
          outputPreset: scenario.streamProfile.preset,
          outputBitrateKbps: scenario.streamProfile.bitrateKbps,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ],
      selectedTargetId: target.id,
      defaultOutputPreset: scenario.streamProfile.preset,
      defaultBitrateKbps: scenario.streamProfile.bitrateKbps,
      enabledTargetIds: [target.id]
    },
    captions: {
      burnTarget: 'stream',
      position: 'bottom',
      textSize: 'm'
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: true,
      microphoneSyncOffsetMs: 0
    }
  }
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

function assertArtifactFile(label, path, kind) {
  const size = path && existsSync(path) ? statSync(path).size : 0
  if (size <= 0) {
    throw new Error(`[${label}] ${kind} is missing or empty: ${path ?? 'no path'}`)
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

function detailedRequest(ws, timeout, method, params) {
  const id = `comment-highlight-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      rejectRequest(new Error(`Timed out waiting for ${method}.`))
    }, timeout)

    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== id) return

      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (message.ok) {
        resolveRequest(message.payload)
        return
      }
      const error = new Error(message.error?.message ?? `${method} failed.`)
      error.code = message.error?.code
      rejectRequest(error)
    }

    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
