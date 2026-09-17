#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCaptureDecayD3CandidateCheckout,
  captureDecayGitTree
} from './lib/capture-decay-publication-git.mjs'
import {
  buildCaptureDecayAttemptLedgerManifest,
  finishCaptureDecayAttempt,
  startCaptureDecayAttempt
} from './lib/capture-decay-attempt-ledger.mjs'
import {
  assertCaptureDecayCandidateIdentityUnchanged,
  assertCaptureDecayRunChildExit,
  assertCaptureDecayDebugRunnerProvenance,
  assertCaptureDecayRunnerIdentityUnchanged,
  buildCaptureDecayRunAttestation,
  captureDecayBoundCandidateExecutablePath,
  captureDecayCandidateIdentityFromFiles,
  captureDecayCanonicalJsonSha256,
  captureDecayRunCoordinates,
  captureDecayRunnerIdentity,
  loadCaptureDecaySealedCandidateForRun,
  lockedCaptureDecayRealReleaseEnvironment
} from './lib/capture-decay-release-acceptance.mjs'
import { readCaptureDecayEvidenceArtifact } from './lib/capture-decay-evidence-artifact.mjs'
import { macosD3SealedCandidateBindingSha256 } from './lib/macos-d3-sealed-candidate.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const soakScript = join(repoRoot, 'scripts', 'smoke-capture-decay-soak.mjs')

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('capture-decay real-release evidence requires the owner macOS host')
  }
  const recovery = parseRecovery(process.argv.slice(2))
  const evidenceRoot = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_EVIDENCE_ROOT'))
  const outputDirectory = resolve(requiredEnv('VIDEORC_SMOKE_OUTPUT_DIR'))
  assertContainedRunDirectory(evidenceRoot, outputDirectory)
  const ledgerDirectory = join(evidenceRoot, 'attempt-ledger')
  const ceremonyId = requiredEnv('VIDEORC_CAPTURE_DECAY_CEREMONY_ID')
  const sourceCommit = requiredEnv('VIDEORC_CAPTURE_DECAY_SOURCE_COMMIT')
  const hostId = requiredSha256Env('VIDEORC_CAPTURE_DECAY_HOST_ID')
  const suppliedCandidateExecutablePath = resolve(
    requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_EXECUTABLE')
  )
  const candidateDmgPath = resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_DMG'))

  await assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit })
  const sourceTree = await captureDecayGitTree(repoRoot, sourceCommit)
  const candidate = await captureDecayCandidateIdentityFromFiles({
    sourceCommit,
    sourceTree,
    candidateExecutablePath: suppliedCandidateExecutablePath,
    candidateDmgPath
  })
  const sealedCandidate = await loadCaptureDecaySealedCandidateForRun({
    evidenceRoot,
    expectedCandidate: candidate,
    expectedPublicationDestinationBindingSha256: requiredSha256Env(
      'VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256'
    ),
    receiptPath: resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT'))
  })
  if (Date.parse(sealedCandidate.sealReceipt.sealedAt) >= Date.now()) {
    throw new Error('candidate seal receipt must predate every real-release attempt')
  }
  const sealedCandidateBindingSha256 = macosD3SealedCandidateBindingSha256(sealedCandidate)
  const candidateExecutablePath = captureDecayBoundCandidateExecutablePath(
    suppliedCandidateExecutablePath,
    candidate
  )
  const runnerExecutablePath = recovery
    ? resolve(requiredEnv('VIDEORC_SOAK_DEBUG_APP_EXECUTABLE'))
    : candidateExecutablePath
  const runnerBefore = await captureDecayRunnerIdentity(runnerExecutablePath, {
    requireDebugBackend: recovery
  })
  let runner = runnerBefore
  let provenanceText = null
  if (recovery) {
    provenanceText = await readFile(
      resolve(requiredEnv('VIDEORC_CAPTURE_DECAY_DEBUG_RUNNER_PROVENANCE')),
      'utf8'
    )
    const document = JSON.parse(provenanceText)
    const normalizedProvenance = assertCaptureDecayDebugRunnerProvenance(document, {
      candidate,
      runner
    })
    if (`${JSON.stringify(normalizedProvenance, null, 2)}\n` !== provenanceText) {
      throw new Error('debug runner provenance must use canonical validator JSON')
    }
    runner = {
      ...runner,
      provenance: {
        filename: 'capture-decay-debug-runner-provenance.json',
        sha256: captureDecayCanonicalJsonSha256(normalizedProvenance),
        document: normalizedProvenance
      }
    }
  }
  const coordinates = captureDecayRunCoordinates(process.env, { recovery })
  const env = lockedCaptureDecayRealReleaseEnvironment(
    captureDecaySanitizedChildEnvironment(process.env),
    { recovery }
  )
  assertCaptureDecayChildEnvironmentSafe(env)

  // The target is a write-once run directory. Even a failed/interrupted run is
  // retained and a retry must choose a new directory, preventing pass evidence
  // from silently overwriting an earlier attempt.
  await createExclusiveDirectory(outputDirectory)
  await assertRealContainedRunDirectory(evidenceRoot, outputDirectory)
  if (provenanceText !== null) {
    await writeExclusiveText(
      join(outputDirectory, 'capture-decay-debug-runner-provenance.json'),
      provenanceText
    )
  }
  await prepareAttemptLedgerDirectory(evidenceRoot, ledgerDirectory)

  const candidateCanonicalSha256 = captureDecayCanonicalJsonSha256(candidate)
  let child = null
  let childResult = null
  let attemptId = null
  const signals = installAttemptSignalHandlers(() => child)
  try {
    const startedAttempt = await startCaptureDecayAttempt({
      attemptKind: recovery ? 'recovery' : 'soak',
      candidateCanonicalSha256,
      ceremonyId,
      hostId,
      ledgerDirectory,
      sealedCandidateBindingSha256
    })
    attemptId = startedAttempt.attemptId
    const startEntrySha256 = startedAttempt.ledger.openAttempt?.startEntrySha256
    if (!startEntrySha256) {
      throw new Error('attempt ledger did not preserve the newly appended start entry')
    }
    assertAttemptNotInterrupted(signals.signal, null)
    child = spawn(
      process.execPath,
      [soakScript, '--gate', ...(recovery ? ['--recovery-gate'] : [])],
      {
        cwd: repoRoot,
        env: {
          ...env,
          VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
          VIDEORC_PACKAGED_APP_EXECUTABLE: candidateExecutablePath,
          ...(recovery
            ? {
                VIDEORC_SOAK_DEBUG_APP_EXECUTABLE: runnerExecutablePath
              }
            : {})
        },
        stdio: 'inherit'
      }
    )
    childResult = await waitForOwnedChild(child)
    assertAttemptNotInterrupted(signals.signal, childResult.signal)
    const childExit = assertCaptureDecayRunChildExit(childResult)
    const candidateAfter = await captureDecayCandidateIdentityFromFiles({
      sourceCommit,
      sourceTree,
      candidateExecutablePath,
      candidateDmgPath
    })
    assertCaptureDecayCandidateIdentityUnchanged(candidate, candidateAfter)
    const runnerAfter = await captureDecayRunnerIdentity(runnerExecutablePath, {
      requireDebugBackend: recovery
    })
    assertCaptureDecayRunnerIdentityUnchanged(runnerBefore, runnerAfter, {
      requireDebugBackend: recovery
    })
    assertAttemptNotInterrupted(signals.signal, childResult.signal)
    const checkpointPath = join(outputDirectory, 'capture-decay-soak.json')
    const checkpointArtifact = await readCaptureDecayEvidenceArtifact({
      label: 'capture-decay checkpoint',
      path: checkpointPath,
      readBytes: true,
      root: outputDirectory
    })
    const checkpoint = JSON.parse(checkpointArtifact.bytes.toString('utf8'))
    const rawCsvArtifact = await runArtifactDescriptor(
      join(outputDirectory, 'capture-decay-soak.csv'),
      outputDirectory
    )
    const recordingArtifact = recovery
      ? await recoveryRecordingArtifact(checkpoint, outputDirectory)
      : null
    const sidecars = [
      { role: 'raw-csv', ...rawCsvArtifact },
      ...(recovery
        ? [
            {
              role: 'debug-runner-provenance',
              ...(await runArtifactDescriptor(
                join(outputDirectory, 'capture-decay-debug-runner-provenance.json'),
                outputDirectory
              ))
            },
            { role: 'recording', ...recordingArtifact }
          ]
        : [])
    ]
    const attestation = buildCaptureDecayRunAttestation({
      attemptLedger: { attemptId, ceremonyId, startEntrySha256 },
      candidate,
      checkpoint,
      checkpointSha256: checkpointArtifact.sha256,
      checkpointSizeBytes: checkpointArtifact.sizeBytes,
      childExit,
      coordinates,
      hostId,
      recordingArtifact,
      recovery,
      runId: attemptId,
      runner,
      sealedCandidateBindingSha256,
      sidecars
    })
    const attestationPath = join(outputDirectory, 'capture-decay-real-release-attestation.json')
    await writeExclusiveJson(attestationPath, attestation)
    const attestationDescriptor = await evidenceArtifactDescriptor(attestationPath, evidenceRoot)
    assertAttemptNotInterrupted(signals.signal, childResult.signal)
    await finishCaptureDecayAttempt({
      attestation: attestationDescriptor,
      attemptId,
      bundleRoot: evidenceRoot,
      candidateCanonicalSha256,
      ceremonyId,
      hostId,
      ledgerDirectory,
      sealedCandidateBindingSha256,
      status: 'passed'
    })
    await writeAttemptLedgerManifestSnapshot({ evidenceRoot, ledgerDirectory })
    console.log(
      `capture-decay-real-release: wrote immutable ${recovery ? 'camera+screen recovery recording' : `soak ${coordinates.runOrdinal}`} attestation`
    )
  } catch (cause) {
    if (attemptId === null) throw cause
    const status = signals.signal !== null || childResult?.signal ? 'interrupted' : 'failed'
    let settlementError = null
    try {
      await finishCaptureDecayAttempt({
        attestation: null,
        attemptId,
        bundleRoot: evidenceRoot,
        candidateCanonicalSha256,
        ceremonyId,
        hostId,
        ledgerDirectory,
        sealedCandidateBindingSha256,
        status
      })
      await writeAttemptLedgerManifestSnapshot({ evidenceRoot, ledgerDirectory })
    } catch (error) {
      settlementError = error
    }
    if (settlementError) {
      throw new AggregateError(
        [cause, settlementError],
        `capture-decay attempt failed and its ${status} result could not be recorded`
      )
    }
    throw cause
  } finally {
    signals.cleanup()
  }
}

