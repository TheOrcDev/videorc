import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildMacosD3SealedCandidatePlan,
  canonicalMacosD3Json,
  downloadMacosD3SealedCandidate,
  inspectMacosD3RemoteArtifact,
  MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME,
  MACOS_D3_EXPECTED_SIGNING_AUTHORITY,
  MACOS_D3_EXPECTED_SIGNING_PUBLISHER,
  MACOS_D3_EXPECTED_SIGNING_TEAM_ID,
  MACOS_D3_PUBLICATION_VERIFICATION_FILENAME,
  macosD3CandidateArtifactMap,
  macosD3CandidatePublicationArtifactMapping,
  macosD3CandidateSealSummary,
  normalizeMacosD3UpdateFeedForSealing,
  normalizeMacosD3SealedCandidateBinding,
  normalizeMacosD3SealedCandidateManifest,
  sha256MacosD3CanonicalJson,
  stageMacosD3SealedCandidate,
  validateZipCentralDirectory,
  verifyDownloadedMacosD3SealedCandidate,
  verifyMacosD3ReleaseArtifactAuthenticity,
  writeMacosD3PublicationVerificationDescriptor,
  writeMacosD3CanonicalJsonExclusive
} from './macos-d3-sealed-candidate.mjs'

const sourceCommit = 'a'.repeat(40)
const sourceTree = 'b'.repeat(40)
const destinationBindingSha256 = 'd'.repeat(64)
const releasedAt = '2026-08-28T12:00:00.000Z'

const storageConfig = Object.freeze({
  accessKeyId: 'CANDIDATETEST',
  bucket: 'videorc-candidates',
  endpointUrl: 'https://candidate.example.test/',
  forcePathStyle: true,
  region: 'auto',
  secretAccessKey: 'candidate-secret',
  sessionToken: null,
  tlsPolicy: {
    allowedIssuerOrganizations: ['Test CA'],
    allowedSpkiSha256: []
  }
})

const appBundle = Object.freeze({
  profile: 'capture-decay-app-bundle-v1',
  bundleFilename: 'Videorc.app',
  executableRelativePath: 'Contents/MacOS/Videorc',
  manifestSha256: 'e'.repeat(64),
  entryCount: 12,
  regularFileCount: 8,
  totalRegularFileSizeBytes: 1_024
})

const validDmgSigningDetails = [
  'Executable=/release/Videorc.dmg',
  'Authority=Developer ID Application: Uros Miric (C2PA37RB58)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=C2PA37RB58'
].join('\n')

