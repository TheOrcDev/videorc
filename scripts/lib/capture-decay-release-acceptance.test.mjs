import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import { CAPTURE_DECAY_APP_BUNDLE_PROFILE } from './capture-decay-app-bundle.mjs'
import {
  buildCaptureDecayAttemptLedgerManifest,
  finishCaptureDecayAttempt,
  startCaptureDecayAttempt
} from './capture-decay-attempt-ledger.mjs'
import {
  CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
  CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE,
  CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
  CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
  CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
  CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE,
  buildCaptureDecayD3DestinationBinding
} from './capture-decay-publication-attestation.mjs'
import {
  getCaptureDecayD3PublicRouteReadS3Config,
  verifyCaptureDecayD3PublishedReleaseRoutes
} from './capture-decay-published-release.mjs'
import { assembleCaptureDecayD3PublicationReceipt } from './capture-decay-publication-receipt-assembly.mjs'

import {
  CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE,
  CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH,
  CAPTURE_DECAY_D3_EVIDENCE_PROFILE,
  CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE,
  CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE,
  CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION,
  CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES,
  CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES,
  CAPTURE_DECAY_REQUIRED_RETENTION_POINTS,
  assertCaptureDecayD3AcceptanceRecord,
  assertCaptureDecayD3PublicationReceipt,
  assertCaptureDecayD3PublicationSourceState,
  buildCaptureDecayDebugRunnerProvenance,
  buildCaptureDecayD3AcceptanceRecord,
  buildCaptureDecayD3PublicationReceipt,
  buildCaptureDecayRunAttestation,
  buildSatisfiedCaptureDecayD3Record,
  captureDecayCanonicalJsonSha256,
  captureDecayD3PublicationAttestationSubjectSha256s,
  captureDecayRunCoordinates,
  loadAndValidateCaptureDecayD3Evidence,
  lockedCaptureDecayRealReleaseEnvironment,
  readCaptureDecayD3AcceptanceRecord,
  validateCaptureDecayD3Evidence,
  validateCaptureDecayD3PublicationReceipt,
  writeCaptureDecayD3AcceptanceRecord
} from './capture-decay-release-acceptance.mjs'
import {
  MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
  MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE,
  MACOS_D3_SEALED_CANDIDATE_PROFILE,
  canonicalMacosD3Json,
  macosD3CandidatePrefix,
  macosD3CandidatePublicationArtifactMapping,
  macosD3CandidateSealSummary,
  macosD3SealedCandidateBindingSha256,
  sha256MacosD3CanonicalJson
} from './macos-d3-sealed-candidate.mjs'
import { buildMacosD3PublicationReservation } from './release-upload-s3.mjs'
import { captureDecaySanitizedChildEnvironment } from '../run-capture-decay-real-release.mjs'

const execFileAsync = promisify(execFile)

const candidateAppBundle = Object.freeze({
  profile: CAPTURE_DECAY_APP_BUNDLE_PROFILE,
  bundleFilename: 'Videorc.app',
  executableRelativePath: 'Contents/MacOS/Videorc',
  manifestSha256: '1'.repeat(64),
  entryCount: 200,
  regularFileCount: 150,
  totalRegularFileSizeBytes: 100_000_000
})
const destinationBindingSha256 = publicationDestinationBindingFixture().sha256
const candidate = Object.freeze({
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'f'.repeat(40),
  executableSha256: 'b'.repeat(64),
  executableSizeBytes: 10_000,
  dmgSha256: '1'.repeat(64),
  dmgSizeBytes: 1234,
  executableFilename: 'Videorc',
  dmgFilename: 'Videorc-1.0.0-mac-arm64.dmg',
  appBundle: candidateAppBundle
})
const sealedCandidate = Object.freeze(sealedCandidateFixture(candidate, destinationBindingSha256))
const sealedCandidateBindingSha256 = macosD3SealedCandidateBindingSha256(sealedCandidate)
const debugBuildCommand = Object.freeze({
  program: '/usr/local/bin/node',
  arguments: ['scripts/build-capture-decay-debug-runner.mjs'],
  cwd: '.'
})
const debugExecutable = Object.freeze({
  executableFilename: 'videorc-debug',
  executableSha256: 'e'.repeat(64),
  sizeBytes: 30_000,
  appBundle: {
    ...candidateAppBundle,
    bundleFilename: 'Videorc-D3-Debug.app',
    executableRelativePath: 'Contents/MacOS/videorc-debug',
    manifestSha256: '2'.repeat(64),
    totalRegularFileSizeBytes: 100_100_000
  },
  backend: {
    filename: 'videorc-backend',
    sha256: '7'.repeat(64),
    sizeBytes: 40_000
  }
})
const debugProvenanceDocument = Object.freeze(
  buildCaptureDecayDebugRunnerProvenance({
    build: {
      ...debugBuildCommand,
      programSha256: '8'.repeat(64),
      programSizeBytes: 50_000,
      startedAt: '2026-08-27T11:50:00.000Z',
      finishedAt: '2026-08-27T11:51:00.000Z',
      exitCode: 0,
      shell: false,
      outputDidNotExist: true,
      commandSha256: captureDecayCanonicalJsonSha256(debugBuildCommand)
    },
    candidate,
    runner: debugExecutable,
    sourceBefore: {
      sourceCommit: candidate.sourceCommit,
      sourceTree: candidate.sourceTree,
      trackedClean: true
    },
    sourceAfter: {
      sourceCommit: candidate.sourceCommit,
      sourceTree: candidate.sourceTree,
      trackedClean: true
    }
  })
)
const debugRunner = Object.freeze({
  ...debugExecutable,
  provenance: {
    filename: 'capture-decay-debug-runner-provenance.json',
    sha256: captureDecayCanonicalJsonSha256(debugProvenanceDocument),
    document: debugProvenanceDocument
  }
})
const hostId = 'd'.repeat(64)
const ceremonyId = 'd3-owner-mac-2026-08-28'
const nowMs = Date.parse('2026-08-28T20:00:00.000Z')
const cameraId = 'camera:avfoundation-native:owner-camera'
const screenId = 'screen:screencapturekit:owner-screen'
const rawCsvText = 'elapsedMs,camera,screen\n2000,30,30\n'
const rawCsvArtifact = Object.freeze({
  filename: 'capture-decay-soak.csv',
  relativePath: 'capture-decay-soak.csv',
  sha256: sha256(rawCsvText),
  sizeBytes: Buffer.byteLength(rawCsvText)
})
const recoveryRecordingText = 'recording-bytes'
const recoveryRecordingArtifact = Object.freeze({
  filename: 'recovery.mp4',
  relativePath: 'recovery.mp4',
  sha256: sha256(recoveryRecordingText),
  sizeBytes: Buffer.byteLength(recoveryRecordingText)
})

describe('locked real-release profile', () => {
  it('removes storage, signing, AWS, OAuth, and credential channels before app launch', () => {
    assert.deepEqual(
      captureDecaySanitizedChildEnvironment({
        SAFE_MARKER: 'kept',
        AWS_ACCESS_KEY_ID: 'secret',
        CLOUDFLARE_API_TOKEN: 'secret',
        GIT_ASKPASS: '/secret/helper',
        OAUTH_CLIENT_ID: 'secret',
        VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT: '/secret/receipt',
        VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256: '0'.repeat(64),
        VIDEORC_RELEASE_SIGN_IDENTITY: 'secret'
      }),
      { SAFE_MARKER: 'kept' }
    )
  })

  it('pins real 4K30 sources, visible motion, native Metal, 90% cadence, and 240 minutes', () => {
    const env = lockedCaptureDecayRealReleaseEnvironment({ OWNER_MARKER: 'kept' })
    assert.equal(env.OWNER_MARKER, 'kept')
    assert.equal(env.VIDEORC_SOAK_REAL_SOURCES, '1')
    assert.equal(env.VIDEORC_SCREEN_MOTION_VERIFY_VISIBLE, '1')
    assert.equal(env.VIDEORC_SYNTHETIC_HARD_CONTENT, '0')
    assert.equal(env.VIDEORC_SMOKE_PREVIEW_MOTION, '0')
    assert.equal(env.VIDEORC_METAL_COMPOSITOR, '1')
    assert.equal(env.VIDEORC_ZEROCOPY_SOURCES, '1')
    assert.equal(env.VIDEORC_SOAK_MINUTES, '240')
    assert.equal(env.VIDEORC_SOAK_WIDTH, '3840')
    assert.equal(env.VIDEORC_SOAK_HEIGHT, '2160')
    assert.equal(env.VIDEORC_SOAK_FPS, '30')
    assert.equal(env.VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION, '0.9')
    assert.throws(
      () =>
        lockedCaptureDecayRealReleaseEnvironment({
          VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION: '0.6'
        }),
      hasCode('locked-profile-override')
    )

    const recovery = lockedCaptureDecayRealReleaseEnvironment({}, { recovery: true })
    assert.equal(recovery.VIDEORC_SOAK_MINUTES, '1')
    assert.equal(recovery.VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES, '0')
  })

  it('requires ordinal and dual recovery binding to soak three', () => {
    assert.deepEqual(captureDecayRunCoordinates({ VIDEORC_CAPTURE_DECAY_RUN_ORDINAL: '1' }), {
      qualifiedSoakAttestationSha256: null,
      recoverySources: null,
      runOrdinal: 1,
      previousAttestationSha256: null
    })
    assert.throws(
      () => captureDecayRunCoordinates({ VIDEORC_CAPTURE_DECAY_RUN_ORDINAL: '2' }),
      hasCode('missing-previous-attestation')
    )
    const qualified = '1'.repeat(64)
    assert.deepEqual(
      captureDecayRunCoordinates(
        { VIDEORC_CAPTURE_DECAY_QUALIFIED_SOAK_ATTESTATION_SHA256: qualified },
        { recovery: true }
      ),
      {
        qualifiedSoakAttestationSha256: qualified,
        recoverySources: ['camera', 'screen'],
        runOrdinal: null,
        previousAttestationSha256: null
      }
    )
  })

  it('attests only a successful evidence child exit and binds that result', () => {
    const startedAt = '2026-08-27T00:00:00.000Z'
    const finishedAt = '2026-08-27T04:00:05.000Z'
    const checkpoint = checkpointFixture({ finishedAt, startedAt })
    const build = (childExit) =>
      buildCaptureDecayRunAttestation({
        attemptLedger: attemptLedgerBinding('successful-child-exit', '1'.repeat(64)),
        candidate,
        checkpoint,
        checkpointSha256: sha256(canonical(checkpoint)),
        checkpointSizeBytes: Buffer.byteLength(canonical(checkpoint)),
        childExit,
        coordinates: {
          qualifiedSoakAttestationSha256: null,
          recoverySources: null,
          runOrdinal: 1,
          previousAttestationSha256: null
        },
        hostId,
        recovery: false,
        runner: {
          executableFilename: candidate.executableFilename,
          executableSha256: candidate.executableSha256,
          sizeBytes: candidate.executableSizeBytes,
          appBundle: candidate.appBundle
        },
        runId: 'successful-child-exit',
        sealedCandidateBindingSha256,
        sidecars: [{ role: 'raw-csv', ...rawCsvArtifact }],
        writtenAt: addSeconds(finishedAt, 1)
      })

    assert.throws(() => build({ code: 1, signal: null }), hasCode('run-child-exit'))
    assert.throws(() => build({ code: 0, signal: 'SIGTERM' }), hasCode('run-child-exit'))
    assert.deepEqual(build({ code: 0, signal: null }).childExit, { code: 0, signal: null })
  })
})

