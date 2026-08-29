import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  assertCaptureDecayAppBundleIdentityEqual,
  captureDecayAppBundleIdentityFromExecutable,
  captureDecayAppBundlePaths,
  normalizeCaptureDecayAppBundleIdentity,
  verifyCaptureDecayDmgAppBundle
} from './capture-decay-app-bundle.mjs'
import {
  loadAndValidateCaptureDecayAttemptLedger,
  validateCaptureDecayAttemptLedgerSelection
} from './capture-decay-attempt-ledger.mjs'
import { readCaptureDecayEvidenceArtifact } from './capture-decay-evidence-artifact.mjs'
import { sha256File } from './beta-release-manifest.mjs'
import {
  CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
  CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE,
  CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
  CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
  CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
  CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE
} from './capture-decay-publication-attestation.mjs'
import {
  MACOS_D3_CANDIDATE_ARTIFACT_LABELS,
  MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
  MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME,
  assertMacosD3SealedCandidateMatches,
  canonicalMacosD3Json,
  macosD3CandidatePublicationArtifactMapping,
  macosD3CandidateSealSummary,
  macosD3SealedCandidateBindingSha256,
  normalizeMacosD3CandidateSealReceipt,
  normalizeMacosD3SealedCandidateBinding,
  normalizeMacosD3SealedCandidateManifest
} from './macos-d3-sealed-candidate.mjs'

export const CAPTURE_DECAY_D3_SCHEMA_VERSION = 2
export const CAPTURE_DECAY_CHECKPOINT_SCHEMA_VERSION = 3
export const CAPTURE_DECAY_D3_EVIDENCE_PROFILE = 'capture-decay-d3-evidence-v2'
export const CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE = 'capture-decay-d3-acceptance-v2'
export const CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE =
  'capture-decay-d3-publication-receipt-v2'
export const CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE =
  'capture-decay-debug-runner-provenance-v1'
export const CAPTURE_DECAY_REAL_RELEASE_PROFILE = 'capture-decay-real-release-v2'
export const CAPTURE_DECAY_REAL_RELEASE_RECOVERY_PROFILE = 'capture-decay-real-release-recovery-v2'
export const CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES = 240
export const CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION = 0.9
export const CAPTURE_DECAY_D3_MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const CAPTURE_DECAY_D3_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000
export const CAPTURE_DECAY_D3_MAX_RECOVERY_DELAY_MS = 30 * 60 * 1_000
export const CAPTURE_DECAY_D3_MAX_ATTESTATION_DELAY_MS = 5 * 60 * 1_000
export const CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH = 'docs/acceptance/macos-capture-decay-d3.json'

const CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE =
  'capture-decay-d3-publication-reservation-v3'
const CAPTURE_DECAY_D3_EXACT_PROMOTION_MODE = 'exact-sealed-candidate'
const CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_MAX_BYTES = 4 * 1024 * 1024
const CAPTURE_DECAY_D3_MAX_PUBLIC_ROUTE_VERIFICATION_DELAY_MS = 5 * 60 * 1_000
const CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES = 8 * 1024 * 1024
const execFileAsync = promisify(execFile)

const CAPTURE_DECAY_REQUIRED_VIDEO_PROFILE = Object.freeze({
  width: 3_840,
  height: 2_160,
  fps: 30,
  bitrateKbps: 30_000
})
const CAPTURE_DECAY_DEBUG_RUNNER_BUILD_ARGUMENTS = Object.freeze([
  'scripts/build-capture-decay-debug-runner.mjs'
])

export const CAPTURE_DECAY_REQUIRED_RETENTION_POINTS = Object.freeze([
  'metalCaptureSourceImports',
  'metalTargetRingSlots',
  'encoderInflightTargetRefs',
  'nativePreviewPresenterImports'
])
export const CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES = Object.freeze(['camera', 'screen'])
export const CAPTURE_DECAY_REQUIRED_SOAK_SIDECARS = Object.freeze(['raw-csv'])
export const CAPTURE_DECAY_REQUIRED_RECOVERY_SIDECARS = Object.freeze([
  'raw-csv',
  'debug-runner-provenance',
  'recording'
])

const RELEASE_COMMON_ENV = Object.freeze({
  VIDEORC_SOAK_REAL_SOURCES: '1',
  VIDEORC_SCREEN_MOTION_VERIFY_VISIBLE: '1',
  VIDEORC_SYNTHETIC_HARD_CONTENT: '0',
  VIDEORC_SMOKE_PREVIEW_MOTION: '0',
  VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
  VIDEORC_DISABLE_AUTO_PREVIEW: '1',
  VIDEORC_METAL_COMPOSITOR: '1',
  VIDEORC_ZEROCOPY_SOURCES: '1',
  VIDEORC_CAMERA_CAPTURE_CPU_COPY: '0',
  VIDEORC_SCREEN_CAPTURE_CPU_COPY: '0',
  VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW: '1',
  VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT: '1',
  VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR: '1',
  VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS: '1',
  VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS: '1000',
  VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS: '1000',
  VIDEORC_SOAK_SAMPLE_SECONDS: '2',
  VIDEORC_SMOKE_TIMEOUT_MS: '420000',
  VIDEORC_SOAK_RPC_TIMEOUT_MS: '5000',
  VIDEORC_SOAK_SOURCE_READY_TIMEOUT_MS: '90000',
  VIDEORC_SOAK_SOURCE_READY_POLL_MS: '2000',
  VIDEORC_SOAK_SOURCE_READY_CONSECUTIVE_POLLS: '3',
  VIDEORC_SOAK_SURFACE_RELEASE_TIMEOUT_MS: '10000',
  VIDEORC_SOAK_REAL_SOURCE_FAILURE_CONSECUTIVE_SAMPLES: '3',
  VIDEORC_SOAK_MAX_RECOVERY_DURATION_MS: '4000',
  VIDEORC_SOAK_MAX_RECOVERY_DETECTION_MS: '6000',
  VIDEORC_SOAK_MIN_SAMPLE_COVERAGE: '0.95',
  VIDEORC_SOAK_MAX_SAMPLE_GAP_MS: '6000',
  VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT: '12',
  VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT: '16',
  VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE: '0.05',
  VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES: '10',
  VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE: '2',
  VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION: String(CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION),
  VIDEORC_SOAK_MAX_REAL_SOURCE_AGE_MS: '1000',
  VIDEORC_SOAK_WIDTH: '3840',
  VIDEORC_SOAK_HEIGHT: '2160',
  VIDEORC_SOAK_FPS: '30',
  VIDEORC_SOAK_BITRATE_KBPS: '30000'
})

export const CAPTURE_DECAY_REAL_RELEASE_ENV = Object.freeze({
  ...RELEASE_COMMON_ENV,
  VIDEORC_SOAK_DEBUG_APP_EXECUTABLE: '',
  VIDEORC_SOAK_MINUTES: String(CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES)
})

export const CAPTURE_DECAY_REAL_RELEASE_RECOVERY_ENV = Object.freeze({
  ...RELEASE_COMMON_ENV,
  VIDEORC_SOAK_MINUTES: '1',
  VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES: '0'
})

export class CaptureDecayReleaseAcceptanceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CaptureDecayReleaseAcceptanceError'
    this.code = code
  }
}

export function lockedCaptureDecayRealReleaseEnvironment(env = {}, { recovery = false } = {}) {
  const locked = recovery ? CAPTURE_DECAY_REAL_RELEASE_RECOVERY_ENV : CAPTURE_DECAY_REAL_RELEASE_ENV
  const conflicts = []
  for (const [name, value] of Object.entries(locked)) {
    if (Object.hasOwn(env, name) && String(env[name] ?? '') !== value) {
      conflicts.push(`${name}=${JSON.stringify(env[name])} (required ${JSON.stringify(value)})`)
    }
  }
  if (conflicts.length > 0) {
    throw acceptanceError(
      'locked-profile-override',
      `Capture-decay real-release evidence rejects locked-profile overrides: ${conflicts.join('; ')}`
    )
  }
  return { ...env, ...locked }
}

export async function captureDecayCandidateIdentityFromFiles(
  { sourceCommit, sourceTree, candidateExecutablePath, candidateDmgPath },
  dependencies = {}
) {
  const executablePath = requiredText(candidateExecutablePath, 'candidate executable')
  const dmgPath = requiredText(candidateDmgPath, 'candidate DMG')
  const [executableStat, dmgStat, appBundle] = await Promise.all([
    lstat(executablePath),
    lstat(dmgPath),
    captureDecayAppBundleIdentityFromExecutable(executablePath)
  ])
  if (!executableStat.isFile() || !dmgStat.isFile()) {
    throw acceptanceError('candidate-artifact', 'Candidate executable and DMG must be files.')
  }
  const [executableSha256, dmgSha256] = await Promise.all([
    sha256File(executablePath),
    sha256File(dmgPath)
  ])
  await verifyCaptureDecayDmgAppBundle({ dmgPath, expectedIdentity: appBundle }, dependencies)
  if ((await sha256File(dmgPath)) !== dmgSha256) {
    throw acceptanceError(
      'candidate-dmg-mutated',
      'Candidate DMG changed while its mounted app bundle was being verified.'
    )
  }
  try {
    assertCaptureDecayAppBundleIdentityEqual(
      appBundle,
      await captureDecayAppBundleIdentityFromExecutable(executablePath),
      'candidate app bundle after DMG verification'
    )
  } catch (cause) {
    const error = acceptanceError(
      'candidate-app-bundle-mutated',
      'Candidate app bundle changed while its DMG identity was being verified.'
    )
    error.cause = cause
    throw error
  }
  if ((await sha256File(executablePath)) !== executableSha256) {
    throw acceptanceError(
      'candidate-executable-mutated',
      'Candidate executable changed while its app-bundle/DMG identity was being verified.'
    )
  }
  const candidate = assertCandidateIdentity({
    sourceCommit,
    sourceTree,
    executableSha256,
    executableSizeBytes: executableStat.size,
    dmgSha256,
    dmgSizeBytes: dmgStat.size,
    executableFilename: basename(candidateExecutablePath),
    dmgFilename: basename(candidateDmgPath),
    appBundle
  })
  return candidate
}

export function captureDecayBoundCandidateExecutablePath(candidateExecutablePath, candidate) {
  const normalizedCandidate = assertCandidateIdentity(candidate)
  const paths = captureDecayAppBundlePaths(candidateExecutablePath, 'candidate executable')
  if (
    basename(paths.bundlePath) !== normalizedCandidate.appBundle.bundleFilename ||
    paths.executableRelativePath !== normalizedCandidate.appBundle.executableRelativePath
  ) {
    throw acceptanceError(
      'candidate-launch-path',
      'Packaged D3 soak must launch the exact executable bound into the candidate app bundle.'
    )
  }
  return paths.executablePath
}

export async function captureDecayRunnerIdentity(
  runnerExecutablePath,
  { requireDebugBackend = false } = {}
) {
  const executablePath = requiredText(runnerExecutablePath, 'runner executable')
  const [executableStat, appBundle] = await Promise.all([
    lstat(executablePath),
    captureDecayAppBundleIdentityFromExecutable(executablePath)
  ])
  if (!executableStat.isFile() || executableStat.size <= 0) {
    throw acceptanceError('runner-executable', 'Runner executable must be a non-empty file.')
  }
  const identity = {
    executableFilename: basename(executablePath),
    executableSha256: await sha256File(executablePath),
    sizeBytes: executableStat.size,
    appBundle
  }
  if (requireDebugBackend) {
    const backendPath = resolve(dirname(executablePath), '..', 'Resources', 'videorc-backend')
    const backendStat = await lstat(backendPath)
    if (!backendStat.isFile() || backendStat.size <= 0) {
      throw acceptanceError(
        'runner-debug-backend',
        'Debug recovery runner must embed a non-empty Contents/Resources/videorc-backend.'
      )
    }
    identity.backend = {
      filename: 'videorc-backend',
      sha256: await sha256File(backendPath),
      sizeBytes: backendStat.size
    }
  }
  return identity
}

export function assertCaptureDecayCandidateIdentityUnchanged(before, after) {
  assertSameCandidate(before, after, 'post-run candidate identity')
  return assertCandidateIdentity(after)
}

export function assertCaptureDecayRunnerIdentityUnchanged(
  before,
  after,
  { requireDebugBackend = false } = {}
) {
  const expected = normalizeRunnerArtifactIdentity(before, 'pre-run runner', {
    requireDebugBackend
  })
  const actual = normalizeRunnerArtifactIdentity(after, 'post-run runner', {
    requireDebugBackend
  })
  for (const field of ['executableFilename', 'executableSha256', 'sizeBytes']) {
    if (actual[field] !== expected[field]) {
      throw acceptanceError(
        'runner-artifact-mutated',
        `Runner ${field} changed while capture-decay evidence was running.`
      )
    }
  }
  assertCaptureDecayAppBundleIdentityEqual(
    expected.appBundle,
    actual.appBundle,
    'post-run runner app bundle'
  )
  if (requireDebugBackend && JSON.stringify(actual.backend) !== JSON.stringify(expected.backend)) {
    throw acceptanceError(
      'runner-artifact-mutated',
      'Debug runner backend changed while capture-decay evidence was running.'
    )
  }
  return actual
}

export function buildCaptureDecayDebugRunnerProvenance({
  build,
  candidate,
  runner,
  sourceAfter,
  sourceBefore
}) {
  const normalizedCandidate = assertCandidateIdentity(candidate)
  const normalizedRunner = normalizeRunnerExecutable(runner, 'debug runner')
  const normalizedAppBundle = normalizeRunnerAppBundle(runner, normalizedRunner, 'debug runner')
  const normalizedBackend = normalizeFileIdentity(runner?.backend, 'debug runner backend')
  const before = normalizeBuildSourceSnapshot(sourceBefore, 'debug build source before')
  const after = normalizeBuildSourceSnapshot(sourceAfter, 'debug build source after')
  assertSameBuildSource(before, after)
  if (
    before.sourceCommit !== normalizedCandidate.sourceCommit ||
    before.sourceTree !== normalizedCandidate.sourceTree
  ) {
    throw acceptanceError(
      'runner-build-source',
      'Debug runner build did not start and finish at the exact candidate commit/tree.'
    )
  }
  const normalizedBuild = normalizeExecutedBuild(build)
  return normalizeRunnerProvenanceDocument({
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE,
    candidate: normalizedCandidate,
    sourceBefore: before,
    sourceAfter: after,
    build: normalizedBuild,
    executable: {
      filename: normalizedRunner.executableFilename,
      sha256: normalizedRunner.executableSha256,
      sizeBytes: normalizedRunner.sizeBytes
    },
    appBundle: normalizedAppBundle,
    backend: normalizedBackend
  })
}

export function assertCaptureDecayDebugRunnerProvenance(document, { candidate, runner }) {
  const normalized = normalizeRunnerProvenanceDocument(document)
  assertSameCandidate(candidate, normalized.candidate, 'debug runner provenance candidate')
  const normalizedRunner = normalizeRunnerExecutable(runner, 'debug runner')
  const normalizedAppBundle = normalizeRunnerAppBundle(runner, normalizedRunner, 'debug runner')
  const normalizedBackend = normalizeFileIdentity(runner?.backend, 'debug runner backend')
  if (
    normalized.executable.filename !== normalizedRunner.executableFilename ||
    normalized.executable.sha256 !== normalizedRunner.executableSha256 ||
    normalized.executable.sizeBytes !== normalizedRunner.sizeBytes ||
    JSON.stringify(normalized.appBundle) !== JSON.stringify(normalizedAppBundle) ||
    JSON.stringify(normalized.backend) !== JSON.stringify(normalizedBackend)
  ) {
    throw acceptanceError(
      'runner-provenance-executable',
      'Debug runner executable bytes/size/name do not match the executed build provenance.'
    )
  }
  return normalized
}

export function captureDecayRunCoordinates(env = {}, { recovery = false } = {}) {
  if (recovery) {
    return {
      qualifiedSoakAttestationSha256: requireSha256(
        env.VIDEORC_CAPTURE_DECAY_QUALIFIED_SOAK_ATTESTATION_SHA256,
        'VIDEORC_CAPTURE_DECAY_QUALIFIED_SOAK_ATTESTATION_SHA256'
      ),
      recoverySources: [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES],
      runOrdinal: null,
      previousAttestationSha256: null
    }
  }

  const runOrdinal = Number(env.VIDEORC_CAPTURE_DECAY_RUN_ORDINAL)
  if (!Number.isSafeInteger(runOrdinal) || runOrdinal < 1 || runOrdinal > 3) {
    throw acceptanceError(
      'invalid-run-ordinal',
      'VIDEORC_CAPTURE_DECAY_RUN_ORDINAL must be exactly 1, 2, or 3.'
    )
  }
  const previous = nonEmpty(env.VIDEORC_CAPTURE_DECAY_PREVIOUS_ATTESTATION_SHA256)
  if (runOrdinal === 1 && previous !== null) {
    throw acceptanceError(
      'unexpected-previous-attestation',
      'The first D3 soak must not name a previous attestation SHA-256.'
    )
  }
  if (runOrdinal > 1 && previous === null) {
    throw acceptanceError(
      'missing-previous-attestation',
      `D3 soak ${runOrdinal} must name the preceding attestation SHA-256.`
    )
  }
  return {
    qualifiedSoakAttestationSha256: null,
    recoverySources: null,
    runOrdinal,
    previousAttestationSha256:
      previous === null ? null : requireSha256(previous, 'previous attestation SHA-256')
  }
}

export function assertCaptureDecayRunChildExit(childExit) {
  if (childExit?.code !== 0 || childExit?.signal !== null) {
    throw acceptanceError(
      'run-child-exit',
      `Capture-decay evidence child did not exit successfully (code ${childExit?.code ?? 'missing'}, signal ${childExit?.signal ?? 'none'}).`
    )
  }
  return { code: 0, signal: null }
}

export function buildCaptureDecayRunAttestation({
  attemptLedger,
  candidate,
  checkpoint,
  checkpointSha256,
  checkpointSizeBytes,
  childExit,
  coordinates,
  hostId,
  recordingArtifact = null,
  recovery = false,
  runner,
  runId = randomUUID(),
  sealedCandidateBindingSha256,
  sidecars,
  writtenAt = new Date().toISOString()
}) {
  const normalizedCandidate = assertCandidateIdentity(candidate)
  requireSha256(checkpointSha256, 'checkpoint SHA-256')
  const sizingEvidence = structuredClone(extractCaptureSizingEvidence(checkpoint))
  return {
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: recovery
      ? CAPTURE_DECAY_REAL_RELEASE_RECOVERY_PROFILE
      : CAPTURE_DECAY_REAL_RELEASE_PROFILE,
    kind: recovery ? 'recovery' : 'soak',
    runId: requiredText(runId, 'run id'),
    attemptLedger: normalizeRunAttemptLedgerBinding(attemptLedger, runId),
    sealedCandidateBindingSha256: requireSha256(
      sealedCandidateBindingSha256,
      'sealed candidate binding SHA-256'
    ),
    runOrdinal: recovery ? null : coordinates.runOrdinal,
    recoverySources: recovery ? [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES] : null,
    previousAttestationSha256: coordinates.previousAttestationSha256,
    qualifiedSoakAttestationSha256: recovery ? coordinates.qualifiedSoakAttestationSha256 : null,
    writtenAt,
    childExit: assertCaptureDecayRunChildExit(childExit),
    captureIdentity: captureIdentityFromCheckpoint(checkpoint, hostId),
    candidate: normalizedCandidate,
    runner: normalizeRunnerIdentity(runner, { candidate: normalizedCandidate, recovery }),
    checkpoint: {
      filename: 'capture-decay-soak.json',
      sha256: checkpointSha256,
      sizeBytes: positiveFileSize(checkpointSizeBytes, 'checkpoint size'),
      status: checkpoint?.status ?? null,
      startedAt: checkpoint?.startedAt ?? null,
      finishedAt: checkpoint?.finishedAt ?? null
    },
    recordingArtifact: recovery
      ? normalizeRunRecordingArtifact(recordingArtifact, 'recovery recording artifact')
      : null,
    sidecars: normalizeRunSidecars(sidecars, {
      recordingArtifact,
      recovery,
      runner
    }),
    sizingEvidence
  }
}

export function extractCaptureSizingEvidence(checkpoint) {
  const readiness = checkpoint?.startupEvidence?.readinessPolls ?? []
  const readinessTimeline = readiness.map((poll) => ({
    sampledAt: poll?.sampledAt ?? null,
    camera: sourceDimensions(poll?.cameraStatus, 'camera'),
    screen: sourceDimensions(poll?.screenStatus, 'screen')
  }))
  const sampleTimeline = []
  let previousSignature = null
  for (const sample of Array.isArray(checkpoint?.samples) ? checkpoint.samples : []) {
    const entry = {
      elapsedMs: finiteOrNull(sample?.elapsedMs),
      camera: flattenedSampleDimensions(sample, 'camera'),
      screen: flattenedSampleDimensions(sample, 'screen'),
      recovery: {
        phase: sample?.captureRecoveryPhase ?? null,
        source: sample?.captureRecoverySource ?? null,
        sourceGeneration: finiteOrNull(sample?.captureRecoverySourceGeneration)
      }
    }
    const signature = JSON.stringify({
      camera: entry.camera,
      screen: entry.screen,
      recovery: entry.recovery
    })
    if (signature !== previousSignature) {
      sampleTimeline.push(entry)
      previousSignature = signature
    }
  }
  const recoveryGenerations = (checkpoint?.recoveryObservations ?? []).map((observation) => ({
    observedAt: observation?.observedAt ?? null,
    phase: observation?.phase ?? null,
    source: observation?.source ?? null,
    sourceGeneration: finiteOrNull(observation?.sourceGeneration)
  }))
  const retentionReconfigurationTimeline = Array.isArray(
    checkpoint?.evidenceSummary?.reconfigurationTimeline
  )
    ? checkpoint.evidenceSummary.reconfigurationTimeline
    : []
  return {
    readinessTimeline,
    sampleTimeline,
    recoveryGenerations,
    retentionReconfigurationTimeline
  }
}

