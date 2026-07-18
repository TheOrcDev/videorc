import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  assertWindowsFeedTransition,
  inspectRemoteArtifact,
  readRemoteTextObject,
  WindowsReleasePublicationError
} from './windows-release-publication.mjs'

const config = {
  accessKeyId: 'test-access',
  bucket: 'private-releases',
  endpointUrl: 'https://r2.example.test',
  forcePathStyle: true,
  region: 'auto',
  secretAccessKey: 'test-secret',
  sessionToken: null
}

function feed(version, sha = 'same') {
  const filename = `Videorc-${version}-win-x64.exe`
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${filename}`,
    `    sha512: ${sha}`,
    '    size: 123',
    `path: ${filename}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-07-18T00:00:00.000Z'",
    ''
  ].join('\n')
}

describe('Windows feed transition', () => {
  it('allows a first release, a strict advance, and an exact retry', () => {
    assert.equal(
      assertWindowsFeedTransition({
        acceptedReleaseIds: [],
        currentFeedYml: null,
        nextFeedYml: feed('0.10.0'),
        stage: 'pilot',
        trustedCurrentVersion: '0.10.0'
      }).kind,
      'first-release'
    )
    assert.equal(
      assertWindowsFeedTransition({
        acceptedReleaseIds: ['0.10.0-alpha.1'],
        currentFeedYml: feed('0.10.0'),
        nextFeedYml: feed('0.10.1'),
        stage: 'pilot',
        trustedCurrentVersion: '0.10.1'
      }).kind,
      'advance'
    )
    assert.equal(
      assertWindowsFeedTransition({
        acceptedReleaseIds: ['0.10.0-alpha.1'],
        currentFeedYml: feed('0.10.0'),
        nextFeedYml: feed('0.10.0'),
        stage: 'public',
        trustedCurrentVersion: '0.10.0'
      }).kind,
      'idempotent'
    )
  })

  it('rejects regressions and changed artifacts without a version advance', () => {
    for (const [currentFeedYml, nextFeedYml, code] of [
      [feed('0.10.1'), feed('0.10.0'), 'update-version-regression'],
      [feed('0.10.0'), feed('0.10.0', 'changed'), 'update-version-not-advanced']
    ]) {
      assert.throws(
        () =>
          assertWindowsFeedTransition({
            acceptedReleaseIds: ['0.10.0-alpha.1'],
            currentFeedYml,
            nextFeedYml,
            stage: 'public',
            trustedCurrentVersion: '0.10.0'
          }),
        (error) => error instanceof WindowsReleasePublicationError && error.code === code
      )
    }
  })

  it('fails closed when a public feed disappears after trusted release history exists', () => {
    assert.throws(
      () =>
        assertWindowsFeedTransition({
          acceptedReleaseIds: ['0.10.0-alpha.1', '0.10.1-alpha.1'],
          currentFeedYml: null,
          nextFeedYml: feed('0.10.1'),
          stage: 'public',
          trustedCurrentVersion: '0.10.1'
        }),
      (error) =>
        error instanceof WindowsReleasePublicationError && error.code === 'published-feed-missing'
    )
  })

  it('binds promotion to trusted main version and the highest accepted public version', () => {
    for (const [nextVersion, trustedCurrentVersion, code] of [
      ['0.10.0', '0.10.1', 'candidate-not-current-version'],
      ['0.10.0', '0.10.0', 'accepted-version-regression']
    ]) {
      assert.throws(
        () =>
          assertWindowsFeedTransition({
            acceptedReleaseIds: ['0.10.1-alpha.1'],
            currentFeedYml: feed('0.9.9'),
            nextFeedYml: feed(nextVersion),
            stage: 'pilot',
            trustedCurrentVersion
          }),
        (error) => error instanceof WindowsReleasePublicationError && error.code === code
      )
    }
  })
})

describe('private storage verification', () => {
  it('reads missing/text objects and verifies exact remote bytes', async () => {
    const bytes = Buffer.from('signed-installer')
    const artifact = {
      objectKey: 'releases/windows/0.10.0-alpha.1/installer.exe',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length
    }
    const fetchImpl = async (_url, request) => {
      if (request.method !== 'GET') throw new Error('unexpected method')
      return new Response(bytes, { status: 200 })
    }

    assert.equal(
      await readRemoteTextObject({ config, fetchImpl, objectKey: 'updates/windows/latest.yml' }),
      bytes.toString()
    )
    assert.equal((await inspectRemoteArtifact({ artifact, config, fetchImpl })).state, 'identical')
    assert.equal(
      await readRemoteTextObject({
        config,
        fetchImpl: async () => new Response(null, { status: 404 }),
        objectKey: 'missing'
      }),
      null
    )
  })

  it('rejects a same-size remote substitution', async () => {
    const expected = Buffer.from('expected')
    const artifact = {
      objectKey: 'candidate.exe',
      sha256: createHash('sha256').update(expected).digest('hex'),
      sizeBytes: expected.length
    }
    await assert.rejects(
      inspectRemoteArtifact({
        artifact,
        config,
        fetchImpl: async () => new Response(Buffer.from('attacker'), { status: 200 })
      }),
      (error) =>
        error instanceof WindowsReleasePublicationError && error.code === 'remote-artifact-mismatch'
    )
  })

  it('bounds remote text reads', async () => {
    await assert.rejects(
      readRemoteTextObject({
        config,
        fetchImpl: async () => new Response('oversized', { status: 200 }),
        maxBytes: 4,
        objectKey: 'changelog/changelog.json'
      }),
      (error) =>
        error instanceof WindowsReleasePublicationError && error.code === 'remote-read-too-large'
    )
  })
})
