import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { installBuild, rollbackInstall } from './install-flow.mjs'
import { InstallRefusal } from './install-runner.mjs'
import {
  RELEASE_FEED_URL,
  candidateArtifactName,
  parseBuildSpec,
  parseUpdateFeed
} from './install-sources.mjs'
import { installRecordPath, previousAppPath, readInstallRecord } from './install-swap.mjs'
import { LAB_TEAM_ID, parseCodesignDetails, verifyApp } from './install-verify.mjs'

// The live lab runs on macOS only (launchd, pf, codesign, POSIX paths and modes).
const macOnly = { skip: process.platform === 'win32' && 'the live lab runs on macOS only' }

const SHA = '0123abcd'.repeat(5)
const SHORT = SHA.slice(0, 7)
const RUN_ID = '987654321'
const CANDIDATE_VERSION = `0.9.141-lab.${SHORT}`

// A fake "zip" is a JSON profile of the app inside it; the fake ditto turns
// it into a bundle whose Contents/fake-signature.json drives the fake
// codesign, spctl, xattr and plutil.
function profile(overrides = {}) {
  return {
    marker: 'new',
    version: '0.9.141',
    teamId: LAB_TEAM_ID,
    adhoc: false,
    verify: true,
    notarized: true,
    quarantine: false,
    ...overrides
  }
}

async function writeApp(appPath, appProfile) {
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(appPath, 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(appPath, 'Contents', 'MacOS', 'Videorc'), appProfile.marker)
  await writeFile(join(appPath, 'Contents', 'Resources', 'videorc-backend'), 'backend')
  await writeFile(join(appPath, 'Contents', 'fake-signature.json'), JSON.stringify(appProfile))
}

async function readProfile(appPath) {
  try {
    return JSON.parse(await readFile(join(appPath, 'Contents', 'fake-signature.json'), 'utf8'))
  } catch {
    return null
  }
}

async function marker(appPath) {
  return readFile(join(appPath, 'Contents', 'MacOS', 'Videorc'), 'utf8')
}

function fakeRunner({ gh = {}, runningPaths = [] } = {}) {
  const calls = []
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr })
  const fail = (code = 1, stderr = '') => ({ code, stdout: '', stderr })
  const runner = async (command, args) => {
    calls.push([command, ...args])
    const last = args.at(-1)
    if (command === 'ditto') {
      const [, , zipPath, target] = args
      await writeApp(join(target, 'Videorc.app'), JSON.parse(await readFile(zipPath, 'utf8')))
      return ok()
    }
    if (command === 'codesign' && args[0] === '--verify') {
      const app = await readProfile(last)
      return app?.verify ? ok('', `${last}: valid on disk`) : fail(1, `${last}: invalid signature`)
    }
    if (command === 'codesign' && args[0] === '-dv') {
      const app = await readProfile(last)
      if (!app) return fail(1, 'code object is not signed at all')
      const lines = ['Identifier=dev.theorcdev.videorc']
      if (app.adhoc) {
        lines.push('Signature=adhoc', 'TeamIdentifier=not set')
      } else {
        lines.push(
          `Authority=Developer ID Application: Test Org (${app.teamId})`,
          'Authority=Developer ID Certification Authority',
          `TeamIdentifier=${app.teamId}`
        )
      }
      return ok('', lines.join('\n'))
    }
    if (command === 'spctl') {
      const app = await readProfile(last)
      return app?.notarized
        ? ok('', `${last}: accepted\nsource=Notarized Developer ID`)
        : fail(3, `${last}: rejected\nsource=Unnotarized Developer ID`)
    }
    if (command === 'xattr') {
      const app = await readProfile(last)
      return app?.quarantine ? ok('0081;00000000;gh;') : fail(1, 'No such xattr')
    }
    if (command === '/usr/bin/plutil') {
      const app = await readProfile(dirname(dirname(last)))
      return app ? ok(`${app.version}\n`) : fail(1, 'file does not exist')
    }
    if (command === 'lsof') {
      const paths = args.slice(2)
      const hits = paths.filter((path) => runningPaths.some((running) => path.startsWith(running)))
      return hits.length > 0 ? ok('4242\n') : fail(1)
    }
    if (command === 'gh') {
      const key = `${args[0]} ${args[1]}`
      const handler = gh[key]
      if (!handler) return fail(1, `unexpected gh ${key}`)
      return handler(args)
    }
    return fail(127, `unexpected command ${command}`)
  }
  return { runner, calls }
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'videorc-live-install-test-'))
  return {
    root,
    labDir: join(root, 'lab'),
    appPath: join(root, 'Applications', 'Videorc.app'),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function sha512(text) {
  return createHash('sha512').update(text).digest('base64')
}

function releaseFetch(zipText, { feedSha512 = sha512(zipText), version = '0.9.141' } = {}) {
  const zipName = `Videorc-${version}-mac-arm64.zip`
  const feed = [
    `version: ${version}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${feedSha512}`,
    `    size: ${Buffer.byteLength(zipText)}`,
    `  - url: Videorc-${version}-mac-arm64.dmg`,
    '    sha512: AAAA',
    '    size: 10',
    `path: ${zipName}`,
    `sha512: ${feedSha512}`,
    "releaseDate: '2026-10-11T09:12:37.263Z'"
  ].join('\n')
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url)
    if (url === `${RELEASE_FEED_URL}latest-mac.yml`) return new Response(feed)
    if (url === `${RELEASE_FEED_URL}${zipName}`) return new Response(zipText)
    return new Response('missing', { status: 404 })
  }
  return { fetchImpl, requested }
}

