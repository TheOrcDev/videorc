import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWindowsIncidentMatrix,
  parseWindowsIncidentArgs,
  evaluateWindowsIncidentRun,
  incidentSessionParams,
  incidentProcessGroups,
  executeIncidentAttempt,
  createIncidentReadyParser
} from './windows-incident-matrix.mjs'

test('incident matrix crosses every topology, profile, audio and retry policy three times', () => {
  const cases = buildWindowsIncidentMatrix()
  assert.equal(cases.length, 64)
  assert.equal(
    cases.reduce((count, item) => count + item.repetitions, 0),
    192
  )
  assert.deepEqual([...new Set(cases.map((item) => item.receivers))].sort(), [0, 1, 2])
  const same = cases.find((item) => item.retry === 'same-process')
  const restarted = cases.find((item) => item.retry === 'restart')
  assert.equal(incidentProcessGroups(same).length, 1)
  assert.deepEqual(incidentProcessGroups(same)[0], [1, 2, 3])
  assert.deepEqual(incidentProcessGroups(restarted), [[1], [2], [3]])
  assert.throws(() => parseWindowsIncidentArgs(['--incident', '--runs', '1']))
})

test('dual receiver parameters retain recording, two endpoints and fixed output profile', () => {
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const targets = [1, 2].map((port) => ({
    serverUrl: `rtmp://127.0.0.1:${19000 + port}/live`,
    streamKey: `owned-${port}`
  }))
  const params = incidentSessionParams(scenario, targets)
  assert.equal(params.output.recordEnabled, true)
  assert.equal(params.streaming.enabledTargetIds.length, 2)
  assert.equal(params.streaming.targets.length, 2)
  assert.equal(params.output.video.width, 1920)
  assert.throws(() => incidentSessionParams(scenario, [targets[0]]))
  assert.throws(() =>
    incidentSessionParams(scenario, [
      { ...targets[0], serverUrl: 'rtmp://example.com/live' },
      targets[1]
    ])
  )
})

test('a startup timeout or missing second receiver cannot pass on a recording artifact', () => {
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const report = {
    startOutcome: 'failed',
    cleanup: { backendAlive: false, receiversReaped: true },
    artifacts: [{ role: 'recording', verdict: 'PASS' }],
    evidence: {}
  }
  const verdict = evaluateWindowsIncidentRun(scenario, report)
  assert.equal(verdict.pass, false)
  assert.ok(verdict.failures.some((item) => item.includes('startup')))
  assert.ok(verdict.failures.some((item) => item.includes('receiver-2')))
  assert.ok(verdict.failures.some((item) => item.includes('diagnostics')))
})

test('worker and direct-fallback evidence cannot be replaced by controlled sine', () => {
  for (const audio of ['worker', 'direct-fallback']) {
    const scenario = buildWindowsIncidentMatrix().find((item) => item.audio === audio)
    const verdict = evaluateWindowsIncidentRun(scenario, {
      startOutcome: 'running',
      evidence: { audioPath: 'controlled', finalDiagnostics: {} },
      artifacts: [],
      cleanup: {}
    })
    assert.equal(verdict.pass, false)
    assert.ok(verdict.failures.some((item) => item.includes('audio')))
  }
})

test('real attempt seam persists failed-start evidence and analyzes both receivers after stop rejection', async () => {
  const calls = []
  const scenario = buildWindowsIncidentMatrix().find((item) => item.topology === 'record-dual')
  const run = await executeIncidentAttempt(scenario, {
    start: async () => {
      calls.push('start')
      throw new Error('positive media timeout')
    },
    measure: async () => {
      throw new Error('must not measure a failed start')
    },
    stop: async () => {
      calls.push('stop')
      throw new Error('stop refused')
    },
    collect: async () => {
      calls.push('collect')
      return {
        sessionId: 'failed-session',
        finalDiagnostics: { sessionId: 'failed-session' },
        ffmpegTail: 'retained before retry'
      }
    },
    reap: async () => {
      calls.push('reap')
      return { receiversReaped: true }
    },
    analyze: async () => {
      calls.push('analyze')
      return [
        { role: 'receiver-1', verdict: 'FAIL' },
        { role: 'receiver-2', verdict: 'FAIL' }
      ]
    }
  })
  assert.deepEqual(calls, ['start', 'stop', 'collect', 'reap', 'analyze'])
  assert.equal(run.failure, 'positive media timeout')
  assert.equal(run.evidence.sessionId, 'failed-session')
  assert.equal(run.evidence.ffmpegTail, 'retained before retry')
  assert.equal(run.cleanup.receiversReaped, true)
  assert.equal(run.artifacts.length, 2)
  assert.equal(run.verdict.pass, false)
})

