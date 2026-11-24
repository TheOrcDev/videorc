// Diagnostic incident coverage, deliberately separate from protected performance qualification.
export function buildWindowsIncidentMatrix() {
  return [1080, 720].flatMap((height) =>
    ['record', 'single', 'dual', 'record-dual'].flatMap((topology) =>
      ['controlled', 'ffmpeg-control', 'worker', 'direct-fallback'].flatMap((audio) =>
        ['same-process', 'restart'].map((retry) => ({
          id: `${height}p30-${topology}-${audio}-${retry}`,
          width: height === 1080 ? 1920 : 1280,
          height,
          fps: 30,
          bitrateKbps: 6000,
          topology,
          audio,
          retry,
          recordEnabled: topology === 'record' || topology === 'record-dual',
          receivers: topology === 'record' ? 0 : topology === 'single' ? 1 : 2,
          repetitions: 3,
          durationMs: 12000,
          preview: 'backend-compositor-no-presenter'
        }))
      )
    )
  )
}

export function incidentProcessGroups(scenario) {
  const runs = Array.from({ length: scenario.repetitions }, (_, index) => index + 1)
  return scenario.retry === 'same-process' ? [runs] : runs.map((run) => [run])
}

export function createIncidentReadyParser(onReady, onError) {
  let pending = ''
  let bytes = 0
  let complete = false
  return (chunk) => {
    if (complete) return
    bytes += Buffer.byteLength(chunk)
    if (bytes > 64000) {
      complete = true
      onError(new Error('Backend READY exceeded bounded output'))
      return
    }
    pending += chunk.toString()
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (!line.startsWith('READY ')) continue
      complete = true
      try {
        onReady(JSON.parse(line.slice(6)))
      } catch {
        onError(new Error('Malformed backend READY'))
      }
      return
    }
  }
}

export function parseWindowsIncidentArgs(argv) {
  const args = argv.filter((arg) => arg !== '--')
  const result = {
    list: false,
    scenario: null,
    audio: null,
    backend: null,
    output: null,
    microphone: null
  }
  while (args.length) {
    const flag = args.shift()
    if (flag === '--incident') continue
    if (flag === '--list') {
      result.list = true
      continue
    }
    const key = {
      '--scenario': 'scenario',
      '--audio': 'audio',
      '--backend': 'backend',
      '--output': 'output',
      '--microphone': 'microphone'
    }[flag]
    if (!key || !args[0] || args[0].startsWith('--'))
      throw new Error(`Unknown or incomplete incident option: ${flag}`)
    if (result[key] !== null) throw new Error(`Duplicate incident option: ${flag}`)
    result[key] = args.shift()
  }
  result.scenarios = buildWindowsIncidentMatrix().filter(
    (scenario) =>
      (!result.scenario || scenario.id === result.scenario) &&
      (!result.audio || scenario.audio === result.audio)
  )
  if (!result.scenarios.length) throw new Error('Incident selection contains no cases')
  return result
}

export function assertOwnedLoopbackTarget(target) {
  const url = new URL(target.serverUrl)
  if (
    url.protocol !== 'rtmp:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/live' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(target.streamKey)
  ) {
    throw new Error('Incident destinations must be runner-owned literal loopback receivers')
  }
}

export function incidentAudioEnvironment(audio) {
  return {
    VIDEORC_CAPTION_CONTRACT_TEST: audio === 'controlled' ? '1' : '0',
    VIDEORC_LIVE_SOURCE_SWITCH_TEST: audio === 'controlled' ? '1' : '0',
    VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '0',
    VIDEORC_INCIDENT_FFMPEG_TONE: audio === 'ffmpeg-control' ? '1' : '0'
  }
}

