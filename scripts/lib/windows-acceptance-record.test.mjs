import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyWindowsAcceptanceRecord,
  assertWindowsAcceptanceRecord,
  parseWindowsAcceptanceRecordUrl,
  REQUIRED_WINDOWS_ACCEPTANCE_GATES,
  resolveWindowsAcceptanceRecord,
  WindowsAcceptanceRecordError
} from './windows-acceptance-record.mjs'
import { windowsCandidateIdentity, windowsCandidatePrefix } from './windows-release-candidate.mjs'

const sourceCommit = 'b'.repeat(40)
const recordCommit = 'c'.repeat(40)
const installerSha256 = 'a'.repeat(64)
const releaseId = '0.10.0-alpha.1'
const filename = 'Videorc-0.10.0-win-x64.exe'
const publisherName = 'Videorc Test Publisher'
const rawUrl = `https://raw.githubusercontent.com/TheOrcDev/videorc/${recordCommit}/docs/acceptance/windows-alpha/${releaseId}.json`
const blobUrl = `https://github.com/TheOrcDev/videorc/blob/${recordCommit}/docs/acceptance/windows-alpha/${releaseId}.json`

const expectations = {
  filename,
  installerSha256,
  now: new Date('2026-07-19T00:00:00.000Z'),
  publisherName,
  releasedAt: '2026-07-18T00:00:00.000Z',
  releaseId,
  sourceCommit,
  priorAcceptedReleaseIds: ['0.9.9-alpha.1']
}

function validRecord() {
  return {
    schemaVersion: 2,
    kind: 'videorc-windows-alpha-acceptance',
    status: 'PASS',
    releaseId,
    sourceCommit,
    candidateIdentity: windowsCandidateIdentity({ installerSha256, releaseId, sourceCommit }),
    candidateStoragePrefix: windowsCandidatePrefix({ releaseId, sourceCommit }),
    installer: { filename, sha256: installerSha256, publisherName },
    testedAt: '2026-07-18T12:00:00.000Z',
    testPlatform: {
      operatingSystem: 'Windows 11',
      architecture: 'x64',
      physicalHardware: true
    },
    releaseSequence: {
      kind: 'successor',
      previousReleaseId: '0.9.9-alpha.1'
    },
    requiredGates: Object.fromEntries(
      REQUIRED_WINDOWS_ACCEPTANCE_GATES.map((gate) => [gate, { status: 'PASS' }])
    )
  }
}

function responseFor(record, overrides = {}) {
  const body = JSON.stringify(record)
  return new Response(body, {
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    },
    status: 200,
    ...overrides
  })
}

describe('Windows public acceptance URL', () => {
  it('accepts only public commit-pinned GitHub raw/blob paths in the fixed directory', () => {
    assert.equal(parseWindowsAcceptanceRecordUrl(rawUrl).canonicalRawUrl, rawUrl)
    assert.equal(parseWindowsAcceptanceRecordUrl(blobUrl).canonicalRawUrl, rawUrl)
    for (const unsafe of [
      'https://www.videorc.com/releases/0.10.0-alpha.1/acceptance',
      `https://raw.githubusercontent.com/Other/videorc/${recordCommit}/docs/acceptance/windows-alpha/a.json`,
      'https://raw.githubusercontent.com/TheOrcDev/videorc/main/docs/acceptance/windows-alpha/a.json',
      `${rawUrl}?token=secret`,
      `https://raw.githubusercontent.com@127.0.0.1/${recordCommit}/a.json`,
      `https://github.com/TheOrcDev/videorc/blob/${recordCommit}/docs/acceptance/other/a.json`
    ]) {
      assert.throws(
        () => parseWindowsAcceptanceRecordUrl(unsafe),
        (error) =>
          error instanceof WindowsAcceptanceRecordError &&
          error.code === 'unsafe-acceptance-record-url'
      )
    }
  })
})