function candidateGh({ sidecarOverrides = {}, appProfile, run = {}, artifacts } = {}) {
  const zipText = JSON.stringify(appProfile)
  const zipName = `Videorc-${CANDIDATE_VERSION}-mac-arm64.zip`
  return {
    'run view': async () => ({
      code: 0,
      stdout: JSON.stringify({
        workflowName: 'Lab candidate macOS',
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        ...run
      }),
      stderr: ''
    }),
    'run download': async (args) => {
      const dir = args[args.indexOf('--dir') + 1]
      // gh puts a --pattern download in a per-artifact folder.
      const target = args.includes('--pattern') ? join(dir, candidateArtifactName(SHA)) : dir
      await mkdir(target, { recursive: true })
      await writeFile(join(target, zipName), zipText)
      const sidecar = {
        schema: 1,
        sha: SHA,
        ref: 'feature/x',
        version: CANDIDATE_VERSION,
        builtAt: '2026-10-12T10:00:00.000Z',
        teamId: LAB_TEAM_ID,
        runId: RUN_ID,
        runAttempt: '1',
        zip: { name: zipName, sha256: createHash('sha256').update(zipText).digest('hex') },
        ...sidecarOverrides
      }
      await writeFile(join(target, 'lab-candidate.json'), JSON.stringify(sidecar))
      return { code: 0, stdout: '', stderr: '' }
    },
    'api -X': async () => ({
      code: 0,
      stdout: JSON.stringify({
        artifacts: artifacts ?? [
          {
            name: candidateArtifactName(SHA),
            expired: false,
            created_at: '2026-10-12T10:05:00Z',
            workflow_run: { id: Number(RUN_ID) }
          },
          {
            name: candidateArtifactName(SHA),
            expired: false,
            created_at: '2026-10-10T10:05:00Z',
            workflow_run: { id: 111 }
          }
        ]
      }),
      stderr: ''
    })
  }
}

async function assertRefused(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof InstallRefusal, `expected InstallRefusal, got ${error}`)
    assert.equal(error.code, code)
    return true
  })
}

async function leftovers(appPath) {
  return (await readdir(dirname(appPath))).filter((name) => name.startsWith('.videorc-install-'))
}

test('parseBuildSpec accepts release, run ids and shas only', () => {
  assert.deepEqual(parseBuildSpec('release'), { kind: 'release' })
  assert.deepEqual(parseBuildSpec('candidate:123'), { kind: 'candidate', runId: '123' })
  assert.deepEqual(parseBuildSpec('candidate:ABCDEF1'), { kind: 'candidate', sha: 'abcdef1' })
  assert.throws(() => parseBuildSpec('candidate:abc'), /--build must be/)
  assert.throws(() => parseBuildSpec('nightly'), /--build must be/)
})

