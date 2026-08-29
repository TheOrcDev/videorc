import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
  CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
  buildCaptureDecayD3DestinationBinding,
  verifyCaptureDecayD3PublicationAttestation
} from './capture-decay-publication-attestation.mjs'

describe('capture-decay D3 publication destination binding', () => {
  it('canonically binds the non-secret destination and exact phased object plan', () => {
    const input = destinationFixture()
    const first = buildCaptureDecayD3DestinationBinding(input)
    const second = buildCaptureDecayD3DestinationBinding(destinationFixture())
    assert.deepEqual(second, first)
    assert.deepEqual(
      first.document.uploadPlan.map(({ label, phase }) => [label, phase]),
      [
        ['dmg', 'immutable'],
        ['d3-publication-reservation', 'reservation'],
        ['latest-manifest', 'pointer']
      ]
    )
    assert.equal(first.document.schemaVersion, 2)
    assert.deepEqual(first.document.destination.tlsPolicy, {
      allowedIssuerOrganizations: ['Alpha CA', 'Zulu CA'],
      allowedSpkiSha256: ['a'.repeat(64), 'b'.repeat(64)]
    })

    const changedBucket = destinationFixture()
    changedBucket.config.bucket = 'attacker-releases'
    changedBucket.reservation.document.destination.bucket = 'attacker-releases'
    assert.notEqual(buildCaptureDecayD3DestinationBinding(changedBucket).sha256, first.sha256)

    const changedObject = destinationFixture()
    changedObject.artifacts[1].objectKey = 'attacker/latest/release.json'
    assert.notEqual(buildCaptureDecayD3DestinationBinding(changedObject).sha256, first.sha256)

    const mismatchedReservation = destinationFixture()
    mismatchedReservation.reservation.document.destination.region = 'us-west-2'
    assert.throws(
      () => buildCaptureDecayD3DestinationBinding(mismatchedReservation),
      hasCode('destination-reservation')
    )

    const changedTlsPolicy = destinationFixture()
    changedTlsPolicy.config.tlsPolicy.allowedIssuerOrganizations = ['Different CA']
    changedTlsPolicy.reservation.document.destination.tlsPolicy.allowedIssuerOrganizations = [
      'Different CA'
    ]
    assert.notEqual(buildCaptureDecayD3DestinationBinding(changedTlsPolicy).sha256, first.sha256)

    const mismatchedTlsPolicy = destinationFixture()
    mismatchedTlsPolicy.reservation.document.destination.tlsPolicy.allowedSpkiSha256 = [
      'c'.repeat(64)
    ]
    assert.throws(
      () => buildCaptureDecayD3DestinationBinding(mismatchedTlsPolicy),
      hasCode('destination-reservation')
    )
  })
})