describe('sealed macOS D3 candidate plan', () => {
  it('canonically binds exactly the six signed release/update artifacts', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      assert.deepEqual(
        plan.document.release.artifacts.map((artifact) => artifact.label),
        ['dmg', 'sha256', 'manifest', 'feed-zip', 'feed-blockmap', 'feed-manifest']
      )
      assert.equal(
        plan.document.release.artifactSetSha256,
        sha256MacosD3CanonicalJson(plan.document.release.artifacts)
      )
      assert.equal(
        plan.manifestArtifact.sha256,
        sha256Hex(Buffer.from(canonicalMacosD3Json(plan.document)))
      )
      assert.equal(
        plan.document.storage.prefix,
        `candidates/macos/capture-decay-d3/1.2.3-beta.4/${sourceCommit}/${fixture.candidate.dmgSha256}`
      )
      assert.deepEqual(Object.keys(macosD3CandidateArtifactMap(plan.document)), [
        'dmg',
        'sha256',
        'manifest',
        'feed-zip',
        'feed-blockmap',
        'feed-manifest'
      ])
      assert.deepEqual(
        macosD3CandidatePublicationArtifactMapping(plan.document).map((entry) => entry.sha256),
        plan.document.release.artifacts.map((entry) => entry.sha256)
      )
    })
  })

  it('normalizes the standard Electron Builder ZIP + DMG feed before sealing', async () => {
    await withFixture(async (fixture) => {
      const zipBytesValue = await readFile(fixture.paths.zip)
      const dmgBytesValue = await readFile(fixture.paths.dmg)
      const zipSha512 = createHash('sha512').update(zipBytesValue).digest('base64')
      const dmgSha512 = createHash('sha512').update(dmgBytesValue).digest('base64')
      await writeFile(
        fixture.paths.feed,
        [
          'version: 1.2.3',
          'files:',
          `  - url: Videorc-1.2.3-mac-arm64.zip`,
          `    sha512: ${zipSha512}`,
          `    size: ${zipBytesValue.byteLength}`,
          `  - url: Videorc-1.2.3-mac-arm64.dmg`,
          `    sha512: ${dmgSha512}`,
          `    size: ${dmgBytesValue.byteLength}`,
          'path: Videorc-1.2.3-mac-arm64.zip',
          `sha512: ${zipSha512}`,
          `releaseDate: ${releasedAt}`,
          ''
        ].join('\n')
      )

      await normalizeMacosD3UpdateFeedForSealing({
        candidate: fixture.candidate,
        manifestPath: fixture.paths.manifest,
        releaseDir: fixture.releaseDir
      })
      const normalized = await readFile(fixture.paths.feed, 'utf8')
      assert.match(normalized, /Videorc-1\.2\.3-mac-arm64\.zip/)
      assert.doesNotMatch(normalized, /\.dmg/)
      assert.doesNotMatch(normalized, /\r/)
      await fixture.buildPlan()
    })
  })

  it('refuses to normalize an Electron Builder feed with an unsealed file', async () => {
    await withFixture(async (fixture) => {
      const feed = await readFile(fixture.paths.feed, 'utf8')
      await writeFile(
        fixture.paths.feed,
        feed.replace(
          'path: Videorc-1.2.3-mac-arm64.zip',
          [
            '  - url: unexpected.pkg',
            `    sha512: ${createHash('sha512').update('unexpected').digest('base64')}`,
            '    size: 10',
            'path: Videorc-1.2.3-mac-arm64.zip'
          ].join('\n')
        )
      )
      await assert.rejects(
        normalizeMacosD3UpdateFeedForSealing({
          candidate: fixture.candidate,
          manifestPath: fixture.paths.manifest,
          releaseDir: fixture.releaseDir
        }),
        hasCode('candidate-feed-files')
      )
    })
  })

  it('rejects traversal and duplicate artifact routes', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const traversal = structuredClone(plan.document)
      traversal.release.artifacts[1].objectKey = '../escape'
      traversal.release.artifactSetSha256 = sha256MacosD3CanonicalJson(traversal.release.artifacts)
      assert.throws(
        () => normalizeMacosD3SealedCandidateManifest(traversal),
        hasCode('candidate-object-key')
      )

      const duplicate = structuredClone(plan.document)
      duplicate.release.artifacts[3].filename = duplicate.release.artifacts[0].filename
      duplicate.release.artifacts[3].objectKey = duplicate.release.artifacts[0].objectKey
      duplicate.release.artifactSetSha256 = sha256MacosD3CanonicalJson(duplicate.release.artifacts)
      assert.throws(
        () => normalizeMacosD3SealedCandidateManifest(duplicate),
        hasCode('candidate-artifact-duplicate')
      )
    })
  })

  it('rejects missing and oversized local payloads before any stage', async () => {
    await withFixture(async (fixture) => {
      await unlink(fixture.paths.blockmap)
      await assert.rejects(fixture.buildPlan(), hasCode('candidate-file-missing'))
    })
    await withFixture(async (fixture) => {
      await writeFile(fixture.paths.sidecar, Buffer.alloc(1_025, 120))
      await assert.rejects(fixture.buildPlan(), hasCode('candidate-file-type'))
    })
  })

  it('detects payload and executable mutation during bundle verification', async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(
        fixture.buildPlan({
          verifyDmgAppBundle: async () => {
            await writeFile(fixture.paths.dmg, 'mutated-dmg')
          }
        }),
        hasCode('candidate-artifact-mutated')
      )
    })
    await withFixture(async (fixture) => {
      await assert.rejects(
        fixture.buildPlan({
          verifyZipAppBundle: async () => {
            await writeFile(fixture.paths.executable, 'mutated-executable')
          }
        }),
        hasCode('candidate-executable-mutated')
      )
    })
  })
})