test('parseUpdateFeed reads the electron-builder latest-mac.yml shape', () => {
  const feed = parseUpdateFeed(
    'version: 0.9.141\nfiles:\n  - url: Videorc-0.9.141-mac-arm64.zip\n    sha512: abc==\n    size: 12\npath: Videorc-0.9.141-mac-arm64.zip\n'
  )
  assert.deepEqual(feed, {
    version: '0.9.141',
    zip: { url: 'Videorc-0.9.141-mac-arm64.zip', sha512: 'abc==', size: 12 }
  })
  assert.throws(() => parseUpdateFeed('version: 1\nfiles: []\n'), /no version or no arm64 zip/)
})

test('parseCodesignDetails reads team, ad-hoc and authorities', () => {
  const adhoc = parseCodesignDetails('Identifier=x\nSignature=adhoc\nTeamIdentifier=not set\n')
  assert.equal(adhoc.adhoc, true)
  assert.equal(adhoc.teamId, null)
  const signed = parseCodesignDetails(
    'Authority=Developer ID Application: Test (C2PA37RB58)\nTeamIdentifier=C2PA37RB58\n'
  )
  assert.equal(signed.adhoc, false)
  assert.equal(signed.teamId, 'C2PA37RB58')
  assert.equal(signed.authorities.length, 1)
})

test('verifyApp passes a notarized Developer ID release and reads its version', async () => {
  const box = await sandbox()
  try {
    await writeApp(box.appPath, profile())
    const { runner } = fakeRunner()
    const result = await verifyApp(runner, box.appPath, {
      gatekeeper: true,
      expectedVersion: '0.9.141'
    })
    assert.deepEqual(result, {
      teamId: LAB_TEAM_ID,
      version: '0.9.141',
      gatekeeper: 'Notarized Developer ID'
    })
  } finally {
    await box.cleanup()
  }
})

test('verifyApp refuses ad-hoc, wrong team, bad signature, Gatekeeper and quarantine', async () => {
  const box = await sandbox()
  const { runner } = fakeRunner()
  const cases = [
    [profile({ adhoc: true }), { gatekeeper: false }, 'adhoc-signature'],
    [profile({ teamId: 'ZZZZZZZZZZ' }), { gatekeeper: false }, 'wrong-team'],
    [profile({ verify: false }), { gatekeeper: false }, 'codesign-invalid'],
    [profile({ notarized: false }), { gatekeeper: true }, 'gatekeeper-rejected'],
    [
      profile({ quarantine: true, notarized: false }),
      { gatekeeper: false },
      'quarantined-candidate'
    ],
    [profile(), { gatekeeper: false, expectedVersion: '9.9.9' }, 'version-mismatch']
  ]
  try {
    for (const [appProfile, options, code] of cases) {
      await rm(box.appPath, { recursive: true, force: true })
      await writeApp(box.appPath, appProfile)
      await assertRefused(verifyApp(runner, box.appPath, options), code)
    }
    await rm(box.appPath, { recursive: true, force: true })
    await writeApp(box.appPath, profile({ adhoc: true }))
    await assert.rejects(verifyApp(runner, box.appPath, { gatekeeper: false }), /TCC/)
  } finally {
    await box.cleanup()
  }
})

test(
  'release install verifies sha512, codesign and Gatekeeper, keeps the old app',
  macOnly,
  async () => {
    const box = await sandbox()
    try {
      await writeApp(box.appPath, profile({ marker: 'old', version: '0.9.140' }))
      const zipText = JSON.stringify(profile({ marker: 'new' }))
      const { fetchImpl, requested } = releaseFetch(zipText)
      const { runner, calls } = fakeRunner()
      const record = await installBuild({
        spec: parseBuildSpec('release'),
        appPath: box.appPath,
        labDir: box.labDir,
        runner,
        fetchImpl,
        now: () => new Date('2026-10-12T12:00:00Z')
      })
      assert.equal(await marker(box.appPath), 'new')
      assert.equal(await marker(previousAppPath(box.appPath)), 'old')
      assert.deepEqual(requested, [
        `${RELEASE_FEED_URL}latest-mac.yml`,
        `${RELEASE_FEED_URL}Videorc-0.9.141-mac-arm64.zip`
      ])
      assert.ok(calls.some(([command]) => command === 'spctl'))
      assert.equal(record.source, 'release')
      assert.equal(record.version, '0.9.141')
      assert.equal(record.sha, null)
      assert.equal(record.verifiedAt, '2026-10-12T12:00:00.000Z')
      assert.deepEqual(record.previous, { source: 'unknown', version: '0.9.140', sha: null })
      assert.deepEqual(await readInstallRecord(box.labDir), record)
      assert.equal((await stat(installRecordPath(box.labDir))).mode & 0o777, 0o600)
      assert.deepEqual(await leftovers(box.appPath), [])
      assert.deepEqual(await readdir(join(box.labDir, 'downloads')), [])
    } finally {
      await box.cleanup()
    }
  }
)