function parseRecovery(args) {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--recovery') return true
  throw new Error('usage: run-capture-decay-real-release.mjs [--recovery]')
}

async function recoveryRecordingArtifact(checkpoint, outputDirectory) {
  const outputPath = checkpoint?.injectedRecoveryEvidence?.recording?.outputPath
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
    throw new Error('dual recovery checkpoint is missing its recording outputPath')
  }
  const artifact = await readCaptureDecayEvidenceArtifact({
    label: 'dual recovery recording artifact',
    path: resolve(outputPath),
    root: outputDirectory
  })
  return {
    filename: artifact.filename,
    relativePath: artifact.relativePath,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  }
}

async function runArtifactDescriptor(path, outputDirectory) {
  const artifact = await readCaptureDecayEvidenceArtifact({
    label: 'capture-decay sidecar',
    path,
    root: outputDirectory
  })
  return {
    filename: artifact.filename,
    relativePath: artifact.relativePath,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  }
}

async function evidenceArtifactDescriptor(path, evidenceRoot) {
  const artifact = await readCaptureDecayEvidenceArtifact({
    label: 'attempt attestation',
    path,
    root: evidenceRoot
  })
  return {
    relativePath: artifact.relativePath,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes
  }
}

function assertContainedRunDirectory(evidenceRoot, outputDirectory) {
  const relativePath = relative(evidenceRoot, outputDirectory)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === 'attempt-ledger' ||
    relativePath.startsWith(`attempt-ledger${sep}`)
  ) {
    throw new Error(
      'VIDEORC_SMOKE_OUTPUT_DIR must be a new run directory inside the common evidence root and outside attempt-ledger'
    )
  }
}

