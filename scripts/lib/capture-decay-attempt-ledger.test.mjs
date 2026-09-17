import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  buildCaptureDecayAttemptLedgerManifest,
  CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE,
  CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE,
  CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION,
  captureDecayAttemptLedgerCanonicalText,
  captureDecayAttemptLedgerSha256,
  finishCaptureDecayAttempt,
  loadAndValidateCaptureDecayAttemptLedger,
  loadCaptureDecayAttemptLedgerManifest,
  startCaptureDecayAttempt,
  validateCaptureDecayAttemptLedgerSelection
} from './capture-decay-attempt-ledger.mjs'

const candidateCanonicalSha256 = 'a'.repeat(64)
const hostId = 'b'.repeat(64)
const sealedCandidateBindingSha256 = 'c'.repeat(64)
const ceremonyId = 'd3-2026-08-28-owner-mac'
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('capture-decay attempt ledger', () => {
  it('builds and reloads an exact immutable chain and selects the qualifying attempts', async () => {
    const fixture = await ceremonyFixture()
    const soakDigests = []
    for (let index = 1; index <= 3; index += 1) {
      const digest = await passedAttempt(fixture, {
        attemptId: `soak-${index}`,
        attemptKind: 'soak',
        minute: index
      })
      soakDigests.push(digest)
    }
    const recoveryDigest = await passedAttempt(fixture, {
      attemptId: 'recovery-1',
      attemptKind: 'recovery',
      minute: 4
    })

    const manifest = await buildCaptureDecayAttemptLedgerManifest({
      bundleRoot: fixture.root,
      ledgerDirectory: fixture.ledgerDirectory
    })
    assert.equal(manifest.entryCount, 8)
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.profile, 'capture-decay-attempt-ledger-manifest-v2')
    assert.equal(manifest.profile, CAPTURE_DECAY_ATTEMPT_LEDGER_MANIFEST_PROFILE)
    assert.equal(manifest.sealedCandidateBindingSha256, sealedCandidateBindingSha256)
    assert.equal(manifest.entries[0].relativePath, 'attempt-ledger/entry-000001.json')
    assert.equal(manifest.entries.at(-1).sha256, manifest.headEntrySha256)
    for (const entry of await ledgerEntries(fixture)) {
      assert.equal(entry.schemaVersion, CAPTURE_DECAY_ATTEMPT_LEDGER_SCHEMA_VERSION)
      assert.equal(entry.profile, CAPTURE_DECAY_ATTEMPT_LEDGER_ENTRY_PROFILE)
      assert.equal(entry.sealedCandidateBindingSha256, sealedCandidateBindingSha256)
    }

    const manifestPath = join(fixture.root, 'attempt-ledger-manifest.json')
    await writeFile(manifestPath, captureDecayAttemptLedgerCanonicalText(manifest))
    const ledger = await loadCaptureDecayAttemptLedgerManifest({
      expectedCandidateCanonicalSha256: candidateCanonicalSha256,
      expectedCeremonyId: ceremonyId,
      expectedHostId: hostId,
      expectedSealedCandidateBindingSha256: sealedCandidateBindingSha256,
      manifestPath
    })
    await assert.rejects(
      () =>
        loadCaptureDecayAttemptLedgerManifest({
          expectedCandidateCanonicalSha256: candidateCanonicalSha256,
          expectedCeremonyId: ceremonyId,
          expectedHostId: hostId,
          expectedSealedCandidateBindingSha256: 'd'.repeat(64),
          manifestPath
        }),
      hasCode('ledger-identity')
    )
    assert.equal(ledger.attempts.length, 4)
    assert.deepEqual(
      validateCaptureDecayAttemptLedgerSelection({
        ledger,
        selectedRecoveryAttestationSha256: recoveryDigest,
        selectedSoakAttestationSha256s: soakDigests
      }),
      {
        recoveryAttemptId: 'recovery-1',
        soakAttemptIds: ['soak-1', 'soak-2', 'soak-3']
      }
    )
  })

  it('closes an unmatched start as interrupted before starting the next attempt', async () => {
    const fixture = await ceremonyFixture()
    await start(fixture, {
      attemptId: 'abandoned',
      attemptKind: 'soak',
      minute: 1
    })
    const next = await start(fixture, {
      attemptId: 'replacement',
      attemptKind: 'soak',
      minute: 2
    })
    assert.equal(next.autoInterruptedAttemptId, 'abandoned')
    assert.equal(next.ledger.entries.length, 3)
    assert.equal(next.ledger.entries[1].status, 'interrupted')
    assert.equal(next.ledger.entries[2].attemptId, 'replacement')

    await finish(fixture, {
      attemptId: 'replacement',
      finishedMinute: 3,
      status: 'failed'
    })
    await assert.rejects(
      () =>
        finish(fixture, {
          attemptId: 'replacement',
          finishedMinute: 4,
          status: 'failed'
        }),
      hasCode('no-open-attempt')
    )
  })

  it('requires the selected soaks to be the latest trailing three-pass streak', async () => {
    const fixture = await ceremonyFixture()
    const oldPass = await passedAttempt(fixture, {
      attemptId: 'old-pass',
      attemptKind: 'soak',
      minute: 1
    })
    await start(fixture, { attemptId: 'failed', attemptKind: 'soak', minute: 2 })
    await finish(fixture, { attemptId: 'failed', finishedMinute: 3, status: 'failed' })

    const latest = []
    for (let index = 0; index < 3; index += 1) {
      latest.push(
        await passedAttempt(fixture, {
          attemptId: `latest-${index + 1}`,
          attemptKind: 'soak',
          minute: 4 + index
        })
      )
    }
    const recovery = await passedAttempt(fixture, {
      attemptId: 'recovery',
      attemptKind: 'recovery',
      minute: 7
    })
    const ledger = await builtLedger(fixture)

    assert.throws(
      () =>
        validateCaptureDecayAttemptLedgerSelection({
          ledger,
          selectedRecoveryAttestationSha256: recovery,
          selectedSoakAttestationSha256s: [oldPass, latest[0], latest[1]]
        }),
      hasCode('soak-selection-not-latest-streak')
    )
    assert.doesNotThrow(() =>
      validateCaptureDecayAttemptLedgerSelection({
        ledger,
        selectedRecoveryAttestationSha256: recovery,
        selectedSoakAttestationSha256s: latest
      })
    )
  })

  it('rejects an open ledger, attestation reuse, and identity changes', async () => {
    const fixture = await ceremonyFixture()
    const opened = await start(fixture, { attemptId: 'open', attemptKind: 'soak', minute: 1 })
    await assert.rejects(
      () =>
        buildCaptureDecayAttemptLedgerManifest({
          bundleRoot: fixture.root,
          ledgerDirectory: fixture.ledgerDirectory
        }),
      hasCode('open-attempt')
    )
    await assert.rejects(
      () =>
        startCaptureDecayAttempt({
          ...identity(fixture),
          attemptId: 'wrong-host',
          attemptKind: 'soak',
          hostId: 'c'.repeat(64),
          startedAt: atMinute(2)
        }),
      hasCode('ledger-identity')
    )
    const descriptor = await attestation(
      fixture,
      'open',
      opened.ledger.openAttempt.startEntrySha256
    )
    await finishCaptureDecayAttempt({
      ...identity(fixture),
      attestation: descriptor,
      attemptId: 'open',
      finishedAt: atMinute(2),
      status: 'passed'
    })
    await start(fixture, { attemptId: 'reuser', attemptKind: 'soak', minute: 3 })
    await assert.rejects(
      () =>
        finishCaptureDecayAttempt({
          ...identity(fixture),
          attestation: descriptor,
          attemptId: 'reuser',
          finishedAt: atMinute(4),
          status: 'passed'
        }),
      hasCode('attestation-reuse')
    )
  })

  it('requires every passed attestation to bind its exact start entry', async () => {
    const fixture = await ceremonyFixture()
    await start(fixture, { attemptId: 'misbound', attemptKind: 'soak', minute: 1 })
    const descriptor = await attestation(fixture, 'misbound', 'f'.repeat(64))
    await assert.rejects(
      () =>
        finishCaptureDecayAttempt({
          ...identity(fixture),
          attestation: descriptor,
          attemptId: 'misbound',
          finishedAt: atMinute(2),
          status: 'passed'
        }),
      hasCode('attestation-attempt-binding')
    )
  })

  it('rejects mixed sealed-candidate bindings in ledger entries and run attestations', async () => {
    const ledgerFixture = await ceremonyFixture()
    await start(ledgerFixture, { attemptId: 'mixed-ledger', attemptKind: 'soak', minute: 1 })
    await finish(ledgerFixture, {
      attemptId: 'mixed-ledger',
      finishedMinute: 2,
      status: 'failed'
    })
    const resultPath = join(ledgerFixture.ledgerDirectory, 'entry-000002.json')
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    result.sealedCandidateBindingSha256 = 'd'.repeat(64)
    await chmod(resultPath, 0o600)
    await writeFile(resultPath, captureDecayAttemptLedgerCanonicalText(result))
    await assert.rejects(
      () =>
        buildCaptureDecayAttemptLedgerManifest({
          bundleRoot: ledgerFixture.root,
          ledgerDirectory: ledgerFixture.ledgerDirectory
        }),
      hasCode('ledger-identity')
    )

    const attestationFixture = await ceremonyFixture()
    const started = await start(attestationFixture, {
      attemptId: 'mixed-attestation',
      attemptKind: 'soak',
      minute: 1
    })
    const descriptor = await attestation(
      attestationFixture,
      'mixed-attestation',
      started.ledger.openAttempt.startEntrySha256,
      { sealedBindingSha256: 'd'.repeat(64) }
    )
    await assert.rejects(
      () =>
        finishCaptureDecayAttempt({
          ...identity(attestationFixture),
          attestation: descriptor,
          attemptId: 'mixed-attestation',
          finishedAt: atMinute(2),
          status: 'passed'
        }),
      hasCode('attestation-attempt-binding')
    )
  })

  it('requires a lowercase sealed-candidate SHA-256 identity', async () => {
    const fixture = await ceremonyFixture()
    await assert.rejects(
      () =>
        startCaptureDecayAttempt({
          ...identity(fixture),
          attemptId: 'uppercase-seal',
          attemptKind: 'soak',
          sealedCandidateBindingSha256: 'C'.repeat(64),
          startedAt: atMinute(1)
        }),
      hasCode('invalid-sha256')
    )
  })

  it('detects manifest omission, reordering, traversal, and entry tampering', async () => {
    const fixture = await ceremonyFixture()
    await passedAttempt(fixture, {
      attemptId: 'soak',
      attemptKind: 'soak',
      minute: 1
    })
    const manifest = await buildCaptureDecayAttemptLedgerManifest({
      bundleRoot: fixture.root,
      ledgerDirectory: fixture.ledgerDirectory
    })

    await assert.rejects(
      () =>
        loadAndValidateCaptureDecayAttemptLedger({
          manifest: { ...manifest, entries: manifest.entries.slice(1), entryCount: 1 },
          manifestDirectory: fixture.root
        }),
      hasCode('manifest-entry-set')
    )
    await assert.rejects(
      () =>
        loadAndValidateCaptureDecayAttemptLedger({
          manifest: { ...manifest, entries: [...manifest.entries].reverse() },
          manifestDirectory: fixture.root
        }),
      hasCode('manifest-entry-order')
    )
    await assert.rejects(
      () =>
        loadAndValidateCaptureDecayAttemptLedger({
          manifest: {
            ...manifest,
            entries: [
              { ...manifest.entries[0], relativePath: '../escaped.json' },
              manifest.entries[1]
            ]
          },
          manifestDirectory: fixture.root
        }),
      hasCode('path-traversal')
    )
    await assert.rejects(
      () =>
        loadAndValidateCaptureDecayAttemptLedger({
          manifest: { ...manifest, sealedCandidateBindingSha256: 'd'.repeat(64) },
          manifestDirectory: fixture.root
        }),
      hasCode('ledger-identity')
    )

    const entryPath = join(fixture.ledgerDirectory, 'entry-000001.json')
    await chmod(entryPath, 0o600)
    await writeFile(entryPath, `${await readFile(entryPath, 'utf8')} `)
    await assert.rejects(
      () =>
        loadAndValidateCaptureDecayAttemptLedger({
          manifest,
          manifestDirectory: fixture.root
        }),
      hasCode('entry-noncanonical')
    )
  })

  it('rejects a canonically rewritten entry with a broken predecessor hash', async () => {
    const fixture = await ceremonyFixture()
    await passedAttempt(fixture, {
      attemptId: 'soak',
      attemptKind: 'soak',
      minute: 1
    })
    const resultPath = join(fixture.ledgerDirectory, 'entry-000002.json')
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    result.previousEntrySha256 = 'f'.repeat(64)
    await chmod(resultPath, 0o600)
    await writeFile(resultPath, captureDecayAttemptLedgerCanonicalText(result))

    await assert.rejects(
      () =>
        buildCaptureDecayAttemptLedgerManifest({
          bundleRoot: fixture.root,
          ledgerDirectory: fixture.ledgerDirectory
        }),
      hasCode('entry-chain')
    )
  })

  it('rechecks the passed attestation bytes while building and loading the manifest', async () => {
    const fixture = await ceremonyFixture()
    await passedAttempt(fixture, {
      attemptId: 'soak',
      attemptKind: 'soak',
      minute: 1
    })
    const attestationPath = join(
      fixture.root,
      'runs/soak/capture-decay-real-release-attestation.json'
    )
    const changed = JSON.parse(await readFile(attestationPath, 'utf8'))
    changed.attemptId = 'sook'
    await writeFile(attestationPath, captureDecayAttemptLedgerCanonicalText(changed))
    await assert.rejects(
      () =>
        buildCaptureDecayAttemptLedgerManifest({
          bundleRoot: fixture.root,
          ledgerDirectory: fixture.ledgerDirectory
        }),
      hasCode('attestation-sha256')
    )
  })

  it('rejects recovery evidence that is not a distinct passed attempt after soak three', async () => {
    const fixture = await ceremonyFixture()
    const earlyRecovery = await passedAttempt(fixture, {
      attemptId: 'early-recovery',
      attemptKind: 'recovery',
      minute: 1
    })
    const soaks = []
    for (let index = 0; index < 3; index += 1) {
      soaks.push(
        await passedAttempt(fixture, {
          attemptId: `soak-${index + 1}`,
          attemptKind: 'soak',
          minute: index + 2
        })
      )
    }
    const ledger = await builtLedger(fixture)
    assert.throws(
      () =>
        validateCaptureDecayAttemptLedgerSelection({
          ledger,
          selectedRecoveryAttestationSha256: earlyRecovery,
          selectedSoakAttestationSha256s: soaks
        }),
      hasCode('recovery-not-final-attempt')
    )
  })

  it('rejects a selected recovery when any later ceremony attempt completed', async () => {
    const fixture = await ceremonyFixture()
    const soaks = []
    for (let index = 0; index < 3; index += 1) {
      soaks.push(
        await passedAttempt(fixture, {
          attemptId: `soak-${index + 1}`,
          attemptKind: 'soak',
          minute: index + 1
        })
      )
    }
    const recovery = await passedAttempt(fixture, {
      attemptId: 'selected-recovery',
      attemptKind: 'recovery',
      minute: 4
    })
    await start(fixture, { attemptId: 'later-recovery', attemptKind: 'recovery', minute: 5 })
    await finish(fixture, {
      attemptId: 'later-recovery',
      finishedMinute: 6,
      status: 'failed'
    })

    const ledger = await builtLedger(fixture)
    assert.throws(
      () =>
        validateCaptureDecayAttemptLedgerSelection({
          ledger,
          selectedRecoveryAttestationSha256: recovery,
          selectedSoakAttestationSha256s: soaks
        }),
      hasCode('recovery-not-final-attempt')
    )
  })
})