describe('sealed candidate macOS authenticity gate', () => {
  it('requires the real validator to pass and pins the exact Videorc signing identity', async () => {
    assert.equal(MACOS_D3_EXPECTED_SIGNING_PUBLISHER, 'Uros Miric')
    assert.equal(MACOS_D3_EXPECTED_SIGNING_TEAM_ID, 'C2PA37RB58')
    assert.equal(
      MACOS_D3_EXPECTED_SIGNING_AUTHORITY,
      'Developer ID Application: Uros Miric (C2PA37RB58)'
    )
    const dmgPath = resolve('/release/Videorc.dmg')
    const calls = []
    const verified = await verifyMacosD3ReleaseArtifactAuthenticity(
      { dmgPath },
      {
        runArtifactValidation: async (path) => {
          calls.push(['validate', path])
          return { ok: true }
        },
        readSigningDetails: async (path) => {
          calls.push(['identity', path])
          return validDmgSigningDetails
        }
      }
    )
    assert.deepEqual(verified, {
      authority: 'Developer ID Application: Uros Miric (C2PA37RB58)',
      publisher: 'Uros Miric',
      teamId: 'C2PA37RB58'
    })
    assert.deepEqual(calls, [
      ['validate', dmgPath],
      ['identity', dmgPath]
    ])
  })

  it('rejects unsigned, unnotarized, unstapled, and otherwise unverifiable artifacts', async () => {
    for (const failure of [
      'code object is not signed at all',
      'Gatekeeper rejected the artifact',
      'stapler validate failed'
    ]) {
      await assert.rejects(
        verifyMacosD3ReleaseArtifactAuthenticity(
          { dmgPath: '/release/Videorc.dmg' },
          {
            runArtifactValidation: async () => {
              throw new Error(failure)
            }
          }
        ),
        hasCode('candidate-authenticity-validation')
      )
    }

    await assert.rejects(
      verifyMacosD3ReleaseArtifactAuthenticity(
        { dmgPath: '/release/Videorc.dmg' },
        { runArtifactValidation: async () => undefined }
      ),
      hasCode('candidate-authenticity-unverifiable')
    )
    await assert.rejects(
      verifyMacosD3ReleaseArtifactAuthenticity(
        { dmgPath: '/release/Videorc.dmg' },
        {
          runArtifactValidation: async () => ({ ok: true }),
          readSigningDetails: async () => {
            throw new Error('codesign unavailable')
          }
        }
      ),
      hasCode('candidate-authenticity-unverifiable')
    )
  })

  it('rejects a wrong signing publisher, wrong Team ID, or incomplete identity output', async () => {
    const verifyDetails = (signingDetails) =>
      verifyMacosD3ReleaseArtifactAuthenticity(
        { dmgPath: '/release/Videorc.dmg' },
        {
          runArtifactValidation: async () => ({ ok: true }),
          readSigningDetails: async () => signingDetails
        }
      )

    await assert.rejects(
      verifyDetails(validDmgSigningDetails.replace('Uros Miric', 'Impostor Publisher')),
      hasCode('candidate-authenticity-publisher')
    )
    await assert.rejects(
      verifyDetails(
        validDmgSigningDetails.replace('TeamIdentifier=C2PA37RB58', 'TeamIdentifier=BADTEAM123')
      ),
      hasCode('candidate-authenticity-team-id')
    )
    await assert.rejects(
      verifyDetails('Signature=adhoc\nTeamIdentifier=C2PA37RB58'),
      hasCode('candidate-authenticity-unverifiable')
    )
  })
})