test('release install refuses a zip whose sha512 does not match the feed', async () => {
  const box = await sandbox()
  try {
    await writeApp(box.appPath, profile({ marker: 'old', version: '0.9.140' }))
    const zipText = JSON.stringify(profile())
    const { fetchImpl } = releaseFetch(zipText, { feedSha512: sha512('something else') })
    const { runner, calls } = fakeRunner()
    await assertRefused(
      installBuild({
        spec: parseBuildSpec('release'),
        appPath: box.appPath,
        labDir: box.labDir,
        runner,
        fetchImpl
      }),
      'sha512-mismatch'
    )
    assert.equal(await marker(box.appPath), 'old')
    assert.ok(!calls.some(([command]) => command === 'ditto'))
    assert.equal(await readInstallRecord(box.labDir), null)
  } finally {
    await box.cleanup()
  }
})

test('candidate install by run id checks the team and records sha, ref and run', async () => {
  const box = await sandbox()
  try {
    const appProfile = profile({ version: CANDIDATE_VERSION, notarized: false })
    const { runner, calls } = fakeRunner({ gh: candidateGh({ appProfile }) })
    const record = await installBuild({
      spec: parseBuildSpec(`candidate:${RUN_ID}`),
      appPath: box.appPath,
      labDir: box.labDir,
      runner
    })
    assert.equal(await marker(box.appPath), 'new')
    assert.equal(record.source, 'candidate')
    assert.equal(record.sha, SHA)
    assert.equal(record.ref, 'feature/x')
    assert.equal(record.runId, RUN_ID)
    assert.equal(record.version, CANDIDATE_VERSION)
    assert.equal(record.previous, null)
    // Candidates are not notarized: no spctl, but the quarantine flag is checked.
    assert.ok(!calls.some(([command]) => command === 'spctl'))
    assert.ok(calls.some(([command]) => command === 'xattr'))
    const download = calls.find(
      ([command, a, b]) => command === 'gh' && a === 'run' && b === 'download'
    )
    assert.ok(download.includes('--pattern'))
  } finally {
    await box.cleanup()
  }
})

test('candidate install by sha picks the newest unexpired artifact', async () => {
  const box = await sandbox()
  try {
    const appProfile = profile({ version: CANDIDATE_VERSION, notarized: false })
    const { runner, calls } = fakeRunner({ gh: candidateGh({ appProfile }) })
    const record = await installBuild({
      spec: parseBuildSpec(`candidate:${SHA.slice(0, 10)}`),
      appPath: box.appPath,
      labDir: box.labDir,
      runner
    })
    assert.equal(record.runId, RUN_ID)
    const download = calls.find(
      ([command, a, b]) => command === 'gh' && a === 'run' && b === 'download'
    )
    assert.equal(download[3], RUN_ID)
    assert.ok(download.includes(candidateArtifactName(SHA)))
  } finally {
    await box.cleanup()
  }
})