describe('D3 real evidence validation', () => {
  it('accepts only three chained 240-minute passes plus one dual-source recovery recording', () => {
    const evidence = validEvidence()
    const validation = validate(evidence)
    assert.equal(validation.soaks.length, 3)
    assert.deepEqual(
      Object.keys(validation.recovery.sources),
      CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES
    )
    assert.deepEqual(
      Object.keys(validation.soaks[0].retention),
      CAPTURE_DECAY_REQUIRED_RETENTION_POINTS
    )
    const record = buildAccepted(validation)
    assert.equal(assertCaptureDecayD3AcceptanceRecord(record), record)
    assert.equal(record.validator.minimumRateFraction, 0.9)
    assert.equal(record.validator.requiredSoakMinutes, 240)
  })

  it('rejects missing, duplicate, out-of-order, overlapping, failed, interrupted, and stale runs', () => {
    const evidence = validEvidence()
    const originalSoaks = evidence.soaks
    evidence.soaks = evidence.soaks.slice(0, 2)
    assert.throws(() => validate(evidence), hasCode('soak-count'))
    evidence.soaks = originalSoaks

    const originalCheckpointSha = evidence.soaks[1].checkpointSha256
    evidence.soaks[1].checkpointSha256 = evidence.soaks[0].checkpointSha256
    evidence.soaks[1].attestation.checkpoint.sha256 = evidence.soaks[0].checkpointSha256
    assert.throws(() => validate(evidence), hasCode('duplicate-checkpoint'))
    evidence.soaks[1].checkpointSha256 = originalCheckpointSha
    evidence.soaks[1].attestation.checkpoint.sha256 = originalCheckpointSha

    const originalOrdinal = evidence.soaks[1].attestation.runOrdinal
    evidence.soaks[1].attestation.runOrdinal = 3
    assert.throws(() => validate(evidence), hasCode('run-order'))
    evidence.soaks[1].attestation.runOrdinal = originalOrdinal

    const originalStart = evidence.soaks[1].checkpoint.startedAt
    evidence.soaks[1].checkpoint.startedAt = addSeconds(evidence.soaks[0].checkpoint.finishedAt, -1)
    evidence.soaks[1].attestation.checkpoint.startedAt = addSeconds(
      evidence.soaks[0].checkpoint.finishedAt,
      -1
    )
    assert.throws(() => validate(evidence), hasCode('overlapping-soaks'))
    evidence.soaks[1].checkpoint.startedAt = originalStart
    evidence.soaks[1].attestation.checkpoint.startedAt = originalStart

    evidence.soaks[0].checkpoint.status = 'failed'
    evidence.soaks[0].attestation.checkpoint.status = 'failed'
    assert.throws(() => validate(evidence), hasCode('checkpoint-not-passed'))
    evidence.soaks[0].checkpoint.status = 'passed'
    evidence.soaks[0].attestation.checkpoint.status = 'passed'

    evidence.soaks[0].checkpoint.interruptedSignal = 'SIGTERM'
    assert.throws(() => validate(evidence), hasCode('checkpoint-failures'))
    delete evidence.soaks[0].checkpoint.interruptedSignal

    assert.throws(
      () =>
        validateCaptureDecayD3Evidence({
          ...validationArguments(evidence),
          nowMs: nowMs + 8 * 24 * 60 * 60 * 1_000
        }),
      hasCode('stale-evidence')
    )
  })

  it('requires every attestation to bind a successful evidence child exit', () => {
    const evidence = validEvidence()
    delete evidence.soaks[0].attestation.childExit
    assert.throws(() => validate(evidence), hasCode('run-child-exit'))

    evidence.soaks[0].attestation.childExit = { code: 0, signal: null }
    evidence.recovery.attestation.childExit = { code: 1, signal: null }
    assert.throws(() => validate(evidence), hasCode('run-child-exit'))

    const missingLedgerBinding = validEvidence()
    delete missingLedgerBinding.soaks[0].attestation.attemptLedger
    assert.throws(() => validate(missingLedgerBinding), hasCode('run-attempt-ledger-binding'))
  })

  it('requires the evidence candidate to bind a deterministic full app-bundle manifest', () => {
    const evidence = validEvidence()
    evidence.manifest.candidate = { ...evidence.manifest.candidate }
    delete evidence.manifest.candidate.appBundle

    assert.throws(() => validate(evidence), hasCode('app-bundle-profile'))
  })

  it('rejects a mixed seal binding and a seal whose DMG is not the tested candidate', () => {
    const mixed = validEvidence()
    mixed.soaks[1].attestation.sealedCandidateBindingSha256 = '0'.repeat(64)
    assert.throws(() => validate(mixed), hasCode('attestation-sealed-candidate'))

    const wrongDmgSeal = sealedCandidateFixture(
      { ...candidate, dmgSha256: '0'.repeat(64) },
      destinationBindingSha256
    )
    assert.throws(
      () =>
        validateCaptureDecayD3Evidence({
          ...validationArguments(validEvidence()),
          sealedCandidate: wrongDmgSeal
        }),
      hasCode('candidate-seal-identity-mismatch')
    )
  })

  it('binds the full app bundle for packaged and debug runners', () => {
    let evidence = validEvidence()
    assert.deepEqual(evidence.soaks[0].attestation.runner.appBundle, candidate.appBundle)
    assert.deepEqual(evidence.recovery.attestation.runner.appBundle, debugExecutable.appBundle)
    assert.deepEqual(
      evidence.recovery.attestation.runner.provenance.document.appBundle,
      debugExecutable.appBundle
    )

    delete evidence.soaks[0].attestation.runner.appBundle
    assert.throws(() => validate(evidence), hasCode('app-bundle-profile'))

    evidence = validEvidence()
    const recoveryRunner = evidence.recovery.attestation.runner
    recoveryRunner.provenance.document.candidate.appBundle = {
      ...recoveryRunner.provenance.document.candidate.appBundle,
      manifestSha256: '0'.repeat(64)
    }
    recoveryRunner.provenance.sha256 = captureDecayCanonicalJsonSha256(
      recoveryRunner.provenance.document
    )
    evidence.recovery.attestation.sidecars.find(
      (sidecar) => sidecar.role === 'debug-runner-provenance'
    ).sha256 = recoveryRunner.provenance.sha256
    assert.throws(() => validate(evidence), hasCode('app-bundle-identity-mismatch'))
  })

  it('rejects duplicate sample schedule points even when reported coverage is complete', () => {
    const evidence = validEvidence()
    const samples = evidence.soaks[0].checkpoint.samples
    samples[1].elapsedMs = samples[0].elapsedMs

    assert.throws(() => validate(evidence), hasCode('sample-timeline'))
  })

  it('does not count duplicate schedule points toward 95% sample coverage', () => {
    const evidence = validEvidence()
    const checkpoint = evidence.soaks[0].checkpoint
    const requiredSampleCount = checkpoint.evidenceSummary.requiredSampleCount
    const samples = checkpoint.samples.slice(0, requiredSampleCount - 1)
    samples.push({
      ...samples.at(-1),
      cameraLatestSequence: samples.at(-1).cameraLatestSequence + 1,
      screenLatestSequence: samples.at(-1).screenLatestSequence + 1
    })
    checkpoint.samples = samples
    checkpoint.samplesCollected = samples.length
    checkpoint.evidenceSummary.samplesCollected = samples.length

    assert.throws(() => validate(evidence), hasCode('sample-coverage'))
  })

  it('rejects mixed candidate/runner identities and changed owner sources', () => {
    const evidence = validEvidence()
    evidence.soaks[1].attestation.candidate.executableSha256 = '9'.repeat(64)
    assert.throws(() => validate(evidence), hasCode('mixed-candidate-identity'))
    evidence.soaks[1].attestation.candidate.executableSha256 = candidate.executableSha256

    evidence.soaks[2].attestation.runner.executableSha256 = '8'.repeat(64)
    assert.throws(() => validate(evidence), hasCode('soak-runner-identity'))
    evidence.soaks[2].attestation.runner.executableSha256 = candidate.executableSha256

    evidence.recovery.attestation.captureIdentity.hostId = '7'.repeat(64)
    assert.throws(() => validate(evidence), hasCode('mixed-capture-identity'))
    evidence.recovery.attestation.captureIdentity.hostId = hostId

    evidence.recovery.attestation.runner.executableSha256 = '6'.repeat(64)
    assert.throws(() => validate(evidence), hasCode('runner-provenance'))
  })

  it('rejects short/wrong-profile, synthetic/static, or below-90% real-source evidence', () => {
    const evidence = validEvidence()
    evidence.soaks[0].checkpoint.config.soakMinutes = 239
    assert.throws(() => validate(evidence), hasCode('checkpoint-config'))
    evidence.soaks[0].checkpoint.config.soakMinutes = 240

    evidence.soaks[0].checkpoint.startupEvidence.sceneRequest.video.width = 1920
    assert.throws(() => validate(evidence), hasCode('video-profile'))
    evidence.soaks[0].checkpoint.startupEvidence.sceneRequest.video.width = 3840

    evidence.soaks[0].checkpoint.sourceSelection.testPattern = true
    assert.throws(() => validate(evidence), hasCode('real-source-identity'))
    evidence.soaks[0].checkpoint.sourceSelection.testPattern = false

    evidence.soaks[0].checkpoint.startupEvidence.motionStimulus.visibility.visible = false
    assert.throws(() => validate(evidence), hasCode('real-source-readiness'))
    evidence.soaks[0].checkpoint.startupEvidence.motionStimulus.visibility.visible = true

    for (const sample of evidence.soaks[0].checkpoint.samples.slice(0, 3)) {
      sample.cameraPublicationFps = 26
    }
    assert.throws(() => validate(evidence), hasCode('cadence-below-target'))
  })

  it('rejects missing/unbounded cached native counters, teardown leaks, and sizing mismatch', () => {
    const evidence = validEvidence()
    delete evidence.soaks[0].checkpoint.evidenceSummary.retentionPoints.metalTargetRingSlots
    assert.throws(() => validate(evidence), hasCode('retention-points-missing'))
    evidence.soaks[0] = validEvidence().soaks[0]

    evidence.soaks[0].checkpoint.evidenceSummary.retentionPoints.nativePreviewPresenterImports.liveCount = 5
    assert.throws(() => validate(evidence), hasCode('retention-point-unbounded'))
    evidence.soaks[0] = validEvidence().soaks[0]

    evidence.soaks[0].checkpoint.teardownEvidence.finalRetentionState.encoderInflightTargetRefs.liveCount = 1
    assert.throws(() => validate(evidence), hasCode('retention-teardown-live'))
    evidence.soaks[0] = validEvidence().soaks[0]

    evidence.soaks[0].attestation.sizingEvidence.retentionReconfigurationTimeline[0].compositorWidth = 1920
    assert.throws(() => validate(evidence), hasCode('sizing-evidence-binding'))
  })

  it('fails closed until one session records both bounded exact-generation recoveries', () => {
    const evidence = validEvidence()
    const injected = evidence.recovery.checkpoint.injectedRecoveryEvidence
    const screen = injected.screen
    delete injected.screen
    assert.throws(() => validate(evidence), hasCode('recovery-evidence'))
    injected.screen = screen

    screen.observations[0].trigger = 'manual'
    assert.throws(() => validate(evidence), hasCode('recovery-evidence'))
    screen.observations[0].trigger = 'automatic'

    screen.summary.observedDetectionMs = 6001
    assert.throws(() => validate(evidence), hasCode('recovery-evidence'))
    screen.summary.observedDetectionMs = 1000

    screen.summary.cadenceRestore.samples[0].sourceGeneration = 99
    assert.throws(() => validate(evidence), hasCode('recovery-cadence'))
    screen.summary.cadenceRestore.samples[0].sourceGeneration = 2

    const cadenceSamples = screen.summary.cadenceRestore.samples
    for (const sampleCount of [2, 4]) {
      screen.summary.cadenceRestore.samples = Array.from(
        { length: sampleCount },
        (_, index) => cadenceSamples[Math.min(index, cadenceSamples.length - 1)]
      )
      assert.throws(() => validate(evidence), hasCode('recovery-cadence'))
    }
    screen.summary.cadenceRestore.samples = cadenceSamples

    const secondCadenceTimestamp = cadenceSamples[1].observedAt
    delete cadenceSamples[1].observedAt
    assert.throws(() => validate(evidence), hasCode('recovery-cadence'))
    cadenceSamples[1].observedAt = cadenceSamples[0].observedAt
    assert.throws(() => validate(evidence), hasCode('recovery-cadence'))
    cadenceSamples[1].observedAt = secondCadenceTimestamp

    const accepted = buildAccepted(validate(evidence))
    const acceptedSamples = accepted.recovery.sources.screen.cadenceRestore.samples
    for (const sampleCount of [2, 4]) {
      accepted.recovery.sources.screen.cadenceRestore.samples = Array.from(
        { length: sampleCount },
        (_, index) => acceptedSamples[Math.min(index, acceptedSamples.length - 1)]
      )
      assert.throws(
        () => assertCaptureDecayD3AcceptanceRecord(accepted),
        hasCode('record-recovery-bounds')
      )
    }
    accepted.recovery.sources.screen.cadenceRestore.samples = acceptedSamples
    acceptedSamples[0].publicationFps = 1
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(accepted),
      hasCode('record-recovery-bounds')
    )
    acceptedSamples[0].publicationFps = 30
    acceptedSamples[0].sourceGeneration = 3
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(accepted),
      hasCode('record-recovery-bounds')
    )
    acceptedSamples[0].sourceGeneration = 2

    for (const sample of cadenceSamples) {
      sample.expectedProducerFps = 1
      sample.expectedConsumerFps = 1
      sample.captureCallbackFps = 1
      sample.publicationFps = 1
      sample.freshServeFps = 1
    }
    assert.throws(() => validate(evidence), hasCode('recovery-cadence'))
    for (const sample of cadenceSamples) {
      sample.expectedProducerFps = 30
      sample.expectedConsumerFps = 30
      sample.captureCallbackFps = 30
      sample.publicationFps = 30
      sample.freshServeFps = 30
    }

    const acceptedLowered = buildAccepted(validate(evidence))
    for (const sample of acceptedLowered.recovery.sources.screen.cadenceRestore.samples) {
      sample.expectedProducerFps = 1
      sample.expectedConsumerFps = 1
      sample.captureCallbackFps = 1
      sample.publicationFps = 1
      sample.freshServeFps = 1
    }
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(acceptedLowered),
      hasCode('record-recovery-bounds')
    )
    for (const sample of acceptedLowered.recovery.sources.screen.cadenceRestore.samples) {
      sample.expectedProducerFps = 30
      sample.expectedConsumerFps = 30
      sample.captureCallbackFps = 30
      sample.publicationFps = 30
      sample.freshServeFps = 30
    }

    injected.recording.observations[2].sessionId = 'different-session'
    assert.throws(() => validate(evidence), hasCode('recovery-recording-session'))
    injected.recording.observations[2].sessionId = injected.sessionId

    const screenBeforeTimestamp = injected.recording.observations[2].observedAt
    injected.recording.observations[2].observedAt = injected.recording.observations[1].observedAt
    assert.throws(() => validate(evidence), hasCode('recovery-recording-session'))
    injected.recording.observations[2].observedAt = screenBeforeTimestamp

    const recordingStartedTimestamp = injected.recording.started.observedAt
    injected.recording.started.observedAt = injected.recording.observations[0].observedAt
    assert.throws(() => validate(evidence), hasCode('recovery-recording-session'))
    injected.recording.started.observedAt = recordingStartedTimestamp

    const recordingStoppedTimestamp = injected.recording.stopped.observedAt
    injected.recording.stopped.observedAt = injected.recording.observations[3].observedAt
    assert.throws(() => validate(evidence), hasCode('recovery-recording-session'))
    injected.recording.stopped.observedAt = recordingStoppedTimestamp

    const cameraBeforeTimestamp = injected.recording.observations[0].observedAt
    injected.recording.observations[0].observedAt = addSeconds(
      new Date(injected.camera.armedAtMs).toISOString(),
      1
    )
    assert.throws(() => validate(evidence), hasCode('recovery-recording-session'))
    injected.recording.observations[0].observedAt = cameraBeforeTimestamp

    const acceptedTimeline = buildAccepted(validate(evidence))
    acceptedTimeline.recovery.recording.observations[2].observedAt =
      acceptedTimeline.recovery.recording.observations[1].observedAt
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(acceptedTimeline),
      hasCode('record-recovery-recording')
    )
    acceptedTimeline.recovery.recording.observations[2].observedAt = screenBeforeTimestamp
    acceptedTimeline.recovery.recording.started.observedAt =
      acceptedTimeline.recovery.recording.observations[0].observedAt
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(acceptedTimeline),
      hasCode('record-recovery-recording')
    )
    acceptedTimeline.recovery.recording.started.observedAt = recordingStartedTimestamp
    acceptedTimeline.recovery.recording.stopped.backendState = 'recording'
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(acceptedTimeline),
      hasCode('record-recovery-recording')
    )

    evidence.recovery.attestation.qualifiedSoakAttestationSha256 = null
    assert.throws(() => validate(evidence), hasCode('recovery-chain'))
  })

  it('accepts recovery only from an executed clean-source debug build receipt', () => {
    let evidence = validEvidence()
    evidence.recovery.attestation.runner.provenance.document.sourceBefore.trackedClean = false
    assert.throws(() => validate(evidence), hasCode('runner-build-dirty'))

    evidence = validEvidence()
    evidence.recovery.attestation.runner.provenance.document.build.outputDidNotExist = false
    assert.throws(() => validate(evidence), hasCode('runner-build-execution'))

    evidence = validEvidence()
    const substitutedBuild = evidence.recovery.attestation.runner.provenance.document.build
    substitutedBuild.arguments = ['scripts/unbound-after-the-fact-build.mjs']
    substitutedBuild.commandSha256 = captureDecayCanonicalJsonSha256({
      program: substitutedBuild.program,
      arguments: substitutedBuild.arguments,
      cwd: '.'
    })
    assert.throws(() => validate(evidence), hasCode('runner-build-execution'))

    evidence = validEvidence()
    evidence.recovery.attestation.runner.provenance.document.sourceAfter.sourceTree = '0'.repeat(40)
    assert.throws(() => validate(evidence), hasCode('runner-build-source-changed'))

    evidence = validEvidence()
    evidence.recovery.attestation.runner.backend.sha256 = '0'.repeat(64)
    assert.throws(() => validate(evidence), hasCode('runner-provenance'))
  })

  it('rejects unfinished MKV recovery artifacts in raw and accepted evidence', () => {
    const evidence = validEvidence()
    evidence.recovery.attestation.recordingArtifact.filename = 'recovery.mkv'
    evidence.recovery.attestation.recordingArtifact.relativePath = 'recovery.mkv'
    assert.throws(() => validate(evidence), hasCode('recording-artifact-container'))

    const accepted = buildAccepted(validate(validEvidence()))
    accepted.recovery.recordingArtifact.filename = 'recovery.mkv'
    accepted.recovery.recordingArtifact.relativePath = 'recovery.mkv'
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(accepted),
      hasCode('recording-artifact-container')
    )
  })
})