describe('sealed candidate immutable staging', () => {
  it('uploads six payloads first and the canonical manifest as the commit marker', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const transport = new MemoryS3Transport(storageConfig)
      const receipt = await stageMacosD3SealedCandidate(plan, {
        now: () => new Date(releasedAt),
        transport,
        verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
      })
      assert.deepEqual(
        transport.puts,
        [...plan.artifacts, plan.manifestArtifact].map((artifact) => artifact.objectKey)
      )
      assert.equal(transport.puts.at(-1), plan.document.storage.manifestObjectKey)
      assert.deepEqual(
        receipt.objects.map((entry) => entry.action),
        Array(7).fill('uploaded')
      )
      assert.deepEqual(
        normalizeMacosD3SealedCandidateBinding(macosD3CandidateSealSummary(receipt)),
        macosD3CandidateSealSummary(receipt)
      )
    })
  })

  it('supports an idempotent retry without rewriting immutable objects', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const transport = new MemoryS3Transport(storageConfig)
      await stageMacosD3SealedCandidate(plan, {
        transport,
        verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
      })
      transport.puts.length = 0
      const retry = await stageMacosD3SealedCandidate(plan, {
        transport,
        verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
      })
      assert.deepEqual(transport.puts, [])
      assert.deepEqual(
        retry.objects.map((entry) => entry.action),
        Array(7).fill('reused')
      )
    })
  })

  it('resumes a partial stage and still commits the manifest last', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const transport = new MemoryS3Transport(storageConfig)
      await transport.seedArtifact(plan.artifacts[0])
      await transport.seedArtifact(plan.artifacts[1])
      const receipt = await stageMacosD3SealedCandidate(plan, {
        transport,
        verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
      })
      assert.deepEqual(
        receipt.objects.slice(0, 2).map((entry) => entry.action),
        ['reused', 'reused']
      )
      assert.equal(transport.puts.at(-1), plan.manifestArtifact.objectKey)
      assert.deepEqual(
        transport.puts,
        [...plan.artifacts.slice(2), plan.manifestArtifact].map((artifact) => artifact.objectKey)
      )
    })
  })

  it('fails closed on an immutable collision or reused object with wrong metadata', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const collision = new MemoryS3Transport(storageConfig)
      await collision.seedArtifact(plan.artifacts[0], { body: Buffer.from('substitution') })
      await assert.rejects(
        stageMacosD3SealedCandidate(plan, {
          transport: collision,
          verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
        }),
        (error) => error?.code === 'immutable-artifact-collision'
      )
      assert.deepEqual(collision.puts, [])

      const badMetadata = new MemoryS3Transport(storageConfig)
      await badMetadata.seedArtifact(plan.artifacts[0], { metadataSha256: 'f'.repeat(64) })
      await assert.rejects(
        stageMacosD3SealedCandidate(plan, {
          transport: badMetadata,
          verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
        }),
        hasCode('candidate-remote-metadata')
      )
      assert.deepEqual(badMetadata.puts, [])
    })
  })

  it('rejects failed macOS authenticity verification before the first immutable write', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      const transport = new MemoryS3Transport(storageConfig)
      await assert.rejects(
        stageMacosD3SealedCandidate(plan, {
          transport,
          verifyReleaseArtifactAuthenticity: async () => {
            throw codedError('test-authenticity-failure')
          }
        }),
        hasCode('test-authenticity-failure')
      )
      assert.deepEqual(transport.puts, [])
    })
  })

  it('refuses a local artifact mutated after the plan was sealed', async () => {
    await withFixture(async (fixture) => {
      const plan = await fixture.buildPlan()
      await writeFile(plan.artifacts[4].path, 'same-plan-different-blockmap')
      const transport = new MemoryS3Transport(storageConfig)
      await assert.rejects(
        stageMacosD3SealedCandidate(plan, {
          transport,
          verifyReleaseArtifactAuthenticity: fixture.verifiers.verifyReleaseArtifactAuthenticity
        }),
        hasCode('candidate-artifact-mutated')
      )
      assert.deepEqual(transport.puts, [])
    })
  })
})