describe('Windows acceptance record contract', () => {
  it('accepts a sanitized exact-candidate PASS record with every physical gate', () => {
    assert.equal(assertWindowsAcceptanceRecord(validRecord(), expectations).status, 'PASS')
  })

  it('permits the explicit bootstrap exception only for the first public Alpha', () => {
    const record = validRecord()
    record.releaseSequence = { kind: 'first-public-alpha' }
    record.requiredGates.alphaToAlphaUpdate = {
      status: 'NOT_APPLICABLE',
      reason: 'first-public-alpha'
    }
    assert.equal(
      assertWindowsAcceptanceRecord(record, {
        ...expectations,
        priorAcceptedReleaseIds: []
      }).status,
      'PASS'
    )
    assert.throws(
      () => assertWindowsAcceptanceRecord(record, expectations),
      WindowsAcceptanceRecordError
    )
  })

  it('rejects a syntactically lower predecessor without an exact committed PASS record', () => {
    const record = validRecord()
    record.releaseSequence.previousReleaseId = '0.9.8-alpha.1'
    assert.throws(
      () => assertWindowsAcceptanceRecord(record, expectations),
      (error) =>
        error instanceof WindowsAcceptanceRecordError &&
        error.code === 'unaccepted-previous-release'
    )
  })

  it('requires the immediately preceding PASS record rather than an older accepted alpha', () => {
    const record = validRecord()
    assert.throws(
      () =>
        assertWindowsAcceptanceRecord(record, {
          ...expectations,
          priorAcceptedReleaseIds: ['0.9.9-alpha.1', '0.9.10-alpha.1']
        }),
      (error) =>
        error instanceof WindowsAcceptanceRecordError &&
        error.code === 'unaccepted-previous-release'
    )
  })

  it('fails closed on candidate mismatch, non-PASS gate, extra fields, and nonphysical host', () => {
    const cases = [
      { ...validRecord(), sourceCommit: 'd'.repeat(40) },
      {
        ...validRecord(),
        requiredGates: {
          ...validRecord().requiredGates,
          cleanInstall: { status: 'FAIL' }
        }
      },
      { ...validRecord(), operatorEmail: 'private@example.test' },
      {
        ...validRecord(),
        testPlatform: { ...validRecord().testPlatform, physicalHardware: false }
      }
    ]
    for (const record of cases) {
      assert.throws(
        () => assertWindowsAcceptanceRecord(record, expectations),
        WindowsAcceptanceRecordError
      )
    }
  })

  it('fetches only the canonical raw URL without following redirects', async () => {
    let called
    const result = await resolveWindowsAcceptanceRecord({
      expectations,
      fetchImpl: async (url, options) => {
        called = { options, url }
        return responseFor(validRecord())
      },
      url: blobUrl
    })
    assert.equal(called.url, rawUrl)
    assert.equal(called.options.redirect, 'error')
    assert.equal(result.publicUrl, blobUrl)
    assert.equal(result.record.status, 'PASS')
  })

  it('rejects oversized and redirected fetch results', async () => {
    await assert.rejects(
      resolveWindowsAcceptanceRecord({
        expectations,
        fetchImpl: async () =>
          new Response('{}', {
            headers: { 'content-length': String(65 * 1024) },
            status: 200
          }),
        url: rawUrl
      }),
      (error) =>
        error instanceof WindowsAcceptanceRecordError &&
        error.code === 'acceptance-record-too-large'
    )
    await assert.rejects(
      resolveWindowsAcceptanceRecord({
        expectations,
        fetchImpl: async () => {
          throw new TypeError('redirect mode is error')
        },
        url: rawUrl
      }),
      (error) =>
        error instanceof WindowsAcceptanceRecordError && error.code === 'acceptance-record-fetch'
    )
  })
})

describe('accepted manifest mutation', () => {
  const manifest = {
    acceptanceRecordUrl: null,
    acceptanceStatus: 'pending',
    architecture: 'x64',
    bundleVersion: '0.10.0',
    channel: 'alpha',
    displayVersion: '0.10.0 alpha 1',
    filename,
    knownIssuesUrl: 'https://www.videorc.com/windows-alpha',
    minimumOS: 'Windows 11 or later',
    minimumWindows: 'Windows 11 or later',
    objectKey: `releases/windows/${releaseId}/${filename}`,
    platform: 'windows',
    product: 'Videorc',
    publisherName,
    releaseId,
    releasedAt: expectations.releasedAt,
    releaseNotesUrl: `https://www.videorc.com/releases/${releaseId}`,
    sha256: installerSha256,
    signingStatus: 'signed',
    sizeBytes: 123,
    sourceCommit
  }

  it('changes only the two acceptance fields after exact record verification', () => {
    const accepted = applyWindowsAcceptanceRecord({
      acceptanceRecordUrl: blobUrl,
      manifest,
      now: expectations.now,
      priorAcceptedReleaseIds: expectations.priorAcceptedReleaseIds,
      record: validRecord()
    })
    const changed = Object.keys(accepted).filter((key) => accepted[key] !== manifest[key])
    assert.deepEqual(changed.sort(), ['acceptanceRecordUrl', 'acceptanceStatus'])
    assert.equal(accepted.acceptanceStatus, 'pass')
    assert.equal(accepted.acceptanceRecordUrl, blobUrl)
  })
})