describe('immutable evidence bundle loading', () => {
  it('requires the seal receipt to predate the first immutable ceremony attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-d3-late-seal-'))
    try {
      const lateSeal = sealedCandidateFixture(
        candidate,
        destinationBindingSha256,
        '2026-08-27T00:00:00.000Z'
      )
      const manifest = await writeEvidenceBundle(directory, validEvidence(), {
        bundleSealedCandidate: lateSeal
      })
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, canonical(manifest))
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('candidate-seal-order')
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('hash-verifies every sidecar/checkpoint and rejects later mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-d3-evidence-'))
    try {
      const evidence = validEvidence()
      const manifest = await writeEvidenceBundle(directory, evidence)
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, canonical(manifest))
      const validation = await loadAndValidateCaptureDecayD3Evidence({
        manifestPath,
        expectedCandidate: candidate,
        expectedPublicationDestinationBindingSha256: destinationBindingSha256,
        nowMs
      })
      assert.equal(validation.accepted, true)

      await writeFile(join(directory, 'run-1', 'capture-decay-soak.json'), '{}\n')
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('checkpoint-tampered')
      )

      await writeFile(
        join(directory, 'run-1', 'capture-decay-soak.json'),
        canonical(evidence.soaks[0].checkpoint)
      )
      await writeFile(
        join(directory, 'run-1', 'capture-decay-soak.csv'),
        rawCsvText.replace('2000,30,30', '2000,31,30')
      )
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('run-sidecar-tampered')
      )

      await writeFile(join(directory, 'run-1', 'capture-decay-soak.csv'), rawCsvText)
      manifest.soaks[0].sizeBytes += 1
      await writeFile(manifestPath, canonical(manifest))
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('attestation-size')
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects exact-byte checkpoint and sidecar substitutions through symlinks', async () => {
    const substitutions = [
      'run-1/capture-decay-soak.json',
      'run-1/capture-decay-soak.csv',
      'run-4/capture-decay-debug-runner-provenance.json',
      'run-4/recovery.mp4'
    ]

    for (const [index, relativePath] of substitutions.entries()) {
      const directory = await mkdtemp(join(tmpdir(), 'videorc-d3-evidence-symlink-'))
      const outsideDirectory = await mkdtemp(join(tmpdir(), 'videorc-d3-evidence-outside-'))
      try {
        const manifest = await writeEvidenceBundle(directory, validEvidence())
        const manifestPath = join(directory, 'manifest.json')
        await writeFile(manifestPath, canonical(manifest))

        const artifactPath = join(directory, relativePath)
        const outsidePath = join(outsideDirectory, `substitution-${index}`)
        await rename(artifactPath, outsidePath)
        await symlink(outsidePath, artifactPath)

        await assert.rejects(
          () =>
            loadAndValidateCaptureDecayD3Evidence({
              manifestPath,
              expectedCandidate: candidate,
              expectedPublicationDestinationBindingSha256: destinationBindingSha256,
              nowMs
            }),
          hasCode('evidence-artifact-symlink'),
          relativePath
        )
      } finally {
        await Promise.all(
          [directory, outsideDirectory].map((path) => rm(path, { recursive: true, force: true }))
        )
      }
    }
  })

  it('requires the complete ledger and rejects a failed soak inside the selected streak', async () => {
    const missingDirectory = await mkdtemp(join(tmpdir(), 'videorc-d3-ledger-missing-'))
    const failedDirectory = await mkdtemp(join(tmpdir(), 'videorc-d3-ledger-failed-'))
    try {
      const missingManifest = await writeEvidenceBundle(missingDirectory, validEvidence())
      delete missingManifest.attemptLedger
      const missingManifestPath = join(missingDirectory, 'manifest.json')
      await writeFile(missingManifestPath, canonical(missingManifest))
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath: missingManifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('attempt-ledger-invalid-manifest')
      )

      const failedManifest = await writeEvidenceBundle(failedDirectory, validEvidence(), {
        failBetweenSelectedSoaks: true
      })
      const failedManifestPath = join(failedDirectory, 'manifest.json')
      await writeFile(failedManifestPath, canonical(failedManifest))
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath: failedManifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('attempt-ledger-soak-selection-not-latest-streak')
      )

      failedManifest.attemptLedger.entries.splice(2, 1)
      failedManifest.attemptLedger.entryCount -= 1
      await writeFile(failedManifestPath, canonical(failedManifest))
      await assert.rejects(
        () =>
          loadAndValidateCaptureDecayD3Evidence({
            manifestPath: failedManifestPath,
            expectedCandidate: candidate,
            expectedPublicationDestinationBindingSha256: destinationBindingSha256,
            nowMs
          }),
        hasCode('attempt-ledger-manifest-entry-set')
      )
    } finally {
      await Promise.all(
        [missingDirectory, failedDirectory].map((directory) =>
          rm(directory, { recursive: true, force: true })
        )
      )
    }
  })
})

