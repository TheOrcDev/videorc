import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { linuxBetaAcceptanceTemplate } from './linux-beta-acceptance.mjs'
import {
  buildLinuxBetaPublicPromotionPlan,
  linuxPromotionGitReader
} from './linux-beta-promotion.mjs'
import { finalizeVerifiedLinuxBetaPlan } from './linux-beta-publication.mjs'
import {
  createLinuxBetaPublicationJournal,
  LINUX_BETA_PUBLICATION_JOURNAL_KEY
} from './linux-beta-publication-journal.mjs'
import {
  buildLinuxReleaseManifest,
  buildLinuxUpdateFeedYml,
  formatSha256File
} from './linux-release.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const recordCommit = 'c'.repeat(40)
const trustedMainCommit = 'd'.repeat(40)

// Artificial files and observations for contract tests, never release evidence.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'beta-promotion-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('ARTIFICIAL APPIMAGE CONTRACT FIXTURE, NOT EXECUTABLE')
  const manifest = buildLinuxReleaseManifest({
    artifactPath: 'Videorc-0.16.1-linux-x64.AppImage',
    packageVersion: '0.16.1',
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    sourceCommit: 'b'.repeat(40),
    releasedAt: '2026-10-01T00:00:00.000Z',
    env: { VIDEORC_RELEASE_ID: '0.16.1-beta.1' }
  })
  const feed = buildLinuxUpdateFeedYml({
    filename: manifest.filename,
    version: manifest.bundleVersion,
    releaseDate: manifest.releasedAt,
    sha512: createHash('sha512').update(bytes).digest('base64'),
    sizeBytes: bytes.length
  })
  for (const [name, contents] of Object.entries({
    [manifest.filename]: bytes,
    [`${manifest.filename}.sha256`]: formatSha256File(manifest),
    'release.json': JSON.stringify(manifest),
    'latest-linux.yml': feed,
    'FFMPEG-LICENSE.txt': 'artificial license',
    'FFMPEG-SOURCE.txt': 'artificial source',
    'measurement.log': 'ARTIFICIAL MEASUREMENT'
  }))
    await writeFile(join(root, name), contents)
  const record = linuxBetaAcceptanceTemplate(manifest)
  record.status = 'pass'
  for (const key of Object.keys(record.owners)) record.owners[key] = 'fixture-owner'
  async function receipt(path, fields) {
    const data = JSON.stringify({
      schemaVersion: 1,
      status: 'pass',
      candidate: record.candidate,
      artifacts: [{ path: 'measurement.log', sha256: sha256('ARTIFICIAL MEASUREMENT') }],
      ...fields
    })
    await writeFile(join(root, path), data)
    return { path, sha256: sha256(data) }
  }
  for (const [i, env] of record.environments.entries()) {
    Object.assign(env, {
      machine: `fixture-${i}`,
      operator: 'fixture-operator',
      osVersion: i === 0 ? 'Ubuntu 24.04.3' : 'Omarchy 4.0.4',
      desktopVersion: i === 0 ? 'GNOME 46 Wayland' : 'Hyprland 0.51 Wayland',
      cpu: 'fixture-cpu',
      gpu: 'fixture-gpu',
      kernel: 'fixture-kernel',
      ramGiB: 16,
      startedAt: '2026-10-02T00:00:00.000Z',
      finishedAt: '2026-10-19T00:00:00.000Z',
      criticalWorkflowFreshPasses: 3,
      previewCycles: 20,
      minimumSpecHours: 4
    })
    const evidence = await receipt(`categories-${i}.json`, {
      environmentId: env.id,
      operator: env.operator,
      categoryIds: env.categories.map((c) => c.id),
      startedAt: env.startedAt,
      finishedAt: env.finishedAt
    })
    for (const category of env.categories)
      Object.assign(category, { status: 'pass', evidence: [evidence] })
    for (const encoder of env.encoders)
      Object.assign(encoder, {
        recordCycles: 50,
        recordAndLocalStreamMinutes: 60,
        metrics: {
          fpsErrorRatio: 0.02,
          frameCountErrorRatio: 0.02,
          motionFreezeMs: 100,
          repeatedFrames: 2,
          audioGapMs: 20,
          avSkewMs: 150,
          gopSeconds: 2.5,
          stopTailMs: 100,
          coldStartMs: 1000,
          warmStartP95Ms: 350,
          stopP95Ms: 300,
          shortFinalizeP95Ms: 5000,
          takeCoverage: 0.98
        }
      })
    env.pilot = {
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: '2026-10-10T00:00:00.000Z',
      sessions: []
    }
    for (let j = 0; j < 9; j++) {
      const session = {
        id: `session-${i}-${j}`,
        tester: `fixture-tester-${Math.floor(j / 3)}`,
        status: 'pass',
        startedAt: `2026-10-0${3 + (j % 3)}T10:00:00.000Z`,
        finishedAt: `2026-10-0${3 + (j % 3)}T12:00:00.000Z`
      }
      session.evidence = await receipt(`pilot-${i}-${j}.json`, {
        environmentId: env.id,
        operator: session.tester,
        pilotSessionId: session.id,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt
      })
      env.pilot.sessions.push(session)
    }
  }
  const reads = []
  const options = {
    candidateDirectory: root,
    coordinates: {
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      appImageSha256: manifest.sha256
    },
    trustedMainCommit,
    acceptanceRecordUrl: `https://github.com/TheOrcDev/videorc/blob/${recordCommit}/docs/acceptance/linux-beta/${manifest.releaseId}.json`,
    evidenceRoot: root,
    now: new Date('2026-10-20T00:00:00.000Z'),
    git: {
      isAncestor: (commit, head) =>
        (head === trustedMainCommit && [manifest.sourceCommit, recordCommit].includes(commit)) ||
        (head === recordCommit && commit === manifest.sourceCommit),
      readBlob: (commit, path) => {
        reads.push({ commit, path })
        if (commit === trustedMainCommit && path === 'apps/desktop/package.json')
          return Buffer.from('{"version":"0.16.1"}')
        assert.equal(commit, recordCommit)
        assert.equal(path, `docs/acceptance/linux-beta/${manifest.releaseId}.json`)
        return Buffer.from(JSON.stringify(record))
      }
    }
  }
  return {
    root,
    manifest,
    record,
    reads,
    options,
    plan: () => buildLinuxBetaPublicPromotionPlan(options)
  }
}