async function ceremonyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'capture-decay-ledger-'))
  roots.push(root)
  const ledgerDirectory = join(root, 'attempt-ledger')
  await mkdir(ledgerDirectory)
  return { root, ledgerDirectory }
}

function identity(fixture) {
  return {
    candidateCanonicalSha256,
    ceremonyId,
    hostId,
    ledgerDirectory: fixture.ledgerDirectory,
    sealedCandidateBindingSha256
  }
}

function start(fixture, { attemptId, attemptKind, minute }) {
  return startCaptureDecayAttempt({
    ...identity(fixture),
    attemptId,
    attemptKind,
    startedAt: atMinute(minute)
  })
}

function finish(fixture, { attemptId, finishedMinute, status }) {
  return finishCaptureDecayAttempt({
    ...identity(fixture),
    attestation: null,
    attemptId,
    finishedAt: atMinute(finishedMinute),
    status
  })
}

async function passedAttempt(fixture, { attemptId, attemptKind, minute }) {
  const started = await start(fixture, { attemptId, attemptKind, minute })
  const descriptor = await attestation(
    fixture,
    attemptId,
    started.ledger.openAttempt.startEntrySha256
  )
  await finishCaptureDecayAttempt({
    ...identity(fixture),
    attestation: descriptor,
    attemptId,
    finishedAt: atMinute(minute, 30),
    status: 'passed'
  })
  return descriptor.sha256
}