test('candidate refusals: ad-hoc, wrong team, sha mismatch, red run, missing artifact', async () => {
  const box = await sandbox()
  const signed = profile({ version: CANDIDATE_VERSION, notarized: false })
  const cases = [
    [`candidate:${RUN_ID}`, { appProfile: { ...signed, adhoc: true } }, 'adhoc-signature'],
    [`candidate:${RUN_ID}`, { appProfile: { ...signed, teamId: 'ABCDE12345' } }, 'wrong-team'],
    [
      `candidate:${SHA.slice(0, 9)}`,
      { appProfile: signed, sidecarOverrides: { sha: 'f'.repeat(40) } },
      'sha-mismatch'
    ],
    [
      `candidate:${RUN_ID}`,
      {
        appProfile: signed,
        sidecarOverrides: {
          zip: { name: `Videorc-${CANDIDATE_VERSION}-mac-arm64.zip`, sha256: '0'.repeat(64) }
        }
      },
      'sha256-mismatch'
    ],
    [
      `candidate:${RUN_ID}`,
      { appProfile: signed, sidecarOverrides: { zip: { name: 'x.zip', sha256: '0'.repeat(64) } } },
      'sidecar-invalid'
    ],
    [
      `candidate:${RUN_ID}`,
      { appProfile: signed, sidecarOverrides: { version: '0.9.141' } },
      'sidecar-invalid'
    ],
    [
      `candidate:${RUN_ID}`,
      { appProfile: signed, run: { conclusion: 'failure' } },
      'candidate-run-not-green'
    ],
    [
      `candidate:${RUN_ID}`,
      { appProfile: signed, run: { workflowName: 'CI' } },
      'not-a-lab-candidate'
    ],
    [`candidate:${SHA}`, { appProfile: signed, artifacts: [] }, 'candidate-not-found']
  ]
  try {
    await writeApp(box.appPath, profile({ marker: 'old', version: '0.9.140' }))
    for (const [build, ghOptions, code] of cases) {
      const { runner } = fakeRunner({ gh: candidateGh(ghOptions) })
      await assertRefused(
        installBuild({
          spec: parseBuildSpec(build),
          appPath: box.appPath,
          labDir: box.labDir,
          runner
        }),
        code
      )
      assert.equal(await marker(box.appPath), 'old', `${code} left the old app in place`)
      assert.deepEqual(await leftovers(box.appPath), [])
    }
    assert.equal(await readInstallRecord(box.labDir), null)
  } finally {
    await box.cleanup()
  }
})

test('install refuses while Videorc runs from the target, before downloading', async () => {
  const box = await sandbox()
  try {
    await writeApp(box.appPath, profile({ marker: 'old' }))
    const { fetchImpl, requested } = releaseFetch(JSON.stringify(profile()))
    const { runner, calls } = fakeRunner({ runningPaths: [box.appPath] })
    await assertRefused(
      installBuild({
        spec: parseBuildSpec('release'),
        appPath: box.appPath,
        labDir: box.labDir,
        runner,
        fetchImpl
      }),
      'app-running'
    )
    assert.deepEqual(requested, [])
    assert.equal(await marker(box.appPath), 'old')
    const lsof = calls.find(([command]) => command === 'lsof')
    assert.deepEqual(lsof.slice(1, 3), ['-t', '--'])
  } finally {
    await box.cleanup()
  }
})

test('rollback swaps back, re-verifies, and a second rollback returns', async () => {
  const box = await sandbox()
  try {
    await writeApp(box.appPath, profile({ marker: 'old', version: '0.9.140' }))
    const { fetchImpl } = releaseFetch(JSON.stringify(profile({ marker: 'new' })))
    const { runner } = fakeRunner()
    await installBuild({
      spec: parseBuildSpec('release'),
      appPath: box.appPath,
      labDir: box.labDir,
      runner,
      fetchImpl
    })

    const back = await rollbackInstall({ appPath: box.appPath, labDir: box.labDir, runner })
    assert.equal(await marker(box.appPath), 'old')
    assert.equal(await marker(previousAppPath(box.appPath)), 'new')
    assert.equal(back.version, '0.9.140')
    assert.equal(back.previous.version, '0.9.141')
    assert.equal(back.previous.source, 'release')

    const forward = await rollbackInstall({ appPath: box.appPath, labDir: box.labDir, runner })
    assert.equal(await marker(box.appPath), 'new')
    assert.equal(forward.version, '0.9.141')
    assert.equal(forward.source, 'release')
    assert.deepEqual(await leftovers(box.appPath), [])
  } finally {
    await box.cleanup()
  }
})

test('rollback refuses with no previous app, or one with an ad-hoc signature', async () => {
  const box = await sandbox()
  try {
    await writeApp(box.appPath, profile())
    const { runner } = fakeRunner()
    await assertRefused(
      rollbackInstall({ appPath: box.appPath, labDir: box.labDir, runner }),
      'no-previous'
    )
    await writeApp(previousAppPath(box.appPath), profile({ marker: 'old', adhoc: true }))
    await assertRefused(
      rollbackInstall({ appPath: box.appPath, labDir: box.labDir, runner }),
      'adhoc-signature'
    )
    assert.equal(await marker(box.appPath), 'new')
  } finally {
    await box.cleanup()
  }
})