test('backend readiness waits for complete fragmented line and rejects overlong output', () => {
  const ready = []
  const errors = []
  const feed = createIncidentReadyParser(
    (value) => ready.push(value),
    (error) => errors.push(error)
  )
  feed('READY {"po')
  feed('rt":1234}')
  assert.equal(ready.length, 0)
  feed('\n')
  assert.deepEqual(ready, [{ port: 1234 }])
  assert.equal(errors.length, 0)
  const tooLong = createIncidentReadyParser(
    () => assert.fail('oversized readiness accepted'),
    (error) => errors.push(error)
  )
  tooLong('x'.repeat(64001))
  assert.equal(errors.length, 1)
})

test('receiver cleanup attempts every owned child and fails closed after first rejection', async () => {
  const { reapIncidentReceivers } = await import('./windows-incident-runner.mjs')
  const calls = []
  const receivers = [1, 2].map((pid) => ({ child: { pid }, stderr: () => 'retained' }))
  const result = await reapIncidentReceivers(
    receivers,
    async (child) => {
      calls.push(child.pid)
      if (child.pid === 1) throw new Error('bounded cleanup failed')
      return { childExited: true }
    },
    async () => false
  )
  assert.deepEqual(calls, [1, 2])
  assert.equal(result.receiversReaped, false)
  assert.equal(result.receiverResults[0].cleanup.state, 'leaked')
  assert.equal(result.receiverResults[1].cleanup.childExited, true)
})

test('owned receiver spawn failure rejects through an error listener and removes readiness listeners', async () => {
  const { EventEmitter } = await import('node:events')
  const { waitIncidentSpawn } = await import('./windows-incident-runner.mjs')
  const child = new EventEmitter()
  const ready = waitIncidentSpawn(child, 1000)
  child.emit('error', new Error('ENOENT'))
  await assert.rejects(ready, /ENOENT/)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('spawn'), 0)
})

test('missing physical prerequisites remain blocked while actual failures take precedence', async () => {
  const { incidentAggregateVerdict } = await import('./windows-incident-runner.mjs')
  const blocked = { state: 'BLOCKED', verdict: { pass: false } }
  const passed = { verdict: { pass: true } }
  const failed = { verdict: { pass: false } }
  assert.equal(incidentAggregateVerdict([blocked, passed], 2).verdict, 'BLOCKED')
  assert.equal(incidentAggregateVerdict([blocked, failed], 2).verdict, 'FAIL')
  assert.equal(incidentAggregateVerdict([passed], 1).verdict, 'PASS')
})