describe('pending -> accepted -> satisfied publication state', () => {
  it('pins acceptance to the official publisher and preconfigured destination binding', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    assert.deepEqual(accepted.validator.publication, {
      repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
      workflowPath: CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
      destinationBindingProfile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
      destinationBindingSha256
    })
    const spoofedRepository = structuredClone(accepted)
    spoofedRepository.validator.publication.repository = 'attacker/videorc'
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(spoofedRepository),
      hasCode('record-publication-contract')
    )
    const spoofedWorkflow = structuredClone(accepted)
    spoofedWorkflow.validator.publication.workflowPath = '.github/workflows/attacker.yml'
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(spoofedWorkflow),
      hasCode('record-publication-contract')
    )
    const strippedDestination = structuredClone(accepted)
    delete strippedDestination.validator.publication.destinationBindingSha256
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(strippedDestination),
      hasCode('missing-value')
    )
    assert.throws(
      () => buildCaptureDecayD3AcceptanceRecord(validate(validEvidence())),
      hasCode('missing-value')
    )
  })

  it('pins accepted publication to the candidate ancestry and acceptance-only diff', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    assert.equal(
      assertCaptureDecayD3PublicationSourceState(accepted, {
        candidateIsAncestor: true,
        changedPaths: [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH],
        publicationSourceIsAncestor: false
      }),
      accepted
    )
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationSourceState(accepted, {
          candidateIsAncestor: true,
          changedPaths: [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH, 'crates/backend/src/lib.rs'],
          publicationSourceIsAncestor: false
        }),
      hasCode('accepted-source-diff')
    )
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationSourceState(accepted, {
          candidateIsAncestor: false,
          changedPaths: [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH],
          publicationSourceIsAncestor: false
        }),
      hasCode('accepted-candidate-ancestry')
    )
  })

  it('rejects spoofed publisher, destination, reservation, and remote verification evidence', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)

    const spoofedRepository = structuredClone(receipt)
    spoofedRepository.workflow.repository = 'attacker/videorc'
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(spoofedRepository, {
          acceptedRecord: accepted
        }),
      hasCode('publication-workflow')
    )

    const strippedWorkflow = structuredClone(receipt)
    delete strippedWorkflow.workflow.path
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(strippedWorkflow, {
          acceptedRecord: accepted
        }),
      hasCode('missing-value')
    )

    const spoofedDestination = structuredClone(receipt)
    spoofedDestination.destinationBindingSha256 = '0'.repeat(64)
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(spoofedDestination, {
          acceptedRecord: accepted
        }),
      hasCode('publication-destination-binding')
    )

    const strippedReservation = structuredClone(receipt)
    delete strippedReservation.reservation.sha256
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(strippedReservation, {
          acceptedRecord: accepted
        }),
      hasCode('missing-value')
    )

    const unverifiedArtifact = structuredClone(receipt)
    unverifiedArtifact.release.artifacts[0].verification.state = 'different'
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(unverifiedArtifact, {
          acceptedRecord: accepted
        }),
      hasCode('publication-remote-verification')
    )

    const strippedRemoteEtag = structuredClone(receipt)
    delete strippedRemoteEtag.release.artifacts[0].verification.etag
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(strippedRemoteEtag, {
          acceptedRecord: accepted
        }),
      hasCode('publication-remote-etag')
    )

    const wrongRemoteContentLength = structuredClone(receipt)
    wrongRemoteContentLength.release.artifacts[0].verification.contentLength += 1
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(wrongRemoteContentLength, {
          acceptedRecord: accepted
        }),
      hasCode('publication-remote-verification')
    )

    const strippedTlsPolicy = structuredClone(receipt)
    delete strippedTlsPolicy.destinationBinding.document.destination.tlsPolicy
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(strippedTlsPolicy, {
          acceptedRecord: accepted
        }),
      hasCode('publication-destination-tls-policy')
    )

    const remappedCandidate = structuredClone(receipt)
    remappedCandidate.promotedArtifacts[0].publicationObjectKey =
      remappedCandidate.promotedArtifacts[1].publicationObjectKey
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(remappedCandidate, {
          acceptedRecord: accepted
        }),
      hasCode('publication-promotion-map')
    )

    const mixedReservation = structuredClone(receipt)
    mixedReservation.reservation.sealedCandidateManifestSha256 = '0'.repeat(64)
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(mixedReservation, {
          acceptedRecord: accepted
        }),
      hasCode('publication-reservation-sealed-candidate')
    )

    const substitutedReservationDocument = structuredClone(receipt)
    substitutedReservationDocument.reservation.document.workflow.runId = '54321'
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationReceipt(substitutedReservationDocument, {
          acceptedRecord: accepted
        }),
      hasCode('publication-reservation-workflow')
    )

    const spoofedAttestation = publicationAttestationFixture(receipt)
    spoofedAttestation.repository = 'attacker/videorc'
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: spoofedAttestation,
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('publication-attestation-policy')
    )

    const incompleteAttestation = publicationAttestationFixture(receipt)
    incompleteAttestation.subjectSha256s = incompleteAttestation.subjectSha256s.slice(1)
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: incompleteAttestation,
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('publication-attestation-subjects')
    )

    const mutatedBundle = publicationAttestationFixture(receipt)
    mutatedBundle.bundle.bodyBase64 = Buffer.from('different bundle').toString('base64')
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: mutatedBundle,
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('publication-attestation-bundle')
    )
  })

  it('adopts a stable reservation without overwriting its original creator workflow', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const originalReceipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const creatorDocument = structuredClone(originalReceipt.reservation.document)
    creatorDocument.workflow.runId = '777'
    const creatorBytes = canonical(creatorDocument)
    const creatorSha256 = sha256(creatorBytes)
    const adoptedBuild = structuredClone(publication.build)
    adoptedBuild.reservation = {
      ...adoptedBuild.reservation,
      action: 'adopted',
      document: creatorDocument,
      sha256: creatorSha256,
      sizeBytes: Buffer.byteLength(creatorBytes),
      verification: publicationVerificationFixture({
        contentType: 'application/json',
        etag: '"adopted-reservation"',
        sha256: creatorSha256,
        sizeBytes: Buffer.byteLength(creatorBytes)
      })
    }

    const adoptedReceipt = buildCaptureDecayD3PublicationReceipt(adoptedBuild)
    assert.equal(adoptedReceipt.workflow.runId, publication.build.workflow.runId)
    assert.equal(adoptedReceipt.reservation.action, 'adopted')
    assert.equal(adoptedReceipt.reservation.document.workflow.runId, '777')
    assertCaptureDecayD3PublicationReceipt(adoptedReceipt, { acceptedRecord: accepted })

    const driftedBuild = structuredClone(adoptedBuild)
    driftedBuild.reservation.document.destination.tlsPolicy.allowedSpkiSha256 = ['b'.repeat(64)]
    const driftedBytes = canonical(driftedBuild.reservation.document)
    driftedBuild.reservation.sha256 = sha256(driftedBytes)
    driftedBuild.reservation.sizeBytes = Buffer.byteLength(driftedBytes)
    driftedBuild.reservation.verification = publicationVerificationFixture({
      contentType: 'application/json',
      etag: '"drifted-reservation"',
      sha256: driftedBuild.reservation.sha256,
      sizeBytes: driftedBuild.reservation.sizeBytes
    })
    assert.throws(
      () => buildCaptureDecayD3PublicationReceipt(driftedBuild),
      hasCode('publication-reservation-document')
    )
  })

  it('assembles a creator-owned publication receipt from final upload results', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const sourceReceipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const publicationResults = publicationResultsFixture(sourceReceipt)

    const receipt = assembleCaptureDecayD3PublicationReceipt({
      acceptedRecord: accepted,
      destinationBinding: publication.build.destinationBinding,
      manifest: publication.build.manifest,
      manifestSha256: publication.build.manifestSha256,
      publicationResults,
      publicationSourceCommit: publication.build.publicationSourceCommit,
      publicationWorkflow: publication.build.workflow,
      publishedAt: sourceReceipt.publishedAt,
      sealedCandidate: publication.build.sealedCandidate,
      sealedCandidateManifest: publication.build.sealedCandidateManifest
    })

    assert.deepEqual(receipt.workflow, sourceReceipt.workflow)
    assert.deepEqual(receipt.reservation.document, sourceReceipt.reservation.document)
    assert.deepEqual(receipt.promotedArtifacts, sourceReceipt.promotedArtifacts)
    for (const result of publicationResults) {
      const evidence =
        result.phase === 'reservation'
          ? receipt.reservation
          : receipt.release.artifacts.find(
              (artifact) => artifact.objectKey === result.artifact.objectKey
            )
      assert.deepEqual(evidence.verification, result.result.verification)
      assert.deepEqual(Object.keys(evidence.verification).sort(), [
        'checksumSha256',
        'contentLength',
        'contentType',
        'etag',
        'metadataSha256',
        'sha256',
        'sizeBytes',
        'state'
      ])
    }
    assertCaptureDecayD3PublicationReceipt(receipt, { acceptedRecord: accepted })
  })

  it('assembles a resumed publication with the original reservation and current publisher', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const creatorReceipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const creatorDocument = structuredClone(creatorReceipt.reservation.document)
    creatorDocument.workflow.runId = '777'
    const creatorBytes = canonical(creatorDocument)
    const creatorSha256 = sha256(creatorBytes)
    const creatorSizeBytes = Buffer.byteLength(creatorBytes)
    const currentWorkflow = {
      ...publication.build.workflow,
      runId: '888',
      runAttempt: '2'
    }
    const publicationResults = publicationResultsFixture(creatorReceipt, {
      publicationWorkflow: currentWorkflow,
      reservationAction: 'adopted',
      reservationDocument: creatorDocument,
      reservationSha256: creatorSha256,
      reservationSizeBytes: creatorSizeBytes,
      reservationVerification: publicationVerificationFixture({
        contentType: 'application/json',
        etag: '"adopted-current"',
        sha256: creatorSha256,
        sizeBytes: creatorSizeBytes
      })
    })

    const receipt = assembleCaptureDecayD3PublicationReceipt({
      acceptedRecord: accepted,
      destinationBinding: publication.build.destinationBinding,
      manifest: publication.build.manifest,
      manifestSha256: publication.build.manifestSha256,
      publicationResults,
      publicationSourceCommit: publication.build.publicationSourceCommit,
      publicationWorkflow: currentWorkflow,
      publishedAt: creatorReceipt.publishedAt,
      sealedCandidate: publication.build.sealedCandidate,
      sealedCandidateManifest: publication.build.sealedCandidateManifest
    })

    assert.equal(receipt.workflow.runId, '888')
    assert.equal(receipt.workflow.runAttempt, '2')
    assert.equal(receipt.reservation.action, 'adopted')
    assert.equal(receipt.reservation.document.workflow.runId, '777')
    assert.equal(receipt.reservation.sha256, creatorSha256)
    assert.deepEqual(
      receipt.reservation.verification,
      publicationResults.find((entry) => entry.phase === 'reservation').result.verification
    )
    assert.deepEqual(receipt.promotedArtifacts, creatorReceipt.promotedArtifacts)
    assertCaptureDecayD3PublicationReceipt(receipt, { acceptedRecord: accepted })
  })

  it('authenticates and re-reads every current receipt route before satisfaction', async () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const config = {
      ...receipt.destinationBinding.document.destination,
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret',
      sessionToken: null
    }
    const expectedByLabel = new Map(
      receipt.release.artifacts.map((artifact) => [artifact.label, artifact])
    )
    expectedByLabel.set('d3-publication-reservation', {
      label: 'd3-publication-reservation',
      objectKey: receipt.reservation.objectKey,
      sha256: receipt.reservation.sha256,
      sizeBytes: receipt.reservation.sizeBytes,
      contentType: 'application/json'
    })
    const seen = []
    let closeCount = 0
    const verification = await verifyCaptureDecayD3PublishedReleaseRoutes(
      { config, publicationReceipt: receipt },
      {
        createTransport: () => ({
          close() {
            closeCount += 1
          }
        }),
        inspectArtifact: async ({ artifact, config: readConfig, transport }) => {
          assert.equal(readConfig, config)
          assert.ok(transport)
          seen.push(artifact.label)
          return publicationVerificationFixture({
            contentType: artifact.contentType,
            etag: `"${artifact.label}"`,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes
          })
        },
        now: () => new Date('2026-08-28T20:59:00.000Z')
      }
    )
    assert.equal(closeCount, 1)
    assert.deepEqual(
      seen,
      receipt.destinationBinding.document.uploadPlan.map((route) => route.label)
    )
    assert.deepEqual(
      verification.routes.map((route) => route.label),
      seen
    )
    for (const label of [
      'manifest',
      'latest-manifest',
      'd3-publication-reservation',
      'dmg',
      'sha256',
      'feed-manifest',
      'feed-zip',
      'feed-blockmap'
    ]) {
      assert.ok(seen.includes(label), `${label} must be re-read from public storage`)
    }

    for (const [label, state] of [
      ['latest-manifest', 'missing'],
      ['d3-publication-reservation', 'different'],
      ['feed-zip', 'different']
    ]) {
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublishedReleaseRoutes(
            { config, publicationReceipt: receipt },
            {
              createTransport: () => ({ close() {} }),
              inspectArtifact: async ({ artifact }) => {
                const expected = expectedByLabel.get(artifact.label)
                return artifact.label === label
                  ? {
                      ...publicationVerificationFixture({
                        contentType: expected.contentType,
                        etag: `"substituted-${label}"`,
                        sha256: expected.sha256,
                        sizeBytes: expected.sizeBytes
                      }),
                      state,
                      sha256: '0'.repeat(64)
                    }
                  : publicationVerificationFixture({
                      contentType: expected.contentType,
                      etag: `"${artifact.label}"`,
                      sha256: expected.sha256,
                      sizeBytes: expected.sizeBytes
                    })
              }
            }
          ),
        hasCode('publication-route-mismatch'),
        label
      )
    }

    for (const mutation of ['missing-metadata', 'wrong-content-type']) {
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublishedReleaseRoutes(
            { config, publicationReceipt: receipt },
            {
              createTransport: () => ({ close() {} }),
              inspectArtifact: async ({ artifact }) => {
                const result = publicationVerificationFixture({
                  contentType: artifact.contentType,
                  etag: `"${artifact.label}"`,
                  sha256: artifact.sha256,
                  sizeBytes: artifact.sizeBytes
                })
                if (artifact.label === 'dmg') {
                  if (mutation === 'missing-metadata') delete result.metadataSha256
                  if (mutation === 'wrong-content-type') result.contentType = 'text/html'
                }
                return result
              }
            }
          ),
        hasCode('publication-route-envelope'),
        mutation
      )
    }
  })

  it('loads satisfaction route authority only from dedicated read-only credentials', () => {
    const env = {
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_ACCESS_KEY_ID: 'read-key',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_BUCKET: 'videorc-releases',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_ENDPOINT_URL:
        'https://account.r2.cloudflarestorage.com',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_FORCE_PATH_STYLE: '1',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_REGION: 'auto',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_SECRET_ACCESS_KEY: 'read-secret',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_SESSION_TOKEN: 'read-session',
      VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_TLS_ALLOWED_ISSUER_ORGANIZATIONS:
        'Google Trust Services'
    }
    assert.deepEqual(getCaptureDecayD3PublicRouteReadS3Config(env), {
      accessKeyId: 'read-key',
      bucket: 'videorc-releases',
      endpointUrl: 'https://account.r2.cloudflarestorage.com/',
      forcePathStyle: true,
      region: 'auto',
      secretAccessKey: 'read-secret',
      sessionToken: 'read-session',
      tlsPolicy: {
        allowedIssuerOrganizations: ['Google Trust Services'],
        allowedSpkiSha256: []
      }
    })

    for (const writerName of [
      'VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID',
      'VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY',
      'VIDEORC_RELEASE_UPLOAD_S3_SESSION_TOKEN',
      'VIDEORC_DOWNLOAD_S3_ACCESS_KEY_ID',
      'VIDEORC_DOWNLOAD_S3_SECRET_ACCESS_KEY',
      'VIDEORC_DOWNLOAD_S3_SESSION_TOKEN'
    ]) {
      assert.throws(
        () => getCaptureDecayD3PublicRouteReadS3Config({ ...env, [writerName]: 'writer' }),
        hasCode('publication-route-writer-credentials'),
        writerName
      )
    }
  })

  it('derives satisfied only from the exact accepted record and verified published release', () => {
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const validated = validateCaptureDecayD3PublicationReceipt({
      ...publication.validate,
      publicationAttestation: publicationAttestationFixture(receipt),
      publicationReceipt: receipt,
      publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
    })
    const satisfied = buildSatisfiedCaptureDecayD3Record(validated, {
      satisfiedAt: '2026-08-28T21:00:00.000Z'
    })
    assert.equal(assertCaptureDecayD3AcceptanceRecord(satisfied), satisfied)
    assert.equal(satisfied.status, 'satisfied')
    assert.equal(satisfied.evidenceManifestSha256, accepted.evidenceManifestSha256)
    assert.equal(satisfied.publicationReceipt.profile, CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE)
    assert.equal(
      satisfied.publicRouteVerification.profile,
      CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE
    )
    const missingCurrentRoute = structuredClone(satisfied)
    missingCurrentRoute.publicRouteVerification.routes.pop()
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(missingCurrentRoute),
      hasCode('publication-public-route-count')
    )
    const mutatedRouteEnvelope = structuredClone(satisfied)
    mutatedRouteEnvelope.publicRouteVerification.routes[0].metadataSha256 = '0'.repeat(64)
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(mutatedRouteEnvelope),
      hasCode('publication-remote-verification')
    )
    const mutatedRouteTlsPolicy = structuredClone(satisfied)
    mutatedRouteTlsPolicy.publicRouteVerification.destination.tlsPolicy.allowedSpkiSha256 = [
      'b'.repeat(64)
    ]
    assert.throws(
      () => assertCaptureDecayD3AcceptanceRecord(mutatedRouteTlsPolicy),
      hasCode('publication-public-route-destination')
    )
    assert.equal(
      assertCaptureDecayD3PublicationSourceState(satisfied, {
        candidateIsAncestor: false,
        changedPaths: [],
        publicationSourceIsAncestor: true
      }),
      satisfied
    )
    assert.throws(
      () =>
        assertCaptureDecayD3PublicationSourceState(satisfied, {
          candidateIsAncestor: false,
          changedPaths: [],
          publicationSourceIsAncestor: false
        }),
      hasCode('satisfied-publication-ancestry')
    )
  })

  it('rejects premature/manual-looking satisfaction and wrong receipt/release/artifact chains', () => {
    assert.throws(
      () =>
        assertCaptureDecayD3AcceptanceRecord({
          schemaVersion: 2,
          profile: CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE,
          status: 'satisfied',
          satisfiedAt: '2026-08-28T21:00:00.000Z'
        }),
      hasCode('record-not-accepted')
    )

    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicRouteVerification: undefined,
          publicationAttestation: publicationAttestationFixture(receipt),
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('publication-public-route-profile')
    )
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: publicationAttestationFixture(receipt),
          acceptedRecordSha256: '0'.repeat(64),
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('publication-accepted-record-hash')
    )
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: publicationAttestationFixture(receipt),
          publishedManifest: { ...publication.validate.publishedManifest, releaseId: 'wrong' },
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('published-release-mismatch')
    )
    assert.throws(
      () =>
        validateCaptureDecayD3PublicationReceipt({
          ...publication.validate,
          publicationAttestation: publicationAttestationFixture(receipt),
          publishedArtifacts: publication.validate.publishedArtifacts.map((artifact) =>
            artifact.label === 'dmg' ? { ...artifact, sha256: 'f'.repeat(64) } : artifact
          ),
          publicationReceipt: receipt,
          publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
        }),
      hasCode('published-release-mismatch')
    )
  })

  it('permits each locked state transition exactly once', async () => {
    const pending = {
      schemaVersion: 2,
      profile: CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE,
      status: 'pending',
      blockingReason: 'real-device evidence has not been accepted'
    }
    const accepted = buildAccepted(validate(validEvidence()))
    const publication = publicationFixture(accepted)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const satisfied = buildSatisfiedCaptureDecayD3Record(
      validateCaptureDecayD3PublicationReceipt({
        ...publication.validate,
        publicationAttestation: publicationAttestationFixture(receipt),
        publicationReceipt: receipt,
        publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
      }),
      { satisfiedAt: '2026-08-28T21:00:00.000Z' }
    )

    await withAcceptanceGitRepository(pending, async ({ recordPath, repoRoot, headCommit }) => {
      await writeCaptureDecayD3AcceptanceRecord(recordPath, accepted, {
        expectedCurrentStatus: 'pending',
        expectedHeadCommit: headCommit,
        repoRoot
      })
      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), accepted)
      const acceptedHead = await commitAcceptanceRecord(repoRoot, 'accept D3 evidence')
      await assert.rejects(
        () =>
          writeCaptureDecayD3AcceptanceRecord(recordPath, accepted, {
            expectedCurrentStatus: 'pending',
            expectedHeadCommit: acceptedHead,
            repoRoot
          }),
        hasCode('invalid-pending-record')
      )

      await writeCaptureDecayD3AcceptanceRecord(recordPath, satisfied, {
        expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(accepted),
        expectedCurrentStatus: 'accepted',
        expectedHeadCommit: acceptedHead,
        repoRoot
      })
      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), satisfied)
      const satisfiedHead = await commitAcceptanceRecord(repoRoot, 'satisfy D3 acceptance')
      await assert.rejects(
        () =>
          writeCaptureDecayD3AcceptanceRecord(recordPath, satisfied, {
            expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(accepted),
            expectedCurrentStatus: 'accepted',
            expectedHeadCommit: satisfiedHead,
            repoRoot
          }),
        hasCode('record-not-accepted')
      )
      await assert.rejects(
        () =>
          writeCaptureDecayD3AcceptanceRecord(recordPath, accepted, {
            expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(satisfied),
            expectedCurrentStatus: 'accepted',
            expectedHeadCommit: satisfiedHead,
            repoRoot
          }),
        hasCode('illegal-record-transition')
      )

      await writeFile(recordPath, canonical(pending))
      await writeFile(`${recordPath}.transition.lock`, 'held\n')
      await assert.rejects(
        () =>
          writeCaptureDecayD3AcceptanceRecord(recordPath, accepted, {
            expectedCurrentStatus: 'pending',
            expectedHeadCommit: satisfiedHead,
            repoRoot
          }),
        hasCode('record-transition-locked')
      )
    })
  })

  it('rejects symlinked accepted records before parsing their target bytes', async () => {
    const accepted = buildAccepted(validate(validEvidence()))
    await withAcceptanceGitRepository(accepted, async ({ recordPath, repoRoot }) => {
      const targetPath = join(repoRoot, 'attacker-controlled-accepted.json')
      await writeFile(targetPath, canonical(accepted))
      await rm(recordPath)
      await symlink(targetPath, recordPath)

      await assert.rejects(
        readCaptureDecayD3AcceptanceRecord(recordPath, {
          repoRoot,
          requireHeadMatch: true
        }),
        hasCode('record-file-type')
      )

      await rm(recordPath)
      await mkdir(recordPath)
      await assert.rejects(
        readCaptureDecayD3AcceptanceRecord(recordPath, {
          repoRoot,
          requireHeadMatch: true
        }),
        hasCode('record-file-type')
      )
    })
  })

  it('rejects accepted bytes and executable mode that differ from the HEAD blob', async () => {
    const accepted = buildAccepted(validate(validEvidence()))
    await withAcceptanceGitRepository(
      accepted,
      async ({ recordPath, repoRoot }) => {
        await writeFile(
          recordPath,
          canonical({ ...accepted, acceptedAt: '2026-08-28T20:01:00.000Z' })
        )
        await assert.rejects(
          readCaptureDecayD3AcceptanceRecord(recordPath, {
            repoRoot,
            requireHeadMatch: true
          }),
          hasCode('record-head-bytes')
        )
      },
      { suffix: ' bytes [no-shell];' }
    )

    await withAcceptanceGitRepository(accepted, async ({ recordPath, repoRoot }) => {
      await chmod(recordPath, 0o755)
      await assert.rejects(
        readCaptureDecayD3AcceptanceRecord(recordPath, {
          repoRoot,
          requireHeadMatch: true
        }),
        hasCode('record-head-mode')
      )
    })
  })

  it('compare-and-swaps the accepted digest and rejects accepted-A to accepted-B races', async () => {
    const acceptedA = buildAccepted(validate(validEvidence()))
    const acceptedB = {
      ...structuredClone(acceptedA),
      acceptedAt: '2026-08-28T20:01:00.000Z'
    }
    assertCaptureDecayD3AcceptanceRecord(acceptedB)
    const publication = publicationFixture(acceptedA)
    const receipt = buildCaptureDecayD3PublicationReceipt(publication.build)
    const satisfied = buildSatisfiedCaptureDecayD3Record(
      validateCaptureDecayD3PublicationReceipt({
        ...publication.validate,
        publicationAttestation: publicationAttestationFixture(receipt),
        publicationReceipt: receipt,
        publicationReceiptSha256: captureDecayCanonicalJsonSha256(receipt)
      }),
      { satisfiedAt: '2026-08-28T21:00:00.000Z' }
    )

    await withAcceptanceGitRepository(acceptedA, async ({ headCommit, recordPath, repoRoot }) => {
      await assert.rejects(
        writeCaptureDecayD3AcceptanceRecord(recordPath, satisfied, {
          beforePublish: async () => {
            await writeFile(recordPath, canonical(acceptedB))
            await commitAcceptanceRecord(repoRoot, 'replace accepted A with accepted B')
          },
          expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(acceptedA),
          expectedCurrentStatus: 'accepted',
          expectedHeadCommit: headCommit,
          repoRoot
        }),
        (error) =>
          error?.code === 'record-transition-head-race' ||
          error?.code === 'record-transition-source-race'
      )
      assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), acceptedB)
    })

    await withAcceptanceGitRepository(acceptedB, async ({ headCommit, recordPath, repoRoot }) => {
      await assert.rejects(
        writeCaptureDecayD3AcceptanceRecord(recordPath, satisfied, {
          expectedCurrentRecordSha256: captureDecayCanonicalJsonSha256(acceptedA),
          expectedCurrentStatus: 'accepted',
          expectedHeadCommit: headCommit,
          repoRoot
        }),
        hasCode('record-transition-digest')
      )
    })
  })
})

