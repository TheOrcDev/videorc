import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { loadValidatedWindowsAcceptanceHistory } from './windows-acceptance-history.mjs'
import { REQUIRED_WINDOWS_ACCEPTANCE_GATES } from './windows-acceptance-record.mjs'
import { windowsCandidateIdentity, windowsCandidatePrefix } from './windows-release-candidate.mjs'

function acceptanceRecord(releaseId, previousReleaseId = null) {
  const version = releaseId.slice(0, releaseId.indexOf('-'))
  const installerSha256 = previousReleaseId ? 'b'.repeat(64) : 'a'.repeat(64)
  const sourceCommit = previousReleaseId ? 'd'.repeat(40) : 'c'.repeat(40)
  const first = previousReleaseId === null
  return {
    schemaVersion: 2,
    kind: 'videorc-windows-alpha-acceptance',
    status: 'PASS',
    releaseId,
    sourceCommit,
    candidateIdentity: windowsCandidateIdentity({ installerSha256, releaseId, sourceCommit }),
    candidateStoragePrefix: windowsCandidatePrefix({ releaseId, sourceCommit }),
    installer: {
      filename: `Videorc-${version}-win-x64.exe`,
      sha256: installerSha256,
      publisherName: 'Videorc Test Publisher'
    },
    testedAt: '2026-07-18T00:00:00.000Z',
    testPlatform: {
      operatingSystem: 'Windows 11',
      architecture: 'x64',
      physicalHardware: true
    },
    releaseSequence: first
      ? { kind: 'first-public-alpha' }
      : { kind: 'successor', previousReleaseId },
    requiredGates: Object.fromEntries(
      REQUIRED_WINDOWS_ACCEPTANCE_GATES.map((gate) => [
        gate,
        first && gate === 'alphaToAlphaUpdate'
          ? { status: 'NOT_APPLICABLE', reason: 'first-public-alpha' }
          : { status: 'PASS' }
      ])
    )
  }
}

async function writeRecord(directory, releaseId, previousReleaseId = null) {
  await writeFile(
    join(directory, `${releaseId}.json`),
    `${JSON.stringify(acceptanceRecord(releaseId, previousReleaseId), null, 2)}\n`
  )
}

describe('trusted Windows acceptance history', () => {
  it('sorts and validates the complete immediate-predecessor PASS chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-windows-history-'))
    await writeRecord(directory, '0.9.10-alpha.1', '0.9.9-alpha.1')
    await writeRecord(directory, '0.9.9-alpha.1')
    await writeFile(join(directory, 'README.md'), 'ignored')

    assert.deepEqual(await loadValidatedWindowsAcceptanceHistory(directory), [
      '0.9.9-alpha.1',
      '0.9.10-alpha.1'
    ])
  })

  it('rejects a skipped or imaginary predecessor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-windows-history-'))
    await writeRecord(directory, '0.9.9-alpha.1')
    await writeRecord(directory, '0.9.10-alpha.1', '0.9.8-alpha.1')

    await assert.rejects(loadValidatedWindowsAcceptanceHistory(directory), {
      code: 'unaccepted-previous-release'
    })
  })
})