test('CI incident aggregate tolerates one single 3-frame repeated-frame burst when two reps pass', async () => {
  const {
    INCIDENT_CI_REPEATED_FRAME_BURST_ONLY,
    isExactCiRepeatedFrameAnalyzerFailure,
    isIncidentCiRepeatedFrameNoise,
    incidentScenarioSurvivesCiNoise
  } = await import('./windows-incident-matrix.mjs')
  const { incidentAggregateVerdict } = await import('./windows-incident-runner.mjs')
  const scenarioId = '720p30-single-controlled-same-process'
  const noiseLine = `receiver-1 analyzed A/V artifact missing or failed: ${INCIDENT_CI_REPEATED_FRAME_BURST_ONLY}`
  const cleanArtifact = {
    role: 'receiver-1',
    verdict: 'PASS',
    width: 1280,
    height: 720,
    hasAudio: true,
    packetTail: { pass: true, tailMismatchMs: 12 },
    failures: []
  }
  const noisyArtifact = {
    ...cleanArtifact,
    verdict: 'FAIL',
    failures: [INCIDENT_CI_REPEATED_FRAME_BURST_ONLY]
  }
  const noisyRun = {
    scenario: scenarioId,
    repetition: 3,
    startOutcome: 'running',
    cleanup: { receiversReaped: true, sessionIdle: true },
    errors: [],
    failure: null,
    artifacts: [noisyArtifact],
    verdict: { pass: false, failures: [noiseLine] }
  }

  assert.equal(isExactCiRepeatedFrameAnalyzerFailure([INCIDENT_CI_REPEATED_FRAME_BURST_ONLY]), true)
  assert.equal(
    isExactCiRepeatedFrameAnalyzerFailure([
      INCIDENT_CI_REPEATED_FRAME_BURST_ONLY,
      'Packet A/V tail mismatch of 140ms exceeds 100ms'
    ]),
    false
  )
  assert.equal(isIncidentCiRepeatedFrameNoise(noisyRun), true)
  assert.equal(
    isIncidentCiRepeatedFrameNoise({
      ...noisyRun,
      verdict: { pass: false, failures: [noiseLine, 'startup did not reach running'] }
    }),
    false
  )
  // Joined analyzer string (evaluateWindowsIncidentRun joins with "; ") must not match.
  assert.equal(
    isIncidentCiRepeatedFrameNoise({
      ...noisyRun,
      artifacts: [
        {
          ...noisyArtifact,
          failures: [
            INCIDENT_CI_REPEATED_FRAME_BURST_ONLY,
            'Packet A/V tail mismatch of 140ms exceeds 100ms'
          ]
        }
      ],
      verdict: {
        pass: false,
        failures: [
          `receiver-1 analyzed A/V artifact missing or failed: ${INCIDENT_CI_REPEATED_FRAME_BURST_ONLY}; Packet A/V tail mismatch of 140ms exceeds 100ms`
        ]
      }
    }),
    false
  )
  // Dimensions / audio / packet-tail predicates stay independent of the analyzer burst.
  assert.equal(
    isIncidentCiRepeatedFrameNoise({
      ...noisyRun,
      artifacts: [{ ...noisyArtifact, width: 1920 }]
    }),
    false
  )
  assert.equal(
    isIncidentCiRepeatedFrameNoise({
      ...noisyRun,
      artifacts: [{ ...noisyArtifact, hasAudio: false }]
    }),
    false
  )
  assert.equal(
    isIncidentCiRepeatedFrameNoise({
      ...noisyRun,
      artifacts: [
        {
          ...noisyArtifact,
          packetTail: { pass: false, tailMismatchMs: 140, reason: 'Packet A/V tail mismatch' }
        }
      ]
    }),
    false
  )

  const scenarioRuns = [
    {
      scenario: scenarioId,
      repetition: 1,
      verdict: { pass: true, failures: [] },
      artifacts: [cleanArtifact]
    },
    {
      scenario: scenarioId,
      repetition: 2,
      verdict: { pass: true, failures: [] },
      artifacts: [cleanArtifact]
    },
    noisyRun
  ]
  assert.equal(incidentScenarioSurvivesCiNoise(scenarioRuns).pass, true)

  const strict = incidentAggregateVerdict(scenarioRuns, 3)
  assert.equal(strict.verdict, 'FAIL')

  const ci = incidentAggregateVerdict(scenarioRuns, 3, { ci: true })
  assert.equal(ci.verdict, 'PASS')
  assert.equal(ci.ciNoiseTolerated?.length, 1)
  assert.match(ci.ciNoiseTolerated[0].reason, /CI runner noise/)

  const twoNoisy = incidentAggregateVerdict(
    [...scenarioRuns.slice(0, 1), { ...noisyRun, repetition: 2 }, noisyRun],
    3,
    { ci: true }
  )
  assert.equal(twoNoisy.verdict, 'FAIL')

  const realFreeze = incidentAggregateVerdict(
    [
      ...scenarioRuns.slice(0, 2),
      {
        ...noisyRun,
        artifacts: [
          {
            ...noisyArtifact,
            failures: [
              'repeated-frame burst of 7 consecutive identical frames exceeds 2 (1 burst(s))'
            ]
          }
        ],
        verdict: {
          pass: false,
          failures: [
            'receiver-1 analyzed A/V artifact missing or failed: repeated-frame burst of 7 consecutive identical frames exceeds 2 (1 burst(s))'
          ]
        }
      }
    ],
    3,
    { ci: true }
  )
  assert.equal(realFreeze.verdict, 'FAIL')

  const hiddenTail = incidentAggregateVerdict(
    [
      ...scenarioRuns.slice(0, 2),
      {
        ...noisyRun,
        artifacts: [
          {
            ...noisyArtifact,
            packetTail: { pass: false, tailMismatchMs: 140 },
            failures: [
              INCIDENT_CI_REPEATED_FRAME_BURST_ONLY,
              'Packet A/V tail mismatch of 140ms exceeds 100ms'
            ]
          }
        ],
        verdict: {
          pass: false,
          failures: [
            `receiver-1 analyzed A/V artifact missing or failed: ${INCIDENT_CI_REPEATED_FRAME_BURST_ONLY}; Packet A/V tail mismatch of 140ms exceeds 100ms`
          ]
        }
      }
    ],
    3,
    { ci: true }
  )
  assert.equal(hiddenTail.verdict, 'FAIL')
})