export function incidentSessionParams(scenario, targets, microphoneId) {
  if (targets.length !== scenario.receivers) throw new Error('Missing incident receiver')
  targets.forEach(assertOwnedLoopbackTarget)
  if (['worker', 'direct-fallback'].includes(scenario.audio) && !microphoneId)
    throw new Error('Physical microphone required for worker/fallback incident case')
  const now = new Date().toISOString()
  const video = {
    preset: 'custom',
    width: scenario.width,
    height: scenario.height,
    fps: scenario.fps,
    bitrateKbps: scenario.bitrateKbps
  }
  const transform = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  return {
    sources: {
      testPattern: true,
      microphoneId:
        scenario.audio === 'controlled'
          ? 'microphone:coreaudio:4294967295'
          : scenario.audio === 'ffmpeg-control'
            ? undefined
            : microphoneId
    },
    scene: {
      id: 'incident-motion',
      name: 'Incident synthetic motion',
      sources: [
        {
          id: 'source:test-pattern',
          name: 'Moving diagnostic source',
          kind: 'test-pattern',
          transform,
          defaultTransform: transform,
          visible: true,
          locked: false
        }
      ],
      outputs: []
    },
    layout: {
      layoutPreset: 'screen-only',
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
    },
    output: {
      recordEnabled: scenario.recordEnabled,
      streamEnabled: targets.length > 0,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: targets[0]?.serverUrl ?? '',
        streamKey: targets[0]?.streamKey ?? ''
      }
    },
    streaming: {
      enabled: targets.length > 0,
      mode: targets.length > 1 ? 'multi' : 'single',
      defaultOutputPreset: scenario.height === 720 ? 'tutorial-720p30' : 'stream-safe-1080p30',
      defaultBitrateKbps: scenario.bitrateKbps,
      enabledTargetIds: targets.map((_, index) => `incident-${index}`),
      selectedTargetId: targets.length ? 'incident-0' : null,
      targets: targets.map((target, index) => ({
        id: `incident-${index}`,
        platform: 'custom',
        label: `Owned loopback receiver ${index + 1}`,
        enabled: true,
        serverUrl: target.serverUrl,
        streamKey: target.streamKey,
        urlMode: 'server-and-key',
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: now,
        updatedAt: now
      }))
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}

/**
 * Exact one-frame-over repeated-frame analyzer failure seen on GitHub-hosted
 * Windows runners under OpenH264 on short controlled clips.
 *
 * Evidence (main, 2026-11-24):
 * - Run 45349657229: 1080p30-single-controlled-restart #2 only (reps 1+3 PASS)
 * - Run 45378034730: 720p30-single-controlled-same-process #3 only (reps 1+2 PASS)
 * Adjacent full-matrix greens kept maxRepeatedFrameRun ≤ 2. Real freezes are
 * multi-frame (≫3) or multi-burst; those stay hard failures.
 *
 * Product analyzer gates remain maxRepeatedFrameRun: 2. CI may tolerate this
 * burst only when structured artifact predicates (dimensions, audio, packet
 * tail) and every non-artifact gate still pass — never when analyzer failures
 * are joined with a tail/audio/dimension miss (review r4682135380).
 */
export const INCIDENT_CI_REPEATED_FRAME_BURST_ONLY =
  'repeated-frame burst of 3 consecutive identical frames exceeds 2 (1 burst(s))'

const INCIDENT_CI_REPEATED_FRAME_FAILURE_LINE = new RegExp(
  `^\\S+ analyzed A/V artifact missing or failed: ${INCIDENT_CI_REPEATED_FRAME_BURST_ONLY.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  )}$`
)

export function incidentScenarioById(id) {
  return buildWindowsIncidentMatrix().find((scenario) => scenario.id === id) ?? null
}

/** Analyzer failures array must be exactly the known single 3-frame burst. */
export function isExactCiRepeatedFrameAnalyzerFailure(failures) {
  return (
    Array.isArray(failures) &&
    failures.length === 1 &&
    failures[0] === INCIDENT_CI_REPEATED_FRAME_BURST_ONLY
  )
}

/**
 * True only when a failed run's sole defect is that exact analyzer burst on
 * otherwise gate-clean artifacts. Joined analyzer strings, wrong dimensions,
 * missing audio, packet-tail misses, and non-artifact failures all return false.
 */
export function isIncidentCiRepeatedFrameNoise(
  run,
  scenario = incidentScenarioById(run?.scenario)
) {
  if (!run || run.verdict?.pass || run.state === 'BLOCKED' || !scenario) return false
  const failures = run.verdict?.failures ?? []
  if (failures.length === 0) return false
  if (failures.some((failure) => !INCIDENT_CI_REPEATED_FRAME_FAILURE_LINE.test(String(failure)))) {
    return false
  }
  if (run.startOutcome !== 'running') return false
  if (!run.cleanup?.receiversReaped || !run.cleanup?.sessionIdle) return false
  if (run.failure || (Array.isArray(run.errors) && run.errors.length > 0)) return false

  const expectedRoles = [
    ...(scenario.recordEnabled ? ['recording'] : []),
    ...Array.from({ length: scenario.receivers }, (_, index) => `receiver-${index + 1}`)
  ]
  let sawNoise = false
  for (const role of expectedRoles) {
    const artifact = run.artifacts?.find((item) => item.role === role)
    if (!artifact) return false
    if (
      artifact.width !== scenario.width ||
      artifact.height !== scenario.height ||
      artifact.hasAudio !== true ||
      artifact.packetTail?.pass !== true ||
      !Number.isFinite(artifact.packetTail?.tailMismatchMs) ||
      artifact.packetTail.tailMismatchMs > 100
    ) {
      return false
    }
    if (artifact.verdict === 'PASS') continue
    if (artifact.reason || !isExactCiRepeatedFrameAnalyzerFailure(artifact.failures)) {
      return false
    }
    sawNoise = true
  }
  return sawNoise
}

/**
 * Per-scenario CI policy: three retained repetitions stay in the report; the
 * aggregate may PASS when exactly one repetition fails solely with the known
 * single 3-frame runner-noise pattern and the other two pass. Any other
 * failure, two noisy reps, or a bigger freeze still FAIL.
 */
export function incidentScenarioSurvivesCiNoise(runs) {
  const passed = runs.filter((run) => run?.verdict?.pass)
  const failed = runs.filter((run) => !run?.verdict?.pass && run?.state !== 'BLOCKED')
  const blocked = runs.filter((run) => run?.state === 'BLOCKED')
  if (blocked.length > 0) return { pass: false, reason: 'blocked' }
  if (failed.length === 0) return { pass: true, tolerated: [] }
  if (failed.length === 1 && isIncidentCiRepeatedFrameNoise(failed[0])) {
    if (passed.length >= 2) {
      return {
        pass: true,
        tolerated: [
          {
            scenario: failed[0].scenario,
            repetition: failed[0].repetition,
            reason:
              'CI runner noise: one retained repetition had a single 3-frame exact-duplicate burst (threshold 2) with dimensions, audio and packet-tail gates still green; the other two repetitions passed. Product gates stay at maxRepeatedFrameRun 2.'
          }
        ]
      }
    }
  }
  return { pass: false, reason: 'hard-fail' }
}

export function evaluateWindowsIncidentRun(scenario, run) {
  const failures = []
  if (run.startOutcome !== 'running') failures.push('startup did not reach running')
  const evidence = run.evidence ?? {}
  if (!evidence.finalDiagnostics || !evidence.sessionId)
    failures.push('session diagnostics missing')
  if (!evidence.ffmpegStartup || !evidence.ffmpegTail)
    failures.push('retained FFmpeg startup/tail evidence missing')
  if (!evidence.startTimeline || !evidence.stopTimeline)
    failures.push('startup/cleanup timeline missing')
  if (!Number.isFinite(evidence.bridgeFrames) || evidence.bridgeFrames <= 0)
    failures.push('bridge frame evidence missing')
  if (evidence.effectiveEncoder !== 'libopenh264' || evidence.effectiveOutput !== 'raw-yuv420p')
    failures.push('requested raw/OpenH264 path was not observed')
  if (evidence.audioPath !== scenario.audio) failures.push('requested audio path was not observed')
  if (scenario.audio === 'worker' && !(evidence.firstPcm?.frames > 0))
    failures.push('worker PCM was not observed')
  if (
    scenario.audio === 'direct-fallback' &&
    !evidence.fallbackReason?.includes('Injected incident capture-worker')
  )
    failures.push('injected worker fallback was not observed')
  if (!run.cleanup?.receiversReaped || !run.cleanup?.sessionIdle)
    failures.push('owned output cleanup incomplete')
  const expected = [
    ...(scenario.recordEnabled ? ['recording'] : []),
    ...Array.from({ length: scenario.receivers }, (_, index) => `receiver-${index + 1}`)
  ]
  for (const role of expected) {
    const artifact = run.artifacts?.find((item) => item.role === role)
    if (
      !artifact ||
      artifact.verdict !== 'PASS' ||
      artifact.width !== scenario.width ||
      artifact.height !== scenario.height ||
      artifact.hasAudio !== true ||
      artifact.packetTail?.pass !== true ||
      !Number.isFinite(artifact.packetTail?.tailMismatchMs) ||
      artifact.packetTail.tailMismatchMs > 100
    )
      failures.push(
        `${role} analyzed A/V artifact missing or failed${artifact?.reason ? `: ${artifact.reason}` : artifact?.failures?.length ? `: ${artifact.failures.join('; ')}` : ''}`
      )
  }
  return { pass: failures.length === 0, failures }
}

// This is the real runner's failure seam. Every start result, including a
// rejected RPC, reaches collection and owned cleanup before the next retry.
export async function executeIncidentAttempt(scenario, operations) {
  const run = {
    startOutcome: 'failed',
    failure: null,
    cleanup: {},
    evidence: {},
    artifacts: [],
    errors: []
  }
  try {
    const started = await operations.start()
    if (!['recording', 'streaming'].includes(started?.state))
      throw new Error(`Unexpected start state: ${started?.state}`)
    run.startOutcome = 'running'
    await operations.measure()
  } catch (error) {
    run.failure = String(error?.message ?? error)
    run.unsafeCleanup = error?.unsafeCleanup === true
  } finally {
    for (const [name, operation] of [
      ['cleanup', operations.stop],
      ['evidence', operations.collect],
      ['cleanup', operations.reap]
    ]) {
      try {
        Object.assign(run[name], await operation())
      } catch (error) {
        run.errors.push(`${name}: ${String(error?.message ?? error)}`)
      }
    }
    try {
      run.artifacts = await operations.analyze()
    } catch (error) {
      run.errors.push(`artifact analysis: ${String(error?.message ?? error)}`)
    }
  }
  if (run.unsafeCleanup) run.cleanup.receiversReaped = false
  const verdict = evaluateWindowsIncidentRun(scenario, run)
  run.verdict = {
    pass: verdict.pass && run.errors.length === 0 && run.failure === null,
    failures: [...verdict.failures, ...run.errors, ...(run.failure ? [run.failure] : [])]
  }
  return run
}

// Clip silence to the measured interior before evaluating it. The shared
// analyzer deliberately excludes any segment touching lead/tail; a completely
// silent file therefore needs this diagnostic-specific audible-content gate.
export function validateIncidentAudibleInterior(scenario, analysis) {
  const duration = analysis.metrics?.durationSeconds
  const silences = analysis.findings?.silences
  if (!Number.isFinite(duration) || duration <= 0.8 || !Array.isArray(silences))
    return { pass: false, reason: 'Audible interior evidence missing' }
  const start = 0.5
  const end = duration - 0.3
  const clipped = silences
    .map((silence) => ({
      start: Math.max(start, silence.start),
      end: Math.min(end, silence.end ?? duration)
    }))
    .filter((silence) => silence.end > silence.start)
    .sort((a, b) => a.start - b.start)
  let silentSeconds = 0
  let cursor = start
  for (const silence of clipped) {
    silentSeconds += Math.max(0, silence.end - Math.max(cursor, silence.start))
    cursor = Math.max(cursor, silence.end)
  }
  const allowedSilentSeconds = ['controlled', 'ffmpeg-control'].includes(scenario.audio)
    ? 0.02
    : (end - start) * 0.9
  const pass = silentSeconds < allowedSilentSeconds
  return {
    pass,
    silentInteriorMs: silentSeconds * 1000,
    reason: pass
      ? null
      : `Measured interior silence ${(silentSeconds * 1000).toFixed(1)}ms must be below ${(allowedSilentSeconds * 1000).toFixed(1)}ms for ${scenario.audio} audio`
  }
}

export function incidentAudioPath(
  fallbackReason,
  firstPcm,
  requestedAudio,
  ffmpegToneObserved = false
) {
  if (fallbackReason)
    return fallbackReason.includes('Injected incident capture-worker')
      ? 'direct-fallback'
      : 'unexpected-direct-fallback'
  if (requestedAudio === 'ffmpeg-control') return ffmpegToneObserved ? 'ffmpeg-control' : 'unknown'
  if (requestedAudio === 'controlled') return 'controlled'
  if (firstPcm) return 'worker'
  return 'unknown'
}

export function incidentAdapterInventory(result) {
  try {
    if (result.status !== 0 || !result.stdout?.trim()) throw new Error('unavailable')
    const values = JSON.parse(result.stdout)
    if (!values || typeof values !== 'object') throw new Error('invalid shape')
    return { state: 'observed', provenance: 'Win32_VideoController', values }
  } catch {
    return { state: 'unknown', reason: 'Windows adapter inventory unavailable or invalid' }
  }
}

export function incidentSessionEvidence(sessionPage, logPage, supportBundle, sessionId) {
  const row = sessionPage?.items?.find((item) => item.id === sessionId) ?? null
  const bundled = supportBundle?.sessions?.find((item) => item.id === sessionId)
  return {
    session: row ? { ...row, finalDiagnostics: bundled?.finalDiagnostics ?? null } : null,
    logs: Array.isArray(logPage?.entries)
      ? logPage.entries.filter((entry) => entry.sessionId === sessionId)
      : []
  }
}