export function validateCaptureDecayD3Evidence({
  manifest,
  soaks,
  recovery,
  expectedCandidate,
  sealedCandidate,
  publicationDestinationBindingSha256,
  evidenceManifestSha256,
  nowMs = Date.now(),
  maximumEvidenceAgeMs = CAPTURE_DECAY_D3_MAX_EVIDENCE_AGE_MS
}) {
  if (manifest?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION) {
    throw acceptanceError('manifest-schema', 'D3 evidence manifest schemaVersion must be 2.')
  }
  if (manifest?.profile !== CAPTURE_DECAY_D3_EVIDENCE_PROFILE) {
    throw acceptanceError(
      'manifest-profile',
      `D3 evidence manifest profile must be ${CAPTURE_DECAY_D3_EVIDENCE_PROFILE}.`
    )
  }
  const candidate = assertCandidateIdentity(manifest?.candidate)
  assertSameCandidate(candidate, expectedCandidate, 'expected release candidate')
  const normalizedSealedCandidate = assertMacosD3SealedCandidateMatches({
    candidate,
    publicationDestinationBindingSha256,
    sealedCandidate
  })
  const sealedCandidateBindingSha256 =
    macosD3SealedCandidateBindingSha256(normalizedSealedCandidate)
  requireSha256(evidenceManifestSha256, 'evidence manifest SHA-256')
  if (!Array.isArray(soaks) || soaks.length !== 3) {
    throw acceptanceError('soak-count', 'D3 acceptance requires exactly three real-source soaks.')
  }

  const runIds = new Set()
  const attestationDigests = new Set()
  const checkpointDigests = new Set()
  const validatedSoaks = []
  let previousFinishedAtMs = null
  let previousAttestationSha256 = null
  let captureIdentity = null

  for (const [index, artifact] of soaks.entries()) {
    const ordinal = index + 1
    const attestationSha256 = requireSha256(
      artifact?.attestationSha256,
      `soak ${ordinal} attestation SHA-256`
    )
    const checkpointSha256 = requireSha256(
      artifact?.checkpointSha256,
      `soak ${ordinal} checkpoint SHA-256`
    )
    rejectDuplicate(attestationDigests, attestationSha256, 'duplicate-attestation', 'attestation')
    rejectDuplicate(checkpointDigests, checkpointSha256, 'duplicate-checkpoint', 'checkpoint')
    const attestation = artifact?.attestation
    assertAttestationCommon({
      attestation,
      attestationSha256,
      candidate,
      checkpoint: artifact?.checkpoint,
      checkpointSha256,
      expectedKind: 'soak',
      expectedProfile: CAPTURE_DECAY_REAL_RELEASE_PROFILE,
      nowMs,
      maximumEvidenceAgeMs,
      runIds,
      sealedCandidateBindingSha256
    })
    captureIdentity = assertSameCaptureIdentity(
      captureIdentity,
      attestation.captureIdentity,
      `D3 soak ${ordinal}`
    )
    if (attestation.runOrdinal !== ordinal) {
      throw acceptanceError(
        'run-order',
        `D3 soak ${ordinal} attestation declares runOrdinal=${attestation.runOrdinal ?? 'missing'}.`
      )
    }
    if (attestation.previousAttestationSha256 !== previousAttestationSha256) {
      throw acceptanceError(
        'run-chain',
        `D3 soak ${ordinal} does not chain to the preceding attestation SHA-256.`
      )
    }
    if (
      attestation.runner.executableSha256 !== candidate.executableSha256 ||
      attestation.runner.sizeBytes !== candidate.executableSizeBytes
    ) {
      throw acceptanceError(
        'soak-runner-identity',
        `D3 soak ${ordinal} did not run the accepted candidate executable.`
      )
    }

    const checkpoint = artifact.checkpoint
    const timing = assertPassedCheckpoint(checkpoint, {
      expectedMinutes: CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES,
      expectedRecovery: false,
      label: `D3 soak ${ordinal}`,
      maximumEvidenceAgeMs,
      nowMs
    })
    if (previousFinishedAtMs !== null && timing.startedAtMs < previousFinishedAtMs) {
      throw acceptanceError(
        'overlapping-soaks',
        `D3 soak ${ordinal} started before soak ${ordinal - 1} finished.`
      )
    }
    assertFourK30(checkpoint, `D3 soak ${ordinal}`)
    const cadence = assertNearTargetCadence(checkpoint, `D3 soak ${ordinal}`)
    const retention = assertRetentionEvidence(checkpoint, `D3 soak ${ordinal}`, {
      requireSlope: true
    })
    assertSizingEvidence(attestation.sizingEvidence, `D3 soak ${ordinal}`)
    validatedSoaks.push({
      runId: attestation.runId,
      runOrdinal: ordinal,
      startedAt: checkpoint.startedAt,
      finishedAt: checkpoint.finishedAt,
      durationMs: timing.durationMs,
      attestationSha256,
      checkpointSha256,
      previousAttestationSha256,
      minimumRateFraction: cadence.minimumRateFraction,
      retention
    })
    previousFinishedAtMs = timing.finishedAtMs
    previousAttestationSha256 = attestationSha256
  }

  const label = 'D3 camera+screen recovery recording'
  const recoveryAttestationSha256 = requireSha256(
    recovery?.attestationSha256,
    'recovery attestation SHA-256'
  )
  const recoveryCheckpointSha256 = requireSha256(
    recovery?.checkpointSha256,
    'recovery checkpoint SHA-256'
  )
  rejectDuplicate(
    attestationDigests,
    recoveryAttestationSha256,
    'duplicate-attestation',
    'attestation'
  )
  rejectDuplicate(checkpointDigests, recoveryCheckpointSha256, 'duplicate-checkpoint', 'checkpoint')
  assertAttestationCommon({
    attestation: recovery?.attestation,
    attestationSha256: recoveryAttestationSha256,
    candidate,
    checkpoint: recovery?.checkpoint,
    checkpointSha256: recoveryCheckpointSha256,
    expectedKind: 'recovery',
    expectedProfile: CAPTURE_DECAY_REAL_RELEASE_RECOVERY_PROFILE,
    nowMs,
    maximumEvidenceAgeMs,
    runIds,
    sealedCandidateBindingSha256
  })
  captureIdentity = assertSameCaptureIdentity(
    captureIdentity,
    recovery.attestation.captureIdentity,
    label
  )
  if (
    !sameStrings(recovery.attestation.recoverySources, CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES) ||
    recovery.attestation.qualifiedSoakAttestationSha256 !== previousAttestationSha256 ||
    recovery.attestation.previousAttestationSha256 !== null
  ) {
    throw acceptanceError(
      'recovery-chain',
      'Dual recovery does not bind its camera->screen sequence to the third D3 soak.'
    )
  }
  const recordingArtifact = assertRunRecordingArtifact(
    recovery.recordingArtifact,
    recovery.attestation.recordingArtifact,
    'D3 recovery recording'
  )
  const recoveryTiming = assertPassedCheckpoint(recovery.checkpoint, {
    expectedMinutes: 1,
    expectedRecovery: true,
    label,
    maximumEvidenceAgeMs,
    nowMs
  })
  const recoveryArmedAtMs = recovery.checkpoint?.injectedRecoveryEvidence?.camera?.armedAtMs
  if (!nonNegativeFinite(recoveryArmedAtMs)) {
    throw acceptanceError(
      'recovery-order',
      'Dual recovery camera evidence must include a finite armedAtMs.'
    )
  }
  if (
    recoveryArmedAtMs < previousFinishedAtMs ||
    recoveryArmedAtMs - previousFinishedAtMs > CAPTURE_DECAY_D3_MAX_RECOVERY_DELAY_MS ||
    recoveryTiming.startedAtMs < previousFinishedAtMs ||
    recoveryTiming.startedAtMs > recoveryArmedAtMs
  ) {
    throw acceptanceError(
      'recovery-order',
      'Dual recovery must begin after, and within 30 minutes of, the third D3 soak.'
    )
  }
  assertFourK30(recovery.checkpoint, label)
  assertNearTargetCadence(recovery.checkpoint, label)
  const recoveryRetention = assertRetentionEvidence(recovery.checkpoint, label, {
    requireSlope: false
  })
  const recoverySummary = assertBoundedDualRecoveryEvidence(recovery.checkpoint, recordingArtifact)
  assertSizingEvidence(recovery.attestation.sizingEvidence, label)

  return {
    accepted: true,
    candidate,
    sealedCandidate: normalizedSealedCandidate,
    sealedCandidateBindingSha256,
    evidenceManifestSha256,
    maximumEvidenceAgeMs,
    validatedAt: new Date(nowMs).toISOString(),
    soaks: validatedSoaks,
    captureIdentity,
    recovery: {
      runId: recovery.attestation.runId,
      startedAt: recovery.checkpoint.startedAt,
      finishedAt: recovery.checkpoint.finishedAt,
      attestationSha256: recoveryAttestationSha256,
      checkpointSha256: recoveryCheckpointSha256,
      qualifiedSoakAttestationSha256: previousAttestationSha256,
      runner: recovery.attestation.runner,
      recordingArtifact,
      retention: recoveryRetention,
      ...recoverySummary
    }
  }
}

export function buildCaptureDecayD3AcceptanceRecord(
  validation,
  { acceptedAt = validation?.validatedAt, destinationBindingSha256 } = {}
) {
  if (validation?.accepted !== true) {
    throw acceptanceError(
      'unvalidated-evidence',
      'Cannot build a D3 record from unvalidated evidence.'
    )
  }
  const acceptedDestinationBindingSha256 = requireSha256(
    destinationBindingSha256,
    'accepted publication destination binding SHA-256'
  )
  const sealedCandidate = assertMacosD3SealedCandidateMatches({
    candidate: validation.candidate,
    publicationDestinationBindingSha256: acceptedDestinationBindingSha256,
    sealedCandidate: validation.sealedCandidate
  })
  const record = {
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE,
    status: 'accepted',
    acceptedAt: requiredIsoTimestamp(acceptedAt, 'acceptedAt'),
    candidate: { ...validation.candidate },
    sealedCandidate,
    evidenceManifestSha256: validation.evidenceManifestSha256,
    validator: {
      evidenceProfile: CAPTURE_DECAY_D3_EVIDENCE_PROFILE,
      validatedAt: validation.validatedAt,
      maximumEvidenceAgeMs: validation.maximumEvidenceAgeMs,
      requiredSoakCount: 3,
      requiredSoakMinutes: CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES,
      minimumRateFraction: CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION,
      requiredVideoProfile: { ...CAPTURE_DECAY_REQUIRED_VIDEO_PROFILE },
      requiredRetentionPoints: [...CAPTURE_DECAY_REQUIRED_RETENTION_POINTS],
      requiredRecoverySources: [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES],
      publication: {
        repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
        workflowPath: CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
        destinationBindingProfile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
        destinationBindingSha256: requireSha256(
          acceptedDestinationBindingSha256,
          'accepted publication destination binding SHA-256'
        )
      }
    },
    captureIdentity: validation.captureIdentity,
    soaks: validation.soaks,
    recovery: validation.recovery
  }
  assertCaptureDecayD3AcceptanceRecord(record)
  return record
}

export function buildCaptureDecayD3PublicationReceipt({
  acceptedRecord,
  acceptedRecordSha256,
  artifacts,
  destinationBinding,
  destinationBindingSha256,
  manifest,
  manifestSha256,
  promotedArtifacts,
  publicationSourceCommit,
  publishedAt = new Date().toISOString(),
  reservation,
  sealedCandidate,
  sealedCandidateManifest,
  workflow
}) {
  const accepted = assertAcceptedRecord(acceptedRecord)
  const acceptedDigest = requireSha256(acceptedRecordSha256, 'accepted-record SHA-256')
  if (sha256Json(accepted) !== acceptedDigest) {
    throw acceptanceError(
      'publication-accepted-record-hash',
      'Publication receipt does not bind the canonical accepted D3 record.'
    )
  }
  const normalizedArtifacts = normalizePublicationArtifacts(artifacts)
  const promotion = normalizeExactCandidatePromotion({
    acceptedRecord: accepted,
    artifacts: normalizedArtifacts,
    promotedArtifacts,
    sealedCandidate,
    sealedCandidateManifest
  })
  const dmgArtifact = normalizedArtifacts.find((artifact) => artifact.label === 'dmg')
  const manifestArtifact = normalizedArtifacts.find((artifact) => artifact.label === 'manifest')
  if (!dmgArtifact || !manifestArtifact) {
    throw acceptanceError(
      'publication-artifacts',
      'Publication receipt requires the verified DMG and release manifest artifacts.'
    )
  }
  const releaseId = requiredText(manifest?.releaseId, 'published release id')
  const filename = requiredText(manifest?.filename, 'published DMG filename')
  const dmgSha256 = requireSha256(manifest?.sha256, 'published DMG SHA-256')
  if (
    dmgArtifact.filename !== filename ||
    dmgArtifact.sha256 !== dmgSha256 ||
    manifestArtifact.sha256 !== requireSha256(manifestSha256, 'published manifest SHA-256') ||
    releaseId !== promotion.sealedCandidateManifest.release.releaseId ||
    filename !== accepted.candidate.dmgFilename ||
    dmgSha256 !== accepted.candidate.dmgSha256 ||
    manifest?.sizeBytes !== accepted.candidate.dmgSizeBytes
  ) {
    throw acceptanceError(
      'publication-artifact-mismatch',
      'Published manifest and verified upload artifacts do not identify the same release.'
    )
  }
  const sourceCommit = requireCommit(publicationSourceCommit, 'publication source commit')
  const workflowIdentity = normalizePublicationWorkflow(workflow)
  if (workflowIdentity.sha !== sourceCommit) {
    throw acceptanceError(
      'publication-workflow-sha',
      'Publication workflow SHA must equal the gated publication source commit.'
    )
  }
  const acceptedPublication = normalizeAcceptedPublicationContract(accepted?.validator?.publication)
  const reservationEvidence = normalizePublicationReservation(
    {
      ...reservation,
      sealedCandidateArtifactSetSha256: promotion.sealedCandidate.artifactSetSha256,
      sealedCandidateManifestSha256: promotion.sealedCandidate.manifest.sha256
    },
    { sealedCandidate: promotion.sealedCandidate }
  )
  const normalizedDestinationBinding = normalizePublicationDestinationBinding(destinationBinding, {
    artifacts: normalizedArtifacts,
    reservation: reservationEvidence
  })
  const destinationDigest = requireSha256(
    destinationBindingSha256,
    'publication destination binding SHA-256'
  )
  if (
    destinationDigest !== normalizedDestinationBinding.sha256 ||
    destinationDigest !== acceptedPublication.destinationBindingSha256
  ) {
    throw acceptanceError(
      'publication-destination-binding',
      'Publication destination binding does not match the preaccepted D3 destination.'
    )
  }
  const normalizedReservation = bindPublicationReservationDocument({
    reservation: reservationEvidence,
    document: buildPublicationReservationDocument({
      acceptedRecordSha256: acceptedDigest,
      artifacts: normalizedArtifacts,
      destination: normalizedDestinationBinding.document.destination,
      manifestSha256: manifestArtifact.sha256,
      releaseId,
      reservationObjectKey: reservationEvidence.objectKey,
      sealedCandidate: promotion.sealedCandidate,
      sourceCommit,
      workflow: publicationReservationCreatorWorkflow(
        reservation?.document,
        workflowIdentity,
        reservationEvidence.action
      )
    }),
    suppliedDocument: reservation?.document ?? null
  })
  const receipt = {
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE,
    status: 'published',
    promotionMode: CAPTURE_DECAY_D3_EXACT_PROMOTION_MODE,
    publishedAt: requiredIsoTimestamp(publishedAt, 'publishedAt'),
    candidate: { ...accepted.candidate },
    sealedCandidate: promotion.sealedCandidate,
    sealedCandidateBindingSha256: promotion.sealedCandidateBindingSha256,
    sealedCandidateManifest: promotion.sealedCandidateManifest,
    promotedArtifacts: promotion.promotedArtifacts,
    acceptedRecordSha256: acceptedDigest,
    publicationSourceCommit: sourceCommit,
    sourceDiff: [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH],
    workflow: workflowIdentity,
    destinationBinding: normalizedDestinationBinding,
    destinationBindingSha256: destinationDigest,
    reservation: normalizedReservation,
    release: {
      releaseId,
      manifestSha256: manifestArtifact.sha256,
      dmg: { ...dmgArtifact },
      artifacts: normalizedArtifacts
    }
  }
  return assertCaptureDecayD3PublicationReceipt(receipt, {
    acceptedRecord: accepted,
    acceptedRecordSha256: acceptedDigest
  })
}

export function assertCaptureDecayD3PublicationReceipt(
  receipt,
  { acceptedRecord, acceptedRecordSha256 } = {}
) {
  if (
    receipt?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION ||
    receipt?.profile !== CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE ||
    receipt?.status !== 'published'
  ) {
    throw acceptanceError(
      'publication-receipt-profile',
      `D3 publication receipt must be a published ${CAPTURE_DECAY_D3_PUBLICATION_RECEIPT_PROFILE} record.`
    )
  }
  requiredIsoTimestamp(receipt.publishedAt, 'publication receipt publishedAt')
  const receiptAcceptedDigest = requireSha256(
    receipt.acceptedRecordSha256,
    'publication accepted-record SHA-256'
  )
  if (acceptedRecordSha256 && receiptAcceptedDigest !== acceptedRecordSha256) {
    throw acceptanceError(
      'publication-acceptance-chain',
      'Publication receipt is bound to a different accepted D3 record.'
    )
  }
  let accepted = null
  if (acceptedRecord) {
    accepted = assertAcceptedRecord(acceptedRecord)
    if (sha256Json(accepted) !== receiptAcceptedDigest) {
      throw acceptanceError(
        'publication-acceptance-chain',
        'Publication receipt accepted-record SHA-256 is invalid.'
      )
    }
    assertSameCandidate(accepted.candidate, receipt.candidate, 'publication receipt')
    const acceptedPublication = normalizeAcceptedPublicationContract(
      accepted?.validator?.publication
    )
    if (receipt?.destinationBindingSha256 !== acceptedPublication.destinationBindingSha256) {
      throw acceptanceError(
        'publication-destination-binding',
        'Publication receipt destination does not match the accepted D3 destination binding.'
      )
    }
  } else {
    assertCandidateIdentity(receipt.candidate)
  }
  if (receipt?.promotionMode !== CAPTURE_DECAY_D3_EXACT_PROMOTION_MODE) {
    throw acceptanceError(
      'publication-promotion-mode',
      `The first D3 publication must use ${CAPTURE_DECAY_D3_EXACT_PROMOTION_MODE}.`
    )
  }
  const publicationSourceCommit = requireCommit(
    receipt.publicationSourceCommit,
    'publication source commit'
  )
  if (!sameStrings(receipt.sourceDiff, [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH])) {
    throw acceptanceError(
      'publication-source-diff',
      'D3 publication receipt must retain the acceptance-record-only source diff.'
    )
  }
  if (normalizePublicationWorkflow(receipt.workflow).sha !== publicationSourceCommit) {
    throw acceptanceError(
      'publication-workflow-sha',
      'Publication receipt workflow SHA does not match its publication source commit.'
    )
  }
  const artifacts = normalizePublicationArtifacts(receipt?.release?.artifacts)
  const promotion = normalizeExactCandidatePromotion({
    acceptedRecord: accepted,
    artifacts,
    candidate: receipt?.candidate,
    promotedArtifacts: receipt?.promotedArtifacts,
    sealedCandidate: receipt?.sealedCandidate,
    sealedCandidateBindingSha256: receipt?.sealedCandidateBindingSha256,
    sealedCandidateManifest: receipt?.sealedCandidateManifest
  })
  const reservationEvidence = normalizePublicationReservation(receipt?.reservation, {
    sealedCandidate: promotion.sealedCandidate
  })
  const destinationBinding = normalizePublicationDestinationBinding(receipt?.destinationBinding, {
    artifacts,
    reservation: reservationEvidence
  })
  if (receipt?.destinationBindingSha256 !== destinationBinding.sha256) {
    throw acceptanceError(
      'publication-destination-binding',
      'Publication receipt destination binding digest and document are inconsistent.'
    )
  }
  const releaseId = requiredText(receipt?.release?.releaseId, 'publication release id')
  const manifestSha256 = requireSha256(
    receipt?.release?.manifestSha256,
    'publication manifest SHA-256'
  )
  const dmg = normalizePublicationArtifact(receipt?.release?.dmg, 'published DMG')
  const listedDmg = artifacts.find((artifact) => artifact.label === 'dmg')
  const listedManifest = artifacts.find((artifact) => artifact.label === 'manifest')
  const latestManifest = artifacts.find((artifact) => artifact.label === 'latest-manifest')
  const reservation = bindPublicationReservationDocument({
    reservation: reservationEvidence,
    suppliedDocument: receipt?.reservation?.document,
    document: buildPublicationReservationDocument({
      acceptedRecordSha256: receiptAcceptedDigest,
      artifacts,
      destination: destinationBinding.document.destination,
      manifestSha256,
      releaseId,
      reservationObjectKey: reservationEvidence.objectKey,
      sealedCandidate: promotion.sealedCandidate,
      sourceCommit: publicationSourceCommit,
      workflow: publicationReservationCreatorWorkflow(
        receipt?.reservation?.document,
        receipt.workflow,
        reservationEvidence.action
      )
    })
  })
  if (artifacts.some((artifact) => artifact.objectKey === reservation.objectKey)) {
    throw acceptanceError(
      'publication-reservation-object',
      'Publication reservation object key must be distinct from every release artifact.'
    )
  }
  for (const label of [
    'dmg',
    'sha256',
    'manifest',
    'latest-manifest',
    'feed-manifest',
    'feed-zip',
    'feed-blockmap'
  ]) {
    if (!artifacts.some((artifact) => artifact.label === label)) {
      throw acceptanceError(
        'publication-artifacts',
        `D3 publication receipt is missing verified ${label} upload evidence.`
      )
    }
  }
  if (
    !listedDmg ||
    JSON.stringify(listedDmg) !== JSON.stringify(dmg) ||
    listedManifest?.sha256 !== manifestSha256 ||
    latestManifest?.sha256 !== manifestSha256 ||
    releaseId !== promotion.sealedCandidateManifest.release.releaseId ||
    listedDmg.filename !== promotion.sealedCandidateManifest.candidate.dmgFilename ||
    listedDmg.sha256 !== promotion.sealedCandidateManifest.candidate.dmgSha256 ||
    listedDmg.sizeBytes !== promotion.sealedCandidateManifest.candidate.dmgSizeBytes ||
    !listedDmg.objectKey.includes(`/${releaseId}/`) ||
    reservation.objectKey !==
      `${dirname(listedManifest?.objectKey ?? '')}/capture-decay-d3-publication-reservation.json`
  ) {
    throw acceptanceError(
      'publication-artifact-mismatch',
      'D3 publication receipt release identifiers and artifact hashes are inconsistent.'
    )
  }
  return receipt
}