test('unsafe startup cleanup cannot become safe when no receiver reached the owned list', async () => {
  const scenario = buildWindowsIncidentMatrix()[0]
  const run = await executeIncidentAttempt(scenario, {
    start: async () => {
      throw Object.assign(new Error('unreaped startup receiver'), { unsafeCleanup: true })
    },
    measure: async () => assert.fail('failed startup measured'),
    stop: async () => ({ sessionIdle: true }),
    collect: async () => ({}),
    reap: async () => ({ receiversReaped: true }),
    analyze: async () => []
  })
  assert.equal(run.unsafeCleanup, true)
  assert.equal(run.cleanup.receiversReaped, false)
  assert.equal(run.verdict.pass, false)
  assert.ok(run.verdict.failures.includes('owned output cleanup incomplete'))
})

test('incident audio evidence rejects silence spanning lead, measured interior and tail', async () => {
  const { validateIncidentAudibleInterior } = await import('./windows-incident-matrix.mjs')
  const analysis = {
    verdict: { pass: true },
    metrics: { durationSeconds: 3.008, digitalZeroRunCount: 0 },
    findings: { silences: [{ start: 0, end: 3.008, duration: 3.008 }] }
  }
  for (const audio of ['controlled', 'ffmpeg-control', 'worker', 'direct-fallback']) {
    assert.equal(validateIncidentAudibleInterior({ audio }, analysis).pass, false)
  }
  analysis.findings.silences = [{ start: 0, end: 0.1, duration: 0.1 }]
  assert.equal(validateIncidentAudibleInterior({ audio: 'controlled' }, analysis).pass, true)
  analysis.findings.silences = [{ start: 1, end: 1.2, duration: 0.2 }]
  assert.equal(validateIncidentAudibleInterior({ audio: 'controlled' }, analysis).pass, false)
  analysis.findings.silences = [{ start: 1, end: 1.03, duration: 0.03 }]
  assert.match(
    validateIncidentAudibleInterior({ audio: 'controlled' }, analysis).reason,
    /silence 30.0ms must be below 20.0ms/
  )
  analysis.findings.silences = []
  assert.equal(validateIncidentAudibleInterior({ audio: 'controlled' }, analysis).pass, true)
})

