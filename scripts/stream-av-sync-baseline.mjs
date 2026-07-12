#!/usr/bin/env node
// Stream A/V sync baseline — plan WS-A slice A1 (Studio Shell And Live Control Plan).
//
// The record-only av-sync gate proves the local file; this proves what a platform
// RECEIVES. It runs two real-source sessions against the flash+click stimulus:
//
//   1. record-only          — the pre-encoded VideoToolbox MPEG-TS product path
//   2. record+stream        — the DEFAULT stream path (VideoToolbox H.264 -> FFmpeg copy -> tee),
//                             streaming to a local RTMP sink this harness owns
//                             (`ffmpeg -listen 1`), which records the received FLV
//
// then measures the flash/click A/V offset on all three outputs (record-only MKV,
// record+stream MKV leg, RTMP-received FLV), fits drift, classifies the plan's
// hypotheses (H1 timeline-start / H2 drift / H3 tee-leg divergence), and writes a
// JSON evidence file. Pass `--gate` to make the exit code reflect the verdict.
//
// REQUIREMENTS: same as the real-source baseline — a real desktop session with
// Screen Recording and Microphone permissions, speakers audible to the mic. The
// camera is irrelevant to the flash/click loop (screen flash + speaker click -> mic);
// pass VIDEORC_BASELINE_NO_CAMERA=1 when the dev app lacks camera permission.
//
//   node scripts/stream-av-sync-baseline.mjs [--gate] [--skip-record-only]
//   node scripts/stream-av-sync-baseline.mjs --gate --skip-record-only --require-split-output-4k-record
//   node scripts/stream-av-sync-baseline.mjs --gate --skip-record-only --require-youtube-4k-stream
//   node scripts/stream-av-sync-baseline.mjs --gate --skip-record-only --require-mixed-youtube-4k-twitch-1080p
//
// Env:
//   VIDEORC_BASELINE_RECORDING_MS    per-session length (default 60000; >=600000 makes the drift gate binding)
//   VIDEORC_BASELINE_STREAM_PORT     local RTMP sink port (default 19501)
//   VIDEORC_BASELINE_COMPANION_STREAM_PORT companion local RTMP sink port for mixed gate (default 19502)
//   VIDEORC_SMOKE_OUTPUT_DIR         where session dirs + evidence land
//   VIDEORC_SMOKE_FFMPEG_PATH        ffmpeg for the sink and the measurements
//   (all other VIDEORC_BASELINE_* vars pass through to the underlying sessions)
//
// The stream session deliberately UNSETS VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT so the
// backend's default selector chooses the product stream path. The stream key is a
// local dummy; no secrets are involved, and server URLs are still logged redacted.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { measureAvSync } from './lib/av-sync.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { evaluateMixedYoutube4kTwitch1080pEvidence } from './lib/mixed-youtube-4k-twitch-1080p-gate.mjs'
import { probeMedia } from './lib/recording-analyzer.mjs'
import { evaluateSplitOutput4kRecordEvidence } from './lib/split-output-4k-record-gate.mjs'
import { splitOutputPreviewSurfaceDisabled } from './lib/split-output-performance-mode.mjs'
import {
  DEFAULT_STREAM_AV_SYNC_GATES,
  evaluateStreamAvSync,
  fitOffsetDrift,
  summarizeStreamAvSyncEvidence
} from './lib/stream-av-sync.mjs'
import { evaluateYoutube4kStreamEvidence } from './lib/youtube-4k-stream-gate.mjs'
import {
  evaluateOwnedTeardown,
  evaluateProcessEnduranceEvidence,
  performanceEnduranceMetrics
} from './lib/process-endurance.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  observationCheck,
  passingCheck,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import { performanceSamplingInvariants } from './lib/performance-sampling-schedule.mjs'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const config = {
  gate: argv.includes('--gate'),
  skipRecordOnly: argv.includes('--skip-record-only'),
  requireSplitOutput4kRecord: argv.includes('--require-split-output-4k-record'),
  requireYoutube4kStream: argv.includes('--require-youtube-4k-stream'),
  requireMixedYoutube4kTwitch1080p: argv.includes('--require-mixed-youtube-4k-twitch-1080p'),
  recordingMs: Number(process.env.VIDEORC_BASELINE_RECORDING_MS ?? 60000),
  warmupMs: Number(process.env.VIDEORC_BASELINE_WARMUP_MS ?? 8000),
  streamPort: Number(process.env.VIDEORC_BASELINE_STREAM_PORT ?? 19501),
  companionStreamPort: Number(process.env.VIDEORC_BASELINE_COMPANION_STREAM_PORT ?? 19502),
  ffmpegPath: process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? null,
  sinkConnectGraceMs: 1500,
  sinkDrainTimeoutMs: 30000,
  outputRoot: resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-stream-av-sync-${Date.now()}`)
  )
}
const STREAM_KEY = 'avsync-baseline' // local dummy key, not a secret
const COMPANION_STREAM_KEY = 'avsync-baseline-companion' // local dummy key, not a secret
const serverUrl = `rtmp://127.0.0.1:${config.streamPort}/live`
const companionServerUrl = `rtmp://127.0.0.1:${config.companionStreamPort}/live`
const redactedStreamUrl = `${serverUrl}/••••`
const redactedCompanionStreamUrl = `${companionServerUrl}/••••`

let sink = null
let companionSink = null
let exitCode = 0
let performanceResult = null
let runError = null
try {
  performanceResult = await main()
  exitCode = performanceResult.exitCode
} catch (error) {
  runError = error
  console.error(`stream av-sync baseline failed: ${error?.message ?? error}`)
  exitCode = 2
} finally {
  if (sink && sink.exitCode === null) sink.kill('SIGKILL')
  if (companionSink && companionSink.exitCode === null) companionSink.kill('SIGKILL')
}
if (process.env.VIDEORC_PERF_REPORT_PATH) {
  try {
    const acceptanceFailures = [
      ...(runError ? [runError?.message ?? String(runError)] : []),
      ...(!runError && !performanceResult ? ['split-output acceptance result was missing'] : []),
      ...(!runError && performanceResult && !performanceResult.pass
        ? performanceResult.failures?.length
          ? performanceResult.failures
          : ['split-output acceptance failed']
        : [])
    ]
    const nestedProcessEndurance = performanceResult?.recordStreamPerformance?.processEndurance
    const nestedTeardown = performanceResult?.recordStreamPerformance?.teardown
    const nestedVerdict = performanceResult?.recordStreamPerformanceReport?.verdict
    const nestedVerdictAccepted =
      nestedVerdict === 'pass' || (!config.gate && nestedVerdict === 'observation')
    const {
      recordStreamPerformanceReport: _nestedReport,
      recordStreamPerformance: _nestedMetrics,
      ...streamAcceptance
    } = performanceResult ?? {}
    const measurementMs = Math.max(0, config.recordingMs - config.warmupMs)
    const sampleIntervalMs = Number(process.env.VIDEORC_BASELINE_SAMPLE_MS ?? 2_000)
    const samplingInvariants = performanceSamplingInvariants(measurementMs, sampleIntervalMs)
    const minimumSamples = Math.max(2, samplingInvariants.minSamples)
    const processEnduranceFailures = [
      ...(!performanceResult?.recordStreamPerformanceReport
        ? ['split-output real-source child performance report was missing']
        : []),
      ...(performanceResult?.recordStreamPerformanceReport && !nestedVerdictAccepted
        ? [`split-output real-source child performance verdict was ${nestedVerdict ?? 'missing'}`]
        : []),
      ...(performanceResult?.recordStreamPerformance?.processEnduranceError
        ? [
            `split-output process endurance collection failed: ${performanceResult.recordStreamPerformance.processEnduranceError}`
          ]
        : []),
      ...evaluateProcessEnduranceEvidence(nestedProcessEndurance, {
        minimumSamples,
        minimumDurationMs: samplingInvariants.minDurationMs
      }),
      ...evaluateOwnedTeardown(nestedTeardown)
    ]
    const enforcedProcessEnduranceFailures = config.gate ? processEnduranceFailures : []
    const report = createPerformanceReport({
      scenario: 'record-4k-stream-1080p',
      mode: config.gate ? 'gate' : 'report-only',
      metadata: await collectPerformanceMetadata(),
      timing: {
        warmupMs: config.warmupMs,
        measurementMs
      },
      metrics: {
        ...performanceEnduranceMetrics({
          evidence: nestedProcessEndurance,
          teardown: nestedTeardown,
          pipeline: performanceResult?.recordStreamPerformance?.pipeline
        }),
        outputRoot: config.outputRoot,
        acceptance: streamAcceptance,
        nestedRealSourceReport: performanceResult?.recordStreamPerformanceReport
          ? {
              schemaVersion: performanceResult.recordStreamPerformanceReport.schemaVersion,
              scenario: performanceResult.recordStreamPerformanceReport.scenario,
              mode: performanceResult.recordStreamPerformanceReport.mode,
              generatedAt: performanceResult.recordStreamPerformanceReport.generatedAt,
              verdict: performanceResult.recordStreamPerformanceReport.verdict,
              metadata: performanceResult.recordStreamPerformanceReport.metadata,
              timing: performanceResult.recordStreamPerformanceReport.timing,
              checks: performanceResult.recordStreamPerformanceReport.checks
            }
          : null
      },
      checks: [
        ...failingChecks(acceptanceFailures),
        ...failingChecks(enforcedProcessEnduranceFailures),
        ...(!config.gate
          ? processEnduranceFailures.map((failure) =>
              observationCheck(`report-only process endurance observation: ${failure}`)
            )
          : []),
        ...(acceptanceFailures.length === 0 && processEnduranceFailures.length === 0
          ? [
              passingCheck(
                'split-output recording, stream, native-preview cadence/transport, process endurance, resources, teardown, and A/V acceptance passed'
              )
            ]
          : [])
      ]
    })
    await writePerformanceReport(report)
    if (config.gate && processEnduranceFailures.length > 0) exitCode = 1
  } catch (error) {
    console.error(`could not write split-output performance report: ${error?.message ?? error}`)
    exitCode = 2
  }
}
process.exit(exitCode)

async function main() {
  const requestedProfileGates = [
    ['--require-split-output-4k-record', config.requireSplitOutput4kRecord],
    ['--require-youtube-4k-stream', config.requireYoutube4kStream],
    ['--require-mixed-youtube-4k-twitch-1080p', config.requireMixedYoutube4kTwitch1080p]
  ].filter(([, enabled]) => enabled)
  if (requestedProfileGates.length > 1) {
    throw new Error(
      `${requestedProfileGates.map(([flag]) => flag).join(', ')} are mutually exclusive baseline profiles.`
    )
  }
  if (config.requireMixedYoutube4kTwitch1080p && config.streamPort === config.companionStreamPort) {
    throw new Error(
      `mixed baseline requires distinct RTMP sink ports; both were ${config.streamPort}.`
    )
  }

  mkdirSync(config.outputRoot, { recursive: true })
  const recordOnlyDir = join(config.outputRoot, 'record-only')
  const recordStreamDir = join(config.outputRoot, 'record-stream')
  const receivedFlvPath = join(recordStreamDir, 'stream-received.flv')
  const receivedCompanionFlvPath = join(recordStreamDir, 'stream-received-twitch.flv')
  mkdirSync(recordStreamDir, { recursive: true })

  // --- Session 1: record-only baseline (pre-encoded product path) ---------------
  let recordOnlyRecording = null
  let recordOnlyEvidence = null
  if (config.skipRecordOnly) {
    console.log('Skipping record-only baseline session (--skip-record-only).')
  } else {
    console.log(
      `\n=== Session 1/2: record-only av-sync baseline (${config.recordingMs / 1000}s) ===`
    )
    await runBaselineSession({
      outputDir: recordOnlyDir,
      collectPerformance: false,
      env: {
        VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT:
          process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT ?? 'videotoolbox-h264-mpegts'
      }
    })
    recordOnlyEvidence = evidenceFromManifest(recordOnlyDir, 'record-only')
    recordOnlyRecording = recordingFromEvidence(recordOnlyEvidence, 'record-only')
  }

  // --- Session 2: record+stream against the local RTMP sink ---------------------
  console.log(
    `\n=== Session 2/2: record+stream av-sync against local RTMP sink (${config.recordingMs / 1000}s) ===`
  )
  if (process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT) {
    console.log(
      `NOTE: ignoring VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=${process.env.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT} ` +
        'for the stream session — this gate exists to prove the DEFAULT stream selector path.'
    )
  }
  sink = spawnRtmpSink({
    receivedFlvPath,
    serverUrl,
    streamKey: STREAM_KEY,
    label: 'primary RTMP sink'
  })
  if (config.requireMixedYoutube4kTwitch1080p) {
    companionSink = spawnRtmpSink({
      receivedFlvPath: receivedCompanionFlvPath,
      serverUrl: companionServerUrl,
      streamKey: COMPANION_STREAM_KEY,
      label: 'companion RTMP sink'
    })
  }
  await sleep(config.sinkConnectGraceMs)
  if (sink.exitCode !== null) {
    throw new Error(
      `local RTMP sink exited before the session started (code ${sink.exitCode}) — is port ${config.streamPort} free?`
    )
  }
  if (companionSink && companionSink.exitCode !== null) {
    throw new Error(
      `companion RTMP sink exited before the session started (code ${companionSink.exitCode}) — is port ${config.companionStreamPort} free?`
    )
  }
  console.log(`Local RTMP sink listening on ${redactedStreamUrl} -> ${receivedFlvPath}`)
  if (config.requireMixedYoutube4kTwitch1080p) {
    console.log(
      `Companion RTMP sink listening on ${redactedCompanionStreamUrl} -> ${receivedCompanionFlvPath}`
    )
  }

  const recordStreamRun = await runBaselineSession({
    outputDir: recordStreamDir,
    collectPerformance: Boolean(process.env.VIDEORC_PERF_REPORT_PATH),
    env: {
      ...streamProfileEnv(),
      VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: null, // backend default selector decides
      VIDEORC_BASELINE_STREAM: '1',
      VIDEORC_BASELINE_STREAM_SERVER_URL: serverUrl,
      VIDEORC_BASELINE_STREAM_KEY: STREAM_KEY
    }
  })
  const recordStreamEvidence = evidenceFromManifest(recordStreamDir, 'record+stream')
  const recordStreamRecording = recordingFromEvidence(recordStreamEvidence, 'record+stream')
  await drainSink(sink, 'primary RTMP sink')
  await drainSink(companionSink, 'companion RTMP sink')
  const receivedFlv =
    existsSync(receivedFlvPath) && statSync(receivedFlvPath).size > 0 ? receivedFlvPath : null
  if (!receivedFlv) {
    console.error('RTMP sink produced no received FLV — the stream leg never delivered data.')
  } else {
    console.log(
      `Received FLV: ${receivedFlv} (${(statSync(receivedFlv).size / (1024 * 1024)).toFixed(1)} MiB)`
    )
  }
  const receivedFlvProbe = await probeOrNull(receivedFlv)
  const receivedCompanionFlv =
    config.requireMixedYoutube4kTwitch1080p &&
    existsSync(receivedCompanionFlvPath) &&
    statSync(receivedCompanionFlvPath).size > 0
      ? receivedCompanionFlvPath
      : null
  if (config.requireMixedYoutube4kTwitch1080p && !receivedCompanionFlv) {
    console.error(
      'Companion RTMP sink produced no received FLV — the companion stream leg never delivered data.'
    )
  } else if (receivedCompanionFlv) {
    console.log(
      `Received companion FLV: ${receivedCompanionFlv} (${(statSync(receivedCompanionFlv).size / (1024 * 1024)).toFixed(1)} MiB)`
    )
  }
  const receivedCompanionFlvProbe = await probeOrNull(receivedCompanionFlv)

  // --- Measure all three outputs -------------------------------------------------
  console.log('\nMeasuring flash/click A/V offsets…')
  const currentMicrophoneSyncOffsetMs = Number(process.env.VIDEORC_BASELINE_MIC_SYNC_OFFSET_MS ?? 0)
  const measureOptions = { ffmpegPath: config.ffmpegPath, currentMicrophoneSyncOffsetMs }
  const recordOnly = config.skipRecordOnly
    ? undefined
    : await measureOrNull(recordOnlyRecording, measureOptions)
  const recordStreamMkv = await measureOrNull(recordStreamRecording, measureOptions)
  const recordStreamFlv = await measureOrNull(receivedFlv, measureOptions)
  const recordStreamCompanionFlv = config.requireMixedYoutube4kTwitch1080p
    ? await measureOrNull(receivedCompanionFlv, measureOptions)
    : undefined
  const flvDrift = fitOffsetDrift(recordStreamFlv?.pairs ?? [])
  const companionFlvDrift = config.requireMixedYoutube4kTwitch1080p
    ? fitOffsetDrift(recordStreamCompanionFlv?.pairs ?? [])
    : null
  const mkvDrift = fitOffsetDrift(recordStreamMkv?.pairs ?? [])

  const verdict = evaluateStreamAvSync({
    recordOnly,
    recordStreamMkv,
    recordStreamFlv,
    flvDrift,
    mkvDrift,
    durationSec: config.recordingMs / 1000
  })
  const driftEvidence = summarizeStreamAvSyncEvidence({
    recordStreamMkv,
    recordStreamFlv,
    flvDrift,
    mkvDrift
  })
  const companionDriftEvidence = config.requireMixedYoutube4kTwitch1080p
    ? summarizeStreamAvSyncEvidence({
        recordStreamMkv,
        recordStreamFlv: recordStreamCompanionFlv,
        flvDrift: companionFlvDrift,
        mkvDrift
      })
    : null
  const companionVerdict = config.requireMixedYoutube4kTwitch1080p
    ? evaluateStreamAvSync({
        recordOnly,
        recordStreamMkv,
        recordStreamFlv: recordStreamCompanionFlv,
        flvDrift: companionFlvDrift,
        mkvDrift,
        durationSec: config.recordingMs / 1000
      })
    : null
  const splitOutput4kRecordVerdict = config.requireSplitOutput4kRecord
    ? evaluateSplitOutput4kRecordEvidence({
        manifest: recordStreamEvidence,
        receivedStreamProbe: receivedFlvProbe,
        streamAvSyncVerdict: verdict
      })
    : null
  const youtube4kStreamVerdict = config.requireYoutube4kStream
    ? evaluateYoutube4kStreamEvidence({
        manifest: recordStreamEvidence,
        receivedStreamProbe: receivedFlvProbe,
        streamAvSyncVerdict: verdict
      })
    : null
  const mixedYoutube4kTwitch1080pVerdict = config.requireMixedYoutube4kTwitch1080p
    ? evaluateMixedYoutube4kTwitch1080pEvidence({
        manifest: recordStreamEvidence,
        youtubeStreamProbe: receivedFlvProbe,
        twitchStreamProbe: receivedCompanionFlvProbe,
        youtubeAvSyncVerdict: verdict,
        twitchAvSyncVerdict: companionVerdict
      })
    : null
  const pass =
    verdict.pass &&
    (splitOutput4kRecordVerdict?.pass ?? true) &&
    (youtube4kStreamVerdict?.pass ?? true) &&
    (mixedYoutube4kTwitch1080pVerdict?.pass ?? true)

  const evidencePath = join(config.outputRoot, 'stream-av-sync-evidence.json')
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        generatedAtIso: new Date().toISOString(),
        platform: process.platform,
        command: { argv, gate: config.gate },
        config: {
          recordingMs: config.recordingMs,
          streamPort: config.streamPort,
          companionStreamPort: config.requireMixedYoutube4kTwitch1080p
            ? config.companionStreamPort
            : null,
          streamServerUrlRedacted: redactedStreamUrl,
          companionStreamServerUrlRedacted: config.requireMixedYoutube4kTwitch1080p
            ? redactedCompanionStreamUrl
            : null,
          skipRecordOnly: config.skipRecordOnly,
          gates: DEFAULT_STREAM_AV_SYNC_GATES
        },
        sessions: {
          recordOnly: config.skipRecordOnly
            ? null
            : {
                directory: recordOnlyDir,
                recording: recordOnlyRecording,
                mediaQualityMode: recordOnlyEvidence?.result?.mediaQualityMode ?? null,
                splitOutputProof: splitOutputProof(recordOnlyEvidence),
                measurement: summarize(recordOnly)
              },
          recordStream: {
            directory: recordStreamDir,
            recording: recordStreamRecording,
            receivedFlv,
            receivedCompanionFlv,
            mediaQualityMode: recordStreamEvidence?.result?.mediaQualityMode ?? null,
            splitOutputProof: splitOutputProof(recordStreamEvidence),
            measurementMkv: summarize(recordStreamMkv),
            measurementFlv: summarize(recordStreamFlv),
            measurementCompanionFlv: summarize(recordStreamCompanionFlv),
            mkvDrift,
            flvDrift,
            companionFlvDrift,
            driftEvidence
          }
        },
        driftEvidence,
        companionDriftEvidence,
        splitOutput4kRecord: splitOutput4kRecordVerdict
          ? {
              required: true,
              verdict: splitOutput4kRecordVerdict,
              receivedStreamProbe: receivedFlvProbe
            }
          : { required: false },
        youtube4kStream: youtube4kStreamVerdict
          ? {
              required: true,
              verdict: youtube4kStreamVerdict,
              receivedStreamProbe: receivedFlvProbe
            }
          : { required: false },
        mixedYoutube4kTwitch1080p: mixedYoutube4kTwitch1080pVerdict
          ? {
              required: true,
              verdict: mixedYoutube4kTwitch1080pVerdict,
              youtubeStreamProbe: receivedFlvProbe,
              twitchStreamProbe: receivedCompanionFlvProbe,
              twitchAvSyncVerdict: companionVerdict
            }
          : { required: false },
        verdict
      },
      null,
      2
    )}\n`
  )

  printSummary({
    recordOnly,
    recordStreamMkv,
    recordStreamFlv,
    recordStreamCompanionFlv,
    flvDrift,
    companionFlvDrift,
    mkvDrift,
    driftEvidence,
    verdict,
    companionVerdict,
    splitOutput4kRecordVerdict,
    youtube4kStreamVerdict,
    mixedYoutube4kTwitch1080pVerdict,
    evidencePath
  })
  const failures = [
    ...(verdict?.failures ?? []),
    ...(companionVerdict?.failures ?? []),
    ...(splitOutput4kRecordVerdict?.failures ?? []),
    ...(youtube4kStreamVerdict?.failures ?? []),
    ...(mixedYoutube4kTwitch1080pVerdict?.failures ?? [])
  ]
  return {
    exitCode: config.gate && !pass ? 1 : 0,
    pass,
    failures,
    evidencePath,
    recordStreamMkv: recordStreamRecording,
    receivedFlv,
    receivedCompanionFlv,
    verdict,
    companionVerdict,
    splitOutput4kRecordVerdict,
    youtube4kStreamVerdict,
    mixedYoutube4kTwitch1080pVerdict,
    recordStreamPerformanceReport: recordStreamRun.performanceReport,
    recordStreamPerformance: recordStreamRun.performanceReport?.metrics ?? null
  }
}

// --- Session runner ---------------------------------------------------------------

function runBaselineSession({ outputDir, env, collectPerformance = false }) {
  mkdirSync(outputDir, { recursive: true })
  const childEnv = { ...process.env }
  delete childEnv.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT
  delete childEnv.VIDEORC_PERF_REPORT_PATH
  const performanceReportPath = collectPerformance
    ? join(outputDir, 'real-source-performance.json')
    : null
  for (const [key, value] of Object.entries(env)) {
    if (value === null) continue
    childEnv[key] = value
  }
  childEnv.VIDEORC_SMOKE_OUTPUT_DIR = outputDir
  childEnv.VIDEORC_BASELINE_AV_SYNC_STIMULUS = '1'
  childEnv.VIDEORC_BASELINE_RECORDING_MS = String(config.recordingMs)
  if (performanceReportPath) childEnv.VIDEORC_PERF_REPORT_PATH = performanceReportPath

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [
        join('scripts', 'real-source-baseline-app.mjs'),
        ...(performanceReportPath && config.gate ? ['--gate'] : [])
      ],
      {
        env: childEnv,
        stdio: 'inherit'
      }
    )
    child.on('error', rejectRun)
    child.on('close', (code) => {
      if (code === 0) {
        const performanceReport =
          performanceReportPath && existsSync(performanceReportPath)
            ? JSON.parse(readFileSync(performanceReportPath, 'utf8'))
            : null
        resolveRun({ performanceReportPath, performanceReport })
      } else {
        rejectRun(new Error(`real-source baseline session exited with code ${code}`))
      }
    })
  })
}

function streamProfileEnv() {
  if (config.requireMixedYoutube4kTwitch1080p) return mixedYoutube4kTwitch1080pEnv()
  if (config.requireYoutube4kStream) return youtube4kStreamEnv()
  if (config.requireSplitOutput4kRecord) return splitOutput4kRecordEnv()
  return {}
}

function mixedYoutube4kTwitch1080pEnv() {
  return {
    VIDEORC_BASELINE_WIDTH: '3840',
    VIDEORC_BASELINE_HEIGHT: '2160',
    VIDEORC_BASELINE_FPS: '30',
    VIDEORC_BASELINE_BITRATE_KBPS: '30000',
    VIDEORC_BASELINE_STREAMING_SETTINGS: '1',
    VIDEORC_BASELINE_STREAM_OUTPUT_PRESET: 'stream-youtube-4k30',
    VIDEORC_BASELINE_STREAM_BITRATE_KBPS: '30000',
    VIDEORC_BASELINE_STREAM_TARGET_PLATFORM: 'youtube',
    VIDEORC_BASELINE_STREAM_TARGET_ID: 'youtube',
    VIDEORC_BASELINE_STREAM_COMPANION: '1',
    VIDEORC_BASELINE_STREAM_COMPANION_PLATFORM: 'twitch',
    VIDEORC_BASELINE_STREAM_COMPANION_ID: 'twitch',
    VIDEORC_BASELINE_STREAM_COMPANION_SERVER_URL: companionServerUrl,
    VIDEORC_BASELINE_STREAM_COMPANION_KEY: COMPANION_STREAM_KEY,
    VIDEORC_BASELINE_LAYOUT_PRESET: process.env.VIDEORC_BASELINE_LAYOUT_PRESET ?? 'screen-only',
    VIDEORC_BASELINE_NO_CAMERA: process.env.VIDEORC_BASELINE_NO_CAMERA ?? '1',
    VIDEORC_BASELINE_NO_PREVIEW_SURFACE: process.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE ?? '1'
  }
}

function splitOutput4kRecordEnv() {
  return {
    VIDEORC_BASELINE_WIDTH: '3840',
    VIDEORC_BASELINE_HEIGHT: '2160',
    VIDEORC_BASELINE_FPS: '30',
    VIDEORC_BASELINE_BITRATE_KBPS: '30000',
    VIDEORC_BASELINE_STREAMING_SETTINGS: '1',
    VIDEORC_BASELINE_STREAM_OUTPUT_PRESET: 'stream-safe-1080p30',
    VIDEORC_BASELINE_STREAM_BITRATE_KBPS: '6000',
    VIDEORC_BASELINE_LAYOUT_PRESET: process.env.VIDEORC_BASELINE_LAYOUT_PRESET ?? 'screen-only',
    VIDEORC_BASELINE_NO_CAMERA: process.env.VIDEORC_BASELINE_NO_CAMERA ?? '1',
    // The performance scenario must exercise the production native preview
    // while recording + streaming. Keep the historical A/V-isolation command
    // preview-free unless an operator explicitly overrides it.
    VIDEORC_BASELINE_NO_PREVIEW_SURFACE: splitOutputPreviewSurfaceDisabled()
  }
}

function youtube4kStreamEnv() {
  return {
    VIDEORC_BASELINE_WIDTH: '3840',
    VIDEORC_BASELINE_HEIGHT: '2160',
    VIDEORC_BASELINE_FPS: '30',
    VIDEORC_BASELINE_BITRATE_KBPS: '30000',
    VIDEORC_BASELINE_STREAMING_SETTINGS: '1',
    VIDEORC_BASELINE_STREAM_OUTPUT_PRESET: 'stream-youtube-4k30',
    VIDEORC_BASELINE_STREAM_BITRATE_KBPS: '30000',
    VIDEORC_BASELINE_STREAM_TARGET_PLATFORM: 'youtube',
    VIDEORC_BASELINE_STREAM_TARGET_ID: 'youtube',
    VIDEORC_BASELINE_LAYOUT_PRESET: process.env.VIDEORC_BASELINE_LAYOUT_PRESET ?? 'screen-only',
    VIDEORC_BASELINE_NO_CAMERA: process.env.VIDEORC_BASELINE_NO_CAMERA ?? '1',
    VIDEORC_BASELINE_NO_PREVIEW_SURFACE: process.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE ?? '1'
  }
}

function evidenceFromManifest(outputDir, label) {
  const manifestPath = join(outputDir, 'latest-real-source-evidence.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${label} session left no evidence manifest at ${manifestPath}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest?.result?.blockedBeforeEncoding) {
    throw new Error(
      `${label} session was blocked before encoding: ${manifest.result.acceptanceFailures?.[0] ?? 'unknown'}`
    )
  }
  return manifest
}

function recordingFromEvidence(manifest, label) {
  const recording = manifest?.paths?.recording
  if (!recording || !existsSync(recording)) {
    throw new Error(`${label} session produced no recording`)
  }
  return recording
}

function splitOutputProof(manifest) {
  const diagnostics = manifest?.diagnostics ?? {}
  return {
    recordingOutput: diagnostics.recordingOutput ?? null,
    streamOutput: diagnostics.streamOutput ?? null,
    rawVideoCopiedFrames: diagnostics.encoderBridgeRawVideoCopiedFrames ?? 0,
    metalTargetCopiedFrames: diagnostics.encoderBridgeMetalTargetCopiedFrames ?? 0,
    zeroCopyFrames: diagnostics.encoderBridgeZeroCopyFrames ?? 0,
    videoToolboxOutputFrames: diagnostics.encoderBridgeVideoToolboxOutputFrames ?? 0,
    videoToolboxOutputBytes: diagnostics.encoderBridgeVideoToolboxOutputBytes ?? 0,
    activeVideoToolboxOutputEncoders:
      diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders ?? 0,
    recordingVideoToolboxOutputFrames:
      diagnostics.encoderBridgeRecordingVideoToolboxOutputFrames ?? 0,
    recordingVideoToolboxOutputBytes:
      diagnostics.encoderBridgeRecordingVideoToolboxOutputBytes ?? 0,
    streamVideoToolboxOutputFrames: diagnostics.encoderBridgeStreamVideoToolboxOutputFrames ?? 0,
    streamVideoToolboxOutputBytes: diagnostics.encoderBridgeStreamVideoToolboxOutputBytes ?? 0,
    separateOutputEncodersActive: diagnostics.encoderBridgeSeparateOutputEncodersActive === true
  }
}

// --- RTMP sink --------------------------------------------------------------------

function spawnRtmpSink({ receivedFlvPath, serverUrl: rtmpServerUrl, streamKey, label }) {
  const child = spawn(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-listen',
      '1',
      '-f',
      'flv',
      '-i',
      `${rtmpServerUrl}/${streamKey}`,
      '-c',
      'copy',
      '-f',
      'flv',
      receivedFlvPath
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  child.on('error', (error) => {
    console.error(`${label} failed to spawn: ${error?.message ?? error}`)
  })
  return child
}

async function drainSink(child, label) {
  if (!child) return
  if (child.exitCode !== null) return
  console.log(`Waiting for the ${label} to drain and finalize the received FLV…`)
  const exited = await waitForExit(child, config.sinkDrainTimeoutMs)
  if (!exited) {
    console.log(`${label} did not exit after disconnect — terminating it.`)
    child.kill('SIGTERM')
    if (!(await waitForExit(child, 5000))) child.kill('SIGKILL')
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveWait) => {
    if (child.exitCode !== null) {
      resolveWait(true)
      return
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolveWait(false)
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolveWait(true)
    }
    child.once('close', onClose)
  })
}

// --- Measurement helpers ------------------------------------------------------------

async function measureOrNull(filePath, options) {
  if (!filePath) return null
  try {
    return await measureAvSync(filePath, options)
  } catch (error) {
    console.error(`measureAvSync failed for ${filePath}: ${error?.message ?? error}`)
    return null
  }
}

async function probeOrNull(filePath) {
  if (!filePath) return null
  try {
    return await probeMedia(filePath, {
      ffprobePath: config.ffprobePath ?? siblingFfprobePath(config.ffmpegPath) ?? 'ffprobe'
    })
  } catch (error) {
    console.error(`probeMedia failed for ${filePath}: ${error?.message ?? error}`)
    return null
  }
}

function summarize(measurement) {
  if (!measurement) return null
  const { pairs, ...rest } = measurement
  return { ...rest, pairCount: pairs?.length ?? 0 }
}

function printSummary({
  recordOnly,
  recordStreamMkv,
  recordStreamFlv,
  recordStreamCompanionFlv,
  flvDrift,
  companionFlvDrift,
  mkvDrift,
  driftEvidence,
  verdict,
  companionVerdict,
  splitOutput4kRecordVerdict,
  youtube4kStreamVerdict,
  mixedYoutube4kTwitch1080pVerdict,
  evidencePath
}) {
  console.log('\n=== Stream A/V sync summary ===')
  printMeasurement('record-only MKV       ', recordOnly)
  printMeasurement('record+stream MKV leg ', recordStreamMkv)
  printMeasurement('RTMP-received FLV     ', recordStreamFlv)
  if (recordStreamCompanionFlv !== undefined) {
    printMeasurement('RTMP companion FLV    ', recordStreamCompanionFlv)
  }
  printDrift('MKV leg drift         ', mkvDrift)
  printDrift('received FLV drift    ', flvDrift)
  if (recordStreamCompanionFlv !== undefined) {
    printDrift('companion FLV drift   ', companionFlvDrift)
  }
  console.log(`classification         ${driftEvidence.classification}`)
  for (const finding of verdict.hypotheses) console.log(`HYPOTHESIS: ${finding}`)
  for (const warning of verdict.warnings) console.log(`WARN: ${warning}`)
  for (const failure of verdict.failures) console.log(`FAIL: ${failure}`)
  if (companionVerdict) {
    for (const warning of companionVerdict.warnings) console.log(`WARN companion: ${warning}`)
    for (const failure of companionVerdict.failures) console.log(`FAIL companion: ${failure}`)
  }
  if (splitOutput4kRecordVerdict) {
    console.log('\n=== Split-output 4K recording summary ===')
    console.log(
      `recording output       ${formatOutputProfile(splitOutput4kRecordVerdict.summary.recordingOutput)}`
    )
    console.log(
      `stream output          ${formatOutputProfile(splitOutput4kRecordVerdict.summary.streamOutput)}`
    )
    console.log(
      `RTMP-received stream   ${formatOutputProfile(splitOutput4kRecordVerdict.summary.receivedStream)}`
    )
    console.log(
      `VT output encoders     ${splitOutput4kRecordVerdict.summary.activeVideoToolboxOutputEncoders ?? 'n/a'}`
    )
    console.log(
      `separate encoders      ${formatBoolean(splitOutput4kRecordVerdict.summary.separateOutputEncodersActive)}`
    )
    console.log(
      `media quality mode     ${splitOutput4kRecordVerdict.summary.mediaQualityMode ?? 'n/a'}`
    )
    for (const warning of splitOutput4kRecordVerdict.warnings) console.log(`WARN: ${warning}`)
    for (const failure of splitOutput4kRecordVerdict.failures) console.log(`FAIL: ${failure}`)
    console.log(
      splitOutput4kRecordVerdict.pass
        ? 'PASS — 4K local recording plus 1080p stream output proved.'
        : 'FAIL — split-output 4K recording evidence outside the gate.'
    )
  }
  if (youtube4kStreamVerdict) {
    console.log('\n=== YouTube 4K stream summary ===')
    console.log(
      `recording output       ${formatOutputProfile(youtube4kStreamVerdict.summary.recordingOutput)}`
    )
    console.log(
      `stream output          ${formatOutputProfile(youtube4kStreamVerdict.summary.streamOutput)}`
    )
    console.log(
      `RTMP-received stream   ${formatOutputProfile(youtube4kStreamVerdict.summary.receivedStream)}`
    )
    console.log(
      `stream platform        ${youtube4kStreamVerdict.summary.streamTargetPlatform ?? 'n/a'}`
    )
    console.log(
      `VT output encoders     ${youtube4kStreamVerdict.summary.activeVideoToolboxOutputEncoders ?? 'n/a'}`
    )
    console.log(
      `separate encoders      ${formatBoolean(youtube4kStreamVerdict.summary.separateOutputEncodersActive)}`
    )
    console.log(
      `media quality mode     ${youtube4kStreamVerdict.summary.mediaQualityMode ?? 'n/a'}`
    )
    for (const warning of youtube4kStreamVerdict.warnings) console.log(`WARN: ${warning}`)
    for (const failure of youtube4kStreamVerdict.failures) console.log(`FAIL: ${failure}`)
    console.log(
      youtube4kStreamVerdict.pass
        ? 'PASS — YouTube 4K30 stream output proved.'
        : 'FAIL — YouTube 4K30 stream evidence outside the gate.'
    )
  }
  if (mixedYoutube4kTwitch1080pVerdict) {
    console.log('\n=== Mixed YouTube 4K + Twitch 1080p stream summary ===')
    console.log(
      `recording output       ${formatOutputProfile(mixedYoutube4kTwitch1080pVerdict.summary.recordingOutput)}`
    )
    console.log(
      `companion stream out   ${formatOutputProfile(mixedYoutube4kTwitch1080pVerdict.summary.companionStreamOutput)}`
    )
    console.log(
      `YouTube received       ${formatOutputProfile(mixedYoutube4kTwitch1080pVerdict.summary.youtubeReceived)}`
    )
    console.log(
      `Twitch received        ${formatOutputProfile(mixedYoutube4kTwitch1080pVerdict.summary.twitchReceived)}`
    )
    console.log(
      `VT output encoders     ${mixedYoutube4kTwitch1080pVerdict.summary.activeVideoToolboxOutputEncoders ?? 'n/a'}`
    )
    console.log(
      `separate encoders      ${formatBoolean(mixedYoutube4kTwitch1080pVerdict.summary.separateOutputEncodersActive)}`
    )
    console.log(
      `media quality mode     ${mixedYoutube4kTwitch1080pVerdict.summary.mediaQualityMode ?? 'n/a'}`
    )
    for (const warning of mixedYoutube4kTwitch1080pVerdict.warnings) console.log(`WARN: ${warning}`)
    for (const failure of mixedYoutube4kTwitch1080pVerdict.failures) console.log(`FAIL: ${failure}`)
    console.log(
      mixedYoutube4kTwitch1080pVerdict.pass
        ? 'PASS — mixed YouTube 4K30 and Twitch 1080p30 outputs proved.'
        : 'FAIL — mixed-destination stream evidence outside the gate.'
    )
  }
  console.log(`Evidence: ${evidencePath}`)
  console.log(
    verdict.pass &&
      (splitOutput4kRecordVerdict?.pass ?? true) &&
      (youtube4kStreamVerdict?.pass ?? true) &&
      (mixedYoutube4kTwitch1080pVerdict?.pass ?? true)
      ? 'PASS — stream baseline inside the requested gate(s).'
      : 'FAIL — stream baseline outside the requested gate(s).'
  )
}

function printMeasurement(label, measurement) {
  if (measurement === undefined) {
    console.log(`${label} skipped`)
    return
  }
  if (measurement === null) {
    console.log(`${label} NOT MEASURED`)
    return
  }
  const median = measurement.medianOffsetMs
  const medianText = Number.isFinite(median)
    ? `${median >= 0 ? '+' : ''}${median.toFixed(0)}ms median`
    : 'no pairs'
  console.log(
    `${label} ${medianText} (${measurement.flashCount} flashes, ${measurement.clickCount} clicks, ` +
      `maxAbs ${Number.isFinite(measurement.maxAbsOffsetMs) ? measurement.maxAbsOffsetMs.toFixed(0) : '—'}ms)`
  )
}

function printDrift(label, drift) {
  if (!drift) {
    console.log(`${label} insufficient pairs for a fit`)
    return
  }
  console.log(
    `${label} ${drift.slopeMsPerMinute >= 0 ? '+' : ''}${drift.slopeMsPerMinute.toFixed(2)}ms/min ` +
      `(${(drift.slopeMsPerMinute * 30).toFixed(1)}ms/30min over ${drift.samples} pairs, span ${drift.spanSec.toFixed(0)}s)`
  )
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function formatOutputProfile(profile) {
  if (!profile) return 'not reported'
  const fps = profile.fps ?? profile.avgFps ?? profile.nominalFps ?? 'n/a'
  const bitrate = typeof profile.bitrateKbps === 'number' ? `, ${profile.bitrateKbps}kbps` : ''
  return `${profile.width ?? 'n/a'}x${profile.height ?? 'n/a'} @ ${fps}fps${bitrate}`
}

function formatBoolean(value) {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : 'n/a'
}