describe('sealed candidate remote download and local verification', () => {
  it('downloads exact remote bytes into an empty directory and verifies the set', async () => {
    await withFixture(async (fixture) => {
      const { plan, transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download')
      const downloaded = await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      assert.equal(downloaded.document.release.artifactSetSha256, summary.artifactSetSha256)
      const verified = await verifyDownloadedMacosD3SealedCandidate(
        { expectedManifest: summary.manifest, outputDir },
        fixture.verifiers
      )
      assert.equal(verified.document.candidate.dmgSha256, fixture.candidate.dmgSha256)
      assert.deepEqual(
        await Promise.all(
          plan.document.release.artifacts.map(async (artifact) =>
            readFile(join(outputDir, artifact.filename))
          )
        ),
        await Promise.all(plan.artifacts.map((artifact) => readFile(artifact.path)))
      )
    })
  })

  it('refuses non-empty output and never overwrites an existing file', async () => {
    await withFixture(async (fixture) => {
      const { transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'occupied')
      await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir))
      await writeFile(join(outputDir, 'keep.txt'), 'keep')
      await assert.rejects(
        downloadMacosD3SealedCandidate(
          {
            candidateStorageConfig: storageConfig,
            expectedManifest: summary.manifest,
            outputDir
          },
          { transport }
        ),
        hasCode('candidate-output-not-empty')
      )
      assert.equal(await readFile(join(outputDir, 'keep.txt'), 'utf8'), 'keep')
    })
  })

  it('rejects missing, truncated, oversized, and metadata-mismatched remote objects', async () => {
    await withFixture(async (fixture) => {
      const staged = await fixture.staged()
      staged.transport.objects.delete(staged.plan.manifestArtifact.objectKey)
      await assert.rejects(
        inspectMacosD3RemoteArtifact({
          artifact: staged.plan.manifestArtifact,
          config: storageConfig,
          transport: staged.transport
        }),
        hasCode('candidate-remote-read')
      )
    })
    await withFixture(async (fixture) => {
      const staged = await fixture.staged()
      const artifact = staged.plan.artifacts[0]
      staged.transport.objects.get(artifact.objectKey).body = Buffer.from('x')
      await assert.rejects(
        inspectMacosD3RemoteArtifact({
          artifact,
          config: storageConfig,
          transport: staged.transport
        }),
        hasCode('candidate-remote-bytes')
      )
    })
    await withFixture(async (fixture) => {
      const staged = await fixture.staged()
      const artifact = staged.plan.artifacts[0]
      staged.transport.objects.get(artifact.objectKey).body = Buffer.concat([
        await readFile(artifact.path),
        Buffer.from('extra')
      ])
      await assert.rejects(
        inspectMacosD3RemoteArtifact({
          artifact,
          config: storageConfig,
          transport: staged.transport
        }),
        hasCode('candidate-remote-size')
      )
    })
    await withFixture(async (fixture) => {
      const staged = await fixture.staged()
      const artifact = staged.plan.artifacts[0]
      staged.transport.objects.get(artifact.objectKey).metadataSha256 = '0'.repeat(64)
      await assert.rejects(
        inspectMacosD3RemoteArtifact({
          artifact,
          config: storageConfig,
          transport: staged.transport
        }),
        hasCode('candidate-remote-metadata')
      )
    })
  })

  it('detects mutation of a downloaded artifact', async () => {
    await withFixture(async (fixture) => {
      const { plan, transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download-mutated')
      await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      await writeFile(
        join(outputDir, plan.document.release.artifacts[4].filename),
        'changed blockmap'
      )
      await assert.rejects(
        verifyDownloadedMacosD3SealedCandidate(
          { expectedManifest: summary.manifest, outputDir },
          fixture.verifiers
        ),
        hasCode('candidate-local-artifact')
      )
    })
  })

  it('rejects downloaded bytes when promotion-time macOS authenticity verification fails', async () => {
    await withFixture(async (fixture) => {
      const { transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download-authenticity-failure')
      await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      await assert.rejects(
        verifyDownloadedMacosD3SealedCandidate(
          { expectedManifest: summary.manifest, outputDir },
          {
            ...fixture.verifiers,
            verifyReleaseArtifactAuthenticity: async () => {
              throw codedError('test-authenticity-failure')
            }
          }
        ),
        hasCode('test-authenticity-failure')
      )
    })
  })

  it('verifies the exact accepted seal receipt materialized beside the payloads', async () => {
    await withFixture(async (fixture) => {
      const { transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download-with-receipt')
      await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      const receiptPath = join(outputDir, MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME)
      await writeMacosD3CanonicalJsonExclusive(receiptPath, summary.sealReceipt.document)
      await verifyDownloadedMacosD3SealedCandidate(
        { expectedSealedCandidate: summary, outputDir },
        fixture.verifiers
      )
      const tampered = structuredClone(summary.sealReceipt.document)
      tampered.sealedAt = '2026-08-28T12:00:01.000Z'
      await writeFile(receiptPath, canonicalMacosD3Json(tampered))
      await assert.rejects(
        verifyDownloadedMacosD3SealedCandidate(
          { expectedSealedCandidate: summary, outputDir },
          fixture.verifiers
        ),
        hasCode('candidate-local-seal-receipt')
      )
    })
  })

  it('uses a credential-free verification descriptor instead of reparsing archives during publication', async () => {
    await withFixture(async (fixture) => {
      const { transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download-for-publication')
      await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      await writeMacosD3CanonicalJsonExclusive(
        join(outputDir, MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME),
        summary.sealReceipt.document
      )
      await verifyDownloadedMacosD3SealedCandidate(
        { expectedSealedCandidate: summary, outputDir },
        fixture.verifiers
      )
      const descriptorPath = join(outputDir, MACOS_D3_PUBLICATION_VERIFICATION_FILENAME)
      const writeDescriptor = () =>
        writeMacosD3PublicationVerificationDescriptor({
          descriptorPath,
          expectedSealedCandidate: summary,
          outputDir
        })

      if (!Number.isSafeInteger(constants.O_NOFOLLOW)) {
        await assert.rejects(
          writeDescriptor(),
          hasCode('candidate-publication-verification-nofollow')
        )
        return
      }
      await writeDescriptor()

      let fullParserCalls = 0
      const verified = await verifyDownloadedMacosD3SealedCandidate(
        { expectedSealedCandidate: summary, outputDir },
        {
          exactPromotion: true,
          publicationVerificationDescriptorPath: descriptorPath,
          verifyDmgAppBundle: async () => {
            fullParserCalls += 1
            throw new Error('DMG parser must not run with writer credentials')
          },
          verifyReleaseArtifactAuthenticity: async () => {
            fullParserCalls += 1
            throw new Error('authenticity parser must not run with writer credentials')
          },
          verifyZipAppBundle: async () => {
            fullParserCalls += 1
            throw new Error('ZIP parser must not run with writer credentials')
          }
        }
      )
      assert.equal(fullParserCalls, 0)
      assert.deepEqual(verified.document, summary.sealReceipt.document.candidateManifest)
    })
  })

  it('rejects mutated bytes and symlinks during no-follow publication revalidation', async () => {
    await withFixture(async (fixture) => {
      const { plan, transport, summary } = await fixture.staged()
      const outputDir = join(fixture.root, 'download-for-publication-tamper')
      await downloadMacosD3SealedCandidate(
        {
          candidateStorageConfig: storageConfig,
          expectedManifest: summary.manifest,
          outputDir
        },
        { transport }
      )
      await writeMacosD3CanonicalJsonExclusive(
        join(outputDir, MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME),
        summary.sealReceipt.document
      )
      const descriptorPath = join(outputDir, MACOS_D3_PUBLICATION_VERIFICATION_FILENAME)
      const writeDescriptor = () =>
        writeMacosD3PublicationVerificationDescriptor({
          descriptorPath,
          expectedSealedCandidate: summary,
          outputDir
        })

      if (!Number.isSafeInteger(constants.O_NOFOLLOW)) {
        await assert.rejects(
          writeDescriptor(),
          hasCode('candidate-publication-verification-nofollow')
        )
        return
      }
      await writeDescriptor()

      const blockmap = plan.document.release.artifacts.find(
        (artifact) => artifact.label === 'feed-blockmap'
      )
      const blockmapPath = join(outputDir, blockmap.filename)
      const exactBytes = await readFile(blockmapPath)

      await writeFile(blockmapPath, 'mutated blockmap')
      await assert.rejects(
        verifyDownloadedMacosD3SealedCandidate(
          { expectedSealedCandidate: summary, outputDir },
          { exactPromotion: true, publicationVerificationDescriptorPath: descriptorPath }
        ),
        hasCode('candidate-publication-verification-file')
      )

      const linkedBytes = join(fixture.root, 'linked-blockmap')
      await writeFile(linkedBytes, exactBytes)
      await unlink(blockmapPath)
      await symlink(linkedBytes, blockmapPath)
      await assert.rejects(
        verifyDownloadedMacosD3SealedCandidate(
          { expectedSealedCandidate: summary, outputDir },
          { exactPromotion: true, publicationVerificationDescriptorPath: descriptorPath }
        ),
        hasCode('candidate-directory-contents')
      )
    })
  })
})

describe('candidate update ZIP path validation', () => {
  it('accepts a single safe app root and rejects traversal, duplicates, and header mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-candidate-zip-test-'))
    try {
      const safe = join(root, 'safe.zip')
      await writeFile(safe, zipBytes(['Videorc.app/', 'Videorc.app/Contents/MacOS/Videorc']))
      assert.deepEqual(await validateZipCentralDirectory(safe, 'Videorc.app'), [
        'Videorc.app/',
        'Videorc.app/Contents/MacOS/Videorc'
      ])

      const traversal = join(root, 'traversal.zip')
      await writeFile(traversal, zipBytes(['Videorc.app/../escape']))
      await assert.rejects(
        validateZipCentralDirectory(traversal, 'Videorc.app'),
        hasCode('candidate-zip-entry-path')
      )

      const duplicate = join(root, 'duplicate.zip')
      await writeFile(duplicate, zipBytes(['Videorc.app/file', 'Videorc.app/file']))
      await assert.rejects(
        validateZipCentralDirectory(duplicate, 'Videorc.app'),
        hasCode('candidate-zip-duplicate')
      )

      const mismatch = join(root, 'mismatch.zip')
      await writeFile(
        mismatch,
        zipBytes(['Videorc.app/good'], { localNames: ['Videorc.app/evil'] })
      )
      await assert.rejects(
        validateZipCentralDirectory(mismatch, 'Videorc.app'),
        hasCode('candidate-zip-header-mismatch')
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

async function withFixture(run) {
  const fixture = await createFixture()
  try {
    return await run(fixture)
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'videorc-macos-d3-candidate-test-'))
  const releaseDir = join(root, 'release')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(releaseDir))
  const dmgFilename = 'Videorc-1.2.3-mac-arm64.dmg'
  const zipFilename = 'Videorc-1.2.3-mac-arm64.zip'
  const paths = {
    dmg: join(releaseDir, dmgFilename),
    sidecar: join(releaseDir, `${dmgFilename}.sha256`),
    manifest: join(releaseDir, 'release.json'),
    zip: join(releaseDir, zipFilename),
    blockmap: join(releaseDir, `${zipFilename}.blockmap`),
    feed: join(releaseDir, 'latest-mac.yml'),
    executable: join(root, 'Videorc')
  }
  await writeFile(paths.dmg, 'signed-notarized-dmg-bytes')
  await writeFile(paths.zip, 'signed-update-zip-bytes')
  await writeFile(paths.blockmap, 'blockmap-bytes')
  await writeFile(paths.executable, 'candidate-executable-bytes')
  const candidate = {
    sourceCommit,
    sourceTree,
    executableSha256: sha256Hex(await readFile(paths.executable)),
    executableSizeBytes: (await readFile(paths.executable)).byteLength,
    dmgSha256: sha256Hex(await readFile(paths.dmg)),
    dmgSizeBytes: (await readFile(paths.dmg)).byteLength,
    executableFilename: 'Videorc',
    dmgFilename,
    appBundle
  }
  await writeFile(paths.sidecar, `${candidate.dmgSha256}  ${dmgFilename}\n`)
  const manifest = {
    product: 'Videorc',
    channel: 'beta',
    releaseId: '1.2.3-beta.4',
    displayVersion: '1.2.3 beta 4',
    bundleVersion: '1.2.3',
    platform: 'macos',
    architecture: 'arm64',
    filename: dmgFilename,
    objectKey: `releases/macos/1.2.3-beta.4/${dmgFilename}`,
    sha256: candidate.dmgSha256,
    sizeBytes: candidate.dmgSizeBytes,
    minimumMacOS: 'macOS 13 Ventura or later',
    releasedAt,
    releaseNotesUrl: 'https://www.videorc.com/releases/1.2.3-beta.4'
  }
  await writeFile(paths.manifest, canonicalMacosD3Json(manifest))
  const zipBytesValue = await readFile(paths.zip)
  const zipSha512 = createHash('sha512').update(zipBytesValue).digest('base64')
  await writeFile(
    paths.feed,
    [
      'version: 1.2.3',
      'files:',
      `  - url: ${zipFilename}`,
      `    sha512: ${zipSha512}`,
      `    size: ${zipBytesValue.byteLength}`,
      `path: ${zipFilename}`,
      `sha512: ${zipSha512}`,
      `releaseDate: ${releasedAt}`,
      ''
    ].join('\n')
  )
  const verifiers = {
    captureAppBundleIdentity: async () => appBundle,
    verifyReleaseArtifactAuthenticity: async () => ({
      authority: 'Developer ID Application: Uros Miric (C2PA37RB58)',
      publisher: 'Uros Miric',
      teamId: 'C2PA37RB58'
    }),
    verifyDmgAppBundle: async () => appBundle,
    verifyZipAppBundle: async () => appBundle
  }
  const buildPlan = async (overrides = {}) =>
    await buildMacosD3SealedCandidatePlan(
      {
        candidate,
        candidateExecutablePath: paths.executable,
        candidateStorageConfig: storageConfig,
        manifestPath: paths.manifest,
        publicationDestinationBindingSha256: destinationBindingSha256,
        releaseDir
      },
      { ...verifiers, ...overrides }
    )
  return {
    root,
    releaseDir,
    paths,
    candidate,
    verifiers,
    buildPlan,
    async staged() {
      const plan = await buildPlan()
      const transport = new MemoryS3Transport(storageConfig)
      const receipt = await stageMacosD3SealedCandidate(plan, {
        now: () => new Date(releasedAt),
        transport,
        verifyReleaseArtifactAuthenticity: verifiers.verifyReleaseArtifactAuthenticity
      })
      return { plan, receipt, summary: macosD3CandidateSealSummary(receipt), transport }
    }
  }
}

class MemoryS3Transport {
  constructor(config) {
    this.config = config
    this.objects = new Map()
    this.puts = []
  }

  close() {}

  async request(url, { body = null, headers = {}, method }) {
    const objectKey = this.objectKey(url)
    if (method === 'GET') {
      const object = this.objects.get(objectKey)
      if (!object) return response(404, Buffer.alloc(0), {})
      return response(200, object.body, {
        'content-length': String(object.headerSizeBytes ?? object.expectedSizeBytes),
        'content-type': object.contentType,
        etag: object.etag,
        'x-amz-checksum-sha256': object.checksumSha256,
        'x-amz-meta-videorc-sha256': object.metadataSha256
      })
    }
    if (method !== 'PUT') throw new Error(`unsupported method ${method}`)
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
    )
    if (normalizedHeaders['if-none-match'] === '*' && this.objects.has(objectKey)) {
      return response(412, Buffer.alloc(0), {})
    }
    const bytes = await bodyBytes(body)
    const sha256 = sha256Hex(bytes)
    this.objects.set(objectKey, {
      body: bytes,
      checksumSha256: normalizedHeaders['x-amz-checksum-sha256'],
      contentType: normalizedHeaders['content-type'],
      etag: `"${sha256}"`,
      expectedSizeBytes: Number(normalizedHeaders['content-length']),
      metadataSha256: normalizedHeaders['x-amz-meta-videorc-sha256']
    })
    this.puts.push(objectKey)
    return response(200, Buffer.alloc(0), {})
  }

  async seedArtifact(artifact, overrides = {}) {
    const body =
      overrides.body ?? (artifact.body ? Buffer.from(artifact.body) : await readFile(artifact.path))
    this.objects.set(artifact.objectKey, {
      body,
      checksumSha256: createHash('sha256').update(body).digest('base64'),
      contentType: artifact.contentType,
      etag: `"${sha256Hex(body)}"`,
      expectedSizeBytes: artifact.sizeBytes,
      metadataSha256: overrides.metadataSha256 ?? artifact.sha256
    })
  }

  objectKey(url) {
    const parts = new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    assert.equal(parts.shift(), this.config.bucket)
    return parts.join('/')
  }
}

function response(status, body, headers) {
  const values = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value ?? null])
  )
  return {
    body: Readable.from(body.length > 0 ? [body] : []),
    headers: { get: (name) => values.get(String(name).toLowerCase()) ?? null },
    ok: status >= 200 && status < 300,
    status
  }
}

async function bodyBytes(body) {
  if (body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function zipBytes(centralNames, { localNames = centralNames } = {}) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (let index = 0; index < centralNames.length; index += 1) {
    const localName = Buffer.from(localNames[index])
    const centralName = Buffer.from(centralNames[index])
    const local = Buffer.alloc(30 + localName.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(localName.length, 26)
    localName.copy(local, 30)
    localParts.push(local)

    const central = Buffer.alloc(46 + centralName.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(centralName.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralName.copy(central, 46)
    centralParts.push(central)
    localOffset += local.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centralNames.length, 8)
  eocd.writeUInt16LE(centralNames.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hasCode(code) {
  return (error) => error?.code === code
}

function codedError(code) {
  return Object.assign(new Error(code), { code })
}