test('optional adapter metadata failure cannot abort the incident matrix', async () => {
  const { incidentAdapterInventory } = await import('./windows-incident-matrix.mjs')
  assert.equal(incidentAdapterInventory({ status: 0, stdout: 'invalid JSON' }).state, 'unknown')
  assert.equal(incidentAdapterInventory({ status: 0, stdout: 'null' }).state, 'unknown')
  assert.equal(
    incidentAdapterInventory({ status: 0, stdout: '[{"Name":"GPU"}]' }).state,
    'observed'
  )
})

test('worker PCM before fallback never proves the final worker audio path', async () => {
  const { incidentAudioPath } = await import('./windows-incident-matrix.mjs')
  assert.equal(
    incidentAudioPath('Natural worker failure', { frames: 100 }, 'worker'),
    'unexpected-direct-fallback'
  )
  assert.equal(
    incidentAudioPath('Injected incident capture-worker failure', { frames: 100 }, 'worker'),
    'direct-fallback'
  )
  assert.equal(incidentAudioPath(null, { frames: 100 }, 'worker'), 'worker')
})

test('720p single, dual and record-dual select the backend named stream profile at 6000 kbps', () => {
  for (const topology of ['single', 'dual', 'record-dual']) {
    const scenario = buildWindowsIncidentMatrix().find(
      (item) => item.height === 720 && item.topology === topology && item.audio === 'controlled'
    )
    const targets = Array.from({ length: scenario.receivers }, (_, index) => ({
      serverUrl: `rtmp://127.0.0.1:${19000 + index}/live`,
      streamKey: 'owned'
    }))
    const params = incidentSessionParams(scenario, targets)
    assert.equal(params.streaming.defaultOutputPreset, 'tutorial-720p30')
    assert.equal(params.streaming.defaultBitrateKbps, 6000)
    assert.equal(params.output.video.width, 1280)
    assert.equal(params.output.video.height, 720)
    assert.equal(params.output.video.bitrateKbps, 6000)
    assert.ok(params.streaming.targets.every((target) => target.outputPreset === undefined))
  }
})

test('incident collection reads lightweight Library rows, log entries and exact-session bundle diagnostics', async () => {
  const { incidentSessionEvidence } = await import('./windows-incident-matrix.mjs')
  const row = { id: 'current', status: 'completed', mp4Path: 'owned/current.mp4' }
  const logs = [{ sessionId: 'current', code: 'ffmpeg-startup-evidence', message: 'retained' }]
  const evidence = incidentSessionEvidence(
    { items: [row] },
    { entries: logs },
    {
      sessions: [
        { id: 'previous', finalDiagnostics: { sessionId: 'previous' } },
        {
          id: 'current',
          finalDiagnostics: { sessionId: 'current', encoderBridgeRawVideoCopiedFrames: 360 }
        }
      ]
    },
    'current'
  )
  assert.equal(evidence.session.mp4Path, row.mp4Path)
  assert.equal(evidence.session.finalDiagnostics.encoderBridgeRawVideoCopiedFrames, 360)
  assert.deepEqual(evidence.logs, logs)
  assert.equal(
    incidentSessionEvidence(
      { items: [row] },
      { entries: [] },
      { sessions: [{ id: 'previous', finalDiagnostics: {} }] },
      'current'
    ).session.finalDiagnostics,
    null
  )
})

test('controlled audio selects the portable debug PCM fixture and owns its enabling flags', async () => {
  const { incidentAudioEnvironment, incidentAudioPath } =
    await import('./windows-incident-matrix.mjs')
  const controlled = buildWindowsIncidentMatrix().find(
    (item) => item.audio === 'controlled' && item.receivers === 0
  )
  assert.equal(
    incidentSessionParams(controlled, []).sources.microphoneId,
    'microphone:coreaudio:4294967295'
  )
  assert.deepEqual(incidentAudioEnvironment('controlled'), {
    VIDEORC_CAPTION_CONTRACT_TEST: '1',
    VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
    VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '0',
    VIDEORC_INCIDENT_FFMPEG_TONE: '0'
  })
  for (const audio of ['worker', 'direct-fallback']) {
    assert.deepEqual(incidentAudioEnvironment(audio), {
      VIDEORC_CAPTION_CONTRACT_TEST: '0',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '0',
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '0',
      VIDEORC_INCIDENT_FFMPEG_TONE: '0'
    })
  }
  assert.equal(incidentAudioPath(null, { frames: 100 }, 'controlled'), 'controlled')
})