test('plans exact Beta bytes and pinned measured evidence without changing the candidate', async (t) => {
  const f = await fixture(t)
  const before = await readFile(join(f.root, 'release.json'))
  const plan = await f.plan()
  assert.equal(plan.mode, 'read-only')
  assert.equal(plan.requiresProtectedFinalizer, true)
  assert.equal(plan.manifest.stage, 'public')
  assert.equal(plan.manifest.acceptanceStatus, 'pass')
  assert.equal(plan.acceptance.recordSha256, sha256(JSON.stringify(f.record)))
  assert.equal(plan.acceptance.verifiedFiles, 21)
  assert.deepEqual(
    f.reads.map((r) => r.commit),
    [trustedMainCommit, recordCommit]
  )
  assert.deepEqual(await readFile(join(f.root, 'release.json')), before)
  assert.equal(plan.candidateManifestSha256, sha256(before))
  assert.equal(plan.immutable.length, 7)
  const copies = plan.immutable.filter((a) => a.label === 'appimage')
  assert.equal(copies.length, 2)
  for (const copy of copies) {
    assert.equal(copy.sha256, f.manifest.sha256)
    assert.equal(copy.sizeBytes, f.manifest.sizeBytes)
    assert.match(copy.sourceObjectKey, /^candidates\/linux-beta\//)
  }
  for (const item of [...plan.immutable, ...plan.pointers]) {
    assert.match(item.objectKey, /^(releases|updates)\/linux-beta\//)
    if (item.bodyBase64) assert.equal(item.sha256, sha256(Buffer.from(item.bodyBase64, 'base64')))
  }
  assert.deepEqual(
    plan.pointers.map((p) => p.objectKey),
    ['updates/linux-beta/latest-linux.yml', 'releases/linux-beta/latest/release.json']
  )
})

test('the verified planner output can cross the publication core with exact staged bytes', async (t) => {
  const f = await fixture(t)
  const plan = await f.plan()
  const objects = new Map()
  for (const artifact of plan.immutable) {
    const body = artifact.bodyBase64
      ? Buffer.from(artifact.bodyBase64, 'base64')
      : await readFile(join(f.root, basename(artifact.sourceObjectKey)))
    objects.set(artifact.objectKey, { body, etag: '"staged"' })
  }
  let journalObject = null
  let revision = 0
  const journal = createLinuxBetaPublicationJournal({
    store: {
      async read(key) {
        assert.equal(key, LINUX_BETA_PUBLICATION_JOURNAL_KEY)
        return structuredClone(journalObject)
      },
      async write(key, value, etag) {
        assert.equal(key, LINUX_BETA_PUBLICATION_JOURNAL_KEY)
        assert.equal(etag, journalObject?.etag ?? null)
        journalObject = { value: structuredClone(value), etag: `"journal-${++revision}"` }
        return structuredClone(journalObject)
      }
    }
  })
  await journal.initialize()
  const result = await finalizeVerifiedLinuxBetaPlan({
    plan,
    origins: ['fixture'],
    primaryName: 'fixture',
    publishedReleaseIds: [],
    storage: {
      readCandidate: (key) => readFile(join(f.root, basename(key))),
      inspectImmutable: async (_origin, key) => {
        const object = objects.get(key)
        return object && { sha256: sha256(object.body), sizeBytes: object.body.length }
      },
      readPointer: async (_origin, key) => objects.get(key) ?? null,
      putPointer: async (_origin, key, body, condition) => {
        assert.deepEqual(condition, { ifMatch: null, ifNoneMatch: '*' })
        assert.equal(objects.has(key), false)
        objects.set(key, { body, etag: '"published-fixture"' })
      }
    },
    journal
  })
  assert.equal(result.receipts.length, 2)
  assert.equal((await journal.inspect()).active.status, 'complete-awaiting-ack')
  await journal.acknowledge(result)
  assert.deepEqual(await journal.publishedReleaseIds(), [plan.manifest.releaseId])
  assert.deepEqual(
    JSON.parse(objects.get('releases/linux-beta/latest/release.json').body.toString()),
    plan.manifest
  )
})

test('refuses missing pins, foreign records, mutable refs and detached ancestry', async (t) => {
  const f = await fixture(t)
  for (const override of [
    { coordinates: { ...f.options.coordinates, appImageSha256: undefined } },
    { coordinates: { ...f.options.coordinates, appImageSha256: 'a'.repeat(64) } },
    { trustedMainCommit: 'main' },
    { acceptanceRecordUrl: f.options.acceptanceRecordUrl.replace(recordCommit, 'main') },
    { acceptanceRecordUrl: f.options.acceptanceRecordUrl.replace('TheOrcDev', 'attacker') },
    {
      acceptanceRecordUrl: f.options.acceptanceRecordUrl.replace('0.16.1-beta.1', '0.16.2-beta.1')
    },
    { git: { ...f.options.git, isAncestor: (commit) => commit !== f.manifest.sourceCommit } },
    { git: { ...f.options.git, isAncestor: (commit) => commit !== recordCommit } },
    { git: { ...f.options.git, isAncestor: (_commit, head) => head !== recordCommit } },
    { git: { ...f.options.git, readBlob: () => Buffer.from('{"version":"0.16.2"}') } }
  ])
    await assert.rejects(buildLinuxBetaPublicPromotionPlan({ ...f.options, ...override }))
})

test('Alpha candidates and already-public manifests cannot enter Beta preparation', async (t) => {
  const f = await fixture(t)
  const alpha = buildLinuxReleaseManifest({
    artifactPath: f.manifest.filename,
    packageVersion: f.manifest.bundleVersion,
    sha256: f.manifest.sha256,
    sizeBytes: f.manifest.sizeBytes,
    sourceCommit: f.manifest.sourceCommit,
    releasedAt: f.manifest.releasedAt,
    env: { VIDEORC_RELEASE_ID: '0.16.1-alpha.1' }
  })
  await writeFile(join(f.root, 'release.json'), JSON.stringify(alpha))
  await assert.rejects(
    buildLinuxBetaPublicPromotionPlan({
      ...f.options,
      coordinates: { ...f.options.coordinates, releaseId: alpha.releaseId }
    }),
    /only Linux Beta/
  )
  await writeFile(
    join(f.root, 'release.json'),
    JSON.stringify({
      ...f.manifest,
      stage: 'public',
      acceptanceStatus: 'pass',
      acceptanceRecordUrl: f.options.acceptanceRecordUrl
    })
  )
  await assert.rejects(f.plan(), /pending/)
})

test('a claimed PASS, waiver, skipped desktop or short pilot never bypasses the evidence contract', async (t) => {
  for (const change of [
    (f) => {
      f.record.status = 'waived'
    },
    (f) => {
      f.record.environments.pop()
    },
    (f) => {
      f.record.environments[0].categories[0].status = 'skipped'
    },
    (f) => {
      f.record.environments[0].pilot.finishedAt = '2026-10-04T00:00:00.000Z'
    },
    (f) => {
      f.record.candidate.sha256 = 'a'.repeat(64)
    },
    (f) => {
      f.record.environments[0].encoders[0].metrics.audioGapMs = 21
    }
  ]) {
    const f = await fixture(t)
    change(f)
    await assert.rejects(f.plan(), /Beta acceptance failed/)
  }
})

test('refuses tampered measurements, candidate bytes, sidecar, feed and acceptance receipts', async (t) => {
  for (const name of [
    'measurement.log',
    'categories-0.json',
    'Videorc-0.16.1-linux-x64.AppImage',
    'Videorc-0.16.1-linux-x64.AppImage.sha256',
    'latest-linux.yml'
  ]) {
    const f = await fixture(t)
    await writeFile(join(f.root, name), 'tampered')
    await assert.rejects(f.plan())
  }
})

test('local Git reader uses committed blobs, refuses oversized/missing blobs, and verifies ancestry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'beta-promotion-git-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  run('init', '--template=')
  await writeFile(join(root, 'record.json'), '{"committed":true}')
  run('add', 'record.json')
  run(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=',
    'commit',
    '-m',
    'fixture'
  )
  const commit = run('rev-parse', 'HEAD')
  await writeFile(join(root, 'record.json'), '{"committed":false}')
  const git = linuxPromotionGitReader(root)
  assert.equal(git.readBlob(commit, 'record.json', 1024).toString(), '{"committed":true}')
  assert.equal(git.isAncestor(commit, commit), true)
  assert.throws(() => git.isAncestor('main', commit), /full lowercase/)
  assert.throws(() => git.readBlob(commit, 'missing.json', 1024), /Missing or oversized/)
  assert.throws(() => git.readBlob(commit, 'record.json', 4), /Missing or oversized/)
})