async function attestation(
  fixture,
  attemptId,
  startEntrySha256,
  { sealedBindingSha256 = sealedCandidateBindingSha256 } = {}
) {
  const relativePath = `runs/${attemptId}/capture-decay-real-release-attestation.json`
  const absolutePath = join(fixture.root, relativePath)
  await mkdir(join(fixture.root, 'runs', attemptId), { recursive: true })
  const document = attestationDocument(attemptId, startEntrySha256, sealedBindingSha256)
  const text = captureDecayAttemptLedgerCanonicalText(document)
  await writeFile(absolutePath, text)
  return {
    relativePath,
    sha256: captureDecayAttemptLedgerSha256(document),
    sizeBytes: Buffer.byteLength(text)
  }
}

function attestationDocument(attemptId, startEntrySha256, sealedBindingSha256) {
  return {
    attemptId,
    passed: true,
    attemptLedger: { attemptId, ceremonyId, startEntrySha256 },
    sealedCandidateBindingSha256: sealedBindingSha256
  }
}

async function ledgerEntries(fixture) {
  const entries = []
  for (let index = 1; ; index += 1) {
    const name = `entry-${String(index).padStart(6, '0')}.json`
    try {
      entries.push(JSON.parse(await readFile(join(fixture.ledgerDirectory, name), 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
  assert.ok(entries.length > 0)
  return entries
}

async function builtLedger(fixture) {
  const manifest = await buildCaptureDecayAttemptLedgerManifest({
    bundleRoot: fixture.root,
    ledgerDirectory: fixture.ledgerDirectory
  })
  return loadAndValidateCaptureDecayAttemptLedger({
    manifest,
    manifestDirectory: fixture.root
  })
}

function atMinute(minute, seconds = 0) {
  return new Date(Date.UTC(2026, 7, 28, 12, minute, seconds)).toISOString()
}

function hasCode(code) {
  return (error) => error?.code === code
}