export function validateCaptureDecayD3PublicationReceipt({
  acceptedRecord,
  acceptedRecordSha256,
  publicRouteVerification,
  publicationAttestation,
  publicationReceipt,
  publicationReceiptSha256,
  publishedArtifacts,
  publishedManifest
}) {
  const accepted = assertAcceptedRecord(acceptedRecord)
  const acceptedDigest = requireSha256(acceptedRecordSha256, 'accepted-record SHA-256')
  if (sha256Json(accepted) !== acceptedDigest) {
    throw acceptanceError('publication-accepted-record-hash', 'Accepted D3 record hash is invalid.')
  }
  const receipt = assertCaptureDecayD3PublicationReceipt(publicationReceipt, {
    acceptedRecord: accepted,
    acceptedRecordSha256: acceptedDigest
  })
  const receiptDigest = requireSha256(publicationReceiptSha256, 'receipt SHA-256')
  if (sha256Json(receipt) !== receiptDigest) {
    throw acceptanceError('publication-receipt-hash', 'Publication receipt SHA-256 is invalid.')
  }
  const attestation = normalizePublicationAttestation(publicationAttestation, {
    publicationSourceCommit: receipt.publicationSourceCommit,
    receiptSha256: receiptDigest,
    subjectSha256s: captureDecayD3PublicationAttestationSubjectSha256s(
      receipt.sealedCandidate,
      receiptDigest
    )
  })
  const downloaded = normalizePublishedSealedCandidateArtifacts(publishedArtifacts, {
    publicationArtifacts: receipt.release.artifacts,
    sealedCandidate: receipt.sealedCandidate
  })
  const manifestArtifact = downloaded.find((artifact) => artifact.label === 'manifest')
  const dmg = downloaded.find((artifact) => artifact.label === 'dmg')
  if (
    receipt.release.releaseId !== publishedManifest?.releaseId ||
    receipt.release.manifestSha256 !== manifestArtifact?.sha256 ||
    receipt.release.dmg.filename !== publishedManifest?.filename ||
    receipt.release.dmg.filename !== dmg?.filename ||
    receipt.release.dmg.sha256 !== publishedManifest?.sha256 ||
    receipt.release.dmg.sha256 !== dmg?.sha256 ||
    receipt.release.dmg.sizeBytes !== dmg?.sizeBytes ||
    publishedManifest?.sizeBytes !== dmg?.sizeBytes ||
    publishedManifest?.bundleVersion !== receipt.sealedCandidateManifest.release.bundleVersion
  ) {
    throw acceptanceError(
      'published-release-mismatch',
      'Publication receipt does not match all six downloaded public sealed-candidate artifacts.'
    )
  }
  const currentPublicRoutes = normalizePublicRouteVerification(publicRouteVerification, {
    receipt
  })
  return {
    acceptedRecord: accepted,
    publicRouteVerification: currentPublicRoutes,
    publicationAttestation: attestation,
    publicationReceipt: receipt,
    publishedArtifacts: downloaded
  }
}

export function captureDecayD3PublicationSubjectDescriptors(sealedCandidate) {
  const normalized = normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  return [
    {
      label: 'candidate-manifest',
      filename: MACOS_D3_CANDIDATE_MANIFEST_FILENAME,
      sha256: normalized.manifest.sha256,
      sizeBytes: normalized.manifest.sizeBytes
    },
    {
      label: 'candidate-seal-receipt',
      filename: MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME,
      sha256: normalized.sealReceipt.sha256,
      sizeBytes: normalized.sealReceipt.sizeBytes
    },
    ...macosD3CandidatePublicationArtifactMapping(
      normalized.sealReceipt.document.candidateManifest
    ).map((artifact) => ({
      label: artifact.candidateLabel,
      filename: artifact.filename,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes
    }))
  ]
}

export function captureDecayD3PublicationAttestationSubjectSha256s(
  sealedCandidate,
  publicationReceiptSha256
) {
  return [
    requireSha256(publicationReceiptSha256, 'publication receipt SHA-256'),
    ...captureDecayD3PublicationSubjectDescriptors(sealedCandidate).map(
      (artifact) => artifact.sha256
    )
  ].sort()
}

export function buildSatisfiedCaptureDecayD3Record(
  validation,
  { satisfiedAt = new Date().toISOString() } = {}
) {
  const acceptedRecord = assertAcceptedRecord(validation?.acceptedRecord)
  const publicationReceipt = assertCaptureDecayD3PublicationReceipt(
    validation?.publicationReceipt,
    { acceptedRecord }
  )
  const publicationAttestation = normalizePublicationAttestation(
    validation?.publicationAttestation,
    {
      publicationSourceCommit: publicationReceipt.publicationSourceCommit,
      receiptSha256: sha256Json(publicationReceipt),
      subjectSha256s: captureDecayD3PublicationAttestationSubjectSha256s(
        publicationReceipt.sealedCandidate,
        sha256Json(publicationReceipt)
      )
    }
  )
  const publicRouteVerification = normalizePublicRouteVerification(
    validation?.publicRouteVerification,
    { receipt: publicationReceipt }
  )
  const record = {
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE,
    status: 'satisfied',
    satisfiedAt: requiredIsoTimestamp(satisfiedAt, 'satisfiedAt'),
    candidate: { ...acceptedRecord.candidate },
    sealedCandidate: structuredClone(acceptedRecord.sealedCandidate),
    evidenceManifestSha256: acceptedRecord.evidenceManifestSha256,
    acceptedRecordSha256: sha256Json(acceptedRecord),
    publicationReceiptSha256: sha256Json(publicationReceipt),
    publicationAttestation,
    publicRouteVerification,
    acceptedRecord,
    publicationReceipt
  }
  return assertCaptureDecayD3AcceptanceRecord(record)
}

export function assertCaptureDecayD3PublicationSourceState(
  record,
  { candidateIsAncestor, changedPaths = [], publicationSourceIsAncestor }
) {
  const valid = assertCaptureDecayD3AcceptanceRecord(record)
  if (valid.status === 'accepted') {
    if (candidateIsAncestor !== true) {
      throw acceptanceError(
        'accepted-candidate-ancestry',
        'The tested D3 candidate commit is not an ancestor of the publication commit.'
      )
    }
    if (!sameStrings(changedPaths, [CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH])) {
      throw acceptanceError(
        'accepted-source-diff',
        'Accepted D3 publication permits only the committed acceptance-record change after the tested commit.'
      )
    }
  } else if (publicationSourceIsAncestor !== true) {
    throw acceptanceError(
      'satisfied-publication-ancestry',
      'The validated first D3 publication is not an ancestor of this later release.'
    )
  }
  return valid
}

export function assertCaptureDecayD3AcceptanceRecord(record) {
  if (record?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION) {
    throw acceptanceError(
      'record-schema',
      'Capture-decay D3 acceptance record schemaVersion must be 2.'
    )
  }
  if (record?.profile !== CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE) {
    throw acceptanceError(
      'record-profile',
      `Capture-decay D3 acceptance record profile must be ${CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE}.`
    )
  }
  if (record?.status === 'accepted') {
    return assertAcceptedRecord(record)
  }
  if (record?.status === 'satisfied') {
    return assertSatisfiedRecord(record)
  }
  throw acceptanceError(
    'd3-pending',
    `Capture-decay D3 acceptance is ${record?.status ?? 'missing'}; macOS publication remains blocked.`
  )
}

function assertAcceptedRecord(record) {
  if (record?.status !== 'accepted') {
    throw acceptanceError(
      'record-not-accepted',
      'The embedded capture-decay D3 record must retain status accepted.'
    )
  }
  const candidate = assertCandidateIdentity(record.candidate)
  requireSha256(record.evidenceManifestSha256, 'accepted evidence manifest SHA-256')
  requiredIsoTimestamp(record.acceptedAt, 'acceptedAt')
  const publication = normalizeAcceptedPublicationContract(record?.validator?.publication)
  const sealedCandidate = assertMacosD3SealedCandidateMatches({
    candidate,
    publicationDestinationBindingSha256: publication.destinationBindingSha256,
    sealedCandidate: record.sealedCandidate
  })
  if (
    record?.validator?.evidenceProfile !== CAPTURE_DECAY_D3_EVIDENCE_PROFILE ||
    record?.validator?.requiredSoakCount !== 3 ||
    record?.validator?.requiredSoakMinutes !== CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES ||
    record?.validator?.minimumRateFraction !== CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION ||
    JSON.stringify(record?.validator?.requiredVideoProfile) !==
      JSON.stringify(CAPTURE_DECAY_REQUIRED_VIDEO_PROFILE) ||
    !sameStrings(
      record?.validator?.requiredRetentionPoints,
      CAPTURE_DECAY_REQUIRED_RETENTION_POINTS
    ) ||
    !sameStrings(
      record?.validator?.requiredRecoverySources,
      CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES
    )
  ) {
    throw acceptanceError(
      'record-validator-contract',
      'D3 record validator contract is incomplete.'
    )
  }
  if (!Array.isArray(record.soaks) || record.soaks.length !== 3) {
    throw acceptanceError(
      'record-soak-count',
      'Accepted D3 record must retain exactly three soaks.'
    )
  }
  const runIds = new Set()
  const digests = new Set()
  const captureIdentity = assertCaptureIdentity(record?.captureIdentity, 'accepted record')
  let previousFinishedAtMs = null
  let previousAttestationSha256 = null
  for (const [index, soak] of record.soaks.entries()) {
    const ordinal = index + 1
    if (soak?.runOrdinal !== ordinal) {
      throw acceptanceError('record-run-order', `Accepted soak ${ordinal} is out of order.`)
    }
    rejectDuplicate(
      runIds,
      requiredText(soak?.runId, 'accepted run id'),
      'record-duplicate-run',
      'run'
    )
    const attestationSha256 = requireSha256(
      soak?.attestationSha256,
      `accepted soak ${ordinal} attestation SHA-256`
    )
    rejectDuplicate(digests, attestationSha256, 'record-duplicate-attestation', 'attestation')
    requireSha256(soak?.checkpointSha256, `accepted soak ${ordinal} checkpoint SHA-256`)
    if (soak?.previousAttestationSha256 !== previousAttestationSha256) {
      throw acceptanceError('record-run-chain', `Accepted soak ${ordinal} has a broken hash chain.`)
    }
    const startedAtMs = timestampMs(soak?.startedAt, `accepted soak ${ordinal} startedAt`)
    const finishedAtMs = timestampMs(soak?.finishedAt, `accepted soak ${ordinal} finishedAt`)
    if (finishedAtMs - startedAtMs < CAPTURE_DECAY_REAL_RELEASE_SOAK_MINUTES * 60_000) {
      throw acceptanceError(
        'record-short-soak',
        `Accepted soak ${ordinal} is shorter than 240 minutes.`
      )
    }
    if (previousFinishedAtMs !== null && startedAtMs < previousFinishedAtMs) {
      throw acceptanceError('record-overlap', `Accepted soak ${ordinal} overlaps its predecessor.`)
    }
    if (soak?.minimumRateFraction < CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION) {
      throw acceptanceError(
        'record-cadence-floor',
        `Accepted soak ${ordinal} used a cadence floor below 90%.`
      )
    }
    assertRetentionSummaryRecord(soak?.retention, `accepted soak ${ordinal}`)
    previousFinishedAtMs = finishedAtMs
    previousAttestationSha256 = attestationSha256
  }
  const recovery = record?.recovery
  const recoveryIdentity = assertRecoveryIdentity(recovery?.identity, 'accepted recovery identity')
  if (
    recoveryIdentity.sessionId !== recovery?.sessionId ||
    recoveryIdentity.appProcessId !== recovery?.appProcessId ||
    recoveryIdentity.backendProcessId !== recovery?.backendProcessId
  ) {
    throw acceptanceError(
      'record-recovery-identity',
      'Accepted recovery did not preserve one app/backend/recording identity.'
    )
  }
  rejectDuplicate(
    runIds,
    requiredText(recovery?.runId, 'accepted recovery run id'),
    'record-duplicate-run',
    'run'
  )
  const recoveryAttestationSha256 = requireSha256(
    recovery?.attestationSha256,
    'accepted recovery attestation SHA-256'
  )
  rejectDuplicate(digests, recoveryAttestationSha256, 'record-duplicate-attestation', 'attestation')
  requireSha256(recovery?.checkpointSha256, 'accepted recovery checkpoint SHA-256')
  if (recovery?.qualifiedSoakAttestationSha256 !== previousAttestationSha256) {
    throw acceptanceError('record-recovery-chain', 'Accepted recovery does not bind to soak 3.')
  }
  normalizeRunnerIdentity(recovery?.runner, { candidate, recovery: true })
  const cameraArmedAtMs = timestampMs(
    recovery?.sources?.camera?.armedAt,
    'accepted camera recovery armedAt'
  )
  const startedAtMs = timestampMs(recovery?.startedAt, 'accepted recovery startedAt')
  requiredIsoTimestamp(recovery?.finishedAt, 'accepted recovery finishedAt')
  if (
    cameraArmedAtMs < previousFinishedAtMs ||
    cameraArmedAtMs - previousFinishedAtMs > CAPTURE_DECAY_D3_MAX_RECOVERY_DELAY_MS ||
    startedAtMs < previousFinishedAtMs ||
    startedAtMs > cameraArmedAtMs
  ) {
    throw acceptanceError('record-recovery-order', 'Accepted dual recovery is not immediate.')
  }
  const sourceKeys =
    recovery?.sources && typeof recovery.sources === 'object'
      ? Object.keys(recovery.sources).sort()
      : []
  if (!sameStrings(sourceKeys, [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES].sort())) {
    throw acceptanceError(
      'record-recovery-sources',
      'Accepted recovery must preserve camera and screen evidence from one session.'
    )
  }
  for (const source of CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES) {
    assertRecoverySummaryRecord(recovery.sources[source], {
      source,
      targetFps: record.validator.requiredVideoProfile.fps
    })
  }
  assertRecordingSummaryRecord(recovery?.recording, recovery?.recordingArtifact, {
    camera: recovery.sources.camera,
    identity: recoveryIdentity,
    screen: recovery.sources.screen
  })
  assertRetentionSummaryRecord(recovery?.retention, 'accepted dual recovery')
  assertCaptureIdentity(captureIdentity, 'accepted record')
  normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  return record
}

function assertSatisfiedRecord(record) {
  const satisfiedAtMs = timestampMs(record?.satisfiedAt, 'satisfiedAt')
  const acceptedRecord = assertAcceptedRecord(record?.acceptedRecord)
  const acceptedRecordSha256 = requireSha256(
    record?.acceptedRecordSha256,
    'satisfied accepted-record SHA-256'
  )
  if (sha256Json(acceptedRecord) !== acceptedRecordSha256) {
    throw acceptanceError(
      'satisfied-acceptance-chain',
      'Satisfied D3 record does not preserve the exact accepted record hash.'
    )
  }
  const receipt = assertCaptureDecayD3PublicationReceipt(record?.publicationReceipt, {
    acceptedRecord,
    acceptedRecordSha256
  })
  const receiptSha256 = requireSha256(
    record?.publicationReceiptSha256,
    'publication receipt SHA-256'
  )
  if (sha256Json(receipt) !== receiptSha256) {
    throw acceptanceError(
      'satisfied-receipt-chain',
      'Satisfied D3 record does not preserve the exact publication receipt hash.'
    )
  }
  normalizePublicationAttestation(record?.publicationAttestation, {
    publicationSourceCommit: receipt.publicationSourceCommit,
    receiptSha256,
    subjectSha256s: captureDecayD3PublicationAttestationSubjectSha256s(
      receipt.sealedCandidate,
      receiptSha256
    )
  })
  const publicRouteVerification = normalizePublicRouteVerification(
    record?.publicRouteVerification,
    { receipt }
  )
  const publicRouteVerifiedAtMs = timestampMs(
    publicRouteVerification.verifiedAt,
    'public-route verifiedAt'
  )
  if (
    publicRouteVerifiedAtMs > satisfiedAtMs ||
    satisfiedAtMs - publicRouteVerifiedAtMs >
      CAPTURE_DECAY_D3_MAX_PUBLIC_ROUTE_VERIFICATION_DELAY_MS
  ) {
    throw acceptanceError(
      'satisfied-public-route-time',
      'Satisfied D3 state requires current public-route reads completed immediately before satisfaction.'
    )
  }
  assertSameCandidate(acceptedRecord.candidate, record?.candidate, 'satisfied record')
  if (
    JSON.stringify(normalizeMacosD3SealedCandidateBinding(record?.sealedCandidate)) !==
    JSON.stringify(acceptedRecord.sealedCandidate)
  ) {
    throw acceptanceError(
      'satisfied-sealed-candidate-chain',
      'Satisfied D3 record changed the accepted sealed-candidate binding.'
    )
  }
  if (record?.evidenceManifestSha256 !== acceptedRecord.evidenceManifestSha256) {
    throw acceptanceError(
      'satisfied-evidence-chain',
      'Satisfied D3 record changed the accepted evidence-manifest SHA-256.'
    )
  }
  return record
}

export async function loadAndValidateCaptureDecayD3Evidence({
  manifestPath,
  expectedCandidate,
  expectedPublicationDestinationBindingSha256,
  nowMs = Date.now(),
  maximumEvidenceAgeMs = CAPTURE_DECAY_D3_MAX_EVIDENCE_AGE_MS
}) {
  const absoluteManifestPath = resolve(requiredText(manifestPath, 'evidence manifest path'))
  const manifestArtifact = await readCaptureDecayEvidenceArtifact({
    label: 'D3 evidence manifest',
    path: absoluteManifestPath,
    readBytes: true,
    root: dirname(absoluteManifestPath)
  })
  const manifestText = manifestArtifact.bytes.toString('utf8')
  const manifest = parseJson(manifestText, 'D3 evidence manifest')
  const manifestDirectory = dirname(manifestArtifact.path)
  const manifestCandidate = assertCandidateIdentity(manifest?.candidate)
  assertSameCandidate(manifestCandidate, expectedCandidate, 'expected release candidate')
  const sealedCandidate = await loadCaptureDecaySealedCandidate({
    descriptor: manifest?.sealedCandidate,
    expectedCandidate: manifestCandidate,
    expectedPublicationDestinationBindingSha256,
    manifestDirectory
  })
  const sealedCandidateBindingSha256 = macosD3SealedCandidateBindingSha256(sealedCandidate)
  let attemptLedger
  try {
    attemptLedger = await loadAndValidateCaptureDecayAttemptLedger({
      expectedCandidateCanonicalSha256: sha256Json(manifestCandidate),
      expectedSealedCandidateBindingSha256: sealedCandidateBindingSha256,
      manifest: manifest?.attemptLedger,
      manifestDirectory
    })
  } catch (cause) {
    const error = acceptanceError(
      `attempt-ledger-${cause?.code ?? 'invalid'}`,
      `D3 evidence attempt ledger is invalid: ${cause?.message ?? String(cause)}`
    )
    error.cause = cause
    throw error
  }
  const firstAttemptStartedAt = attemptLedger.attempts.at(0)?.startedAt
  if (
    !firstAttemptStartedAt ||
    Date.parse(sealedCandidate.sealReceipt.sealedAt) >= Date.parse(firstAttemptStartedAt)
  ) {
    throw acceptanceError(
      'candidate-seal-order',
      'The candidate seal receipt must predate the first immutable ceremony attempt.'
    )
  }
  if (!Array.isArray(manifest?.soaks) || manifest.soaks.length !== 3 || !manifest?.recovery) {
    throw acceptanceError(
      'manifest-artifacts',
      'D3 evidence manifest must name exactly three soak attestations plus one dual-source recovery recording attestation.'
    )
  }
  const descriptors = [...manifest.soaks, manifest.recovery]
  const loaded = []
  for (const [index, descriptor] of descriptors.entries()) {
    const label = index < 3 ? `soak ${index + 1}` : 'camera+screen recovery recording'
    const attestationPath = resolveContainedPath(
      manifestDirectory,
      descriptor?.attestation,
      `${label} attestation`
    )
    const attestationArtifact = await readCaptureDecayEvidenceArtifact({
      label: `${label} attestation`,
      path: attestationPath,
      readBytes: true,
      root: manifestDirectory
    })
    const attestationText = attestationArtifact.bytes.toString('utf8')
    const attestationSha256 = attestationArtifact.sha256
    if (attestationSha256 !== requireSha256(descriptor?.sha256, `${label} attestation SHA-256`)) {
      throw acceptanceError('attestation-tampered', `${label} attestation SHA-256 does not match.`)
    }
    if (
      attestationArtifact.sizeBytes !==
      positiveFileSize(descriptor?.sizeBytes, `${label} attestation size`)
    ) {
      throw acceptanceError('attestation-size', `${label} attestation byte size does not match.`)
    }
    const attestation = parseJson(attestationText, `${label} attestation`)
    if (attestationText !== serializeJson(attestation)) {
      throw acceptanceError(
        'attestation-noncanonical',
        `${label} attestation is not canonical JSON.`
      )
    }
    const checkpointPath = resolveContainedPath(
      dirname(attestationArtifact.path),
      attestation?.checkpoint?.filename,
      `${label} checkpoint`
    )
    const checkpointArtifact = await readCaptureDecayEvidenceArtifact({
      label: `${label} checkpoint`,
      path: checkpointPath,
      readBytes: true,
      root: dirname(attestationArtifact.path)
    })
    const checkpointText = checkpointArtifact.bytes.toString('utf8')
    const checkpointSha256 = checkpointArtifact.sha256
    if (
      checkpointSha256 !==
      requireSha256(attestation?.checkpoint?.sha256, `${label} checkpoint SHA-256`)
    ) {
      throw acceptanceError('checkpoint-tampered', `${label} checkpoint SHA-256 does not match.`)
    }
    if (
      Buffer.byteLength(checkpointText) !==
      positiveFileSize(attestation?.checkpoint?.sizeBytes, `${label} checkpoint size`)
    ) {
      throw acceptanceError(
        'checkpoint-size-binding',
        `${label} checkpoint byte size does not match.`
      )
    }
    const checkpoint = parseJson(checkpointText, `${label} checkpoint`)
    if (checkpointText !== serializeJson(checkpoint)) {
      throw acceptanceError('checkpoint-noncanonical', `${label} checkpoint is not canonical JSON.`)
    }
    const verifiedSidecars = await loadAndVerifyRunSidecars({
      attestation,
      runDirectory: dirname(attestationArtifact.path),
      recovery: index === 3
    })
    let recordingArtifact = null
    if (index === 3) {
      const provenanceArtifact = verifiedSidecars.get('debug-runner-provenance')
      const provenanceText = provenanceArtifact.bytes.toString('utf8')
      if (
        sha256Text(provenanceText) !==
        requireSha256(attestation?.runner?.provenance?.sha256, 'debug runner provenance SHA-256')
      ) {
        throw acceptanceError(
          'runner-provenance-tampered',
          'Debug runner provenance SHA-256 does not match.'
        )
      }
      const provenanceDocument = parseJson(provenanceText, 'debug runner provenance')
      if (
        provenanceText !== serializeJson(provenanceDocument) ||
        JSON.stringify(provenanceDocument) !==
          JSON.stringify(attestation?.runner?.provenance?.document)
      ) {
        throw acceptanceError(
          'runner-provenance-binding',
          'Debug runner provenance is noncanonical or does not match its attestation.'
        )
      }
      const verifiedRecording = verifiedSidecars.get('recording')
      recordingArtifact = {
        filename: verifiedRecording.filename,
        relativePath: attestation.recordingArtifact.relativePath,
        sha256: verifiedRecording.sha256,
        sizeBytes: verifiedRecording.sizeBytes
      }
    }
    loaded.push({
      attestation,
      attestationRelativePath: requiredText(descriptor?.attestation, `${label} attestation path`),
      attestationSha256,
      checkpoint,
      checkpointSha256,
      recordingArtifact
    })
  }
  let attemptSelection
  try {
    attemptSelection = validateCaptureDecayAttemptLedgerSelection({
      ledger: attemptLedger,
      selectedSoakAttestationSha256s: loaded
        .slice(0, 3)
        .map((artifact) => artifact.attestationSha256),
      selectedRecoveryAttestationSha256: loaded[3].attestationSha256
    })
  } catch (cause) {
    const error = acceptanceError(
      `attempt-ledger-${cause?.code ?? 'selection'}`,
      `D3 evidence attempt selection is invalid: ${cause?.message ?? String(cause)}`
    )
    error.cause = cause
    throw error
  }
  const selectedAttemptIds = [
    ...attemptSelection.soakAttemptIds,
    attemptSelection.recoveryAttemptId
  ]
  for (const [index, attemptId] of selectedAttemptIds.entries()) {
    const attempt = attemptLedger.attempts.find((entry) => entry.attemptId === attemptId)
    if (attempt?.attestation?.relativePath !== loaded[index].attestationRelativePath) {
      throw acceptanceError(
        'attempt-ledger-selected-path',
        'D3 evidence manifest must select the exact attestation path bound by the attempt ledger.'
      )
    }
  }
  if (attemptLedger.identity.hostId !== loaded[0].attestation?.captureIdentity?.hostId) {
    throw acceptanceError(
      'attempt-ledger-host',
      'D3 attempt ledger host id does not match the selected owner-host attestations.'
    )
  }
  const validation = validateCaptureDecayD3Evidence({
    manifest,
    soaks: loaded.slice(0, 3),
    recovery: loaded[3],
    expectedCandidate,
    sealedCandidate,
    publicationDestinationBindingSha256: expectedPublicationDestinationBindingSha256,
    evidenceManifestSha256: manifestArtifact.sha256,
    nowMs,
    maximumEvidenceAgeMs
  })
  return {
    ...validation,
    attemptLedger: {
      ceremonyId: attemptLedger.identity.ceremonyId,
      candidateCanonicalSha256: attemptLedger.identity.candidateCanonicalSha256,
      hostId: attemptLedger.identity.hostId,
      sealedCandidateBindingSha256,
      entryCount: attemptLedger.entries.length,
      headEntrySha256: attemptLedger.headEntrySha256,
      selection: attemptSelection
    }
  }
}

