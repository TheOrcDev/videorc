import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildLinuxReleaseManifest, buildLinuxUpdateFeedYml } from './linux-release.mjs'
import { linuxCandidatePrefix } from './linux-release-candidate.mjs'
import { downloadLinuxCandidate } from './linux-release-download.mjs'

// Artificial bytes for storage-contract tests, never an installable candidate.
function fixture(channel = 'beta') {
  const app = Buffer.from('test-only AppImage bytes')
  const manifest = buildLinuxReleaseManifest({
    artifactPath: 'Videorc-0.16.1-linux-x64.AppImage',
    packageVersion: '0.16.1',
    sha256: createHash('sha256').update(app).digest('hex'),
    sizeBytes: app.length,
    sourceCommit: 'b'.repeat(40),
    releasedAt: '2026-10-01T00:00:00.000Z',
    env: { VIDEORC_RELEASE_ID: `0.16.1-${channel}.1` }
  })
  const prefix = linuxCandidatePrefix(manifest)
  const objects = new Map(
    Object.entries({
      'release.json': JSON.stringify(manifest),
      [manifest.filename]: app,
      [`${manifest.filename}.sha256`]: `${manifest.sha256}  ${manifest.filename}\n`,
      'latest-linux.yml': buildLinuxUpdateFeedYml({
        filename: manifest.filename,
        version: manifest.bundleVersion,
        sizeBytes: app.length,
        sha512: createHash('sha512').update(app).digest('base64'),
        releaseDate: manifest.releasedAt
      }),
      'FFMPEG-LICENSE.txt': 'test license',
      'FFMPEG-SOURCE.txt': 'test source offer'
    }).map(([name, bytes]) => [`${prefix}/${name}`, Buffer.from(bytes)])
  )
  return {
    manifest,
    objects,
    prefix,
    coordinates: {
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      appImageSha256: manifest.sha256
    }
  }
}
function response(bytes) {
  return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
}
async function harness(t, channel) {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'linux-download-test-'))
  t.after(() => rm(parentDirectory, { recursive: true, force: true }))
  await writeFile(join(parentDirectory, 'keep.txt'), 'existing user data')
  const data = fixture(channel)
  const requests = []
  return {
    ...data,
    parentDirectory,
    requests,
    getObject: async (key) => {
      requests.push(key)
      return response(data.objects.get(key))
    }
  }
}

for (const channel of ['alpha', 'beta'])
  test(`${channel}: downloads exact bytes into a fresh private directory`, async (t) => {
    const h = await harness(t, channel)
    const result = await downloadLinuxCandidate(h)
    assert.equal(result.manifest.releaseId, h.coordinates.releaseId)
    assert.deepEqual(
      await readFile(join(result.directory, h.manifest.filename)),
      h.objects.get(`${h.prefix}/${h.manifest.filename}`)
    )
    assert.equal((await stat(join(result.directory, h.manifest.filename))).mode & 0o777, 0o600)
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700)
    assert.equal(h.requests.length, 6)
    assert.ok(h.requests.every((key) => key.startsWith(`${h.prefix}/`)))
    assert.equal(await readFile(join(h.parentDirectory, 'keep.txt'), 'utf8'), 'existing user data')
    assert.equal(result.plan.artifacts.length, 6)
  })

for (const [name, transform] of [
  ['wrong hash', (bytes) => response(Buffer.alloc(bytes.length, 1))],
  [
    'truncation',
    (bytes) =>
      new Response(bytes.subarray(1), { headers: { 'content-length': String(bytes.length) } })
  ],
  [
    'excess bytes',
    (bytes) =>
      new Response(Buffer.concat([bytes, bytes]), {
        headers: { 'content-length': String(bytes.length) }
      })
  ],
  [
    'partial response',
    (bytes) =>
      new Response(bytes, { status: 206, headers: { 'content-length': String(bytes.length) } })
  ],
  ['redirect', () => new Response(null, { status: 302 })],
  [
    'partial envelope with HTTP 200',
    (bytes) =>
      new Response(bytes, {
        headers: {
          'content-length': String(bytes.length),
          'content-range': `bytes 0-${bytes.length - 1}/${bytes.length + 1}`
        }
      })
  ],
  ['missing length', (bytes) => new Response(bytes)],
  [
    'compressed body',
    (bytes) =>
      new Response(bytes, {
        headers: { 'content-length': String(bytes.length), 'content-encoding': 'gzip' }
      })
  ],
  [
    'body read failure',
    (bytes) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection lost'))
          }
        }),
        { headers: { 'content-length': String(bytes.length) } }
      )
  ]
])
  test(`removes only its partial directory on ${name}`, async (t) => {
    const h = await harness(t)
    await assert.rejects(
      downloadLinuxCandidate({
        ...h,
        getObject: async (key) =>
          key.endsWith('.AppImage') ? transform(h.objects.get(key)) : h.getObject(key)
      })
    )
    assert.deepEqual(await readdir(h.parentDirectory), ['keep.txt'])
  })

for (const override of [
  { sourceCommit: 'c'.repeat(40) },
  { stage: 'public' },
  { filename: '../escape.AppImage' },
  { sha256: 'c'.repeat(64) },
  { sizeBytes: 3 * 1024 ** 3 }
])
  test(`refuses stale or unsafe manifest ${JSON.stringify(override)}`, async (t) => {
    const h = await harness(t)
    h.objects.set(
      `${h.prefix}/release.json`,
      Buffer.from(JSON.stringify({ ...h.manifest, ...override }))
    )
    await assert.rejects(downloadLinuxCandidate(h))
    assert.deepEqual(await readdir(h.parentDirectory), ['keep.txt'])
    assert.ok(h.requests.length <= 2)
  })

for (const file of ['latest-linux.yml', 'FFMPEG-LICENSE.txt', 'FFMPEG-SOURCE.txt'])
  test(`missing or mismatched ${file} cannot yield a verified directory`, async (t) => {
    const h = await harness(t)
    h.objects.set(
      `${h.prefix}/${file}`,
      Buffer.from(file.endsWith('.yml') ? 'version: 999.0.0' : '')
    )
    await assert.rejects(downloadLinuxCandidate(h))
    assert.deepEqual(await readdir(h.parentDirectory), ['keep.txt'])
  })

test('refuses absent expected hash before any storage request or local directory creation', async () => {
  let fetched = false
  await assert.rejects(
    downloadLinuxCandidate({
      coordinates: { ...fixture().coordinates, appImageSha256: undefined },
      parentDirectory: '/unused',
      getObject: async () => {
        fetched = true
      }
    }),
    /expected AppImage SHA-256/
  )
  assert.equal(fetched, false)
})