async function withAcceptanceGitRepository(record, run, { suffix = '' } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), `videorc-d3-acceptance${suffix}-`))
  const recordPath = join(repoRoot, CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH)
  try {
    await mkdir(join(repoRoot, 'docs', 'acceptance'), { recursive: true })
    await writeFile(recordPath, canonical(record))
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.email', 'tests@videorc.invalid'], {
      cwd: repoRoot
    })
    await execFileAsync('git', ['config', 'user.name', 'Videorc Tests'], { cwd: repoRoot })
    const headCommit = await commitAcceptanceRecord(repoRoot, 'acceptance fixture')
    await run({ headCommit, recordPath, repoRoot })
  } finally {
    await rm(repoRoot, { force: true, recursive: true })
  }
}

async function commitAcceptanceRecord(repoRoot, message) {
  await execFileAsync('git', ['add', '--', CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH], {
    cwd: repoRoot
  })
  await execFileAsync('git', ['commit', '--quiet', '-m', message], { cwd: repoRoot })
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repoRoot
  })
  return stdout.trim()
}

function validate(evidence) {
  return validateCaptureDecayD3Evidence(validationArguments(evidence))
}

function validationArguments(evidence) {
  return {
    manifest: evidence.manifest,
    soaks: evidence.soaks,
    recovery: evidence.recovery,
    expectedCandidate: candidate,
    sealedCandidate,
    publicationDestinationBindingSha256: destinationBindingSha256,
    evidenceManifestSha256: 'f'.repeat(64),
    nowMs
  }
}