async function loadCaptureDecaySealedCandidate({
  descriptor,
  expectedCandidate,
  expectedPublicationDestinationBindingSha256,
  manifestDirectory
}) {
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !sameStrings(Object.keys(descriptor).sort(), ['sealReceipt'])
  ) {
    throw acceptanceError(
      'candidate-seal-descriptor',
      'D3 evidence manifest must contain exactly one candidate seal-receipt descriptor.'
    )
  }
  const receiptDescriptor = descriptor.sealReceipt
  if (
    !receiptDescriptor ||
    typeof receiptDescriptor !== 'object' ||
    Array.isArray(receiptDescriptor) ||
    !sameStrings(Object.keys(receiptDescriptor).sort(), ['relativePath', 'sha256', 'sizeBytes'])
  ) {
    throw acceptanceError(
      'candidate-seal-descriptor',
      'Candidate seal receipt descriptor must bind relativePath, SHA-256, and byte size.'
    )
  }
  const receiptPath = resolveContainedPath(
    manifestDirectory,
    receiptDescriptor.relativePath,
    'candidate seal receipt'
  )
  const artifact = await readCaptureDecayEvidenceArtifact({
    label: 'candidate seal receipt',
    path: receiptPath,
    readBytes: true,
    root: manifestDirectory
  })
  if (
    artifact.sha256 !== requireSha256(receiptDescriptor.sha256, 'candidate seal receipt SHA-256') ||
    artifact.sizeBytes !==
      positiveFileSize(receiptDescriptor.sizeBytes, 'candidate seal receipt size')
  ) {
    throw acceptanceError(
      'candidate-seal-artifact',
      'Candidate seal receipt bytes do not match the evidence-manifest descriptor.'
    )
  }
  const receiptText = artifact.bytes.toString('utf8')
  const parsedReceipt = parseJson(receiptText, 'candidate seal receipt')
  let receipt
  try {
    receipt = normalizeMacosD3CandidateSealReceipt(parsedReceipt)
  } catch (cause) {
    const error = acceptanceError(
      'candidate-seal-invalid',
      `Candidate seal receipt is invalid: ${cause?.message ?? String(cause)}`
    )
    error.cause = cause
    throw error
  }
  if (receiptText !== canonicalMacosD3Json(receipt)) {
    throw acceptanceError(
      'candidate-seal-noncanonical',
      'Candidate seal receipt must use canonical sealed-candidate JSON.'
    )
  }
  try {
    return assertMacosD3SealedCandidateMatches({
      candidate: expectedCandidate,
      publicationDestinationBindingSha256: expectedPublicationDestinationBindingSha256,
      sealedCandidate: macosD3CandidateSealSummary(receipt)
    })
  } catch (cause) {
    const error = acceptanceError(
      'candidate-seal-identity',
      `Candidate seal receipt does not match the tested candidate: ${cause?.message ?? String(cause)}`
    )
    error.cause = cause
    throw error
  }
}

export async function loadCaptureDecaySealedCandidateForRun({
  evidenceRoot,
  expectedCandidate,
  expectedPublicationDestinationBindingSha256,
  receiptPath
}) {
  const root = resolve(requiredText(evidenceRoot, 'capture-decay evidence root'))
  const artifact = await readCaptureDecayEvidenceArtifact({
    label: 'candidate seal receipt',
    path: resolve(requiredText(receiptPath, 'candidate seal receipt path')),
    root
  })
  return await loadCaptureDecaySealedCandidate({
    descriptor: {
      sealReceipt: {
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes
      }
    },
    expectedCandidate,
    expectedPublicationDestinationBindingSha256,
    manifestDirectory: root
  })
}

export async function readCaptureDecayD3AcceptanceRecord(path, options = {}) {
  const state = await readCaptureDecayD3AcceptanceRecordState(path, options)
  return state.record
}

export async function writeCaptureDecayD3AcceptanceRecord(
  path,
  record,
  {
    beforePublish,
    expectedCurrentRecordSha256,
    expectedCurrentStatus,
    expectedHeadCommit,
    repoRoot,
    runGit
  } = {}
) {
  const absolutePath = resolve(path)
  const transition = `${expectedCurrentStatus ?? 'missing'}->${record?.status ?? 'missing'}`
  if (!['pending->accepted', 'accepted->satisfied'].includes(transition)) {
    throw acceptanceError(
      'illegal-record-transition',
      `Capture-decay D3 state transition ${transition} is not allowed.`
    )
  }
  assertCaptureDecayD3AcceptanceRecord(record)
  const sourceHeadCommit = requireCommit(expectedHeadCommit, 'expected transition HEAD commit')
  const expectedSourceDigest =
    expectedCurrentRecordSha256 === undefined
      ? null
      : requireSha256(expectedCurrentRecordSha256, 'expected current acceptance-record SHA-256')
  if (expectedCurrentStatus === 'accepted' && expectedSourceDigest === null) {
    throw acceptanceError(
      'record-transition-digest-required',
      'The accepted-to-satisfied transition must compare-and-swap the canonical accepted-record SHA-256.'
    )
  }
  if (beforePublish !== undefined && typeof beforePublish !== 'function') {
    throw acceptanceError(
      'record-transition-hook',
      'The acceptance transition publication hook must be a function.'
    )
  }
  const trustOptions = {
    repoRoot,
    requireHeadMatch: true,
    runGit
  }
  const lockPath = `${absolutePath}.transition.lock`
  const temporaryPath = `${absolutePath}.tmp-${randomUUID()}`
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw acceptanceError(
        'record-transition-locked',
        'Another capture-decay D3 acceptance transition is already in progress.'
      )
    }
    throw error
  }
  try {
    const currentState = await readCaptureDecayD3AcceptanceRecordState(absolutePath, trustOptions)
    const current = currentState.record
    if (expectedCurrentStatus === 'pending') {
      assertCaptureDecayD3PendingRecord(current)
    } else {
      assertAcceptedRecord(current)
    }
    if (current.status !== expectedCurrentStatus) {
      throw acceptanceError(
        'record-transition-source',
        `Capture-decay D3 record is ${current.status ?? 'missing'}, expected ${expectedCurrentStatus}.`
      )
    }
    if (currentState.headCommit !== sourceHeadCommit) {
      throw acceptanceError(
        'record-transition-head',
        `Capture-decay D3 transition HEAD is ${currentState.headCommit}, expected ${sourceHeadCommit}.`
      )
    }
    if (expectedSourceDigest !== null && currentState.sha256 !== expectedSourceDigest) {
      throw acceptanceError(
        'record-transition-digest',
        'Capture-decay D3 transition source is not the expected canonical acceptance record.'
      )
    }
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(serializeJson(record), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (beforePublish) {
      await beforePublish({
        currentRecord: current,
        currentRecordSha256: currentState.sha256,
        headCommit: currentState.headCommit
      })
    }
    const boundaryState = await readCaptureDecayD3AcceptanceRecordState(absolutePath, trustOptions)
    if (
      boundaryState.headCommit !== sourceHeadCommit ||
      boundaryState.headCommit !== currentState.headCommit
    ) {
      throw acceptanceError(
        'record-transition-head-race',
        'Capture-decay D3 transition HEAD changed before the acceptance record could be published.'
      )
    }
    if (
      boundaryState.sha256 !== currentState.sha256 ||
      (expectedSourceDigest !== null && boundaryState.sha256 !== expectedSourceDigest)
    ) {
      throw acceptanceError(
        'record-transition-source-race',
        'Capture-decay D3 transition source changed before the acceptance record could be published.'
      )
    }
    await rename(temporaryPath, absolutePath)
  } finally {
    await lock.close()
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function readCaptureDecayD3AcceptanceRecordState(
  path,
  { repoRoot, requireHeadMatch, runGit = runAcceptanceGit } = {}
) {
  const absolutePath = resolve(path)
  const acceptanceRepoRoot = captureDecayAcceptanceRepoRoot(absolutePath, repoRoot)
  const verifyHead = requireHeadMatch ?? acceptanceRepoRoot !== null
  if (verifyHead && acceptanceRepoRoot === null) {
    throw acceptanceError(
      'record-head-path',
      `Trusted capture-decay D3 acceptance reads must target ${CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH}.`
    )
  }
  if (acceptanceRepoRoot) {
    await assertCaptureDecayAcceptancePathDirectories(acceptanceRepoRoot)
  }

  const headState = verifyHead
    ? await readCaptureDecayD3AcceptanceHeadState(acceptanceRepoRoot, runGit)
    : null
  const localState = await readBoundedCaptureDecayAcceptanceFile(absolutePath)
  if (headState) {
    if (!localState.bytes.equals(headState.bytes)) {
      throw acceptanceError(
        'record-head-bytes',
        'Capture-decay D3 acceptance bytes do not exactly match the HEAD blob.'
      )
    }
    const localGitMode = (localState.metadata.mode & 0o111n) === 0n ? '100644' : '100755'
    if (localGitMode !== headState.mode) {
      throw acceptanceError(
        'record-head-mode',
        `Capture-decay D3 acceptance mode ${localGitMode} does not match HEAD mode ${headState.mode}.`
      )
    }
    const boundaryHeadCommit = await acceptanceGitText(
      runGit,
      acceptanceRepoRoot,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      'capture-decay acceptance HEAD'
    )
    if (boundaryHeadCommit !== headState.headCommit) {
      throw acceptanceError(
        'record-head-race',
        'HEAD changed while the capture-decay D3 acceptance record was being read.'
      )
    }
  }

  const text = localState.bytes.toString('utf8')
  const record = parseJson(text, 'capture-decay D3 acceptance record')
  if (text !== serializeJson(record)) {
    throw acceptanceError(
      'noncanonical-record',
      'Capture-decay D3 acceptance record must use the canonical validator JSON format.'
    )
  }
  if ((record?.status === 'accepted' || record?.status === 'satisfied') && !headState) {
    throw acceptanceError(
      'record-head-required',
      'Accepted capture-decay D3 state is trusted only at the canonical acceptance path bound to HEAD.'
    )
  }
  return {
    headCommit: headState?.headCommit ?? null,
    metadata: localState.metadata,
    record,
    sha256: createHash('sha256').update(localState.bytes).digest('hex')
  }
}

function captureDecayAcceptanceRepoRoot(absolutePath, suppliedRepoRoot) {
  if (suppliedRepoRoot !== undefined) {
    const normalizedRoot = resolve(suppliedRepoRoot)
    if (absolutePath !== resolve(normalizedRoot, CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH)) {
      throw acceptanceError(
        'record-head-path',
        `Trusted capture-decay D3 acceptance reads must target ${CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH}.`
      )
    }
    return normalizedRoot
  }
  const inferredRoot = dirname(dirname(dirname(absolutePath)))
  return absolutePath === resolve(inferredRoot, CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH)
    ? inferredRoot
    : null
}

async function assertCaptureDecayAcceptancePathDirectories(repoRoot) {
  for (const path of [
    repoRoot,
    resolve(repoRoot, 'docs'),
    resolve(repoRoot, 'docs', 'acceptance')
  ]) {
    let metadata
    try {
      metadata = await lstat(path, { bigint: true })
    } catch (cause) {
      const error = acceptanceError(
        'record-head-path',
        'Capture-decay D3 acceptance path has an unavailable directory component.'
      )
      error.cause = cause
      throw error
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw acceptanceError(
        'record-head-path',
        'Capture-decay D3 acceptance path may not traverse a symlink or special directory component.'
      )
    }
  }
}

async function readCaptureDecayD3AcceptanceHeadState(repoRoot, runGit) {
  const prefix = await acceptanceGitText(
    runGit,
    repoRoot,
    ['rev-parse', '--show-prefix'],
    'capture-decay acceptance repository prefix',
    { allowEmpty: true }
  )
  if (prefix !== '') {
    throw acceptanceError(
      'record-head-repository',
      'Capture-decay D3 acceptance path is not rooted at the Git worktree boundary.'
    )
  }
  const headCommit = requireCommit(
    await acceptanceGitText(
      runGit,
      repoRoot,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      'capture-decay acceptance HEAD'
    ),
    'capture-decay acceptance HEAD'
  )
  const treeOutput = await acceptanceGitBytes(
    runGit,
    repoRoot,
    ['ls-tree', '-z', headCommit, '--', CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH],
    'capture-decay acceptance HEAD entry'
  )
  const match = /^([0-7]{6}) ([^ ]+) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(
    treeOutput.toString('utf8')
  )
  if (
    !match ||
    match[2] !== 'blob' ||
    match[4] !== CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_PATH ||
    !['100644', '100755'].includes(match[1])
  ) {
    throw acceptanceError(
      'record-head-entry',
      'HEAD must contain the canonical capture-decay D3 acceptance path as a regular-file blob.'
    )
  }
  const objectId = requireGitObjectId(match[3], 'capture-decay acceptance HEAD blob')
  const sizeText = await acceptanceGitText(
    runGit,
    repoRoot,
    ['cat-file', '-s', objectId],
    'capture-decay acceptance HEAD blob size'
  )
  const sizeBytes = Number(sizeText)
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES
  ) {
    throw acceptanceError(
      'record-too-large',
      `Capture-decay D3 acceptance record must be at most ${CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES} bytes.`
    )
  }
  const bytes = await acceptanceGitBytes(
    runGit,
    repoRoot,
    ['cat-file', 'blob', objectId],
    'capture-decay acceptance HEAD blob',
    { maxBuffer: CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES + 1 }
  )
  if (bytes.byteLength !== sizeBytes) {
    throw acceptanceError(
      'record-head-bytes',
      'Capture-decay D3 acceptance HEAD blob changed while it was being read.'
    )
  }
  return { bytes, headCommit, mode: match[1], objectId }
}

async function readBoundedCaptureDecayAcceptanceFile(path) {
  let pathBefore
  try {
    pathBefore = await lstat(path, { bigint: true })
  } catch (cause) {
    const error = acceptanceError(
      'record-file-unavailable',
      'Capture-decay D3 acceptance record is unavailable.'
    )
    error.cause = cause
    throw error
  }
  assertCaptureDecayAcceptanceRegularFile(pathBefore)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let handle
  try {
    handle = await open(path, flags)
  } catch (cause) {
    const error = acceptanceError(
      'record-file-type',
      'Capture-decay D3 acceptance record must be a no-follow regular file.'
    )
    error.cause = cause
    throw error
  }
  try {
    const before = await handle.stat({ bigint: true })
    assertCaptureDecayAcceptanceRegularFile(before)
    if (!sameCaptureDecayAcceptanceFileIdentity(pathBefore, before)) {
      throw acceptanceError(
        'record-file-race',
        'Capture-decay D3 acceptance path changed before it could be read.'
      )
    }
    const sizeBytes = Number(before.size)
    const bytes = Buffer.alloc(sizeBytes)
    let offset = 0
    while (offset < sizeBytes) {
      const { bytesRead } = await handle.read(bytes, offset, sizeBytes - offset, offset)
      if (bytesRead === 0) {
        throw acceptanceError(
          'record-file-race',
          'Capture-decay D3 acceptance record shrank while it was being read.'
        )
      }
      offset += bytesRead
    }
    const trailing = Buffer.alloc(1)
    if ((await handle.read(trailing, 0, 1, sizeBytes)).bytesRead !== 0) {
      throw acceptanceError(
        'record-file-race',
        'Capture-decay D3 acceptance record grew while it was being read.'
      )
    }
    const after = await handle.stat({ bigint: true })
    let pathAfter
    try {
      pathAfter = await lstat(path, { bigint: true })
    } catch {
      throw acceptanceError(
        'record-file-race',
        'Capture-decay D3 acceptance path disappeared while it was being read.'
      )
    }
    assertCaptureDecayAcceptanceRegularFile(pathAfter)
    if (
      !sameCaptureDecayAcceptanceFileIdentity(before, after) ||
      !sameCaptureDecayAcceptanceFileIdentity(after, pathAfter)
    ) {
      throw acceptanceError(
        'record-file-race',
        'Capture-decay D3 acceptance path changed while it was being read.'
      )
    }
    return { bytes, metadata: after }
  } finally {
    await handle.close()
  }
}

function assertCaptureDecayAcceptanceRegularFile(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw acceptanceError(
      'record-file-type',
      'Capture-decay D3 acceptance record must be a no-follow regular file.'
    )
  }
  if (metadata.size <= 0n || metadata.size > BigInt(CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES)) {
    throw acceptanceError(
      'record-too-large',
      `Capture-decay D3 acceptance record must be between 1 and ${CAPTURE_DECAY_D3_ACCEPTANCE_RECORD_MAX_BYTES} bytes.`
    )
  }
}

function sameCaptureDecayAcceptanceFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function runAcceptanceGit(repoRoot, args, { maxBuffer = 1024 * 1024 } = {}) {
  return await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer,
    windowsHide: true
  })
}

async function acceptanceGitBytes(runGit, repoRoot, args, label, options = {}) {
  let result
  try {
    result = await runGit(repoRoot, [...args], options)
  } catch (cause) {
    const error = acceptanceError('record-head-git', `Unable to read ${label} with Git.`)
    error.cause = cause
    throw error
  }
  const stdout = result?.stdout ?? result
  if (!Buffer.isBuffer(stdout) && typeof stdout !== 'string') {
    throw acceptanceError('record-head-git', `Git returned invalid ${label} output.`)
  }
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

async function acceptanceGitText(
  runGit,
  repoRoot,
  args,
  label,
  { allowEmpty = false, ...options } = {}
) {
  const value = (await acceptanceGitBytes(runGit, repoRoot, args, label, options))
    .toString('utf8')
    .trim()
  if (!allowEmpty && value.length === 0) {
    throw acceptanceError('record-head-git', `Git returned empty ${label} output.`)
  }
  return value
}

export function assertCaptureDecayD3PendingRecord(record) {
  if (
    record?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION ||
    record?.profile !== CAPTURE_DECAY_D3_ACCEPTANCE_PROFILE ||
    record?.status !== 'pending' ||
    nonEmpty(record?.blockingReason) === null ||
    !sameStrings(Object.keys(record).sort(), [
      'blockingReason',
      'profile',
      'schemaVersion',
      'status'
    ])
  ) {
    throw acceptanceError(
      'invalid-pending-record',
      'Capture-decay D3 pending record must be the canonical four-field fail-closed record.'
    )
  }
  return record
}

export function captureDecayCanonicalJsonSha256(value) {
  return sha256Json(value)
}

function normalizeRunAttemptLedgerBinding(binding, runId) {
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    !sameStrings(Object.keys(binding).sort(), ['attemptId', 'ceremonyId', 'startEntrySha256'])
  ) {
    throw acceptanceError(
      'run-attempt-ledger-binding',
      'Run attestation must bind the canonical ceremony id, attempt id, and start-entry SHA-256.'
    )
  }
  const normalized = {
    attemptId: requiredText(binding.attemptId, 'attempt ledger attempt id'),
    ceremonyId: requiredText(binding.ceremonyId, 'attempt ledger ceremony id'),
    startEntrySha256: requireSha256(binding.startEntrySha256, 'attempt ledger start-entry SHA-256')
  }
  if (normalized.attemptId !== requiredText(runId, 'run id')) {
    throw acceptanceError(
      'run-attempt-ledger-binding',
      'Run id must equal the immutable attempt-ledger attempt id.'
    )
  }
  return normalized
}

function assertAttestationCommon({
  attestation,
  attestationSha256,
  candidate,
  checkpoint,
  checkpointSha256,
  expectedKind,
  expectedProfile,
  nowMs,
  maximumEvidenceAgeMs,
  runIds,
  sealedCandidateBindingSha256
}) {
  if (
    attestation?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION ||
    attestation?.profile !== expectedProfile ||
    attestation?.kind !== expectedKind
  ) {
    throw acceptanceError(
      'attestation-profile',
      `${expectedKind} attestation does not use the locked ${expectedProfile} profile.`
    )
  }
  assertSameCandidate(candidate, attestation.candidate, `${expectedKind} attestation`)
  assertCaptureDecayRunChildExit(attestation?.childExit)
  normalizeRunAttemptLedgerBinding(attestation?.attemptLedger, attestation?.runId)
  if (
    requireSha256(
      attestation?.sealedCandidateBindingSha256,
      `${expectedKind} sealed candidate binding SHA-256`
    ) !== sealedCandidateBindingSha256
  ) {
    throw acceptanceError(
      'attestation-sealed-candidate',
      `${expectedKind} attestation does not bind the ceremony's exact sealed candidate.`
    )
  }
  assertCaptureIdentity(attestation?.captureIdentity, `${expectedKind} attestation`)
  normalizeRunnerIdentity(attestation?.runner, {
    candidate,
    recovery: expectedKind === 'recovery'
  })
  const sidecars = normalizeRunSidecars(attestation?.sidecars, {
    recordingArtifact: attestation?.recordingArtifact,
    recovery: expectedKind === 'recovery',
    runner: attestation?.runner
  })
  assertCheckpointArtifactBindings(checkpoint, sidecars, {
    recovery: expectedKind === 'recovery'
  })
  if (attestation?.checkpoint?.sha256 !== checkpointSha256) {
    throw acceptanceError(
      'checkpoint-binding',
      `${expectedKind} attestation does not bind the supplied checkpoint.`
    )
  }
  positiveFileSize(attestation?.checkpoint?.sizeBytes, `${expectedKind} checkpoint size`)
  if (
    attestation?.checkpoint?.status !== checkpoint?.status ||
    attestation?.checkpoint?.startedAt !== checkpoint?.startedAt ||
    attestation?.checkpoint?.finishedAt !== checkpoint?.finishedAt
  ) {
    throw acceptanceError(
      'checkpoint-summary-mismatch',
      `${expectedKind} attestation checkpoint summary does not match raw evidence.`
    )
  }
  if (
    JSON.stringify(attestation?.sizingEvidence) !==
    JSON.stringify(extractCaptureSizingEvidence(checkpoint))
  ) {
    throw acceptanceError(
      'sizing-evidence-binding',
      `${expectedKind} attestation sizing/reconfiguration timeline does not match its checkpoint.`
    )
  }
  requireSha256(attestationSha256, `${expectedKind} attestation SHA-256`)
  rejectDuplicate(
    runIds,
    requiredText(attestation?.runId, `${expectedKind} run id`),
    'duplicate-run-id',
    'run id'
  )
  const writtenAtMs = timestampMs(attestation?.writtenAt, `${expectedKind} attestation writtenAt`)
  const checkpointFinishedAtMs = timestampMs(
    checkpoint?.finishedAt,
    `${expectedKind} checkpoint finishedAt`
  )
  if (
    writtenAtMs < checkpointFinishedAtMs ||
    writtenAtMs - checkpointFinishedAtMs > CAPTURE_DECAY_D3_MAX_ATTESTATION_DELAY_MS
  ) {
    throw acceptanceError(
      'attestation-timing',
      `${expectedKind} attestation must be written within five minutes after its checkpoint finishes.`
    )
  }
  if (writtenAtMs > nowMs + CAPTURE_DECAY_D3_FUTURE_TOLERANCE_MS) {
    throw acceptanceError('future-evidence', `${expectedKind} attestation is dated in the future.`)
  }
  if (nowMs - writtenAtMs > maximumEvidenceAgeMs) {
    throw acceptanceError('stale-evidence', `${expectedKind} attestation is stale.`)
  }
}