test('FFmpeg tone is an additional independent control with observed enabling evidence', async () => {
  const { incidentAudioEnvironment, incidentAudioPath } =
    await import('./windows-incident-matrix.mjs')
  const cases = parseWindowsIncidentArgs(['--incident', '--audio', 'ffmpeg-control']).scenarios
  assert.equal(cases.length, 16)
  assert.equal(
    cases.reduce((n, c) => n + c.repetitions, 0),
    48
  )
  assert.equal(buildWindowsIncidentMatrix().filter((c) => c.audio === 'controlled').length, 16)
  const scenario = cases.find((c) => c.topology === 'record')
  assert.equal(incidentSessionParams(scenario, []).sources.microphoneId, undefined)
  assert.equal(incidentAudioEnvironment('ffmpeg-control').VIDEORC_INCIDENT_FFMPEG_TONE, '1')
  assert.equal(incidentAudioEnvironment('controlled').VIDEORC_INCIDENT_FFMPEG_TONE, '0')
  assert.equal(incidentAudioPath(null, null, 'ffmpeg-control', false), 'unknown')
  assert.equal(incidentAudioPath(null, null, 'ffmpeg-control', true), 'ffmpeg-control')
})

test('an artifact cannot pass incident acceptance without a measured bounded packet tail', () => {
  const scenario = buildWindowsIncidentMatrix()[0]
  const run = {
    startOutcome: 'running',
    cleanup: { sessionIdle: true, receiversReaped: true },
    evidence: {
      finalDiagnostics: {},
      sessionId: 'session',
      ffmpegStartup: 'ready',
      ffmpegTail: 'tail',
      startTimeline: {},
      stopTimeline: {},
      bridgeFrames: 1,
      effectiveEncoder: 'libopenh264',
      effectiveOutput: 'raw-yuv420p',
      audioPath: 'controlled'
    },
    artifacts: [
      {
        role: 'recording',
        verdict: 'PASS',
        width: scenario.width,
        height: scenario.height,
        hasAudio: true
      }
    ]
  }
  assert.equal(evaluateWindowsIncidentRun(scenario, run).pass, false)
  run.artifacts[0].packetTail = { pass: true, tailMismatchMs: 33 }
  assert.equal(evaluateWindowsIncidentRun(scenario, run).pass, true)
  run.artifacts[0].packetTail = { pass: true, tailMismatchMs: null }
  assert.equal(evaluateWindowsIncidentRun(scenario, run).pass, false)
})

test('incident backend receives the exact selected FFmpeg pair over inherited tools', async () => {
  const { incidentBackendEnvironment } = await import('./windows-incident-runner.mjs')
  const env = incidentBackendEnvironment({
    inherited: {
      VIDEORC_BUNDLED_FFMPEG_PATH: 'other-ffmpeg',
      VIDEORC_BUNDLED_FFPROBE_PATH: 'other-probe'
    },
    ffmpegPath: 'D:/pinned/bin/ffmpeg.exe',
    ffprobePath: 'D:/pinned/bin/ffprobe.exe',
    root: '/owned-incident',
    audio: 'controlled',
    injectFailure: false
  })
  assert.equal(env.VIDEORC_BUNDLED_FFMPEG_PATH, 'D:/pinned/bin/ffmpeg.exe')
  assert.equal(env.VIDEORC_BUNDLED_FFPROBE_PATH, 'D:/pinned/bin/ffprobe.exe')
})