async function assertRealContainedRunDirectory(evidenceRoot, outputDirectory) {
  const [realEvidenceRoot, realOutputDirectory] = await Promise.all([
    realpath(evidenceRoot),
    realpath(outputDirectory)
  ])
  const relativePath = relative(realEvidenceRoot, realOutputDirectory)
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('VIDEORC_SMOKE_OUTPUT_DIR resolves outside the common evidence root')
  }
}

async function prepareAttemptLedgerDirectory(evidenceRoot, ledgerDirectory) {
  await mkdir(ledgerDirectory, { recursive: true })
  const metadata = await lstat(ledgerDirectory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('attempt-ledger must be a real directory inside the common evidence root')
  }
  const [realEvidenceRoot, realLedgerDirectory] = await Promise.all([
    realpath(evidenceRoot),
    realpath(ledgerDirectory)
  ])
  const relativePath = relative(realEvidenceRoot, realLedgerDirectory)
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('attempt-ledger resolves outside the common evidence root')
  }
}

async function writeAttemptLedgerManifestSnapshot({ evidenceRoot, ledgerDirectory }) {
  try {
    const manifest = await buildCaptureDecayAttemptLedgerManifest({
      bundleRoot: evidenceRoot,
      ledgerDirectory
    })
    const path = join(ledgerDirectory, `manifest-${manifest.headEntrySha256}.json`)
    await writeExclusiveJson(path, manifest)
    console.log(`capture-decay-real-release: wrote ledger manifest snapshot ${path}`)
  } catch (error) {
    // The immutable entries are authoritative and can rebuild this convenience
    // snapshot. Never overwrite an already-settled attempt because snapshot I/O
    // failed after its result was durably appended.
    console.error(
      `capture-decay-real-release: ledger snapshot was not written (${error?.message ?? String(error)})`
    )
  }
}