function validEvidence() {
  const soakTimes = [
    ['2026-08-27T00:00:00.000Z', '2026-08-27T04:00:05.000Z'],
    ['2026-08-27T04:01:00.000Z', '2026-08-27T08:01:05.000Z'],
    ['2026-08-27T08:02:00.000Z', '2026-08-27T12:02:05.000Z']
  ]
  const soaks = []
  let previousAttestationSha256 = null
  for (const [index, [startedAt, finishedAt]] of soakTimes.entries()) {
    const checkpoint = checkpointFixture({ finishedAt, startedAt })
    const checkpointSha256 = sha256(canonical(checkpoint))
    const attestation = buildCaptureDecayRunAttestation({
      attemptLedger: attemptLedgerBinding(`soak-${index + 1}`, String(index + 1).repeat(64)),
      candidate,
      checkpoint,
      checkpointSha256,
      checkpointSizeBytes: Buffer.byteLength(canonical(checkpoint)),
      childExit: { code: 0, signal: null },
      coordinates: {
        qualifiedSoakAttestationSha256: null,
        recoverySources: null,
        runOrdinal: index + 1,
        previousAttestationSha256
      },
      hostId,
      recovery: false,
      runner: {
        executableFilename: candidate.executableFilename,
        executableSha256: candidate.executableSha256,
        sizeBytes: candidate.executableSizeBytes,
        appBundle: candidate.appBundle
      },
      runId: `soak-${index + 1}`,
      sealedCandidateBindingSha256,
      sidecars: [{ role: 'raw-csv', ...rawCsvArtifact }],
      writtenAt: addSeconds(finishedAt, 1)
    })
    const attestationSha256 = sha256(canonical(attestation))
    soaks.push({ attestation, attestationSha256, checkpoint, checkpointSha256 })
    previousAttestationSha256 = attestationSha256
  }

  const recoveryTimes = {
    startedAt: '2026-08-27T12:03:00.000Z',
    cameraArmedAt: '2026-08-27T12:03:05.000Z',
    cameraCompletedAt: '2026-08-27T12:03:08.000Z',
    screenArmedAt: '2026-08-27T12:03:15.000Z',
    screenCompletedAt: '2026-08-27T12:03:18.000Z',
    finishedAt: '2026-08-27T12:04:05.000Z'
  }
  const recordingArtifact = { ...recoveryRecordingArtifact }
  const checkpoint = checkpointFixture({ ...recoveryTimes, recovery: true })
  const checkpointSha256 = sha256(canonical(checkpoint))
  const attestation = buildCaptureDecayRunAttestation({
    attemptLedger: attemptLedgerBinding('dual-recovery', '4'.repeat(64)),
    candidate,
    checkpoint,
    checkpointSha256,
    checkpointSizeBytes: Buffer.byteLength(canonical(checkpoint)),
    childExit: { code: 0, signal: null },
    coordinates: {
      qualifiedSoakAttestationSha256: previousAttestationSha256,
      recoverySources: [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES],
      runOrdinal: null,
      previousAttestationSha256: null
    },
    hostId,
    recordingArtifact,
    recovery: true,
    runner: debugRunner,
    runId: 'dual-recovery',
    sealedCandidateBindingSha256,
    sidecars: [
      { role: 'raw-csv', ...rawCsvArtifact },
      {
        role: 'debug-runner-provenance',
        filename: debugRunner.provenance.filename,
        relativePath: debugRunner.provenance.filename,
        sha256: debugRunner.provenance.sha256,
        sizeBytes: Buffer.byteLength(canonical(debugProvenanceDocument))
      },
      { role: 'recording', ...recordingArtifact }
    ],
    writtenAt: addSeconds(recoveryTimes.finishedAt, 1)
  })
  const attestationSha256 = sha256(canonical(attestation))
  const recovery = {
    attestation,
    attestationSha256,
    checkpoint,
    checkpointSha256,
    recordingArtifact
  }
  return {
    manifest: {
      schemaVersion: 2,
      profile: CAPTURE_DECAY_D3_EVIDENCE_PROFILE,
      candidate
    },
    soaks,
    recovery
  }
}

async function writeEvidenceBundle(
  directory,
  evidence,
  { bundleSealedCandidate = sealedCandidate, failBetweenSelectedSoaks = false } = {}
) {
  const ledgerDirectory = join(directory, 'attempt-ledger')
  const candidateCanonicalSha256 = captureDecayCanonicalJsonSha256(candidate)
  const bundleSealedCandidateBindingSha256 =
    macosD3SealedCandidateBindingSha256(bundleSealedCandidate)
  const sealReceiptText = canonicalMacosD3Json(bundleSealedCandidate.sealReceipt.document)
  await writeFile(join(directory, 'candidate-seal-receipt.json'), sealReceiptText)
  const descriptors = []
  let previousAttestationSha256 = null
  const artifacts = [...evidence.soaks, evidence.recovery]

  for (const [index, artifact] of artifacts.entries()) {
    if (index === 1 && failBetweenSelectedSoaks) {
      const failedAttempt = await startCaptureDecayAttempt({
        attemptId: 'failed-between-soak-1-and-2',
        attemptKind: 'soak',
        candidateCanonicalSha256,
        ceremonyId,
        hostId,
        ledgerDirectory,
        sealedCandidateBindingSha256: bundleSealedCandidateBindingSha256,
        startedAt: '2026-08-27T04:00:20.000Z'
      })
      await finishCaptureDecayAttempt({
        attemptId: failedAttempt.attemptId,
        attestation: null,
        bundleRoot: directory,
        candidateCanonicalSha256,
        ceremonyId,
        finishedAt: '2026-08-27T04:00:30.000Z',
        hostId,
        ledgerDirectory,
        sealedCandidateBindingSha256: bundleSealedCandidateBindingSha256,
        status: 'failed'
      })
    }

    const attemptId = artifact.attestation.runId
    const attempt = await startCaptureDecayAttempt({
      attemptId,
      attemptKind: index === 3 ? 'recovery' : 'soak',
      candidateCanonicalSha256,
      ceremonyId,
      hostId,
      ledgerDirectory,
      sealedCandidateBindingSha256: bundleSealedCandidateBindingSha256,
      startedAt: artifact.checkpoint.startedAt
    })
    artifact.attestation.sealedCandidateBindingSha256 = bundleSealedCandidateBindingSha256
    artifact.attestation.attemptLedger = attemptLedgerBinding(
      attemptId,
      attempt.ledger.openAttempt.startEntrySha256
    )

    const runDirectory = join(directory, `run-${index + 1}`)
    await mkdir(runDirectory)
    const checkpointText = canonical(artifact.checkpoint)
    const checkpointSha256 = sha256(checkpointText)
    artifact.attestation.checkpoint.sha256 = checkpointSha256
    artifact.attestation.checkpoint.sizeBytes = Buffer.byteLength(checkpointText)
    artifact.checkpointSha256 = checkpointSha256
    if (index < 3) {
      artifact.attestation.previousAttestationSha256 = previousAttestationSha256
    } else {
      artifact.attestation.previousAttestationSha256 = null
      artifact.attestation.qualifiedSoakAttestationSha256 = previousAttestationSha256
    }
    const attestationText = canonical(artifact.attestation)
    const attestationSha256 = sha256(attestationText)
    artifact.attestationSha256 = attestationSha256
    const attestationRelativePath = `run-${index + 1}/capture-decay-real-release-attestation.json`
    await writeFile(join(runDirectory, 'capture-decay-soak.json'), checkpointText)
    await writeFile(join(runDirectory, 'capture-decay-soak.csv'), rawCsvText)
    await writeFile(join(directory, attestationRelativePath), attestationText)
    if (index === 3) {
      await writeFile(
        join(runDirectory, 'capture-decay-debug-runner-provenance.json'),
        canonical(debugProvenanceDocument)
      )
      await writeFile(join(runDirectory, 'recovery.mp4'), recoveryRecordingText)
    }
    const descriptor = {
      attestation: attestationRelativePath,
      sha256: attestationSha256,
      sizeBytes: Buffer.byteLength(attestationText)
    }
    descriptors.push(descriptor)
    await finishCaptureDecayAttempt({
      attemptId,
      attestation: {
        relativePath: descriptor.attestation,
        sha256: descriptor.sha256,
        sizeBytes: descriptor.sizeBytes
      },
      bundleRoot: directory,
      candidateCanonicalSha256,
      ceremonyId,
      finishedAt: artifact.attestation.writtenAt,
      hostId,
      ledgerDirectory,
      sealedCandidateBindingSha256: bundleSealedCandidateBindingSha256,
      status: 'passed'
    })
    previousAttestationSha256 = attestationSha256
  }

  return {
    schemaVersion: 2,
    profile: CAPTURE_DECAY_D3_EVIDENCE_PROFILE,
    candidate,
    sealedCandidate: {
      sealReceipt: {
        relativePath: 'candidate-seal-receipt.json',
        sha256: sha256(sealReceiptText),
        sizeBytes: Buffer.byteLength(sealReceiptText)
      }
    },
    attemptLedger: await buildCaptureDecayAttemptLedgerManifest({
      bundleRoot: directory,
      ledgerDirectory
    }),
    soaks: descriptors.slice(0, 3),
    recovery: descriptors[3]
  }
}

