import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  createWindowsUnsignedStagingManifest,
  verifyWindowsUnsignedStagingManifest
} from './windows-unsigned-staging.mjs'

const releaseId = '0.10.0-alpha.1'
const sourceCommit = 'a'.repeat(40)
const publisherName = 'Videorc Test Publisher'
const requiredFiles = {
  'Videorc.exe': 'app',
  'resources/app-update.yml': `provider: generic\npublisherName:\n  - ${publisherName}\nurl: https://www.videorc.com/api/updates/\n`,
  'resources/app.asar': 'asar',
  'resources/ffmpeg/LICENSE.txt': 'license',
  'resources/ffmpeg/SOURCE.txt': 'source',
  'resources/ffmpeg/bin/ffmpeg.exe': 'ffmpeg',
  'resources/ffmpeg/bin/ffprobe.exe': 'ffprobe',
  'resources/videorc-backend.exe': 'backend'
}

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe('Windows unsigned staging manifest', () => {
  it('binds every staged file to the exact release and source commit', async () => {
    const rootDir = await fixture()
    const manifest = await createWindowsUnsignedStagingManifest({
      publisherName,
      releaseId,
      rootDir,
      sourceCommit
    })

    assert.equal(manifest.releaseId, releaseId)
    assert.equal(manifest.sourceCommit, sourceCommit)
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      Object.keys(requiredFiles).sort()
    )
    await assert.doesNotReject(() =>
      verifyWindowsUnsignedStagingManifest({
        expectedPublisherName: publisherName,
        expectedReleaseId: releaseId,
        expectedSourceCommit: sourceCommit,
        manifest,
        rootDir
      })
    )
  })

  it('rejects changed bytes and unexpected files after the handoff', async () => {
    const rootDir = await fixture()
    const manifest = await createWindowsUnsignedStagingManifest({
      publisherName,
      releaseId,
      rootDir,
      sourceCommit
    })

    await writeFile(join(rootDir, 'Videorc.exe'), 'changed')
    await assert.rejects(
      () =>
        verifyWindowsUnsignedStagingManifest({
          expectedPublisherName: publisherName,
          expectedReleaseId: releaseId,
          expectedSourceCommit: sourceCommit,
          manifest,
          rootDir
        }),
      /file mismatch/
    )

    await writeFile(join(rootDir, 'unexpected.exe'), 'extra')
    await assert.rejects(
      () =>
        verifyWindowsUnsignedStagingManifest({
          expectedPublisherName: publisherName,
          expectedReleaseId: releaseId,
          expectedSourceCommit: sourceCommit,
          manifest,
          rootDir
        }),
      /file count mismatch/
    )
  })

  it('rejects a manifest rebound to a different candidate identity', async () => {
    const rootDir = await fixture()
    const manifest = await createWindowsUnsignedStagingManifest({
      publisherName,
      releaseId,
      rootDir,
      sourceCommit
    })

    await assert.rejects(
      () =>
        verifyWindowsUnsignedStagingManifest({
          expectedPublisherName: publisherName,
          expectedReleaseId: '0.10.1-alpha.1',
          expectedSourceCommit: sourceCommit,
          manifest,
          rootDir
        }),
      /release ID mismatch/
    )
  })
})

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'videorc-windows-staging-'))
  temporaryDirectories.push(rootDir)
  for (const [path, contents] of Object.entries(requiredFiles)) {
    const absolutePath = join(rootDir, ...path.split('/'))
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents)
  }
  return rootDir
}