describe('capture-decay D3 publication attestation verification', () => {
  it('uses the exact offline gh policy and returns the bound bundle identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-publication-attestation-'))
    try {
      const receiptPath = join(directory, 'receipt.json')
      const bundlePath = join(directory, 'receipt.attestation.jsonl')
      const receiptBytes = Buffer.from('{"receipt":true}\n')
      const bundleBytes = Buffer.from('{"bundle":true}\n')
      await writeFile(receiptPath, receiptBytes)
      await writeFile(bundlePath, bundleBytes)
      const subjectPaths = await writeSubjectFixtures(directory)
      const receiptSha256 = sha256(receiptBytes)
      const subjectSha256s = await Promise.all(
        subjectPaths.map(async (_path, index) => sha256(Buffer.from(`subject-${index}\n`)))
      )
      const calls = []
      const result = await verifyCaptureDecayD3PublicationAttestation(
        {
          attestationBundlePath: bundlePath,
          publicationSourceCommit: 'a'.repeat(40),
          receiptPath,
          subjectPaths
        },
        {
          env: {
            PATH: '/usr/bin',
            GH_TOKEN: 'gh-token',
            AWS_ACCESS_KEY_ID: 'aws-writer',
            AWS_PROFILE: 'writer-profile',
            AWS_SECRET_ACCESS_KEY: 'aws-secret',
            AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/aws-writer-token',
            VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_ACCESS_KEY_ID: 'read-key',
            VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_BUCKET: 'read-bucket',
            VIDEORC_CAPTURE_DECAY_D3_PUBLIC_READ_S3_SECRET_ACCESS_KEY: 'read-secret',
            VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'writer-key',
            VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY: 'writer-secret'
          },
          execute: async (command, args, options) => {
            calls.push({ command, args, options })
            return {
              code: 0,
              signal: null,
              stdout: JSON.stringify([
                {
                  verificationResult: {
                    statement: {
                      subject: [receiptSha256, ...subjectSha256s].map((digest) => ({
                        digest: { sha256: digest }
                      }))
                    }
                  }
                }
              ])
            }
          }
        }
      )
      assert.equal(calls.length, 1)
      assert.equal(calls[0].command, 'gh')
      assert.equal(calls[0].args[0], 'attestation')
      assert.equal(calls[0].args[1], 'verify')
      assert.equal(calls[0].args[2].endsWith('/receipt.json'), true)
      assert.notEqual(calls[0].args[2], resolve(receiptPath))
      assert.equal(calls[0].args[3], '--bundle')
      assert.equal(calls[0].args[4].endsWith('/receipt.attestation.jsonl'), true)
      assert.notEqual(calls[0].args[4], resolve(bundlePath))
      assert.deepEqual(calls[0].args.slice(5), [
        '--repo',
        CAPTURE_DECAY_D3_PUBLICATION_REPOSITORY,
        '--signer-workflow',
        CAPTURE_DECAY_D3_PUBLICATION_SIGNER_WORKFLOW,
        '--source-digest',
        'a'.repeat(40),
        '--format',
        'json'
      ])
      assert.deepEqual(calls[0].options.env, { GH_TOKEN: 'gh-token', PATH: '/usr/bin' })
      assert.equal(result.receiptSha256, receiptSha256)
      assert.deepEqual(result.subjectSha256s, [receiptSha256, ...subjectSha256s].sort())
      assert.deepEqual(result.bundle, {
        filename: 'receipt.attestation.jsonl',
        sha256: sha256(bundleBytes),
        sizeBytes: bundleBytes.byteLength,
        bodyBase64: bundleBytes.toString('base64')
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when gh is missing, rejects, or returns malformed/unbound JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-publication-attestation-fail-'))
    try {
      const receiptPath = join(directory, 'receipt.json')
      const bundlePath = join(directory, 'receipt.attestation.jsonl')
      await writeFile(receiptPath, '{"receipt":true}\n')
      await writeFile(bundlePath, '{"bundle":true}\n')
      const subjectPaths = await writeSubjectFixtures(directory)
      const input = {
        attestationBundlePath: bundlePath,
        publicationSourceCommit: 'b'.repeat(40),
        receiptPath,
        subjectPaths
      }
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => {
              const error = new Error('not found')
              error.code = 'ENOENT'
              throw error
            }
          }),
        hasCode('publication-attestation-tool')
      )
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => ({ code: 1, signal: null, stdout: '[]' })
          }),
        hasCode('publication-attestation-verification')
      )
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => ({ code: 0, signal: null, stdout: 'not json' })
          }),
        hasCode('publication-attestation-output')
      )
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => ({ code: 0, signal: null, stdout: '[{}]' })
          }),
        hasCode('publication-attestation-subject')
      )
      const receiptSha256 = sha256(Buffer.from('{"receipt":true}\n'))
      const subjectSha256s = subjectPaths.map((_path, index) =>
        sha256(Buffer.from(`subject-${index}\n`))
      )
      const requiredSubjectSha256s = [receiptSha256, ...subjectSha256s]
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => ({
              code: 0,
              signal: null,
              stdout: JSON.stringify([
                verifiedStatement(requiredSubjectSha256s),
                verifiedStatement(['e'.repeat(64)])
              ])
            })
          }),
        hasCode('publication-attestation-output')
      )
      for (const { code, verification } of [
        {
          code: 'publication-attestation-output',
          verification: [
            verifiedStatement(requiredSubjectSha256s.slice(0, 5)),
            verifiedStatement(requiredSubjectSha256s.slice(5))
          ]
        },
        {
          code: 'publication-attestation-subject',
          verification: [verifiedStatement([...requiredSubjectSha256s, 'f'.repeat(64)])]
        }
      ]) {
        await assert.rejects(
          () =>
            verifyCaptureDecayD3PublicationAttestation(input, {
              execute: async () => ({
                code: 0,
                signal: null,
                stdout: JSON.stringify(verification)
              })
            }),
          hasCode(code)
        )
      }
      await assert.rejects(
        () =>
          verifyCaptureDecayD3PublicationAttestation(input, {
            execute: async () => {
              await writeFile(bundlePath, '{"bundle":"changed"}\n')
              return {
                code: 0,
                signal: null,
                stdout: JSON.stringify([
                  {
                    verificationResult: {
                      statement: {
                        subject: [receiptSha256, ...subjectSha256s].map((digest) => ({
                          digest: { sha256: digest }
                        }))
                      }
                    }
                  }
                ])
              }
            }
          }),
        hasCode('publication-attestation-mutated')
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function destinationFixture() {
  const config = {
    bucket: 'videorc-releases',
    endpointUrl: 'https://account.r2.cloudflarestorage.com/',
    forcePathStyle: true,
    region: 'auto',
    tlsPolicy: {
      allowedIssuerOrganizations: ['Zulu CA', 'Alpha CA'],
      allowedSpkiSha256: ['B'.repeat(64), 'a'.repeat(64)]
    }
  }
  const reservationObjectKey =
    'releases/macos/1.0.0-beta.1/capture-decay-d3-publication-reservation.json'
  return {
    artifacts: [
      {
        contentType: 'application/x-apple-diskimage',
        immutable: true,
        label: 'dmg',
        objectKey: 'releases/macos/1.0.0-beta.1/Videorc.dmg'
      },
      {
        contentType: 'application/json',
        immutable: false,
        label: 'latest-manifest',
        objectKey: 'releases/macos/latest/release.json'
      }
    ],
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
          bucket: config.bucket,
          endpointUrl: 'https://account.r2.cloudflarestorage.com/',
          forcePathStyle: config.forcePathStyle,
          region: config.region,
          reservationObjectKey,
          tlsPolicy: structuredClone(config.tlsPolicy)
        }
      }
    }
  }
}

function verifiedStatement(digests) {
  return {
    verificationResult: {
      statement: {
        subject: digests.map((digest) => ({ digest: { sha256: digest } }))
      }
    }
  }
}

async function writeSubjectFixtures(directory) {
  const paths = []
  for (let index = 0; index < 8; index += 1) {
    const path = join(directory, `subject-${index}.bin`)
    await writeFile(path, `subject-${index}\n`)
    paths.push(path)
  }
  return paths
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hasCode(code) {
  return (error) => error?.code === code
}