function checkpointFixture({
  cameraArmedAt = null,
  cameraCompletedAt = null,
  finishedAt,
  recovery = false,
  screenArmedAt = null,
  screenCompletedAt = null,
  startedAt
}) {
  const sampleCount = recovery ? 30 : 7200
  const recoveredGeneration = 2
  const samples = Array.from({ length: sampleCount }, (_, index) => ({
    elapsedMs: (index + 1) * 2000,
    cameraCaptureCallbackFps: 30,
    cameraPublicationFps: 30,
    cameraFreshFps: 30,
    screenCaptureCallbackFps: 30,
    screenPublicationFps: 30,
    screenFreshFps: 30,
    cameraLatestSequence: index + 100,
    screenLatestSequence: index + 200,
    cameraStatusState: 'live',
    cameraStatusCameraId: cameraId,
    screenStatusState: 'live',
    screenStatusSourceId: screenId,
    compositorBackend: 'metal',
    previewSurfaceState: 'live',
    previewStatusTransport: 'native-surface',
    previewStatusBacking: 'cametal-layer',
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    captureRecoverySourceGeneration: recovery ? recoveredGeneration : 1,
    degradedStage: null
  }))
  const requiredSampleCount = Math.ceil(sampleCount * 0.95)
  const retentionPoints = Object.fromEntries(
    CAPTURE_DECAY_REQUIRED_RETENTION_POINTS.map((key) => [
      key,
      {
        evidenceSamples: sampleCount,
        liveCount: 1,
        peakCount: 2,
        ceiling: 4,
        slopePerMinute: 0,
        withinCeiling: true,
        initialLiveCount: 1,
        finalLiveCount: 1,
        maximumLiveCount: 1,
        slopeEvaluated: !recovery,
        slopeWindowMinutes: recovery ? 1 : 240
      }
    ])
  )
  const readinessPolls = Array.from({ length: 3 }, (_, index) => ({
    sampledAt: addSeconds(startedAt, -(6 - index * 2)),
    consecutiveReadyPolls: index + 1,
    failures: [],
    cameraStatus: {
      state: 'live',
      cameraId,
      requestedWidth: 3840,
      requestedHeight: 2160,
      actualWidth: 3840,
      actualHeight: 2160,
      selectedFormatWidth: 3840,
      selectedFormatHeight: 2160,
      sourceFps: 30
    },
    screenStatus: {
      state: 'live',
      sourceId: screenId,
      requestedWidth: 3840,
      requestedHeight: 2160,
      actualWidth: 3840,
      actualHeight: 2160,
      nativeWidth: 3840,
      nativeHeight: 2160,
      sourceFps: 30
    }
  }))
  const checkpoint = {
    schemaVersion: 3,
    status: 'passed',
    createdAt: startedAt,
    startedAt,
    finishedAt,
    config: {
      gate: true,
      recoveryGate: recovery,
      releaseGate: false,
      realSources: true,
      soakMinutes: recovery ? 1 : CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES,
      sampleSeconds: 2,
      realSourceFailureConsecutiveSamples: 3,
      maximumRecoveryDurationMs: 4000,
      maximumRecoveryDetectionMs: 6000,
      evidenceGates: {
        requireNativePreview: true,
        requirePresenterAdvancement: true,
        requireMetalCompositor: true,
        requireReleaseRecordingPath: false,
        minimumPreviewPresentFps: 1,
        maximumPreviewFrameAgeMs: 1000,
        maximumPreviewLatencyP95Ms: 1000,
        minimumSampleCoverage: 0.95,
        maximumSampleGapMs: 6000,
        maximumSurfaceLiveCount: 12,
        maximumSurfacePeakCount: 16,
        maximumSurfaceSlopePerMinute: 0.05,
        surfaceSlopeMinimumMinutes: recovery ? 0 : 10,
        surfaceGrowthAllowance: 2,
        minimumRealSourceRateFraction: CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION,
        maximumRealSourceAgeMs: 1000
      }
    },
    sourceSelection: {
      screenId,
      windowId: null,
      cameraId,
      microphoneId: null,
      testPattern: false
    },
    startupEvidence: {
      camera: { id: cameraId, status: 'available' },
      screen: { id: screenId, status: 'available' },
      sceneRequest: {
        sources: {
          screenId,
          windowId: null,
          cameraId,
          microphoneId: null,
          testPattern: false
        },
        video: { width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 }
      },
      sceneCommitted: {
        scene: {
          sources: [
            { kind: 'screen', deviceId: screenId, visible: true },
            { kind: 'camera', deviceId: cameraId, visible: true }
          ]
        }
      },
      sourceCadence: {
        cameraProducerFps: 30,
        cameraConsumerFps: 30,
        screenProducerFps: 30,
        screenConsumerFps: 30
      },
      motionStimulus: {
        driver: 'native-swift',
        visibility: {
          visible: true,
          reason: 'stimulus color signature present',
          totalPixels: 1_000_000,
          passingColors: ['cyan', 'magenta', 'yellow', 'red', 'green', 'blue', 'white']
        }
      },
      readinessPolls
    },
    laggedEvents: [],
    samples,
    samplesCollected: sampleCount,
    degradedSamples: 0,
    failures: [],
    cleanupFailures: [],
    artifacts: {
      csv: {
        path: '/tmp/capture-decay-soak.csv',
        sha256: rawCsvArtifact.sha256,
        sizeBytes: rawCsvArtifact.sizeBytes
      },
      checkpoint: { path: '/tmp/capture-decay-soak.json' },
      recording: recovery
        ? {
            path: '/tmp/recovery.mp4',
            sha256: recoveryRecordingArtifact.sha256,
            sizeBytes: recoveryRecordingArtifact.sizeBytes
          }
        : null
    },
    evidenceSummary: {
      expectedSampleCount: sampleCount,
      requiredSampleCount,
      samplesCollected: sampleCount,
      sampleCoverage: 1,
      maximumObservedSampleGapMs: 2000,
      degradedStageFailureSamples: 0,
      finiteNativeLatencySamples: sampleCount,
      nativeFailureSamples: 0,
      metalCompositorFailureSamples: 0,
      sourceSurfaceFailureSamples: 0,
      surfaces: {
        camera: surfaceSummary(recovery),
        screen: surfaceSummary(recovery)
      },
      retentionPoints,
      reconfigurationTimeline: [
        {
          index: 0,
          elapsedMs: 2000,
          compositorWidth: 3840,
          compositorHeight: 2160,
          compositorMetalTargetWidth: 3840,
          compositorMetalTargetHeight: 2160,
          nativePreviewDrawableWidth: 3840,
          nativePreviewDrawableHeight: 2160,
          nativePreviewIosurfaceInvalidations: 0,
          retentionPoints: Object.fromEntries(
            CAPTURE_DECAY_REQUIRED_RETENTION_POINTS.map((key) => [
              key,
              { liveCount: 1, peakCount: 2, ceiling: 4 }
            ])
          )
        }
      ]
    },
    teardownEvidence: {
      releasedSurfaceBaseline: {
        camera: { liveCount: 0 },
        screen: { liveCount: 0 }
      },
      finalSurfaceState: {
        camera: { liveCount: 0 },
        screen: { liveCount: 0 }
      },
      finalRetentionState: Object.fromEntries(
        CAPTURE_DECAY_REQUIRED_RETENTION_POINTS.map((key) => [
          key,
          { liveCount: 0, peakCount: 2, ceiling: 4 }
        ])
      ),
      failures: []
    }
  }
  if (recovery) {
    checkpoint.injectedRecoveryEvidence = dualRecoveryEvidence({
      cameraArmedAt,
      cameraCompletedAt,
      screenArmedAt,
      screenCompletedAt
    })
    checkpoint.recoveryObservations = [
      ...checkpoint.injectedRecoveryEvidence.camera.observations,
      ...checkpoint.injectedRecoveryEvidence.screen.observations
    ]
    checkpoint.injectedRecoveryEvidence.recording.artifact = {
      path: '/tmp/recovery.mp4',
      sha256: recoveryRecordingArtifact.sha256,
      sizeBytes: recoveryRecordingArtifact.sizeBytes
    }
    checkpoint.injectedRecoveryEvidence.recording.artifactBytes =
      recoveryRecordingArtifact.sizeBytes
    checkpoint.injectedRecoveryEvidence.recording.artifactSha256 = recoveryRecordingArtifact.sha256
  } else {
    checkpoint.injectedRecoveryEvidence = null
    checkpoint.recoveryObservations = []
  }
  return checkpoint
}

function surfaceSummary(recovery) {
  return {
    evidenceSamples: recovery ? 30 : 7200,
    maximumLiveCount: 2,
    maximumPeakCount: 3,
    initialLiveCount: 1,
    finalLiveCount: 1,
    slopeEvaluated: !recovery,
    liveCountSlopePerMinute: recovery ? null : 0
  }
}

function sourceRecoveryEvidence(source, armedAt, completedAt, identity) {
  const active = (phase, generation) => ({
    observedAt: armedAt,
    phase,
    source,
    trigger: 'automatic',
    sourceGeneration: generation
  })
  return {
    identity: { ...identity },
    armedAtMs: Date.parse(armedAt),
    completedAtMs: Date.parse(completedAt),
    acknowledgement: { sourceGeneration: 1 },
    terminalStatus: { phase: 'idle' },
    observations: [
      active('degraded', 1),
      active('restarting', 1),
      active('verifying', 2),
      active('recovered', 2)
    ],
    summary: {
      phases: ['degraded', 'restarting', 'verifying', 'recovered'],
      attemptsHighWater: 1,
      observedDetectionMs: 1000,
      observedRecoveryMs: 2000,
      preRestartGeneration: 1,
      verifyingGenerations: [2],
      recoveredGenerations: [2],
      cadenceRestore: {
        minimumRateFraction: 0.9,
        requiredConsecutiveSamples: 3,
        samples: Array.from({ length: 3 }, (_, index) => ({
          observedAt: addSeconds(completedAt, index),
          sourceGeneration: 2,
          captureCallbackFps: 30,
          publicationFps: 30,
          freshServeFps: 30,
          expectedProducerFps: 30,
          expectedConsumerFps: 30
        }))
      }
    }
  }
}

function dualRecoveryEvidence({
  cameraArmedAt,
  cameraCompletedAt,
  screenArmedAt,
  screenCompletedAt
}) {
  const sessionId = 'recording-session-1'
  const identity = { sessionId, appProcessId: 101, backendProcessId: 202 }
  return {
    identity: { ...identity },
    sessionId,
    appProcessId: identity.appProcessId,
    backendProcessId: identity.backendProcessId,
    sequence: [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES],
    camera: sourceRecoveryEvidence('camera', cameraArmedAt, cameraCompletedAt, identity),
    screen: sourceRecoveryEvidence('screen', screenArmedAt, screenCompletedAt, identity),
    recording: {
      identity: { ...identity },
      started: {
        sessionId,
        state: 'recording',
        observedAt: addSeconds(cameraArmedAt, -2)
      },
      observations: [
        recordingObservation(identity, 'camera', 'before', addSeconds(cameraArmedAt, -1)),
        recordingObservation(identity, 'camera', 'after', cameraCompletedAt),
        recordingObservation(identity, 'screen', 'before', addSeconds(screenArmedAt, -1)),
        recordingObservation(identity, 'screen', 'after', screenCompletedAt)
      ],
      stopped: {
        sessionId,
        state: 'stopped',
        backendState: 'idle',
        observedAt: addSeconds(screenCompletedAt, 20)
      },
      normalStop: true,
      requestedDurationMs: 60_000,
      observedDurationMs: 60_000,
      outputPath: '/tmp/recovery.mp4',
      analyzer: {
        verdict: 'passed',
        artifactDurationSeconds: 60,
        motionPass: true,
        freezePass: true,
        audioPass: true,
        avSyncPass: true,
        metrics: {
          uniqueFrameRatio: 0.5,
          longestCorroboratedFreezeMs: 100,
          maxRepeatedFrameRun: 2,
          maxAudioGapMs: 20,
          avSkewMs: 10,
          tailMismatchMs: 10
        },
        gates: {
          minUniqueFrameRatio: 0.05,
          maxFreezeMs: 1000,
          maxRepeatedFrameRun: 30,
          maxAudioGapMs: 100,
          avSyncHardFailMs: 100,
          maxTailMismatchMs: 150
        }
      }
    }
  }
}

function recordingObservation(identity, source, boundary, observedAt) {
  return { ...identity, source, boundary, state: 'recording', observedAt }
}

function buildAccepted(validation) {
  return buildCaptureDecayD3AcceptanceRecord(validation, { destinationBindingSha256 })
}

function publicationFixture(acceptedRecord) {
  const publicationSourceCommit = '9'.repeat(40)
  const releaseId = '1.0.0-beta.1'
  const dmgSha256 = '1'.repeat(64)
  const manifestSha256 = '2'.repeat(64)
  const filename = 'Videorc-1.0.0-mac-arm64.dmg'
  const sealedCandidateManifest =
    acceptedRecord.sealedCandidate.sealReceipt.document.candidateManifest
  const definitions = [
    ['dmg', filename, `releases/macos/${releaseId}/${filename}`, dmgSha256, 1234],
    [
      'sha256',
      `${filename}.sha256`,
      `releases/macos/${releaseId}/${filename}.sha256`,
      '3'.repeat(64),
      80
    ],
    ['manifest', 'release.json', `releases/macos/${releaseId}/release.json`, manifestSha256, 300],
    ['latest-manifest', 'release.json', 'releases/macos/latest/release.json', manifestSha256, 300],
    ['feed-manifest', 'latest-mac.yml', 'updates/macos/latest-mac.yml', '4'.repeat(64), 400],
    [
      'feed-zip',
      'Videorc-1.0.0-mac-arm64.zip',
      'updates/macos/Videorc-1.0.0-mac-arm64.zip',
      '5'.repeat(64),
      2000
    ],
    [
      'feed-blockmap',
      'Videorc-1.0.0-mac-arm64.zip.blockmap',
      'updates/macos/Videorc-1.0.0-mac-arm64.zip.blockmap',
      '6'.repeat(64),
      500
    ]
  ]
  const artifacts = definitions.map(
    ([label, artifactFilename, objectKey, sha256Value, sizeBytes]) => {
      const immutable = ['dmg', 'sha256', 'manifest', 'feed-zip', 'feed-blockmap'].includes(label)
      return {
        label,
        filename: artifactFilename,
        objectKey,
        sha256: sha256Value,
        sizeBytes,
        contentType: publicationContentType(label),
        immutable,
        phase: immutable ? 'immutable' : 'pointer',
        action: immutable ? 'uploaded' : 'skipped',
        verification: publicationVerificationFixture({
          contentType: publicationContentType(label),
          etag: `"${label}"`,
          sha256: sha256Value,
          sizeBytes
        })
      }
    }
  )
  const manifest = {
    releaseId,
    bundleVersion: sealedCandidateManifest.release.bundleVersion,
    filename,
    sha256: dmgSha256,
    sizeBytes: 1234
  }
  const acceptedRecordSha256 = captureDecayCanonicalJsonSha256(acceptedRecord)
  const reservationObjectKey = `releases/macos/${releaseId}/capture-decay-d3-publication-reservation.json`
  const destinationConfig = {
    bucket: 'videorc-releases',
    endpointUrl: 'https://account.r2.cloudflarestorage.com/',
    forcePathStyle: true,
    region: 'auto',
    tlsPolicy: publicationTlsPolicyFixture()
  }
  const workflow = {
    repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
    path: CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
    runId: '12345',
    runAttempt: '1',
    sha: publicationSourceCommit
  }
  const reservationSource = buildMacosD3PublicationReservation({
    acceptedRecordSha256,
    artifacts,
    config: destinationConfig,
    manifestSha256,
    prefix: `releases/macos/${releaseId}`,
    publicationSourceCommit,
    releaseId,
    sealedCandidateArtifactSetSha256: acceptedRecord.sealedCandidate.artifactSetSha256,
    sealedCandidateManifestSha256: acceptedRecord.sealedCandidate.manifest.sha256,
    workflow
  })
  const destinationBinding = buildCaptureDecayD3DestinationBinding({
    artifacts,
    config: destinationConfig,
    reservation: reservationSource
  })
  assert.equal(destinationBinding.sha256, destinationBindingSha256)
  const byLabel = new Map(artifacts.map((artifact) => [artifact.label, artifact]))
  const publicRouteVerification = {
    profile: CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE,
    verifiedAt: '2026-08-28T20:59:00.000Z',
    readProtocol: 's3-sigv4-get',
    destination: { ...destinationConfig },
    routes: destinationBinding.document.uploadPlan.map((route) => {
      const artifact =
        route.label === 'd3-publication-reservation'
          ? reservationSource.artifact
          : byLabel.get(route.label)
      return {
        label: route.label,
        objectKey: route.objectKey,
        ...publicationVerificationFixture({
          contentType: artifact.contentType,
          etag: `"current-${route.label}"`,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes
        })
      }
    })
  }
  const promotionLabels = new Map([
    ['dmg', ['dmg']],
    ['sha256', ['sha256']],
    ['manifest', ['manifest', 'latest-manifest']],
    ['feed-zip', ['feed-zip']],
    ['feed-blockmap', ['feed-blockmap']],
    ['feed-manifest', ['feed-manifest']]
  ])
  const promotedArtifacts = macosD3CandidatePublicationArtifactMapping(
    sealedCandidateManifest
  ).flatMap((sealed) =>
    promotionLabels.get(sealed.candidateLabel).map((publicationLabel) => {
      const published = byLabel.get(publicationLabel)
      return {
        candidateLabel: sealed.candidateLabel,
        candidateObjectKey: sealed.sealedObjectKey,
        publicationLabel,
        publicationObjectKey: published.objectKey,
        sha256: published.sha256,
        sizeBytes: published.sizeBytes
      }
    })
  )
  return {
    build: {
      acceptedRecord,
      acceptedRecordSha256,
      artifacts,
      destinationBinding,
      destinationBindingSha256,
      manifest,
      manifestSha256,
      promotedArtifacts,
      publicationSourceCommit,
      publishedAt: '2026-08-28T20:30:00.000Z',
      reservation: {
        profile: reservationSource.document.profile,
        objectKey: reservationSource.artifact.objectKey,
        sha256: reservationSource.artifact.sha256,
        sizeBytes: reservationSource.artifact.sizeBytes,
        immutable: true,
        phase: 'reservation',
        action: 'uploaded',
        verification: publicationVerificationFixture({
          contentType: reservationSource.artifact.contentType,
          etag: '"reservation"',
          sha256: reservationSource.artifact.sha256,
          sizeBytes: reservationSource.artifact.sizeBytes
        })
      },
      sealedCandidate: acceptedRecord.sealedCandidate,
      sealedCandidateManifest,
      workflow
    },
    validate: {
      acceptedRecord,
      acceptedRecordSha256,
      publicRouteVerification,
      publishedManifest: manifest,
      publishedArtifacts: macosD3CandidatePublicationArtifactMapping(sealedCandidateManifest).map(
        (sealed) => {
          const published = byLabel.get(sealed.candidateLabel)
          return {
            label: sealed.candidateLabel,
            filename: published.filename,
            objectKey: published.objectKey,
            sha256: published.sha256,
            sizeBytes: published.sizeBytes
          }
        }
      )
    }
  }
}