function assertPassedCheckpoint(
  checkpoint,
  { expectedMinutes, expectedRecovery, label, maximumEvidenceAgeMs, nowMs }
) {
  if (checkpoint?.schemaVersion !== CAPTURE_DECAY_CHECKPOINT_SCHEMA_VERSION) {
    throw acceptanceError(
      'checkpoint-schema',
      `${label} checkpoint schemaVersion must be ${CAPTURE_DECAY_CHECKPOINT_SCHEMA_VERSION}.`
    )
  }
  if (checkpoint?.status !== 'passed') {
    throw acceptanceError(
      'checkpoint-not-passed',
      `${label} checkpoint status is ${checkpoint?.status ?? 'missing'}, expected passed.`
    )
  }
  if (
    (Array.isArray(checkpoint?.failures) && checkpoint.failures.length > 0) ||
    (Array.isArray(checkpoint?.cleanupFailures) && checkpoint.cleanupFailures.length > 0) ||
    checkpoint?.interruptedSignal ||
    Number(checkpoint?.degradedSamples ?? 0) !== 0 ||
    (Array.isArray(checkpoint?.laggedEvents) && checkpoint.laggedEvents.length > 0)
  ) {
    throw acceptanceError('checkpoint-failures', `${label} retains failure/interruption evidence.`)
  }
  const config = checkpoint?.config
  if (
    config?.gate !== true ||
    config?.realSources !== true ||
    config?.releaseGate === true ||
    config?.recoveryGate !== expectedRecovery ||
    config?.soakMinutes !== expectedMinutes ||
    config?.sampleSeconds !== 2 ||
    config?.realSourceFailureConsecutiveSamples !== 3 ||
    config?.maximumRecoveryDurationMs !== 4_000 ||
    config?.maximumRecoveryDetectionMs !== 6_000
  ) {
    throw acceptanceError(
      'checkpoint-config',
      `${label} did not use the locked real-source profile.`
    )
  }
  const gates = config?.evidenceGates
  if (
    gates?.minimumRealSourceRateFraction !== CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION ||
    gates?.requireNativePreview !== true ||
    gates?.requirePresenterAdvancement !== true ||
    gates?.requireMetalCompositor !== true ||
    gates?.minimumSampleCoverage !== 0.95 ||
    gates?.maximumSampleGapMs !== 6_000 ||
    gates?.maximumSurfaceLiveCount !== 12 ||
    gates?.maximumSurfacePeakCount !== 16 ||
    gates?.maximumSurfaceSlopePerMinute !== 0.05 ||
    gates?.surfaceSlopeMinimumMinutes !== (expectedRecovery ? 0 : 10) ||
    gates?.surfaceGrowthAllowance !== 2 ||
    gates?.minimumPreviewPresentFps !== 1 ||
    gates?.maximumPreviewFrameAgeMs !== 1_000 ||
    gates?.maximumPreviewLatencyP95Ms !== 1_000 ||
    gates?.maximumRealSourceAgeMs !== 1_000 ||
    gates?.requireReleaseRecordingPath !== false
  ) {
    throw acceptanceError(
      'checkpoint-gates',
      `${label} evidence gates are not the locked D3 values.`
    )
  }
  const startedAtMs = timestampMs(checkpoint?.startedAt, `${label} startedAt`)
  const finishedAtMs = timestampMs(checkpoint?.finishedAt, `${label} finishedAt`)
  if (finishedAtMs < startedAtMs) {
    throw acceptanceError('checkpoint-time-order', `${label} finished before it started.`)
  }
  if (finishedAtMs > nowMs + CAPTURE_DECAY_D3_FUTURE_TOLERANCE_MS) {
    throw acceptanceError('future-evidence', `${label} finished in the future.`)
  }
  if (nowMs - finishedAtMs > maximumEvidenceAgeMs) {
    throw acceptanceError('stale-evidence', `${label} checkpoint is stale.`)
  }
  const durationMs = finishedAtMs - startedAtMs
  if (!expectedRecovery && durationMs < expectedMinutes * 60_000) {
    throw acceptanceError('short-soak', `${label} is shorter than ${expectedMinutes} minutes.`)
  }
  const samples = checkpoint?.samples
  const expectedSampleCount = Math.ceil((expectedMinutes * 60) / 2)
  const requiredSampleCount = Math.ceil(expectedSampleCount * 0.95)
  const uniqueSampleCount = Array.isArray(samples)
    ? new Set(
        samples
          .map((sample) => sample?.elapsedMs)
          .filter((elapsedMs) => nonNegativeFinite(elapsedMs))
      ).size
    : 0
  if (!Array.isArray(samples) || uniqueSampleCount < requiredSampleCount) {
    throw acceptanceError(
      'sample-coverage',
      `${label} contains ${uniqueSampleCount}/${expectedSampleCount} unique scheduled samples.`
    )
  }
  assertSampleTimeline(samples, expectedMinutes * 60_000, label)
  assertRealSourceIdentity(checkpoint, label)
  if (
    checkpoint?.samplesCollected !== samples.length ||
    checkpoint?.evidenceSummary?.expectedSampleCount !== expectedSampleCount ||
    checkpoint?.evidenceSummary?.requiredSampleCount !== requiredSampleCount ||
    checkpoint?.evidenceSummary?.samplesCollected !== samples.length ||
    checkpoint?.evidenceSummary?.degradedStageFailureSamples !== 0 ||
    checkpoint?.evidenceSummary?.nativeFailureSamples !== 0 ||
    checkpoint?.evidenceSummary?.metalCompositorFailureSamples !== 0 ||
    checkpoint?.evidenceSummary?.sourceSurfaceFailureSamples !== 0
  ) {
    throw acceptanceError('evidence-summary', `${label} evidence summary is incomplete or failed.`)
  }
  if (
    !nonNegativeFinite(checkpoint.evidenceSummary.maximumObservedSampleGapMs) ||
    checkpoint.evidenceSummary.maximumObservedSampleGapMs > 6_000 ||
    !nonNegativeFinite(checkpoint.evidenceSummary.sampleCoverage) ||
    checkpoint.evidenceSummary.sampleCoverage < 0.95 ||
    !nonNegativeFinite(checkpoint.evidenceSummary.finiteNativeLatencySamples) ||
    checkpoint.evidenceSummary.finiteNativeLatencySamples < requiredSampleCount
  ) {
    throw acceptanceError(
      'evidence-coverage',
      `${label} does not retain complete native latency/sample-gap coverage.`
    )
  }
  if (
    !checkpoint?.teardownEvidence ||
    !Array.isArray(checkpoint.teardownEvidence.failures) ||
    checkpoint.teardownEvidence.failures.length > 0
  ) {
    throw acceptanceError('teardown-evidence', `${label} did not prove bounded teardown release.`)
  }
  assertTeardownRetention(checkpoint.teardownEvidence, label)
  return { durationMs, finishedAtMs, startedAtMs }
}

function assertFourK30(checkpoint, label) {
  const video = checkpoint?.startupEvidence?.sceneRequest?.video
  if (
    video?.width !== 3_840 ||
    video?.height !== 2_160 ||
    video?.fps !== 30 ||
    video?.bitrateKbps !== 30_000
  ) {
    throw acceptanceError('video-profile', `${label} did not use the locked 3840x2160@30 profile.`)
  }
}

function assertSampleTimeline(samples, plannedDurationMs, label) {
  let previousElapsedMs = null
  let maximumGapMs = 0
  for (const [index, sample] of samples.entries()) {
    const elapsedMs = sample?.elapsedMs
    if (
      !nonNegativeFinite(elapsedMs) ||
      (previousElapsedMs !== null && elapsedMs <= previousElapsedMs)
    ) {
      throw acceptanceError(
        'sample-timeline',
        `${label} sample ${index + 1} has a missing, duplicate, or out-of-order elapsed time.`
      )
    }
    maximumGapMs = Math.max(maximumGapMs, elapsedMs - (previousElapsedMs ?? 0))
    previousElapsedMs = elapsedMs
  }
  maximumGapMs = Math.max(maximumGapMs, Math.max(0, plannedDurationMs - (previousElapsedMs ?? 0)))
  if (maximumGapMs > 6_000) {
    throw acceptanceError(
      'sample-gap',
      `${label} raw sample timeline contains a ${maximumGapMs}ms gap.`
    )
  }
}

function assertRealSourceIdentity(checkpoint, label) {
  const selection = checkpoint?.sourceSelection
  const cameraId = selection?.cameraId
  const screenId = selection?.screenId
  if (
    typeof cameraId !== 'string' ||
    !cameraId.startsWith('camera:avfoundation-native:') ||
    typeof screenId !== 'string' ||
    !screenId.startsWith('screen:screencapturekit:') ||
    selection?.testPattern !== false ||
    selection?.windowId !== null
  ) {
    throw acceptanceError(
      'real-source-identity',
      `${label} does not retain exact native AVFoundation/ScreenCaptureKit source selection.`
    )
  }
  const startup = checkpoint?.startupEvidence
  const visibility = startup?.motionStimulus?.visibility
  if (
    startup?.camera?.id !== cameraId ||
    startup?.screen?.id !== screenId ||
    startup?.camera?.status !== 'available' ||
    startup?.screen?.status !== 'available' ||
    !['native-swift', 'chromium'].includes(startup?.motionStimulus?.driver) ||
    visibility?.visible !== true ||
    visibility?.reason !== 'stimulus color signature present' ||
    !positiveFinite(visibility?.totalPixels) ||
    !Array.isArray(visibility?.passingColors) ||
    visibility.passingColors.length < 7
  ) {
    throw acceptanceError(
      'real-source-readiness',
      `${label} does not prove TCC-authorized native sources and a visible motion stimulus.`
    )
  }
  const sceneSelection = startup?.sceneRequest?.sources
  if (
    sceneSelection?.cameraId !== cameraId ||
    sceneSelection?.screenId !== screenId ||
    sceneSelection?.testPattern !== false
  ) {
    throw acceptanceError(
      'synthetic-source-marker',
      `${label} scene request is missing native source identity or contains a test-pattern marker.`
    )
  }
  const committedSources = startup?.sceneCommitted?.scene?.sources
  for (const [kind, deviceId] of [
    ['camera', cameraId],
    ['screen', screenId]
  ]) {
    if (
      !Array.isArray(committedSources) ||
      committedSources.filter(
        (source) =>
          source?.kind === kind && source?.deviceId === deviceId && source?.visible === true
      ).length !== 1
    ) {
      throw acceptanceError(
        'committed-source-identity',
        `${label} committed scene does not contain exactly one visible ${kind} source.`
      )
    }
  }
  const readyPolls = startup?.readinessPolls
  const readyTail = Array.isArray(readyPolls) ? readyPolls.slice(-3) : []
  if (
    readyTail.length !== 3 ||
    readyTail.some(
      (poll) =>
        !Array.isArray(poll?.failures) ||
        poll.failures.length > 0 ||
        poll?.cameraStatus?.state !== 'live' ||
        poll?.cameraStatus?.cameraId !== cameraId ||
        poll?.screenStatus?.state !== 'live' ||
        poll?.screenStatus?.sourceId !== screenId
    )
  ) {
    throw acceptanceError(
      'real-source-readiness',
      `${label} lacks three consecutive live native-source readiness polls.`
    )
  }
  let previousCameraSequence = null
  let previousScreenSequence = null
  for (const sample of checkpoint.samples) {
    if (
      sample?.cameraStatusState !== 'live' ||
      sample?.cameraStatusCameraId !== cameraId ||
      sample?.screenStatusState !== 'live' ||
      sample?.screenStatusSourceId !== screenId ||
      sample?.compositorBackend !== 'metal' ||
      sample?.previewSurfaceState !== 'live' ||
      sample?.previewStatusTransport !== 'native-surface' ||
      sample?.previewStatusBacking !== 'cametal-layer' ||
      sample?.previewTransport !== 'native-surface' ||
      sample?.previewSurfaceBacking !== 'cametal-layer'
    ) {
      throw acceptanceError(
        'real-source-sample-identity',
        `${label} contains a synthetic, fallback, stopped, or non-Metal sample.`
      )
    }
    if (
      !Number.isSafeInteger(sample.cameraLatestSequence) ||
      !Number.isSafeInteger(sample.screenLatestSequence) ||
      (previousCameraSequence !== null &&
        (sample.cameraLatestSequence <= previousCameraSequence ||
          sample.screenLatestSequence <= previousScreenSequence))
    ) {
      throw acceptanceError(
        'real-source-sequence',
        `${label} camera/screen sequences did not advance on every collected sample.`
      )
    }
    previousCameraSequence = sample.cameraLatestSequence
    previousScreenSequence = sample.screenLatestSequence
  }
}

function assertNearTargetCadence(checkpoint, label) {
  const cadence = checkpoint?.startupEvidence?.sourceCadence
  const expectations = {
    cameraCaptureCallbackFps: cadence?.cameraProducerFps,
    cameraPublicationFps: cadence?.cameraProducerFps,
    cameraFreshFps: cadence?.cameraConsumerFps,
    screenCaptureCallbackFps: cadence?.screenProducerFps,
    screenPublicationFps: cadence?.screenProducerFps,
    screenFreshFps: cadence?.screenConsumerFps
  }
  if (Object.values(expectations).some((value) => !positiveFinite(value))) {
    throw acceptanceError('cadence-baseline', `${label} has no finite source cadence baseline.`)
  }
  for (const [field, expected] of Object.entries(expectations)) {
    let consecutiveFailures = 0
    for (const sample of checkpoint.samples) {
      const value = sample?.[field]
      consecutiveFailures =
        positiveFinite(value) && value >= expected * 0.9 ? 0 : consecutiveFailures + 1
      if (consecutiveFailures >= 3) {
        throw acceptanceError(
          'cadence-below-target',
          `${label} ${field} stayed below 90% of ${expected}fps for three samples.`
        )
      }
    }
  }
  return { minimumRateFraction: CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION }
}

function assertRetentionEvidence(checkpoint, label, { requireSlope }) {
  const requiredSampleCount = checkpoint?.evidenceSummary?.requiredSampleCount
  const surfaces = checkpoint?.evidenceSummary?.surfaces
  for (const source of ['camera', 'screen']) {
    const summary = surfaces?.[source]
    if (
      !summary ||
      !nonNegativeFinite(summary.maximumLiveCount) ||
      !nonNegativeFinite(summary.maximumPeakCount) ||
      summary.maximumLiveCount > 12 ||
      summary.maximumPeakCount > 16 ||
      !nonNegativeFinite(summary.initialLiveCount) ||
      !nonNegativeFinite(summary.finalLiveCount) ||
      summary.finalLiveCount > summary.initialLiveCount + 2 ||
      (requireSlope &&
        (summary.slopeEvaluated !== true ||
          !Number.isFinite(summary.liveCountSlopePerMinute) ||
          summary.liveCountSlopePerMinute > 0.05))
    ) {
      throw acceptanceError(
        'source-retention-unbounded',
        `${label} ${source} source-surface retention is not flat and bounded.`
      )
    }
  }

  const points = checkpoint?.evidenceSummary?.retentionPoints
  const keys = points && typeof points === 'object' ? Object.keys(points).sort() : []
  if (!sameStrings(keys, [...CAPTURE_DECAY_REQUIRED_RETENTION_POINTS].sort())) {
    throw acceptanceError(
      'retention-points-missing',
      `${label} must report exactly ${CAPTURE_DECAY_REQUIRED_RETENTION_POINTS.join(', ')}.`
    )
  }
  const summary = {}
  for (const key of CAPTURE_DECAY_REQUIRED_RETENTION_POINTS) {
    const point = points[key]
    if (
      !positiveFinite(point?.evidenceSamples) ||
      !positiveFinite(requiredSampleCount) ||
      point.evidenceSamples < requiredSampleCount ||
      !nonNegativeFinite(point?.liveCount) ||
      !nonNegativeFinite(point?.peakCount) ||
      !nonNegativeFinite(point?.ceiling) ||
      !Number.isFinite(point?.slopePerMinute) ||
      !nonNegativeFinite(point?.initialLiveCount) ||
      !nonNegativeFinite(point?.finalLiveCount) ||
      !nonNegativeFinite(point?.maximumLiveCount) ||
      point?.withinCeiling !== true ||
      point.liveCount !== point.finalLiveCount ||
      point.liveCount > point.ceiling ||
      point.peakCount > point.ceiling ||
      point.maximumLiveCount > point.ceiling ||
      point.finalLiveCount > point.initialLiveCount + 2 ||
      (requireSlope && point.slopePerMinute > 0.05)
    ) {
      throw acceptanceError(
        'retention-point-unbounded',
        `${label} retention point ${key} is missing finite bounded counter evidence.`
      )
    }
    summary[key] = {
      evidenceSamples: point.evidenceSamples,
      liveCount: point.liveCount,
      peakCount: point.peakCount,
      ceiling: point.ceiling,
      slopePerMinute: point.slopePerMinute,
      initialLiveCount: point.initialLiveCount,
      finalLiveCount: point.finalLiveCount,
      maximumLiveCount: point.maximumLiveCount,
      withinCeiling: true
    }
  }
  return summary
}

function assertTeardownRetention(teardown, label) {
  const points = teardown?.finalRetentionState
  const keys = points && typeof points === 'object' ? Object.keys(points).sort() : []
  if (!sameStrings(keys, [...CAPTURE_DECAY_REQUIRED_RETENTION_POINTS].sort())) {
    throw acceptanceError(
      'retention-teardown-points',
      `${label} teardown does not report all four native retention points.`
    )
  }
  for (const key of CAPTURE_DECAY_REQUIRED_RETENTION_POINTS) {
    const point = points[key]
    if (
      point?.liveCount !== 0 ||
      !nonNegativeFinite(point?.peakCount) ||
      !nonNegativeFinite(point?.ceiling) ||
      point.peakCount > point.ceiling
    ) {
      throw acceptanceError(
        'retention-teardown-live',
        `${label} teardown retention point ${key} did not return to zero within its ceiling.`
      )
    }
  }
  for (const source of ['camera', 'screen']) {
    const baseline = teardown?.releasedSurfaceBaseline?.[source]?.liveCount
    const final = teardown?.finalSurfaceState?.[source]?.liveCount
    if (!nonNegativeFinite(baseline) || final !== baseline) {
      throw acceptanceError(
        'source-teardown-baseline',
        `${label} ${source} IOSurface live count did not return to its process baseline.`
      )
    }
  }
}

function assertBoundedDualRecoveryEvidence(checkpoint, recordingArtifact) {
  const injected = checkpoint?.injectedRecoveryEvidence
  const targetFps = checkpoint?.startupEvidence?.sceneRequest?.video?.fps
  const sessionId = requiredText(injected?.sessionId, 'dual recovery session id')
  const identity = assertRecoveryIdentity(injected?.identity, 'dual recovery identity')
  if (
    !positiveSafeInteger(injected?.appProcessId) ||
    !positiveSafeInteger(injected?.backendProcessId) ||
    identity.sessionId !== sessionId ||
    identity.appProcessId !== injected.appProcessId ||
    identity.backendProcessId !== injected.backendProcessId ||
    !sameStrings(injected?.sequence, CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES)
  ) {
    throw acceptanceError(
      'recovery-session',
      'D3 recovery must retain one app/backend process and ordered camera -> screen sequence.'
    )
  }
  const sources = {}
  for (const source of CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES) {
    sources[source] = assertSourceRecoveryEvidence(injected?.[source], source, identity, targetFps)
  }
  if (sources.camera.completedAtMs > sources.screen.armedAtMs) {
    throw acceptanceError(
      'recovery-sequence',
      'Screen recovery started before camera recovery returned to idle.'
    )
  }
  const recording = assertRecoveryRecordingEvidence(injected?.recording, {
    camera: sources.camera,
    recordingArtifact,
    screen: sources.screen,
    sessionId,
    identity
  })
  return {
    sessionId,
    appProcessId: injected.appProcessId,
    backendProcessId: injected.backendProcessId,
    identity,
    sequence: [...CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES],
    sources,
    recording
  }
}

function assertSourceRecoveryEvidence(evidence, source, identity, targetFps) {
  const summary = evidence?.summary
  const phases = Array.isArray(summary?.phases) ? summary.phases : []
  const armedAtMs = evidence?.armedAtMs
  const completedAtMs = evidence?.completedAtMs
  if (
    !sameRecoveryIdentity(evidence?.identity, identity) ||
    !nonNegativeFinite(armedAtMs) ||
    !nonNegativeFinite(completedAtMs) ||
    completedAtMs < armedAtMs ||
    !phases.some((phase) => phase === 'degraded' || phase === 'restarting') ||
    !phases.includes('verifying') ||
    !phases.includes('recovered') ||
    summary?.attemptsHighWater !== 1 ||
    !nonNegativeFinite(summary?.observedDetectionMs) ||
    summary.observedDetectionMs > 6_000 ||
    !nonNegativeFinite(summary?.observedRecoveryMs) ||
    summary.observedRecoveryMs > 4_000 ||
    evidence?.terminalStatus?.phase !== 'idle' ||
    summary?.preRestartGeneration !== evidence?.acknowledgement?.sourceGeneration ||
    !positiveSafeInteger(summary?.preRestartGeneration) ||
    !oneAdvancedGeneration(summary?.verifyingGenerations, summary.preRestartGeneration) ||
    !oneAdvancedGeneration(summary?.recoveredGenerations, summary.preRestartGeneration) ||
    !recoveryObservationsMatchSource(evidence?.observations, source)
  ) {
    throw acceptanceError(
      'recovery-evidence',
      `D3 ${source} recovery lacks one bounded exact-generation automatic restart flow.`
    )
  }
  const recoveredGeneration = summary.recoveredGenerations[0]
  const cadence = assertRecoveryCadenceRestore(summary?.cadenceRestore, {
    code: 'recovery-cadence',
    label: `D3 ${source} recovery`,
    minimumObservedAtMs: completedAtMs,
    recoveredGeneration,
    targetFps
  })
  return {
    armedAt: new Date(armedAtMs).toISOString(),
    armedAtMs,
    completedAt: new Date(completedAtMs).toISOString(),
    completedAtMs,
    attemptsHighWater: summary.attemptsHighWater,
    observedDetectionMs: summary.observedDetectionMs,
    observedRecoveryMs: summary.observedRecoveryMs,
    preRestartGeneration: summary.preRestartGeneration,
    verifyingGenerations: summary.verifyingGenerations,
    recoveredGenerations: summary.recoveredGenerations,
    cadenceRestore: {
      minimumRateFraction: cadence.minimumRateFraction,
      requiredConsecutiveSamples: cadence.requiredConsecutiveSamples,
      samples: cadence.samples
    },
    phases
  }
}