async function createExclusiveDirectory(path) {
  await mkdir(path, { recursive: false })
}

async function writeExclusiveJson(path, value) {
  await writeExclusiveText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeExclusiveText(path, value) {
  const handle = await open(path, 'wx', 0o400)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directoryHandle = await open(dirname(path), 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

function waitForOwnedChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', (error) => {
      rejectChild(error)
    })
    child.once('exit', (code, signal) => {
      resolveChild({ code: code ?? signalExitCode(signal), signal })
    })
  })
}

function installAttemptSignalHandlers(currentChild) {
  const state = { signal: null }
  const handlers = new Map()
  let forceKillTimer = null
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      state.signal ??= signal
      const child = currentChild()
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal)
          forceKillTimer ??= setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              try {
                child.kill('SIGKILL')
              } catch (error) {
                console.error(
                  `capture-decay-real-release: could not force-stop interrupted child (${error?.message ?? String(error)})`
                )
              }
            }
          }, 10_000)
          forceKillTimer.unref()
        } catch (error) {
          console.error(
            `capture-decay-real-release: could not forward ${signal} (${error?.message ?? String(error)})`
          )
        }
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return {
    get signal() {
      return state.signal
    },
    cleanup() {
      if (forceKillTimer !== null) clearTimeout(forceKillTimer)
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
  }
}

function assertAttemptNotInterrupted(forwardedSignal, childSignal) {
  const signal = forwardedSignal ?? childSignal
  if (signal) {
    const error = new Error(`capture-decay attempt was interrupted by ${signal}`)
    error.signal = signal
    throw error
  }
}

function signalExitCode(signal) {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal] ?? 1
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function requiredSha256Env(name) {
  const value = requiredEnv(name)
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal characters`)
  }
  return value
}

export function captureDecaySanitizedChildEnvironment(environment) {
  const sanitized = {}
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined || isSensitiveChildEnvironmentName(name)) continue
    sanitized[name] = value
  }
  return sanitized
}

function assertCaptureDecayChildEnvironmentSafe(environment) {
  const leaked = Object.keys(environment).filter(isSensitiveChildEnvironmentName)
  if (leaked.length > 0) {
    throw new Error(
      `capture-decay child environment retained forbidden credential names: ${leaked.join(', ')}`
    )
  }
}

function isSensitiveChildEnvironmentName(name) {
  const upper = String(name).toUpperCase()
  return (
    upper === 'VIDEORC_CAPTURE_DECAY_CANDIDATE_SEAL_RECEIPT' ||
    upper === 'VIDEORC_CAPTURE_DECAY_D3_DESTINATION_BINDING_SHA256' ||
    upper.startsWith('AWS_') ||
    upper.startsWith('APPLE_') ||
    upper.startsWith('AZURE_') ||
    upper.startsWith('CLOUDFLARE_') ||
    upper.startsWith('DIGITALOCEAN_') ||
    upper.startsWith('GCP_') ||
    upper.startsWith('GOOGLE_APPLICATION_CREDENTIALS') ||
    upper.startsWith('MINIO_') ||
    upper.startsWith('R2_') ||
    upper.startsWith('SSH_') ||
    ['DOCKER_CONFIG', 'GIT_ASKPASS', 'KUBECONFIG', 'NETRC', 'NPM_CONFIG_USERCONFIG'].includes(
      upper
    ) ||
    upper.includes('_S3_') ||
    /(?:^|_)(?:ACCESS_KEY|ACCESS_KEY_ID|API_KEY|API_TOKEN|AUTH|BEARER|CERT|CERTIFICATE|CLIENT_SECRET|COOKIE|CREDENTIAL|KEY_PASSPHRASE|KEY_PASSWORD|KEYCHAIN|PASSWORD|PRIVATE_KEY|SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN|TOKEN)(?:_|$)/.test(
      upper
    ) ||
    /(?:^|_)(?:CODE_SIGN|CODESIGN|CSC|DEVELOPER_ID|GPG|GNUPG|NOTARY|NOTARIZATION|OAUTH|P12|PROVISIONING|SIGN|SIGNATURE|SIGNING)(?:_|$)/.test(
      upper
    )
  )
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(`capture-decay-real-release: FAIL (${error?.message ?? 'unexpected error'})`)
    process.exit(1)
  })
}