function publicationResultsFixture(
  receipt,
  {
    publicationWorkflow = receipt.workflow,
    reservationAction = receipt.reservation.action,
    reservationDocument = receipt.reservation.document,
    reservationSha256 = receipt.reservation.sha256,
    reservationSizeBytes = receipt.reservation.sizeBytes,
    reservationVerification = receipt.reservation.verification
  } = {}
) {
  const releaseResults = receipt.release.artifacts.map((artifact) => ({
    artifact: {
      label: artifact.label,
      filename: artifact.filename,
      objectKey: artifact.objectKey,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
      immutable: artifact.immutable
    },
    phase: artifact.phase,
    result: {
      action: artifact.action,
      verification: structuredClone(artifact.verification)
    }
  }))
  const reservationArtifact = {
    label: 'd3-publication-reservation',
    filename: receipt.reservation.objectKey.split('/').at(-1),
    objectKey: receipt.reservation.objectKey,
    sha256: reservationSha256,
    sizeBytes: reservationSizeBytes,
    contentType: 'application/json',
    immutable: true
  }
  const reservationResult = {
    artifact: reservationArtifact,
    phase: 'reservation',
    result: {
      action: reservationAction,
      publishedArtifact: reservationArtifact,
      publisherWorkflow: {
        repository: publicationWorkflow.repository,
        path: publicationWorkflow.path,
        runId: publicationWorkflow.runId,
        sourceCommit: publicationWorkflow.sha
      },
      reservationDocument: structuredClone(reservationDocument),
      verification: structuredClone(reservationVerification)
    }
  }
  return [
    ...releaseResults.filter((entry) => entry.phase === 'immutable'),
    reservationResult,
    ...releaseResults.filter((entry) => entry.phase === 'pointer')
  ]
}

function publicationAttestationFixture(receipt) {
  const bundle = Buffer.from('capture-decay-publication-attestation-bundle')
  const receiptSha256 = captureDecayCanonicalJsonSha256(receipt)
  return {
    profile: CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE,
    repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
    signerWorkflow: CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
    sourceDigest: receipt.publicationSourceCommit,
    receiptSha256,
    subjectSha256s: captureDecayD3PublicationAttestationSubjectSha256s(
      receipt.sealedCandidate,
      receiptSha256
    ),
    bundle: {
      filename: 'capture-decay-d3-publication-receipt.attestation.jsonl',
      sha256: sha256(bundle),
      sizeBytes: bundle.byteLength,
      bodyBase64: bundle.toString('base64')
    }
  }
}

function publicationDestinationBindingFixture() {
  const releaseId = '1.0.0-beta.1'
  const dmgFilename = 'Videorc-1.0.0-mac-arm64.dmg'
  const reservationObjectKey = `releases/macos/${releaseId}/capture-decay-d3-publication-reservation.json`
  const config = {
    bucket: 'videorc-releases',
    endpointUrl: 'https://account.r2.cloudflarestorage.com/',
    forcePathStyle: true,
    region: 'auto',
    tlsPolicy: publicationTlsPolicyFixture()
  }
  const routes = [
    ['dmg', dmgFilename, `releases/macos/${releaseId}/${dmgFilename}`],
    ['sha256', `${dmgFilename}.sha256`, `releases/macos/${releaseId}/${dmgFilename}.sha256`],
    ['manifest', 'release.json', `releases/macos/${releaseId}/release.json`],
    ['latest-manifest', 'release.json', 'releases/macos/latest/release.json'],
    ['feed-manifest', 'latest-mac.yml', 'updates/macos/latest-mac.yml'],
    ['feed-zip', 'Videorc-1.0.0-mac-arm64.zip', 'updates/macos/Videorc-1.0.0-mac-arm64.zip'],
    [
      'feed-blockmap',
      'Videorc-1.0.0-mac-arm64.zip.blockmap',
      'updates/macos/Videorc-1.0.0-mac-arm64.zip.blockmap'
    ]
  ]
  const artifacts = routes.map(([label, filename, objectKey]) => ({
    label,
    filename,
    objectKey,
    contentType: publicationContentType(label),
    immutable: ['dmg', 'sha256', 'manifest', 'feed-zip', 'feed-blockmap'].includes(label)
  }))
  return buildCaptureDecayD3DestinationBinding({
    artifacts,
    config,
    reservation: {
      artifact: {
        contentType: 'application/json',
        immutable: true,
        label: 'd3-publication-reservation',
        objectKey: reservationObjectKey
      },
      document: {
        schemaVersion: 3,
        profile: 'capture-decay-d3-publication-reservation-v3',
        destination: {
          ...config,
          releasePrefix: `releases/macos/${releaseId}`,
          reservationObjectKey
        }
      }
    }
  })
}

function sealedCandidateFixture(
  candidateIdentity,
  publicationDestinationBindingSha256,
  sealedAt = '2026-08-26T23:59:00.000Z'
) {
  const releaseId = '1.0.0-beta.1'
  const bundleVersion = '1.0.0'
  const prefix = macosD3CandidatePrefix({
    releaseId,
    sourceCommit: candidateIdentity.sourceCommit,
    dmgSha256: candidateIdentity.dmgSha256
  })
  const storageIdentity = {
    bucket: 'videorc-private-candidates',
    endpointUrl: 'https://candidate.r2.cloudflarestorage.com/',
    forcePathStyle: true,
    region: 'auto',
    tlsPolicy: {
      allowedIssuerOrganizations: ['Cloudflare, Inc.'],
      allowedSpkiSha256: []
    }
  }
  const artifactDefinitions = [
    [
      'dmg',
      candidateIdentity.dmgFilename,
      candidateIdentity.dmgSha256,
      candidateIdentity.dmgSizeBytes
    ],
    ['sha256', `${candidateIdentity.dmgFilename}.sha256`, '3'.repeat(64), 80],
    ['manifest', 'release.json', '2'.repeat(64), 300],
    ['feed-zip', 'Videorc-1.0.0-mac-arm64.zip', '5'.repeat(64), 2000],
    ['feed-blockmap', 'Videorc-1.0.0-mac-arm64.zip.blockmap', '6'.repeat(64), 500],
    ['feed-manifest', 'latest-mac.yml', '4'.repeat(64), 400]
  ]
  const contentTypes = {
    dmg: 'application/x-apple-diskimage',
    sha256: 'text/plain; charset=utf-8',
    manifest: 'application/json',
    'feed-zip': 'application/zip',
    'feed-blockmap': 'application/octet-stream',
    'feed-manifest': 'text/yaml; charset=utf-8'
  }
  const artifacts = artifactDefinitions.map(([label, filename, sha256Value, sizeBytes]) => ({
    label,
    filename,
    objectKey: `${prefix}/artifacts/${filename}`,
    contentType: contentTypes[label],
    sha256: sha256Value,
    sizeBytes
  }))
  const artifactSetSha256 = sha256MacosD3CanonicalJson(artifacts)
  const candidateManifest = {
    schemaVersion: 1,
    profile: MACOS_D3_SEALED_CANDIDATE_PROFILE,
    source: {
      commit: candidateIdentity.sourceCommit,
      tree: candidateIdentity.sourceTree
    },
    candidate: candidateIdentity,
    publicationDestinationBindingSha256,
    storage: {
      ...storageIdentity,
      prefix,
      manifestObjectKey: `${prefix}/${MACOS_D3_CANDIDATE_MANIFEST_FILENAME}`
    },
    release: {
      releaseId,
      bundleVersion,
      artifactSetSha256,
      artifacts
    }
  }
  const manifestBody = Buffer.from(canonicalMacosD3Json(candidateManifest))
  const manifest = {
    label: 'candidate-manifest',
    filename: MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
    objectKey: `${prefix}/${MACOS_D3_CANDIDATE_MANIFEST_FILENAME}`,
    contentType: 'application/json',
    sha256: sha256(manifestBody),
    sizeBytes: manifestBody.byteLength
  }
  const objects = [...artifacts, manifest].map((artifact) => ({
    ...artifact,
    action: 'uploaded',
    verification: {
      state: 'identical',
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      etag: `"${artifact.label}"`
    }
  }))
  return macosD3CandidateSealSummary({
    schemaVersion: 1,
    profile: MACOS_D3_CANDIDATE_SEAL_RECEIPT_PROFILE,
    sealedAt,
    candidate: {
      ...candidateIdentity,
      artifactSetSha256,
      releaseId,
      bundleVersion,
      publicationDestinationBindingSha256
    },
    candidateManifest,
    manifest,
    storage: storageIdentity,
    objects
  })
}

function publicationContentType(label) {
  return {
    dmg: 'application/x-apple-diskimage',
    sha256: 'text/plain; charset=utf-8',
    manifest: 'application/json',
    'latest-manifest': 'application/json',
    'feed-manifest': 'text/yaml; charset=utf-8',
    'feed-zip': 'application/zip',
    'feed-blockmap': 'application/octet-stream'
  }[label]
}

function publicationVerificationFixture({ contentType, etag, sha256: sha256Value, sizeBytes }) {
  return {
    state: 'identical',
    sha256: sha256Value,
    sizeBytes,
    etag,
    contentType,
    contentLength: sizeBytes,
    metadataSha256: sha256Value,
    checksumSha256: Buffer.from(sha256Value, 'hex').toString('base64')
  }
}

function publicationTlsPolicyFixture() {
  return {
    allowedIssuerOrganizations: ['Cloudflare, Inc.'],
    allowedSpkiSha256: ['a'.repeat(64)]
  }
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function attemptLedgerBinding(attemptId, startEntrySha256) {
  return { attemptId, ceremonyId, startEntrySha256 }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function addSeconds(timestamp, seconds) {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString()
}

function hasCode(code) {
  return (error) => error?.code === code
}