function assertRecoveryRecordingEvidence(
  recording,
  { camera, identity, recordingArtifact, screen, sessionId }
) {
  if (
    !sameRecoveryIdentity(recording?.identity, identity) ||
    recording?.normalStop !== true ||
    !positiveFinite(recording?.requestedDurationMs) ||
    !positiveFinite(recording?.observedDurationMs) ||
    recording.observedDurationMs < recording.requestedDurationMs * 0.97 ||
    recording?.analyzer?.verdict !== 'passed' ||
    !positiveFinite(recording?.analyzer?.artifactDurationSeconds) ||
    recording.analyzer.artifactDurationSeconds * 1_000 < recording.requestedDurationMs * 0.97 ||
    recording?.analyzer?.motionPass !== true ||
    recording?.analyzer?.freezePass !== true ||
    recording?.analyzer?.audioPass !== true ||
    recording?.analyzer?.avSyncPass !== true
  ) {
    throw acceptanceError(
      'recovery-recording',
      'Dual recovery did not retain a normally stopped, analyzed recording from one session.'
    )
  }
  const timeline = assertRecoveryRecordingTimeline(recording, {
    camera,
    code: 'recovery-recording-session',
    identity,
    screen,
    sessionId
  })
  if (
    basename(requiredText(recording?.outputPath, 'recovery recording output path')) !==
    recordingArtifact.filename
  ) {
    throw acceptanceError(
      'recovery-recording-artifact',
      'Recovery checkpoint output path does not match the SHA-bound recording artifact.'
    )
  }
  assertRecoveryAnalyzerMetrics(recording.analyzer)
  return {
    sessionId,
    identity: { ...identity },
    started: timeline.started,
    stopped: timeline.stopped,
    observations: timeline.observations,
    normalStop: true,
    requestedDurationMs: recording.requestedDurationMs,
    observedDurationMs: recording.observedDurationMs,
    analyzer: recording.analyzer,
    artifact: recordingArtifact
  }
}

function assertRecoveryIdentity(identity, label) {
  return {
    sessionId: requiredText(identity?.sessionId, `${label} session id`),
    appProcessId: positiveProcessId(identity?.appProcessId, `${label} app process id`),
    backendProcessId: positiveProcessId(identity?.backendProcessId, `${label} backend process id`)
  }
}

function sameRecoveryIdentity(actual, expected) {
  try {
    return (
      JSON.stringify(assertRecoveryIdentity(actual, 'recovery identity')) ===
      JSON.stringify(expected)
    )
  } catch {
    return false
  }
}

function assertRecoveryAnalyzerMetrics(analyzer) {
  const metrics = analyzer?.metrics
  const gates = analyzer?.gates
  if (
    !nonNegativeFinite(metrics?.uniqueFrameRatio) ||
    !nonNegativeFinite(gates?.minUniqueFrameRatio) ||
    metrics.uniqueFrameRatio < gates.minUniqueFrameRatio ||
    !nonNegativeFinite(metrics?.longestCorroboratedFreezeMs) ||
    !nonNegativeFinite(gates?.maxFreezeMs) ||
    metrics.longestCorroboratedFreezeMs > gates.maxFreezeMs ||
    !nonNegativeFinite(metrics?.maxRepeatedFrameRun) ||
    !nonNegativeFinite(gates?.maxRepeatedFrameRun) ||
    metrics.maxRepeatedFrameRun > gates.maxRepeatedFrameRun ||
    !nonNegativeFinite(metrics?.maxAudioGapMs) ||
    !nonNegativeFinite(gates?.maxAudioGapMs) ||
    metrics.maxAudioGapMs > gates.maxAudioGapMs ||
    !nonNegativeFinite(metrics?.avSkewMs) ||
    !nonNegativeFinite(gates?.avSyncHardFailMs) ||
    metrics.avSkewMs > gates.avSyncHardFailMs ||
    !nonNegativeFinite(metrics?.tailMismatchMs) ||
    !nonNegativeFinite(gates?.maxTailMismatchMs) ||
    metrics.tailMismatchMs > gates.maxTailMismatchMs
  ) {
    throw acceptanceError(
      'recovery-recording-analysis',
      'Recovery recording does not retain bounded motion/freeze/audio/A-V analyzer metrics.'
    )
  }
}

function assertSizingEvidence(sizingEvidence, label) {
  const readiness = sizingEvidence?.readinessTimeline
  if (
    !Array.isArray(readiness) ||
    !readiness.some(
      (entry) => hasDimensions(entry?.camera?.actual) && hasDimensions(entry?.screen?.actual)
    )
  ) {
    throw acceptanceError(
      'sizing-evidence',
      `${label} does not bind the requested/actual capture sizing baseline.`
    )
  }
  const timeline = sizingEvidence?.retentionReconfigurationTimeline
  if (
    !Array.isArray(timeline) ||
    timeline.length === 0 ||
    !timeline.some(
      (entry) =>
        hasDimensions({ width: entry?.compositorWidth, height: entry?.compositorHeight }) &&
        hasDimensions({
          width: entry?.compositorMetalTargetWidth,
          height: entry?.compositorMetalTargetHeight
        }) &&
        hasDimensions({
          width: entry?.nativePreviewDrawableWidth,
          height: entry?.nativePreviewDrawableHeight
        })
    )
  ) {
    throw acceptanceError(
      'reconfiguration-timeline',
      `${label} does not bind capture sizing/Metal target/native drawable reconfiguration evidence.`
    )
  }
  for (const entry of timeline) {
    const points = entry?.retentionPoints
    const keys = points && typeof points === 'object' ? Object.keys(points).sort() : []
    if (!sameStrings(keys, [...CAPTURE_DECAY_REQUIRED_RETENTION_POINTS].sort())) {
      throw acceptanceError(
        'reconfiguration-retention',
        `${label} reconfiguration timeline omits a native retention point.`
      )
    }
    for (const key of CAPTURE_DECAY_REQUIRED_RETENTION_POINTS) {
      const point = points[key]
      if (
        !nonNegativeFinite(point?.liveCount) ||
        !nonNegativeFinite(point?.peakCount) ||
        !nonNegativeFinite(point?.ceiling) ||
        point.liveCount > point.ceiling ||
        point.peakCount > point.ceiling
      ) {
        throw acceptanceError(
          'reconfiguration-retention',
          `${label} reconfiguration timeline has unbounded ${key} retention.`
        )
      }
    }
  }
}

function assertRetentionSummaryRecord(retention, label) {
  const keys = retention && typeof retention === 'object' ? Object.keys(retention).sort() : []
  if (!sameStrings(keys, [...CAPTURE_DECAY_REQUIRED_RETENTION_POINTS].sort())) {
    throw acceptanceError('record-retention-points', `${label} retention summary is incomplete.`)
  }
  for (const key of keys) {
    const point = retention[key]
    if (
      point?.withinCeiling !== true ||
      !positiveFinite(point?.evidenceSamples) ||
      !nonNegativeFinite(point?.liveCount) ||
      !nonNegativeFinite(point?.peakCount) ||
      !nonNegativeFinite(point?.ceiling) ||
      !Number.isFinite(point?.slopePerMinute) ||
      !nonNegativeFinite(point?.initialLiveCount) ||
      !nonNegativeFinite(point?.finalLiveCount) ||
      !nonNegativeFinite(point?.maximumLiveCount) ||
      point.liveCount !== point.finalLiveCount ||
      point.liveCount > point.ceiling ||
      point.peakCount > point.ceiling ||
      point.maximumLiveCount > point.ceiling ||
      point.finalLiveCount > point.initialLiveCount + 2
    ) {
      throw acceptanceError('record-retention-bounds', `${label} ${key} is not bounded.`)
    }
  }
}

function assertRecoverySummaryRecord(summary, { source, targetFps }) {
  const label = `accepted ${source} recovery`
  const baseline = summary?.preRestartGeneration
  if (
    !Number.isFinite(Date.parse(summary?.armedAt)) ||
    !nonNegativeFinite(summary?.armedAtMs) ||
    !Number.isFinite(Date.parse(summary?.completedAt)) ||
    !nonNegativeFinite(summary?.completedAtMs) ||
    summary.completedAtMs < summary.armedAtMs ||
    summary?.attemptsHighWater !== 1 ||
    !nonNegativeFinite(summary?.observedDetectionMs) ||
    summary.observedDetectionMs > 6_000 ||
    !nonNegativeFinite(summary?.observedRecoveryMs) ||
    summary.observedRecoveryMs > 4_000 ||
    !positiveSafeInteger(baseline) ||
    !oneAdvancedGeneration(summary?.verifyingGenerations, baseline) ||
    !oneAdvancedGeneration(summary?.recoveredGenerations, baseline)
  ) {
    throw acceptanceError('record-recovery-bounds', `${label} is incomplete or unbounded.`)
  }
  assertRecoveryCadenceRestore(summary?.cadenceRestore, {
    code: 'record-recovery-bounds',
    label,
    minimumObservedAtMs: summary.completedAtMs,
    recoveredGeneration: summary.recoveredGenerations[0],
    targetFps
  })
}

function assertRecoveryCadenceRestore(
  cadence,
  { code, label, minimumObservedAtMs, recoveredGeneration, targetFps }
) {
  const samples = Array.isArray(cadence?.samples) ? cadence.samples : []
  let previousObservedAtMs = null
  const invalidSamples = samples.some((sample) => {
    const observedAtMs = Date.parse(sample?.observedAt)
    const invalid =
      !Number.isFinite(observedAtMs) ||
      observedAtMs < minimumObservedAtMs ||
      (previousObservedAtMs !== null && observedAtMs <= previousObservedAtMs) ||
      sample?.sourceGeneration !== recoveredGeneration ||
      sample?.expectedProducerFps !== targetFps ||
      sample?.expectedConsumerFps !== targetFps ||
      !rateAtFraction(
        sample?.captureCallbackFps,
        sample?.expectedProducerFps,
        CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION
      ) ||
      !rateAtFraction(
        sample?.publicationFps,
        sample?.expectedProducerFps,
        CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION
      ) ||
      !rateAtFraction(
        sample?.freshServeFps,
        sample?.expectedConsumerFps,
        CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION
      )
    if (Number.isFinite(observedAtMs)) previousObservedAtMs = observedAtMs
    return invalid
  })
  if (
    cadence?.minimumRateFraction !== CAPTURE_DECAY_REAL_RELEASE_RATE_FRACTION ||
    cadence?.requiredConsecutiveSamples !== 3 ||
    targetFps !== CAPTURE_DECAY_REQUIRED_VIDEO_PROFILE.fps ||
    samples.length !== 3 ||
    invalidSamples
  ) {
    throw acceptanceError(
      code,
      `${label} did not retain exactly three strictly ordered exact-generation samples at >=90% cadence.`
    )
  }
  return cadence
}

function assertRecordingSummaryRecord(recording, recordingArtifact, { camera, identity, screen }) {
  const artifact = normalizeRunRecordingArtifact(
    recordingArtifact,
    'accepted recovery recording artifact'
  )
  if (
    !sameRecoveryIdentity(recording?.identity, identity) ||
    recording?.sessionId !== identity.sessionId ||
    recording?.normalStop !== true ||
    !positiveFinite(recording?.requestedDurationMs) ||
    !positiveFinite(recording?.observedDurationMs) ||
    recording.observedDurationMs < recording.requestedDurationMs * 0.97 ||
    recording?.analyzer?.verdict !== 'passed' ||
    !positiveFinite(recording?.analyzer?.artifactDurationSeconds) ||
    recording?.analyzer?.artifactDurationSeconds * 1_000 < recording.requestedDurationMs * 0.97 ||
    recording?.analyzer?.motionPass !== true ||
    recording?.analyzer?.freezePass !== true ||
    recording?.analyzer?.audioPass !== true ||
    recording?.analyzer?.avSyncPass !== true ||
    recording?.artifact?.sha256 !== artifact.sha256 ||
    recording?.artifact?.sizeBytes !== artifact.sizeBytes
  ) {
    throw acceptanceError(
      'record-recovery-recording',
      'Accepted recovery recording/artifact analysis is incomplete.'
    )
  }
  assertRecoveryRecordingTimeline(recording, {
    camera,
    code: 'record-recovery-recording',
    identity,
    screen,
    sessionId: identity.sessionId
  })
  assertRecoveryAnalyzerMetrics(recording.analyzer)
}

function assertRecoveryRecordingTimeline(recording, { camera, code, identity, screen, sessionId }) {
  const expectedBoundaries = [
    ['camera', 'before'],
    ['camera', 'after'],
    ['screen', 'before'],
    ['screen', 'after']
  ]
  const observations = Array.isArray(recording?.observations) ? recording.observations : []
  const structurallyInvalid =
    recording?.started?.sessionId !== sessionId ||
    recording?.started?.state !== 'recording' ||
    recording?.stopped?.sessionId !== sessionId ||
    recording?.stopped?.state !== 'stopped' ||
    recording?.stopped?.backendState !== 'idle' ||
    observations.length !== expectedBoundaries.length ||
    observations.some(
      (observation, index) =>
        observation?.source !== expectedBoundaries[index][0] ||
        observation?.boundary !== expectedBoundaries[index][1] ||
        observation?.sessionId !== sessionId ||
        observation?.state !== 'recording' ||
        observation?.appProcessId !== identity.appProcessId ||
        observation?.backendProcessId !== identity.backendProcessId
    )
  if (structurallyInvalid) {
    throw acceptanceError(
      code,
      'Recording state was not proven before/after both ordered recoveries in the same session.'
    )
  }

  const startedAtMs = timestampMs(recording.started.observedAt, 'recovery recording startedAt')
  const stoppedAtMs = timestampMs(recording.stopped.observedAt, 'recovery recording stoppedAt')
  const boundaryTimes = observations.map((observation, index) =>
    timestampMs(observation.observedAt, `recovery recording boundary ${index + 1}`)
  )
  const [cameraBeforeMs, cameraAfterMs, screenBeforeMs, screenAfterMs] = boundaryTimes
  if (
    startedAtMs >= cameraBeforeMs ||
    cameraBeforeMs > camera.armedAtMs ||
    cameraAfterMs < camera.completedAtMs ||
    screenBeforeMs > screen.armedAtMs ||
    screenAfterMs < screen.completedAtMs ||
    stoppedAtMs <= screenAfterMs ||
    !boundaryTimes.every((value, index) => index === 0 || value > boundaryTimes[index - 1])
  ) {
    throw acceptanceError(
      code,
      'Recording boundaries must strictly bracket camera then screen recovery inside one start/idle-stop interval.'
    )
  }

  return {
    started: { ...recording.started },
    stopped: { ...recording.stopped },
    observations: observations.map((observation) => ({ ...observation }))
  }
}

function assertCandidateIdentity(candidate) {
  const sourceCommit = requiredText(candidate?.sourceCommit, 'candidate source commit')
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw acceptanceError(
      'candidate-source-commit',
      'Candidate source commit must be exactly 40 lowercase hexadecimal characters.'
    )
  }
  const executableFilename = requiredText(
    candidate?.executableFilename,
    'candidate executable filename'
  )
  const dmgFilename = requiredText(candidate?.dmgFilename, 'candidate DMG filename')
  if (
    executableFilename !== basename(executableFilename) ||
    dmgFilename !== basename(dmgFilename) ||
    !dmgFilename.endsWith('.dmg')
  ) {
    throw acceptanceError(
      'candidate-artifact-filename',
      'Candidate executable/DMG filenames must be safe artifact basenames.'
    )
  }
  const appBundle = normalizeCaptureDecayAppBundleIdentity(
    candidate?.appBundle,
    'candidate app bundle'
  )
  if (basename(appBundle.executableRelativePath) !== executableFilename) {
    throw acceptanceError(
      'candidate-bundle-executable',
      'Candidate app-bundle executable path does not match its executable artifact name.'
    )
  }
  return {
    ...candidate,
    sourceCommit,
    sourceTree: requireGitObjectId(candidate?.sourceTree, 'candidate source tree'),
    executableSha256: requireSha256(candidate?.executableSha256, 'candidate executable SHA-256'),
    executableSizeBytes: positiveFileSize(
      candidate?.executableSizeBytes,
      'candidate executable size'
    ),
    dmgSha256: requireSha256(candidate?.dmgSha256, 'candidate DMG SHA-256'),
    dmgSizeBytes: positiveFileSize(candidate?.dmgSizeBytes, 'candidate DMG size'),
    executableFilename,
    dmgFilename,
    appBundle
  }
}

function assertSameCandidate(expected, actual, label) {
  const normalizedExpected = assertCandidateIdentity(expected)
  const normalizedActual = assertCandidateIdentity(actual)
  for (const field of [
    'sourceCommit',
    'sourceTree',
    'executableSha256',
    'executableSizeBytes',
    'dmgSha256',
    'dmgSizeBytes',
    'executableFilename',
    'dmgFilename'
  ]) {
    if (normalizedActual[field] !== normalizedExpected[field]) {
      throw acceptanceError(
        'mixed-candidate-identity',
        `${label} ${field} does not match the accepted candidate.`
      )
    }
  }
  assertCaptureDecayAppBundleIdentityEqual(
    normalizedExpected.appBundle,
    normalizedActual.appBundle,
    `${label} app bundle`
  )
}

function captureIdentityFromCheckpoint(checkpoint, hostId) {
  const cameraId = requiredText(checkpoint?.sourceSelection?.cameraId, 'camera source id')
  const screenId = requiredText(checkpoint?.sourceSelection?.screenId, 'screen source id')
  return assertCaptureIdentity(
    {
      hostId: requireSha256(hostId, 'capture host id'),
      cameraSourceIdSha256: sha256Text(cameraId),
      screenSourceIdSha256: sha256Text(screenId)
    },
    'capture checkpoint'
  )
}

function assertCaptureIdentity(identity, label) {
  return {
    hostId: requireSha256(identity?.hostId, `${label} host id`),
    cameraSourceIdSha256: requireSha256(
      identity?.cameraSourceIdSha256,
      `${label} camera source id SHA-256`
    ),
    screenSourceIdSha256: requireSha256(
      identity?.screenSourceIdSha256,
      `${label} screen source id SHA-256`
    )
  }
}

function assertSameCaptureIdentity(expected, actual, label) {
  const normalized = assertCaptureIdentity(actual, label)
  if (expected === null) return normalized
  for (const field of ['hostId', 'cameraSourceIdSha256', 'screenSourceIdSha256']) {
    if (expected[field] !== normalized[field]) {
      throw acceptanceError(
        'mixed-capture-identity',
        `${label} did not use the same owner host, camera, and screen as the first D3 soak.`
      )
    }
  }
  return expected
}

function sourceDimensions(status, kind) {
  const selected =
    kind === 'camera'
      ? dimensions(status?.selectedFormatWidth, status?.selectedFormatHeight)
      : dimensions(status?.nativeWidth, status?.nativeHeight)
  return {
    requested: dimensions(status?.requestedWidth, status?.requestedHeight),
    actual: dimensions(
      status?.actualWidth ?? status?.width,
      status?.actualHeight ?? status?.height
    ),
    selected
  }
}

function flattenedSampleDimensions(sample, prefix) {
  return {
    requested: dimensions(
      sample?.[`${prefix}RequestedWidth`],
      sample?.[`${prefix}RequestedHeight`]
    ),
    actual: dimensions(sample?.[`${prefix}ActualWidth`], sample?.[`${prefix}ActualHeight`]),
    selected: dimensions(
      sample?.[`${prefix}SelectedWidth`] ?? sample?.[`${prefix}NativeWidth`],
      sample?.[`${prefix}SelectedHeight`] ?? sample?.[`${prefix}NativeHeight`]
    )
  }
}

function dimensions(width, height) {
  return { width: finiteOrNull(width), height: finiteOrNull(height) }
}

function hasDimensions(value) {
  return positiveFinite(value?.width) && positiveFinite(value?.height)
}

function recoveryObservationsMatchSource(observations, expectedSource) {
  if (!Array.isArray(observations) || observations.length === 0) return false
  const active = observations.filter((observation) =>
    ['degraded', 'restarting', 'verifying', 'recovered'].includes(observation?.phase)
  )
  return (
    active.length > 0 &&
    active.every(
      (observation) =>
        observation?.source === expectedSource &&
        observation?.trigger === 'automatic' &&
        positiveSafeInteger(observation?.sourceGeneration)
    )
  )
}

function oneAdvancedGeneration(generations, baseline) {
  return (
    Array.isArray(generations) &&
    generations.length === 1 &&
    positiveSafeInteger(generations[0]) &&
    generations[0] > baseline
  )
}

function normalizeAcceptedPublicationContract(publication) {
  if (
    publication?.repository !== CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY ||
    publication?.workflowPath !== CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH ||
    publication?.destinationBindingProfile !== CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE
  ) {
    throw acceptanceError(
      'record-publication-contract',
      'D3 acceptance does not pin the official repository, workflow, and destination-binding profile.'
    )
  }
  return {
    repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
    workflowPath: CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
    destinationBindingProfile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
    destinationBindingSha256: requireSha256(
      publication?.destinationBindingSha256,
      'accepted publication destination binding SHA-256'
    )
  }
}

function normalizePublicationAttestation(
  attestation,
  { publicationSourceCommit, receiptSha256, subjectSha256s }
) {
  if (
    attestation?.profile !== CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE ||
    attestation?.repository !== CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY ||
    attestation?.signerWorkflow !== CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW
  ) {
    throw acceptanceError(
      'publication-attestation-policy',
      'Publication attestation does not pin the official repository and signer workflow.'
    )
  }
  const sourceDigest = requireCommit(attestation?.sourceDigest, 'attestation source digest')
  const attestedReceiptSha256 = requireSha256(
    attestation?.receiptSha256,
    'attested receipt SHA-256'
  )
  if (sourceDigest !== publicationSourceCommit || attestedReceiptSha256 !== receiptSha256) {
    throw acceptanceError(
      'publication-attestation-chain',
      'Publication attestation does not bind the exact receipt and publication source commit.'
    )
  }
  const subjects = Array.isArray(attestation?.subjectSha256s)
    ? attestation.subjectSha256s.map((digest) =>
        requireSha256(digest, 'publication attestation subject SHA-256')
      )
    : []
  const expectedSubjects = Array.isArray(subjectSha256s)
    ? subjectSha256s.map((digest) =>
        requireSha256(digest, 'expected publication attestation subject SHA-256')
      )
    : []
  if (
    subjects.length !== 9 ||
    new Set(subjects).size !== subjects.length ||
    !sameStrings(subjects, [...subjects].sort()) ||
    !sameStrings(subjects, expectedSubjects)
  ) {
    throw acceptanceError(
      'publication-attestation-subjects',
      'Publication attestation must bind the receipt and exact eight sealed-candidate subjects.'
    )
  }
  const filename = requiredText(attestation?.bundle?.filename, 'attestation bundle filename')
  if (filename !== basename(filename)) {
    throw acceptanceError(
      'publication-attestation-bundle',
      'Publication attestation bundle filename must not contain a path.'
    )
  }
  const bodyBase64 = requiredText(
    attestation?.bundle?.bodyBase64,
    'publication attestation bundle body'
  )
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bodyBase64)) {
    throw acceptanceError(
      'publication-attestation-bundle',
      'Publication attestation bundle body must be canonical base64.'
    )
  }
  const body = Buffer.from(bodyBase64, 'base64')
  const bundleSha256 = requireSha256(attestation?.bundle?.sha256, 'attestation bundle SHA-256')
  const bundleSizeBytes = positiveFileSize(
    attestation?.bundle?.sizeBytes,
    'attestation bundle size'
  )
  if (
    body.byteLength === 0 ||
    body.byteLength > CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_MAX_BYTES ||
    body.toString('base64') !== bodyBase64 ||
    body.byteLength !== bundleSizeBytes ||
    createHash('sha256').update(body).digest('hex') !== bundleSha256
  ) {
    throw acceptanceError(
      'publication-attestation-bundle',
      'Publication attestation bundle body does not match its bounded SHA-256 and byte size.'
    )
  }
  return {
    profile: CAPTURE_DECAY_D3_PUBLICATION_ATTESTATION_PROFILE,
    repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
    signerWorkflow: CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
    sourceDigest,
    receiptSha256: attestedReceiptSha256,
    subjectSha256s: subjects,
    bundle: {
      filename,
      sha256: bundleSha256,
      sizeBytes: bundleSizeBytes,
      bodyBase64
    }
  }
}

function normalizePublicationWorkflow(workflow) {
  const repository = requiredText(workflow?.repository, 'publication workflow repository')
  const path = requiredText(workflow?.path, 'publication workflow path')
  if (repository !== CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY) {
    throw acceptanceError(
      'publication-workflow',
      `Publication repository must be ${CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY}.`
    )
  }
  if (path !== CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH) {
    throw acceptanceError(
      'publication-workflow',
      `Publication workflow must be ${CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH}.`
    )
  }
  const runId = requiredText(workflow?.runId, 'publication workflow run id')
  const runAttempt = requiredText(workflow?.runAttempt, 'publication workflow run attempt')
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw acceptanceError('publication-workflow', 'Publication workflow run identity is invalid.')
  }
  return {
    repository,
    path,
    runId,
    runAttempt,
    sha: requireCommit(workflow?.sha, 'publication workflow SHA')
  }
}

function normalizeRunnerIdentity(runner, { candidate, recovery }) {
  const normalizedExecutable = normalizeRunnerExecutable(runner, 'runner')
  const appBundle = normalizeRunnerAppBundle(runner, normalizedExecutable, 'runner')
  const normalized = { ...normalizedExecutable, appBundle, provenance: null }
  if (!recovery) {
    if (runner?.provenance !== undefined && runner.provenance !== null) {
      throw acceptanceError(
        'unexpected-runner-provenance',
        'Packaged candidate soaks must not substitute a provenance-sidecar runner.'
      )
    }
    if (
      normalized.executableSha256 !== candidate.executableSha256 ||
      normalized.sizeBytes !== candidate.executableSizeBytes
    ) {
      throw acceptanceError(
        'soak-runner-identity',
        'Packaged D3 soak runner bytes/size do not match the accepted candidate executable.'
      )
    }
    assertCaptureDecayAppBundleIdentityEqual(
      candidate.appBundle,
      appBundle,
      'packaged D3 soak runner app bundle'
    )
    return normalized
  }
  const document = normalizeRunnerProvenanceDocument(runner?.provenance?.document)
  assertSameCandidate(candidate, document.candidate, 'debug runner provenance candidate')
  const backend = normalizeFileIdentity(runner?.backend, 'debug runner backend')
  const provenance = {
    filename: requiredText(runner?.provenance?.filename, 'debug runner provenance filename'),
    sha256: requireSha256(runner?.provenance?.sha256, 'debug runner provenance SHA-256'),
    document
  }
  if (
    provenance.filename !== basename(provenance.filename) ||
    provenance.sha256 !== sha256Json(document) ||
    document.candidate.sourceCommit !== candidate.sourceCommit ||
    document.candidate.sourceTree !== candidate.sourceTree ||
    document.candidate.executableSha256 !== candidate.executableSha256 ||
    document.candidate.executableSizeBytes !== candidate.executableSizeBytes ||
    document.candidate.dmgSha256 !== candidate.dmgSha256 ||
    document.candidate.dmgSizeBytes !== candidate.dmgSizeBytes ||
    document.executable.filename !== normalized.executableFilename ||
    document.executable.sha256 !== normalized.executableSha256 ||
    document.executable.sizeBytes !== normalized.sizeBytes ||
    JSON.stringify(document.appBundle) !== JSON.stringify(appBundle) ||
    JSON.stringify(document.backend) !== JSON.stringify(backend)
  ) {
    throw acceptanceError(
      'runner-provenance',
      'Debug runner provenance does not bind its executable to the exact candidate commit/tree.'
    )
  }
  normalized.backend = backend
  normalized.provenance = provenance
  return normalized
}

function normalizeRunnerArtifactIdentity(runner, label, { requireDebugBackend }) {
  const executable = normalizeRunnerExecutable(runner, label)
  const normalized = {
    ...executable,
    appBundle: normalizeRunnerAppBundle(runner, executable, label)
  }
  if (requireDebugBackend) {
    normalized.backend = normalizeFileIdentity(runner?.backend, `${label} backend`)
  }
  return normalized
}

function normalizeRunnerProvenanceDocument(document) {
  if (
    document?.schemaVersion !== CAPTURE_DECAY_D3_SCHEMA_VERSION ||
    document?.profile !== CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE
  ) {
    throw acceptanceError(
      'runner-provenance-profile',
      `Debug runner provenance must use ${CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE}.`
    )
  }
  const candidate = assertCandidateIdentity(document?.candidate)
  const sourceBefore = normalizeBuildSourceSnapshot(
    document?.sourceBefore,
    'debug build source before'
  )
  const sourceAfter = normalizeBuildSourceSnapshot(
    document?.sourceAfter,
    'debug build source after'
  )
  assertSameBuildSource(sourceBefore, sourceAfter)
  if (
    sourceBefore.sourceCommit !== candidate.sourceCommit ||
    sourceBefore.sourceTree !== candidate.sourceTree
  ) {
    throw acceptanceError(
      'runner-build-source',
      'Debug runner provenance source snapshots do not match the candidate commit/tree.'
    )
  }
  return {
    schemaVersion: CAPTURE_DECAY_D3_SCHEMA_VERSION,
    profile: CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE_PROFILE,
    candidate,
    sourceBefore,
    sourceAfter,
    build: normalizeExecutedBuild(document?.build),
    executable: (() => {
      const executable = normalizeRunnerExecutable(document?.executable, 'debug runner')
      return {
        filename: executable.executableFilename,
        sha256: executable.executableSha256,
        sizeBytes: executable.sizeBytes
      }
    })(),
    appBundle: normalizeCaptureDecayAppBundleIdentity(
      document?.appBundle,
      'debug runner provenance app bundle'
    ),
    backend: normalizeFileIdentity(document?.backend, 'debug runner backend')
  }
}

function normalizeRunnerAppBundle(runner, executable, label) {
  const appBundle = normalizeCaptureDecayAppBundleIdentity(runner?.appBundle, `${label} app bundle`)
  if (basename(appBundle.executableRelativePath) !== executable.executableFilename) {
    throw acceptanceError(
      'runner-bundle-executable',
      `${label} app-bundle executable path does not match the executed artifact name.`
    )
  }
  return appBundle
}

function normalizeRunnerExecutable(runner, label) {
  return {
    executableFilename: requiredText(
      runner?.executableFilename ?? runner?.filename,
      `${label} executable filename`
    ),
    executableSha256: requireSha256(
      runner?.executableSha256 ?? runner?.sha256,
      `${label} executable SHA-256`
    ),
    sizeBytes: positiveFileSize(runner?.sizeBytes, `${label} executable size`)
  }
}

function normalizeFileIdentity(file, label) {
  return {
    filename: requiredText(file?.filename, `${label} filename`),
    sha256: requireSha256(file?.sha256, `${label} SHA-256`),
    sizeBytes: positiveFileSize(file?.sizeBytes, `${label} size`)
  }
}

function normalizeBuildSourceSnapshot(snapshot, label) {
  if (snapshot?.trackedClean !== true) {
    throw acceptanceError('runner-build-dirty', `${label} must prove a clean tracked checkout.`)
  }
  return {
    sourceCommit: requireCommit(snapshot?.sourceCommit, `${label} commit`),
    sourceTree: requireGitObjectId(snapshot?.sourceTree, `${label} tree`),
    trackedClean: true
  }
}

function assertSameBuildSource(before, after) {
  if (
    before.sourceCommit !== after.sourceCommit ||
    before.sourceTree !== after.sourceTree ||
    before.trackedClean !== after.trackedClean
  ) {
    throw acceptanceError(
      'runner-build-source-changed',
      'Debug runner build changed the source commit/tree or tracked checkout state.'
    )
  }
}

function normalizeExecutedBuild(build) {
  const startedAt = requiredIsoTimestamp(build?.startedAt, 'debug build startedAt')
  const finishedAt = requiredIsoTimestamp(build?.finishedAt, 'debug build finishedAt')
  if (
    timestampMs(finishedAt, 'debug build finishedAt') <
    timestampMs(startedAt, 'debug build startedAt')
  ) {
    throw acceptanceError('runner-build-time', 'Debug runner build finished before it started.')
  }
  const program = requiredText(build?.program, 'debug build program')
  if (!Array.isArray(build?.arguments) || build.arguments.length === 0) {
    throw acceptanceError('runner-build-command', 'Debug runner build arguments are required.')
  }
  const args = build.arguments.map((argument, index) =>
    requiredText(argument, `debug build argument ${index + 1}`)
  )
  if (
    !sameStrings(args, CAPTURE_DECAY_DEBUG_RUNNER_BUILD_ARGUMENTS) ||
    build?.exitCode !== 0 ||
    build?.shell !== false ||
    build?.outputDidNotExist !== true ||
    build?.cwd !== '.'
  ) {
    throw acceptanceError(
      'runner-build-execution',
      'Debug runner provenance must come from the locked successful shell-free build into a new output.'
    )
  }
  const commandSha256 = requireSha256(build?.commandSha256, 'debug build command SHA-256')
  const expectedCommandSha256 = sha256Json({ program, arguments: args, cwd: '.' })
  if (commandSha256 !== expectedCommandSha256) {
    throw acceptanceError(
      'runner-build-command-hash',
      'Debug runner build command hash does not match the executed argv/cwd.'
    )
  }
  return {
    program,
    programSha256: requireSha256(build?.programSha256, 'debug build program SHA-256'),
    programSizeBytes: positiveFileSize(build?.programSizeBytes, 'debug build program size'),
    arguments: args,
    cwd: '.',
    startedAt,
    finishedAt,
    exitCode: 0,
    shell: false,
    outputDidNotExist: true,
    commandSha256
  }
}

function normalizeRunRecordingArtifact(artifact, label) {
  const relativePath = requiredText(artifact?.relativePath, `${label} relative path`)
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw acceptanceError(
      'recording-artifact-path',
      `${label} must stay inside the evidence bundle.`
    )
  }
  const filename = requiredText(artifact?.filename, `${label} filename`)
  if (basename(relativePath) !== filename) {
    throw acceptanceError('recording-artifact-name', `${label} filename and path do not match.`)
  }
  if (!filename.toLowerCase().endsWith('.mp4')) {
    throw acceptanceError(
      'recording-artifact-container',
      `${label} must be a finalized MP4, never an unfinished MKV.`
    )
  }
  if (!Number.isSafeInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0) {
    throw acceptanceError('recording-artifact-size', `${label} must be a non-empty file.`)
  }
  return {
    filename,
    relativePath,
    sha256: requireSha256(artifact?.sha256, `${label} SHA-256`),
    sizeBytes: artifact.sizeBytes
  }
}

function normalizeRunSidecars(sidecars, { recordingArtifact, recovery, runner }) {
  const requiredRoles = recovery
    ? CAPTURE_DECAY_REQUIRED_RECOVERY_SIDECARS
    : CAPTURE_DECAY_REQUIRED_SOAK_SIDECARS
  if (!Array.isArray(sidecars) || sidecars.length !== requiredRoles.length) {
    throw acceptanceError(
      'run-sidecars',
      `${recovery ? 'Recovery' : 'Soak'} attestation must bind exactly: ${requiredRoles.join(', ')}.`
    )
  }
  const normalized = sidecars.map((sidecar, index) => {
    const role = requiredText(sidecar?.role, `run sidecar ${index + 1} role`)
    const artifact = normalizeRunArtifactDescriptor(sidecar, `run sidecar ${role}`)
    return { role, ...artifact }
  })
  if (
    !sameStrings(
      normalized.map((sidecar) => sidecar.role),
      requiredRoles
    )
  ) {
    throw acceptanceError(
      'run-sidecar-order',
      `Run sidecars must use the canonical order: ${requiredRoles.join(', ')}.`
    )
  }
  if (normalized[0].filename !== 'capture-decay-soak.csv') {
    throw acceptanceError('run-csv-sidecar', 'Raw D3 curve sidecar must be capture-decay-soak.csv.')
  }
  if (recovery) {
    const provenance = normalized[1]
    const recording = normalized[2]
    if (
      provenance.filename !== runner?.provenance?.filename ||
      provenance.sha256 !== runner?.provenance?.sha256
    ) {
      throw acceptanceError(
        'runner-provenance-sidecar',
        'Debug runner provenance sidecar does not match the runner attestation.'
      )
    }
    const normalizedRecording = normalizeRunRecordingArtifact(
      recordingArtifact,
      'recovery recording artifact'
    )
    if (
      recording.filename !== normalizedRecording.filename ||
      recording.relativePath !== normalizedRecording.relativePath ||
      recording.sha256 !== normalizedRecording.sha256 ||
      recording.sizeBytes !== normalizedRecording.sizeBytes
    ) {
      throw acceptanceError(
        'recording-sidecar',
        'Recovery recording sidecar does not match the attested recording artifact.'
      )
    }
  }
  return normalized
}

function normalizeRunArtifactDescriptor(artifact, label) {
  const relativePath = requiredText(artifact?.relativePath, `${label} relative path`)
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw acceptanceError(
      'run-sidecar-path',
      `${label} must stay inside the immutable run directory.`
    )
  }
  const filename = requiredText(artifact?.filename, `${label} filename`)
  if (basename(relativePath) !== filename) {
    throw acceptanceError('run-sidecar-name', `${label} filename and path do not match.`)
  }
  return {
    filename,
    relativePath,
    sha256: requireSha256(artifact?.sha256, `${label} SHA-256`),
    sizeBytes: positiveFileSize(artifact?.sizeBytes, `${label} size`)
  }
}

function assertCheckpointArtifactBindings(checkpoint, sidecars, { recovery }) {
  const csvSidecar = sidecars.find((sidecar) => sidecar.role === 'raw-csv')
  const checkpointCsv = checkpoint?.artifacts?.csv
  if (
    basename(requiredText(checkpointCsv?.path, 'checkpoint raw CSV path')) !==
      csvSidecar.filename ||
    checkpointCsv?.sha256 !== csvSidecar.sha256 ||
    checkpointCsv?.sizeBytes !== csvSidecar.sizeBytes
  ) {
    throw acceptanceError(
      'checkpoint-csv-binding',
      'Checkpoint raw CSV descriptor does not match its immutable attestation sidecar.'
    )
  }
  if (!recovery) return
  const recordingSidecar = sidecars.find((sidecar) => sidecar.role === 'recording')
  const checkpointRecording = checkpoint?.injectedRecoveryEvidence?.recording?.artifact
  if (
    basename(requiredText(checkpointRecording?.path, 'checkpoint recovery recording path')) !==
      recordingSidecar.filename ||
    checkpointRecording?.sha256 !== recordingSidecar.sha256 ||
    checkpointRecording?.sizeBytes !== recordingSidecar.sizeBytes
  ) {
    throw acceptanceError(
      'checkpoint-recording-binding',
      'Checkpoint recovery recording descriptor does not match its immutable attestation sidecar.'
    )
  }
}

async function loadAndVerifyRunSidecars({ attestation, recovery, runDirectory }) {
  const sidecars = normalizeRunSidecars(attestation?.sidecars, {
    recordingArtifact: attestation?.recordingArtifact,
    recovery,
    runner: attestation?.runner
  })
  const verified = new Map()
  for (const sidecar of sidecars) {
    const path = resolveContainedPath(runDirectory, sidecar.relativePath, sidecar.role)
    const artifact = await readCaptureDecayEvidenceArtifact({
      label: `${sidecar.role} sidecar`,
      path,
      readBytes: sidecar.role === 'debug-runner-provenance',
      root: runDirectory
    })
    if (artifact.sizeBytes !== sidecar.sizeBytes) {
      throw acceptanceError(
        'run-sidecar-size',
        `${sidecar.role} sidecar byte size does not match its attestation.`
      )
    }
    if (artifact.sha256 !== sidecar.sha256) {
      throw acceptanceError(
        'run-sidecar-tampered',
        `${sidecar.role} sidecar SHA-256 does not match its attestation.`
      )
    }
    verified.set(sidecar.role, { ...sidecar, bytes: artifact.bytes, path: artifact.path })
  }
  return verified
}

function assertRunRecordingArtifact(actual, attested, label) {
  const normalizedActual = normalizeRunRecordingArtifact(actual, label)
  const normalizedAttested = normalizeRunRecordingArtifact(attested, `${label} attestation`)
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedAttested)) {
    throw acceptanceError(
      'recording-artifact-binding',
      `${label} SHA-256/size/path does not match its attestation.`
    )
  }
  return normalizedActual
}

function normalizePublicationArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length < 7) {
    throw acceptanceError(
      'publication-artifacts',
      'Publication receipt has too few verified release artifacts.'
    )
  }
  const labels = new Set()
  const objectKeys = new Set()
  return artifacts.map((artifact) => {
    const normalized = normalizePublicationArtifact(artifact, 'publication artifact')
    rejectDuplicate(labels, normalized.label, 'publication-duplicate-label', 'artifact label')
    rejectDuplicate(
      objectKeys,
      normalized.objectKey,
      'publication-duplicate-object',
      'artifact object key'
    )
    return normalized
  })
}

function normalizeExactCandidatePromotion({
  acceptedRecord = null,
  artifacts,
  candidate = acceptedRecord?.candidate,
  promotedArtifacts,
  sealedCandidate,
  sealedCandidateBindingSha256 = null,
  sealedCandidateManifest
}) {
  const normalizedSealedCandidate = normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  const bindingSha256 = macosD3SealedCandidateBindingSha256(normalizedSealedCandidate)
  if (
    sealedCandidateBindingSha256 !== null &&
    requireSha256(sealedCandidateBindingSha256, 'publication sealed-candidate binding SHA-256') !==
      bindingSha256
  ) {
    throw acceptanceError(
      'publication-sealed-candidate-binding',
      'Publication receipt sealed-candidate binding digest is inconsistent.'
    )
  }
  if (
    acceptedRecord &&
    JSON.stringify(normalizedSealedCandidate) !== JSON.stringify(acceptedRecord.sealedCandidate)
  ) {
    throw acceptanceError(
      'publication-sealed-candidate-binding',
      'Publication receipt does not preserve the exact accepted sealed-candidate binding.'
    )
  }

  const normalizedManifest = normalizeMacosD3SealedCandidateManifest(sealedCandidateManifest)
  if (
    sha256Json(normalizedManifest) !== normalizedSealedCandidate.manifest.sha256 ||
    JSON.stringify(normalizedManifest) !==
      JSON.stringify(normalizedSealedCandidate.sealReceipt.document.candidateManifest)
  ) {
    throw acceptanceError(
      'publication-sealed-manifest',
      'Publication receipt candidate manifest is not the canonical accepted sealed manifest.'
    )
  }
  if (candidate) {
    assertSameCandidate(
      assertCandidateIdentity(candidate),
      normalizedManifest.candidate,
      'publication sealed candidate manifest'
    )
  }
  if (
    normalizedManifest.release.artifactSetSha256 !== normalizedSealedCandidate.artifactSetSha256
  ) {
    throw acceptanceError(
      'publication-sealed-artifact-set',
      'Publication receipt candidate manifest changed the accepted artifact-set digest.'
    )
  }

  const publicArtifacts = new Map(artifacts.map((artifact) => [artifact.label, artifact]))
  const labelRoutes = new Map([
    ['dmg', ['dmg']],
    ['sha256', ['sha256']],
    ['manifest', ['manifest', 'latest-manifest']],
    ['feed-zip', ['feed-zip']],
    ['feed-blockmap', ['feed-blockmap']],
    ['feed-manifest', ['feed-manifest']]
  ])
  const expectedMappings = macosD3CandidatePublicationArtifactMapping(normalizedManifest).flatMap(
    (sealed) => {
      const publicationLabels = labelRoutes.get(sealed.candidateLabel)
      if (!publicationLabels) {
        throw acceptanceError(
          'publication-promotion-map',
          `Unsupported sealed-candidate artifact label ${sealed.candidateLabel}.`
        )
      }
      return publicationLabels.map((publicationLabel) => {
        const published = publicArtifacts.get(publicationLabel)
        if (
          !published ||
          published.filename !== sealed.filename ||
          published.sha256 !== sealed.sha256 ||
          published.sizeBytes !== sealed.sizeBytes
        ) {
          throw acceptanceError(
            'publication-promotion-map',
            `Published ${publicationLabel} is not the exact sealed ${sealed.candidateLabel} bytes.`
          )
        }
        return {
          candidateLabel: sealed.candidateLabel,
          candidateObjectKey: sealed.sealedObjectKey,
          publicationLabel,
          publicationObjectKey: published.objectKey,
          sha256: sealed.sha256,
          sizeBytes: sealed.sizeBytes
        }
      })
    }
  )
  if (
    expectedMappings.length !== 7 ||
    !Array.isArray(promotedArtifacts) ||
    promotedArtifacts.length !== expectedMappings.length
  ) {
    throw acceptanceError(
      'publication-promotion-map',
      'Exact D3 promotion must retain exactly seven sealed-to-public artifact routes.'
    )
  }
  for (const [index, mapping] of promotedArtifacts.entries()) {
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      Array.isArray(mapping) ||
      !sameStrings(Object.keys(mapping).sort(), [
        'candidateLabel',
        'candidateObjectKey',
        'publicationLabel',
        'publicationObjectKey',
        'sha256',
        'sizeBytes'
      ]) ||
      JSON.stringify(mapping) !== JSON.stringify(expectedMappings[index])
    ) {
      throw acceptanceError(
        'publication-promotion-map',
        'Exact D3 promotion omitted, substituted, reordered, or remapped sealed candidate bytes.'
      )
    }
  }

  return {
    sealedCandidate: normalizedSealedCandidate,
    sealedCandidateBindingSha256: bindingSha256,
    sealedCandidateManifest: normalizedManifest,
    promotedArtifacts: expectedMappings
  }
}

function normalizePublicationArtifact(artifact, label) {
  const identity = normalizePublishedArtifactIdentity(artifact, label)
  const contentType = requiredText(artifact?.contentType, `${label} content type`)
  if (artifact?.immutable !== true && artifact?.immutable !== false) {
    throw acceptanceError(
      'publication-artifact-classification',
      `${label} must retain its immutable/pointer classification.`
    )
  }
  const expectedPhase = artifact.immutable ? 'immutable' : 'pointer'
  if (artifact?.phase !== expectedPhase) {
    throw acceptanceError(
      'publication-artifact-phase',
      `${label} phase does not match its immutable/pointer classification.`
    )
  }
  const allowedActions = artifact.immutable ? ['uploaded', 'reused'] : ['uploaded', 'skipped']
  const action = requiredText(artifact?.action, `${label} action`)
  if (!allowedActions.includes(action)) {
    throw acceptanceError(
      'publication-artifact-action',
      `${label} action is inconsistent with its publication phase.`
    )
  }
  return {
    ...identity,
    contentType,
    immutable: artifact.immutable,
    phase: expectedPhase,
    action,
    verification: normalizePublicationVerification(
      artifact?.verification,
      { ...identity, contentType },
      label
    )
  }
}

function normalizePublishedSealedCandidateArtifacts(
  artifacts,
  { publicationArtifacts, sealedCandidate }
) {
  if (!Array.isArray(artifacts) || artifacts.length !== MACOS_D3_CANDIDATE_ARTIFACT_LABELS.length) {
    throw acceptanceError(
      'published-release-mismatch',
      'Satisfaction requires all six downloaded public sealed-candidate artifacts.'
    )
  }
  const supplied = new Map()
  const labels = new Set()
  for (const artifact of artifacts) {
    const normalized = normalizePublishedArtifactIdentity(
      artifact,
      'downloaded public release artifact'
    )
    rejectDuplicate(
      labels,
      normalized.label,
      'published-release-mismatch',
      'downloaded public artifact label'
    )
    supplied.set(normalized.label, normalized)
  }
  const publishedByLabel = new Map(
    publicationArtifacts.map((artifact) => [artifact.label, artifact])
  )
  const sealed = captureDecayD3PublicationSubjectDescriptors(sealedCandidate).slice(2)
  return sealed.map((expected) => {
    const actual = supplied.get(expected.label)
    const published = publishedByLabel.get(expected.label)
    if (
      !actual ||
      !published ||
      actual.filename !== expected.filename ||
      actual.objectKey !== published.objectKey ||
      actual.sha256 !== expected.sha256 ||
      actual.sha256 !== published.sha256 ||
      actual.sizeBytes !== expected.sizeBytes ||
      actual.sizeBytes !== published.sizeBytes
    ) {
      throw acceptanceError(
        'published-release-mismatch',
        `Downloaded public ${expected.label} does not match its exact sealed and published bytes.`
      )
    }
    return actual
  })
}

function normalizePublishedArtifactIdentity(artifact, label) {
  const filename = requiredText(artifact?.filename, `${label} filename`)
  const objectKey = requiredText(artifact?.objectKey, `${label} object key`)
  if (objectKey.startsWith('/') || objectKey.includes('..')) {
    throw acceptanceError('publication-object-key', `${label} object key is unsafe.`)
  }
  if (!Number.isSafeInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0) {
    throw acceptanceError('publication-artifact-size', `${label} size must be a positive integer.`)
  }
  if (filename !== basename(filename) || filename !== basename(objectKey)) {
    throw acceptanceError(
      'publication-artifact-filename',
      `${label} filename must exactly match its object key basename.`
    )
  }
  return {
    label: requiredText(artifact?.label, `${label} label`),
    filename,
    objectKey,
    sha256: requireSha256(artifact?.sha256, `${label} SHA-256`),
    sizeBytes: artifact.sizeBytes
  }
}

function normalizePublicationReservation(reservation, { sealedCandidate } = {}) {
  if (reservation?.profile !== CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE) {
    throw acceptanceError(
      'publication-reservation-profile',
      `Publication receipt must retain a ${CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE} reservation.`
    )
  }
  const identity = normalizePublishedArtifactIdentity(
    {
      ...reservation,
      label: 'd3-publication-reservation',
      filename: basename(requiredText(reservation?.objectKey, 'publication reservation object key'))
    },
    'publication reservation'
  )
  if (
    reservation?.immutable !== true ||
    reservation?.phase !== 'reservation' ||
    !['adopted', 'uploaded', 'reused'].includes(reservation?.action)
  ) {
    throw acceptanceError(
      'publication-reservation-evidence',
      'Publication reservation must retain its immutable reservation-phase action.'
    )
  }
  const normalizedSealedCandidate = normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  const sealedCandidateManifestSha256 = requireSha256(
    reservation?.sealedCandidateManifestSha256,
    'reservation sealed-candidate manifest SHA-256'
  )
  const sealedCandidateArtifactSetSha256 = requireSha256(
    reservation?.sealedCandidateArtifactSetSha256,
    'reservation sealed-candidate artifact-set SHA-256'
  )
  if (
    sealedCandidateManifestSha256 !== normalizedSealedCandidate.manifest.sha256 ||
    sealedCandidateArtifactSetSha256 !== normalizedSealedCandidate.artifactSetSha256
  ) {
    throw acceptanceError(
      'publication-reservation-sealed-candidate',
      'Publication reservation does not bind the accepted sealed candidate manifest and artifact set.'
    )
  }
  return {
    profile: CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE,
    sealedCandidateManifestSha256,
    sealedCandidateArtifactSetSha256,
    objectKey: identity.objectKey,
    sha256: identity.sha256,
    sizeBytes: identity.sizeBytes,
    immutable: true,
    phase: 'reservation',
    action: reservation.action,
    verification: normalizePublicationVerification(
      reservation?.verification,
      { ...identity, contentType: 'application/json' },
      'publication reservation'
    )
  }
}

function publicationReservationCreatorWorkflow(document, publisherWorkflow, action) {
  const publisher = normalizePublicationWorkflow(publisherWorkflow)
  if (document === undefined || document === null) {
    if (action === 'adopted') {
      throw acceptanceError(
        'publication-reservation-document',
        'An adopted publication reservation must retain its original creator document.'
      )
    }
    return publisher
  }
  const workflow = document?.workflow
  if (
    workflow?.repository !== CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY ||
    workflow?.path !== CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH ||
    !/^[1-9][0-9]*$/.test(requiredText(workflow?.runId, 'reservation creator run id'))
  ) {
    throw acceptanceError(
      'publication-reservation-workflow',
      'Publication reservation creator must be a positive official workflow run.'
    )
  }
  if (action !== 'adopted' && workflow.runId !== publisher.runId) {
    throw acceptanceError(
      'publication-reservation-workflow',
      'Only an adopted publication reservation may retain a creator run distinct from the current publisher.'
    )
  }
  return { ...publisher, runId: workflow.runId }
}

function buildPublicationReservationDocument({
  acceptedRecordSha256,
  artifacts,
  destination,
  manifestSha256,
  releaseId,
  reservationObjectKey,
  sealedCandidate,
  sourceCommit,
  workflow
}) {
  const normalizedSealedCandidate = normalizeMacosD3SealedCandidateBinding(sealedCandidate)
  const normalizedWorkflow = normalizePublicationWorkflow(workflow)
  const normalizedDestination = normalizePublicationDestination(destination)
  const objectKey = requiredText(reservationObjectKey, 'publication reservation object key')
  const artifactBindings = artifacts
    .map((artifact) => ({
      immutable: artifact.immutable,
      label: artifact.label,
      objectKey: artifact.objectKey,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes
    }))
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
  const normalizedManifestSha256 = requireSha256(manifestSha256, 'publication manifest SHA-256')
  if (
    artifactBindings.find((artifact) => artifact.label === 'manifest')?.sha256 !==
    normalizedManifestSha256
  ) {
    throw acceptanceError(
      'publication-reservation-manifest',
      'Publication reservation manifest hash does not match its versioned manifest artifact.'
    )
  }
  return {
    schemaVersion: 3,
    profile: CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE,
    acceptedRecordSha256: requireSha256(
      acceptedRecordSha256,
      'reservation accepted-record SHA-256'
    ),
    sealedCandidateManifestSha256: normalizedSealedCandidate.manifest.sha256,
    sealedCandidateArtifactSetSha256: normalizedSealedCandidate.artifactSetSha256,
    workflow: {
      repository: CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
      path: CAPTURE_DECAY_D3_PUBLICATION_WORKFLOW_PATH,
      runId: normalizedWorkflow.runId,
      sourceCommit: requireCommit(sourceCommit, 'reservation source commit')
    },
    release: {
      releaseId: requiredText(releaseId, 'reservation release id'),
      manifestSha256: normalizedManifestSha256,
      artifacts: artifactBindings
    },
    destination: {
      bucket: normalizedDestination.bucket,
      endpointUrl: normalizedDestination.endpointUrl,
      forcePathStyle: normalizedDestination.forcePathStyle,
      region: normalizedDestination.region,
      releasePrefix: dirname(objectKey),
      reservationObjectKey: objectKey,
      tlsPolicy: normalizedDestination.tlsPolicy
    }
  }
}

function bindPublicationReservationDocument({ reservation, document, suppliedDocument = null }) {
  if (suppliedDocument !== null && JSON.stringify(suppliedDocument) !== JSON.stringify(document)) {
    throw acceptanceError(
      'publication-reservation-document',
      'Publication reservation document does not exactly match the accepted candidate, workflow, release, and destination.'
    )
  }
  const body = serializeJson(document)
  if (
    reservation.sha256 !== sha256Text(body) ||
    reservation.sizeBytes !== Buffer.byteLength(body)
  ) {
    throw acceptanceError(
      'publication-reservation-hash',
      'Publication reservation remote evidence does not match its canonical embedded document.'
    )
  }
  return { ...reservation, document }
}

function normalizePublicationDestinationBinding(binding, { artifacts, reservation }) {
  if (
    binding?.profile !== CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE ||
    binding?.document?.schemaVersion !== 2 ||
    binding?.document?.profile !== CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE
  ) {
    throw acceptanceError(
      'publication-destination-profile',
      `Publication receipt must retain a ${CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE} document.`
    )
  }
  const destination = normalizePublicationDestination(binding.document.destination)
  const expectedPlan = [
    ...artifacts
      .filter((artifact) => artifact.phase === 'immutable')
      .map(publicationDestinationRoute),
    {
      profile: CAPTURE_DECAY_D3_PUBLICATION_RESERVATION_PROFILE,
      label: 'd3-publication-reservation',
      filename: basename(reservation.objectKey),
      objectKey: reservation.objectKey,
      contentType: 'application/json',
      immutable: true,
      phase: 'reservation'
    },
    ...artifacts.filter((artifact) => artifact.phase === 'pointer').map(publicationDestinationRoute)
  ]
  const document = {
    schemaVersion: 2,
    profile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
    destination,
    uploadPlan: expectedPlan
  }
  if (JSON.stringify(binding.document) !== JSON.stringify(document)) {
    throw acceptanceError(
      'publication-destination-plan',
      'Publication destination binding does not exactly match the receipt artifact phases and object routes.'
    )
  }
  const digest = requireSha256(binding?.sha256, 'publication destination document SHA-256')
  if (sha256Json(document) !== digest) {
    throw acceptanceError(
      'publication-destination-hash',
      'Publication destination binding SHA-256 does not match its canonical document.'
    )
  }
  return {
    profile: CAPTURE_DECAY_D3_DESTINATION_BINDING_PROFILE,
    sha256: digest,
    document
  }
}

function normalizePublicationDestination(destination) {
  const bucket = requiredText(destination?.bucket, 'publication destination bucket')
  const region = requiredText(destination?.region, 'publication destination region')
  if (destination?.forcePathStyle !== true && destination?.forcePathStyle !== false) {
    throw acceptanceError(
      'publication-destination-config',
      'Publication destination forcePathStyle must be an explicit boolean.'
    )
  }
  let endpointUrl = destination?.endpointUrl ?? null
  if (endpointUrl !== null) {
    try {
      const url = new URL(requiredText(endpointUrl, 'publication destination endpoint URL'))
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('unsafe endpoint')
      }
      url.pathname = url.pathname.replace(/\/+$/, '')
      endpointUrl = url.toString()
    } catch {
      throw acceptanceError(
        'publication-destination-config',
        'Publication destination endpoint must be a canonical credential-free HTTPS URL.'
      )
    }
  }
  return {
    bucket,
    endpointUrl,
    forcePathStyle: destination.forcePathStyle,
    region,
    tlsPolicy: normalizePublicationTlsPolicy(destination?.tlsPolicy)
  }
}

function normalizePublicationTlsPolicy(policy) {
  if (
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    !sameStrings(Object.keys(policy).sort(), ['allowedIssuerOrganizations', 'allowedSpkiSha256'])
  ) {
    throw acceptanceError(
      'publication-destination-tls-policy',
      'Publication destination must bind exact issuer-organization and SPKI SHA-256 TLS allowlists.'
    )
  }
  const allowedIssuerOrganizations = normalizePublicationTlsPolicyEntries(
    policy.allowedIssuerOrganizations,
    'publication TLS issuer organization'
  )
  const allowedSpkiSha256 = normalizePublicationTlsPolicyEntries(
    policy.allowedSpkiSha256,
    'publication TLS SPKI SHA-256',
    (entry) => entry.toLowerCase()
  )
  if (allowedSpkiSha256.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
    throw acceptanceError(
      'publication-destination-tls-policy',
      'Publication destination TLS SPKI pins must be lowercase SHA-256 digests.'
    )
  }
  if (allowedIssuerOrganizations.length === 0 && allowedSpkiSha256.length === 0) {
    throw acceptanceError(
      'publication-destination-tls-policy',
      'Publication destination TLS policy must retain at least one issuer organization or SPKI pin.'
    )
  }
  return { allowedIssuerOrganizations, allowedSpkiSha256 }
}

function normalizePublicationTlsPolicyEntries(entries, label, transform = (entry) => entry) {
  if (!Array.isArray(entries)) {
    throw acceptanceError(
      'publication-destination-tls-policy',
      `${label} allowlist must be an array.`
    )
  }
  const normalized = entries.map((entry) => {
    const trimmed = requiredText(entry, label)
    const canonical = transform(trimmed)
    if (entry !== trimmed || canonical !== trimmed) {
      throw acceptanceError(
        'publication-destination-tls-policy',
        `${label} allowlist entries must already use their canonical form.`
      )
    }
    return canonical
  })
  const canonical = [...new Set(normalized)].sort()
  if (!sameStrings(normalized, canonical)) {
    throw acceptanceError(
      'publication-destination-tls-policy',
      `${label} allowlist must be trimmed, sorted, and distinct.`
    )
  }
  return canonical
}

function publicationDestinationRoute(artifact) {
  return {
    label: artifact.label,
    filename: artifact.filename,
    objectKey: artifact.objectKey,
    contentType: artifact.contentType,
    immutable: artifact.immutable,
    phase: artifact.phase
  }
}

function normalizePublicationVerification(verification, artifact, label) {
  if (
    verification &&
    typeof verification === 'object' &&
    !Array.isArray(verification) &&
    !Object.hasOwn(verification, 'etag')
  ) {
    throw acceptanceError(
      'publication-remote-etag',
      `${label} must retain its remote ETag field, including an explicit null value.`
    )
  }
  if (
    !verification ||
    typeof verification !== 'object' ||
    Array.isArray(verification) ||
    !sameStrings(Object.keys(verification).sort(), [
      'checksumSha256',
      'contentLength',
      'contentType',
      'etag',
      'metadataSha256',
      'sha256',
      'sizeBytes',
      'state'
    ]) ||
    verification?.state !== 'identical' ||
    verification?.sha256 !== artifact.sha256 ||
    verification?.sizeBytes !== artifact.sizeBytes ||
    verification?.contentType !== artifact.contentType ||
    verification?.contentLength !== artifact.sizeBytes ||
    verification?.metadataSha256 !== artifact.sha256 ||
    verification?.checksumSha256 !== sha256Base64(artifact.sha256)
  ) {
    throw acceptanceError(
      'publication-remote-verification',
      `${label} does not retain the exact authenticated remote response envelope.`
    )
  }
  const etag = verification?.etag ?? null
  if (
    etag !== null &&
    (typeof etag !== 'string' || etag.trim().length === 0 || /[\0\r\n]/.test(etag))
  ) {
    throw acceptanceError('publication-remote-etag', `${label} has an invalid remote ETag.`)
  }
  return {
    state: 'identical',
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    etag,
    contentType: artifact.contentType,
    contentLength: artifact.sizeBytes,
    metadataSha256: artifact.sha256,
    checksumSha256: sha256Base64(artifact.sha256)
  }
}

function normalizePublicRouteVerification(verification, { receipt }) {
  if (verification?.profile !== CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE) {
    throw acceptanceError(
      'publication-public-route-profile',
      `Satisfaction requires ${CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE} evidence.`
    )
  }
  const verifiedAt = requiredIsoTimestamp(
    verification?.verifiedAt,
    'public-route verification time'
  )
  if (
    timestampMs(verifiedAt, 'public-route verification time') < timestampMs(receipt.publishedAt)
  ) {
    throw acceptanceError(
      'publication-public-route-time',
      'Public-route verification cannot predate the publication receipt.'
    )
  }
  if (verification?.readProtocol !== 's3-sigv4-get') {
    throw acceptanceError(
      'publication-public-route-protocol',
      'Public-route verification must use authenticated S3 SigV4 GET reads.'
    )
  }
  const destination = normalizePublicationDestination(verification?.destination)
  if (
    JSON.stringify(destination) !== JSON.stringify(receipt.destinationBinding.document.destination)
  ) {
    throw acceptanceError(
      'publication-public-route-destination',
      'Public-route verification used a different publication destination.'
    )
  }

  const artifactByLabel = new Map(
    receipt.release.artifacts.map((artifact) => [artifact.label, artifact])
  )
  artifactByLabel.set('d3-publication-reservation', {
    label: 'd3-publication-reservation',
    objectKey: receipt.reservation.objectKey,
    sha256: receipt.reservation.sha256,
    sizeBytes: receipt.reservation.sizeBytes,
    contentType: 'application/json'
  })
  const expectedRoutes = receipt.destinationBinding.document.uploadPlan.map((route) => {
    const artifact = artifactByLabel.get(route.label)
    if (!artifact || artifact.objectKey !== route.objectKey) {
      throw acceptanceError(
        'publication-public-route-plan',
        `Publication receipt has no exact-byte identity for route ${route.label}.`
      )
    }
    return artifact
  })
  if (
    !Array.isArray(verification?.routes) ||
    verification.routes.length !== expectedRoutes.length
  ) {
    throw acceptanceError(
      'publication-public-route-count',
      'Public-route verification must re-read every receipt-bound artifact and reservation route.'
    )
  }
  const routes = expectedRoutes.map((expected, index) => {
    const actual = verification.routes[index]
    if (actual?.label !== expected.label || actual?.objectKey !== expected.objectKey) {
      throw acceptanceError(
        'publication-public-route-identity',
        `Public-route verification omitted, substituted, or reordered route ${expected.label}.`
      )
    }
    const { label: _label, objectKey: _objectKey, ...actualVerification } = actual
    const normalized = normalizePublicationVerification(
      actualVerification,
      expected,
      `current public route ${expected.label}`
    )
    return {
      label: expected.label,
      objectKey: expected.objectKey,
      ...normalized
    }
  })
  return {
    profile: CAPTURE_DECAY_D3_PUBLIC_ROUTE_VERIFICATION_PROFILE,
    verifiedAt,
    readProtocol: 's3-sigv4-get',
    destination,
    routes
  }
}

function resolveContainedPath(root, value, label) {
  const text = requiredText(value, `${label} path`)
  if (isAbsolute(text)) {
    throw acceptanceError('absolute-evidence-path', `${label} path must be relative.`)
  }
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, text)
  const traversal = relative(resolvedRoot, resolvedPath)
  if (traversal === '..' || traversal.startsWith(`..${sep}`)) {
    throw acceptanceError('evidence-path-traversal', `${label} path escapes the evidence bundle.`)
  }
  return resolvedPath
}

function rejectDuplicate(set, value, code, label) {
  if (set.has(value)) {
    throw acceptanceError(code, `D3 evidence contains a duplicate ${label}: ${value}.`)
  }
  set.add(value)
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw acceptanceError('invalid-json', `${label} is not valid JSON.`)
  }
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function sha256Json(value) {
  return sha256Text(serializeJson(value))
}

function sha256Base64(value) {
  return Buffer.from(requireSha256(value, 'SHA-256 response checksum'), 'hex').toString('base64')
}

function requireCommit(value, label) {
  const text = requiredText(value, label)
  if (!/^[a-f0-9]{40}$/.test(text)) {
    throw acceptanceError('invalid-commit', `${label} must be 40 lowercase hexadecimal characters.`)
  }
  return text
}

function requireGitObjectId(value, label) {
  const text = requiredText(value, label)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) {
    throw acceptanceError('invalid-git-object', `${label} must be a full Git object id.`)
  }
  return text
}

function requiredRecoverySource(value, label) {
  const source = requiredText(value, label)
  if (!CAPTURE_DECAY_REQUIRED_RECOVERY_SOURCES.includes(source)) {
    throw acceptanceError('invalid-recovery-source', `${label} must be camera or screen.`)
  }
  return source
}

function requireSha256(value, label) {
  const text = requiredText(value, label)
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw acceptanceError('invalid-sha256', `${label} must be 64 lowercase hexadecimal characters.`)
  }
  return text
}

function requiredText(value, label) {
  const text = nonEmpty(value)
  if (text === null) {
    throw acceptanceError('missing-value', `${label} is required.`)
  }
  return text
}

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 ? text : null
}

function requiredIsoTimestamp(value, label) {
  timestampMs(value, label)
  return value
}

function timestampMs(value, label) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw acceptanceError('invalid-timestamp', `${label} must be an ISO timestamp.`)
  }
  return timestamp
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function nonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function positiveProcessId(value, label) {
  if (!positiveSafeInteger(value)) {
    throw acceptanceError('invalid-process-id', `${label} must be a positive safe integer.`)
  }
  return value
}

function positiveFileSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw acceptanceError('invalid-file-size', `${label} must be a positive safe integer.`)
  }
  return value
}

function rateAtFraction(actual, expected, fraction) {
  return positiveFinite(actual) && positiveFinite(expected) && actual >= expected * fraction
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function acceptanceError(code, message) {
  return new CaptureDecayReleaseAcceptanceError(code, message)
}
