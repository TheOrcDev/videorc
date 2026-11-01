import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { buildLinuxUpdateFeedYml, formatSha256File } from '../../lib/linux-alpha-release.mjs'
import { DEFAULT_APP_PATH, defaultAppPath, installBuild, rollbackInstall } from './install-flow.mjs'
import {
  appImageVersionFromName,
  extractAppImage,
  parseDesktopVersion,
  parseSha256File,
  readAsarPackageVersion
} from './install-linux.mjs'
import { InstallRefusal } from './install-runner.mjs'
import {
  RELEASE_FEED_URL,
  candidateArtifactName,
  parseBuildSpec,
  parseUpdateFeed,
  resolveBuildPath
} from './install-sources.mjs'
import {
  installRecordPath,
  linuxRunningPids,
  previousAppPath,
  readInstallRecord
} from './install-swap.mjs'
import { LAB_TEAM_ID, parseCodesignDetails, verifyApp } from './install-verify.mjs'

// The live lab runs on macOS and Linux only (POSIX paths, modes and shells).
const posixOnly = {
  skip: process.platform === 'win32' && 'the live lab runs on macOS and Linux only'
}

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
  // file:/local: are Linux-only; the macOS grammar is unchanged.
  assert.throws(
    () => parseBuildSpec('file:/tmp/x.AppImage', { platform: 'darwin' }),
    /Linux lab only/
  )
  assert.throws(() => parseBuildSpec('local:/tmp/x', { platform: 'darwin' }), /Linux lab only/)
  assert.throws(
    () => parseBuildSpec('nightly', { platform: 'darwin' }),
    /^Error: --build must be "release", "candidate:<run-id>" or "candidate:<sha \(7-40 hex\)>", got "nightly"\.$/
  )
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
  posixOnly,
  async () => {
    const box = await sandbox()
    try {
      await writeApp(box.appPath, profile({ marker: 'old', version: '0.9.140' }))
      const zipText = JSON.stringify(profile({ marker: 'new' }))
      const { fetchImpl, requested } = releaseFetch(zipText)
      const { runner, calls } = fakeRunner()
      const record = await installBuild({
        platform: 'darwin',
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
        platform: 'darwin',
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
      platform: 'darwin',
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
      platform: 'darwin',
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
          platform: 'darwin',
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
        platform: 'darwin',
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
      platform: 'darwin',
      spec: parseBuildSpec('release'),
      appPath: box.appPath,
      labDir: box.labDir,
      runner,
      fetchImpl
    })

    const back = await rollbackInstall({
      platform: 'darwin',
      appPath: box.appPath,
      labDir: box.labDir,
      runner
    })
    assert.equal(await marker(box.appPath), 'old')
    assert.equal(await marker(previousAppPath(box.appPath)), 'new')
    assert.equal(back.version, '0.9.140')
    assert.equal(back.previous.version, '0.9.141')
    assert.equal(back.previous.source, 'release')

    const forward = await rollbackInstall({
      platform: 'darwin',
      appPath: box.appPath,
      labDir: box.labDir,
      runner
    })
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
      rollbackInstall({ platform: 'darwin', appPath: box.appPath, labDir: box.labDir, runner }),
      'no-previous'
    )
    await writeApp(previousAppPath(box.appPath), profile({ marker: 'old', adhoc: true }))
    await assertRefused(
      rollbackInstall({ platform: 'darwin', appPath: box.appPath, labDir: box.labDir, runner }),
      'adhoc-signature'
    )
    assert.equal(await marker(box.appPath), 'new')
  } finally {
    await box.cleanup()
  }
})

// --- Linux (plan 179) ------------------------------------------------------
//
// A fake AppImage is the ELF + "AI\x02" header followed by a JSON profile of
// the squashfs-root inside it; the fake runner's `--appimage-extract` writes
// that tree into its cwd, like the AppImage runtime does.

const LINUX = 'linux'
const APPIMAGE_HEADER = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41, 0x49, 0x02
])
const LINUX_VERSION = '0.9.141'
const APPIMAGE_NAME = `Videorc-${LINUX_VERSION}-linux-x64.AppImage`
const SOURCE_COMMIT = 'f'.repeat(40)

function linuxProfile(overrides = {}) {
  return {
    marker: 'new',
    version: LINUX_VERSION,
    backend: true,
    ffmpeg: true,
    desktop: true,
    ...overrides
  }
}

function appImageBytes(appProfile, { magic = true } = {}) {
  const header = magic ? APPIMAGE_HEADER : Buffer.from('#!/bin/sh\n\n')
  return Buffer.concat([header, Buffer.from(JSON.stringify(appProfile))])
}

// A minimal app.asar holding package.json (the format readAsarPackageVersion reads).
function asarWith(packageJson) {
  const data = Buffer.from(JSON.stringify(packageJson))
  const json = Buffer.from(
    JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } })
  )
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const sizes = Buffer.alloc(8)
  sizes.writeUInt32LE(4, 0)
  sizes.writeUInt32LE(header.length, 4)
  return Buffer.concat([sizes, header, data])
}

async function writeLinuxApp(dir, appProfile) {
  await mkdir(join(dir, 'resources', 'ffmpeg', 'bin'), { recursive: true })
  await writeFile(join(dir, 'videorc'), appProfile.marker, { mode: 0o755 })
  await writeFile(join(dir, 'AppRun'), '#!/bin/sh\n', { mode: 0o755 })
  if (appProfile.backend) {
    await writeFile(join(dir, 'resources', 'videorc-backend'), 'backend', { mode: 0o755 })
  }
  if (appProfile.ffmpeg) {
    await writeFile(join(dir, 'resources', 'ffmpeg', 'bin', 'ffmpeg'), 'ffmpeg', { mode: 0o755 })
  }
  if (appProfile.desktop) {
    await writeFile(
      join(dir, 'videorc.desktop'),
      `[Desktop Entry]\nName=Videorc\nExec=AppRun --no-sandbox %U\nX-AppImage-Version=${appProfile.version}\n`
    )
  }
  if (appProfile.asarVersion) {
    await writeFile(
      join(dir, 'resources', 'app.asar'),
      asarWith({ name: 'videorc', version: appProfile.asarVersion })
    )
  }
}

async function linuxMarker(appDir) {
  return readFile(join(appDir, 'videorc'), 'utf8')
}

function fakeLinuxRunner() {
  const calls = []
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd })
    if (args[0] === '--appimage-extract') {
      if (((await stat(command)).mode & 0o111) === 0) {
        return { code: 126, stdout: '', stderr: `${command}: Permission denied` }
      }
      const appProfile = JSON.parse((await readFile(command)).subarray(11).toString('utf8'))
      await writeLinuxApp(join(options.cwd, 'squashfs-root'), appProfile)
      return { code: 0, stdout: 'squashfs-root/videorc\n', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: `unexpected command ${command}` }
  }
  return { runner, calls }
}

// /proc as a map of pid -> exe link (an Error = unreadable, like EACCES).
function fakeProcfs(exes = {}) {
  return {
    listProcs: async () => Object.keys(exes),
    readlink: async (path) => {
      const exe = exes[/^\/proc\/([0-9]+)\/exe$/.exec(path)?.[1]]
      if (exe === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (exe instanceof Error) throw exe
      return exe
    }
  }
}

const quietProcs = () =>
  fakeProcfs({
    1: '/usr/lib/systemd/systemd',
    77: Object.assign(new Error('EACCES'), { code: 'EACCES' })
  })

async function linuxSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'videorc-live-install-linux-test-'))
  return {
    root,
    home: join(root, 'home'),
    labDir: join(root, 'lab'),
    downloads: join(root, 'Downloads'),
    appPath: join(root, 'share', 'videorc-lab', 'Videorc'),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function linuxReleaseFetch(bytes, { version = LINUX_VERSION, feedStatus = 200, feedSha512 } = {}) {
  const filename = `Videorc-${version}-linux-x64.AppImage`
  // The release tooling's own generator, so the parser is tested against the real feed shape.
  const feed = buildLinuxUpdateFeedYml({
    filename,
    releaseDate: '2026-10-11T09:12:37.263Z',
    sha512: feedSha512 ?? createHash('sha512').update(bytes).digest('base64'),
    sizeBytes: bytes.length,
    version
  })
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url)
    if (url === `${RELEASE_FEED_URL}latest-linux.yml`) {
      return feedStatus === 200 ? new Response(feed) : new Response('nope', { status: feedStatus })
    }
    if (url === `${RELEASE_FEED_URL}${filename}`) return new Response(bytes)
    return new Response('missing', { status: 404 })
  }
  return { fetchImpl, requested }
}

async function writeDownloadedAppImage(box, appProfile, { magic = true, sidecar = 'match' } = {}) {
  await mkdir(box.downloads, { recursive: true })
  const path = join(box.downloads, APPIMAGE_NAME)
  const bytes = appImageBytes(appProfile, { magic })
  await writeFile(path, bytes, { mode: 0o644 })
  const sha256 =
    sidecar === 'match'
      ? createHash('sha256').update(bytes).digest('hex')
      : createHash('sha256').update('something else').digest('hex')
  if (sidecar !== 'none') {
    await writeFile(`${path}.sha256`, formatSha256File({ sha256, filename: APPIMAGE_NAME }))
  }
  return { path, bytes }
}

function linuxInstall(box, spec, extra = {}) {
  return installBuild({
    platform: LINUX,
    spec: parseBuildSpec(spec, { platform: LINUX }),
    home: box.home,
    appPath: box.appPath,
    labDir: box.labDir,
    procfs: quietProcs(),
    now: () => new Date('2026-10-12T12:00:00Z'),
    ...extra
  })
}

test('Linux build grammar, default paths and the previous dir', posixOnly, () => {
  assert.deepEqual(parseBuildSpec('file:~/Downloads/a.AppImage', { platform: LINUX }), {
    kind: 'file',
    path: '~/Downloads/a.AppImage'
  })
  assert.deepEqual(
    parseBuildSpec('local:apps/desktop/release/linux-unpacked', { platform: LINUX }),
    {
      kind: 'local',
      path: 'apps/desktop/release/linux-unpacked'
    }
  )
  assert.deepEqual(parseBuildSpec('candidate:123', { platform: LINUX }), {
    kind: 'candidate',
    runId: '123'
  })
  assert.throws(() => parseBuildSpec('file:', { platform: LINUX }), /needs a path/)
  assert.throws(() => parseBuildSpec('nightly', { platform: LINUX }), /file:<AppImage>/)
  assert.equal(defaultAppPath(LINUX, '/home/lab'), '/home/lab/.local/share/videorc-lab/Videorc')
  assert.equal(defaultAppPath('darwin', '/Users/lab'), DEFAULT_APP_PATH)
  assert.equal(
    previousAppPath('/home/lab/.local/share/videorc-lab/Videorc'),
    '/home/lab/.local/share/videorc-lab/Videorc.previous'
  )
  assert.equal(previousAppPath('/Applications/Videorc.app'), '/Applications/Videorc.previous.app')
  assert.equal(resolveBuildPath('~/Downloads/a', { home: '/home/lab' }), '/home/lab/Downloads/a')
  assert.equal(resolveBuildPath('rel/dir', { cwd: '/repo' }), '/repo/rel/dir')
  assert.equal(appImageVersionFromName(APPIMAGE_NAME), LINUX_VERSION)
  assert.equal(appImageVersionFromName('Videorc-0.9.141-linux-x64 (1).AppImage'), null)
  assert.deepEqual(parseSha256File(formatSha256File({ sha256: 'A'.repeat(64), filename: 'x' })), {
    sha256: 'a'.repeat(64),
    name: 'x'
  })
  assert.equal(parseDesktopVersion('[Desktop Entry]\nX-AppImage-Version=0.9.141\n'), '0.9.141')
  assert.equal(parseDesktopVersion('[Desktop Entry]\n'), null)
})

test(
  'Linux release: feed sha512, magic, extract, structure, version, swap, record',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old', version: '0.9.140' }))
      const { fetchImpl, requested } = linuxReleaseFetch(appImageBytes(linuxProfile()))
      const { runner, calls } = fakeLinuxRunner()
      const lines = []
      const record = await linuxInstall(box, 'release', {
        runner,
        fetchImpl,
        log: (line) => lines.push(line)
      })
      assert.equal(await linuxMarker(box.appPath), 'new')
      assert.equal(await linuxMarker(previousAppPath(box.appPath)), 'old')
      assert.ok(((await stat(join(box.appPath, 'videorc'))).mode & 0o111) !== 0)
      assert.deepEqual(requested, [
        `${RELEASE_FEED_URL}latest-linux.yml`,
        `${RELEASE_FEED_URL}${APPIMAGE_NAME}`
      ])
      // The only thing ever executed: the hash-checked AppImage, extracting into staging.
      assert.equal(calls.length, 1)
      assert.equal(basename(calls[0].command), APPIMAGE_NAME)
      assert.ok(calls[0].command.startsWith(join(box.labDir, 'downloads')))
      assert.deepEqual(calls[0].args, ['--appimage-extract'])
      assert.equal(dirname(dirname(calls[0].cwd)), dirname(box.appPath))
      assert.match(basename(dirname(calls[0].cwd)), /^\.videorc-install-/)
      assert.deepEqual(record, {
        schema: 1,
        source: 'release',
        version: LINUX_VERSION,
        sha: null,
        feedUrl: RELEASE_FEED_URL,
        platform: 'linux',
        verified: 'sha512',
        appPath: box.appPath,
        verifiedAt: '2026-10-12T12:00:00.000Z',
        installedAt: '2026-10-12T12:00:00.000Z',
        previous: { source: 'unknown', version: '0.9.140', sha: null }
      })
      assert.deepEqual(await readInstallRecord(box.labDir), record)
      assert.equal((await stat(installRecordPath(box.labDir))).mode & 0o777, 0o600)
      assert.deepEqual(await leftovers(box.appPath), [])
      assert.deepEqual(await readdir(join(box.labDir, 'downloads')), [])
      assert.ok(lines.some((line) => /sha512 verified/.test(line)))
    } finally {
      await box.cleanup()
    }
  }
)

test(
  'Linux release refuses when the feed is not public, before downloading anything',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old' }))
      for (const status of [404, 401, 403]) {
        const { fetchImpl, requested } = linuxReleaseFetch(appImageBytes(linuxProfile()), {
          feedStatus: status
        })
        const { runner, calls } = fakeLinuxRunner()
        await assert.rejects(linuxInstall(box, 'release', { runner, fetchImpl }), (error) => {
          assert.equal(error.code, 'linux-feed-unavailable')
          assert.match(error.message, /not public/)
          assert.match(error.message, /--build file:<AppImage>/)
          return true
        })
        assert.deepEqual(requested, [`${RELEASE_FEED_URL}latest-linux.yml`])
        assert.deepEqual(calls, [])
      }
      assert.equal(await linuxMarker(box.appPath), 'old')
      assert.equal(await readInstallRecord(box.labDir), null)
    } finally {
      await box.cleanup()
    }
  }
)

test(
  'Linux release refuses an AppImage whose sha512 does not match the feed',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      const { fetchImpl } = linuxReleaseFetch(appImageBytes(linuxProfile()), {
        feedSha512: createHash('sha512').update('other').digest('base64')
      })
      const { runner, calls } = fakeLinuxRunner()
      await assertRefused(linuxInstall(box, 'release', { runner, fetchImpl }), 'sha512-mismatch')
      assert.deepEqual(calls, [])
    } finally {
      await box.cleanup()
    }
  }
)

test(
  'Linux file: verifies the sidecar sha256 while copying and leaves the download untouched',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      const { path } = await writeDownloadedAppImage(box, linuxProfile())
      const { runner, calls } = fakeLinuxRunner()
      const record = await linuxInstall(box, `file:${path}`, { runner })
      assert.equal(await linuxMarker(box.appPath), 'new')
      assert.equal(record.source, 'file')
      assert.equal(record.version, LINUX_VERSION)
      assert.equal(record.verified, 'sha256')
      assert.equal(record.hashFrom, `${APPIMAGE_NAME}.sha256`)
      assert.equal(record.file, APPIMAGE_NAME)
      assert.equal(record.platform, 'linux')
      assert.equal(record.previous, null)
      assert.equal(calls.length, 1)
      assert.notEqual(calls[0].command, path, 'runs the verified copy, never the original')
      assert.equal((await stat(path)).mode & 0o777, 0o644)
    } finally {
      await box.cleanup()
    }
  }
)

test(
  'Linux file: takes --sha256 first, then release.json (with its version and commit)',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      const { path, bytes } = await writeDownloadedAppImage(box, linuxProfile(), {
        sidecar: 'none'
      })
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await writeFile(
        join(box.downloads, 'release.json'),
        JSON.stringify({
          filename: APPIMAGE_NAME,
          sha256,
          sizeBytes: bytes.length,
          bundleVersion: LINUX_VERSION,
          releaseId: `${LINUX_VERSION}-alpha.1`,
          sourceCommit: SOURCE_COMMIT
        })
      )
      const fromManifest = await linuxInstall(box, `file:${path}`, {
        runner: fakeLinuxRunner().runner
      })
      assert.equal(fromManifest.hashFrom, 'release.json')
      assert.equal(fromManifest.sha, SOURCE_COMMIT)
      assert.equal(fromManifest.releaseId, `${LINUX_VERSION}-alpha.1`)

      const fromFlag = await linuxInstall(box, `file:${path}`, {
        runner: fakeLinuxRunner().runner,
        sha256: sha256.toUpperCase()
      })
      assert.equal(fromFlag.hashFrom, '--sha256')
      assert.equal(fromFlag.previous.version, LINUX_VERSION)
      await assertRefused(
        linuxInstall(box, `file:${path}`, { runner: fakeLinuxRunner().runner, sha256: 'abc' }),
        'hash-invalid'
      )
    } finally {
      await box.cleanup()
    }
  }
)

test('Linux file: a hash mismatch is refused before anything runs', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old' }))
    const { path } = await writeDownloadedAppImage(box, linuxProfile(), { sidecar: 'wrong' })
    const { runner, calls } = fakeLinuxRunner()
    await assertRefused(linuxInstall(box, `file:${path}`, { runner }), 'sha256-mismatch')
    assert.deepEqual(calls, [])
    assert.equal(await linuxMarker(box.appPath), 'old')
    assert.deepEqual(await leftovers(box.appPath), [])
    assert.equal(await readInstallRecord(box.labDir), null)
  } finally {
    await box.cleanup()
  }
})

test('Linux file: with no hash anywhere is refused', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    const { path } = await writeDownloadedAppImage(box, linuxProfile(), { sidecar: 'none' })
    const { runner, calls } = fakeLinuxRunner()
    await assert.rejects(linuxInstall(box, `file:${path}`, { runner }), (error) => {
      assert.equal(error.code, 'no-hash')
      assert.match(error.message, /never installs an unverified binary/)
      return true
    })
    // A release.json for another file is no hash either.
    await writeFile(
      join(box.downloads, 'release.json'),
      JSON.stringify({ filename: 'Videorc-0.9.1-linux-x64.AppImage', sha256: '0'.repeat(64) })
    )
    await assertRefused(linuxInstall(box, `file:${path}`, { runner }), 'no-hash')
    assert.deepEqual(calls, [])
    await assertRefused(
      linuxInstall(box, `file:${join(box.downloads, 'missing.AppImage')}`, { runner }),
      'build-not-found'
    )
  } finally {
    await box.cleanup()
  }
})

test(
  'Linux: a file without the AppImage magic is refused before chmod or run',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      const { path } = await writeDownloadedAppImage(box, linuxProfile(), { magic: false })
      const { runner, calls } = fakeLinuxRunner()
      await assertRefused(linuxInstall(box, `file:${path}`, { runner }), 'not-an-appimage')
      assert.deepEqual(calls, [])

      // Directly: the file keeps its mode, so nothing made it executable.
      const staging = join(box.root, 'staging')
      await mkdir(staging)
      const copy = join(box.root, 'copy.AppImage')
      await writeFile(copy, appImageBytes(linuxProfile(), { magic: false }), { mode: 0o600 })
      await chmod(copy, 0o600)
      await assertRefused(extractAppImage(runner, copy, staging), 'not-an-appimage')
      assert.equal((await stat(copy)).mode & 0o777, 0o600)
      assert.deepEqual(calls, [])
    } finally {
      await box.cleanup()
    }
  }
)

test('Linux: a build without resources/videorc-backend is refused', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old' }))
    const { fetchImpl } = linuxReleaseFetch(appImageBytes(linuxProfile({ backend: false })))
    await assert.rejects(
      linuxInstall(box, 'release', { runner: fakeLinuxRunner().runner, fetchImpl }),
      (error) => {
        assert.equal(error.code, 'app-incomplete')
        assert.match(error.message, /resources\/videorc-backend/)
        assert.doesNotMatch(error.message, /ffmpeg/)
        return true
      }
    )
    assert.equal(await linuxMarker(box.appPath), 'old')
    assert.deepEqual(await leftovers(box.appPath), [])
    assert.equal(await readInstallRecord(box.labDir), null)
  } finally {
    await box.cleanup()
  }
})

test(
  'Linux: an AppImage whose .desktop version differs from the feed is refused',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old' }))
      const { fetchImpl } = linuxReleaseFetch(appImageBytes(linuxProfile({ version: '0.9.139' })))
      await assert.rejects(
        linuxInstall(box, 'release', { runner: fakeLinuxRunner().runner, fetchImpl }),
        (error) => {
          assert.equal(error.code, 'version-mismatch')
          assert.match(error.message, /0\.9\.139.*expected 0\.9\.141/)
          return true
        }
      )
      assert.equal(await linuxMarker(box.appPath), 'old')
    } finally {
      await box.cleanup()
    }
  }
)

test('Linux local: copies an unpacked build and records it as local-build', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    const unpacked = join(box.root, 'repo', 'apps', 'desktop', 'release', 'linux-unpacked')
    await writeLinuxApp(unpacked, linuxProfile({ desktop: false, asarVersion: '0.9.142' }))
    const { runner, calls } = fakeLinuxRunner()
    const lines = []
    const record = await linuxInstall(box, `local:${unpacked}`, {
      runner,
      log: (line) => lines.push(line)
    })
    assert.equal(await linuxMarker(box.appPath), 'new')
    assert.equal(await linuxMarker(unpacked), 'new', 'the build dir stays where it was')
    assert.deepEqual(calls, [])
    assert.equal(record.source, 'local-build')
    assert.equal(record.verified, 'local')
    assert.equal(record.version, '0.9.142')
    assert.equal(record.localDir, unpacked)
    assert.equal(record.sha, null)
    assert.ok(lines.filter((line) => /WARNING: local-build/.test(line)).length >= 2)

    await rm(join(unpacked, 'resources', 'ffmpeg'), { recursive: true })
    await assertRefused(linuxInstall(box, `local:${unpacked}`, { runner }), 'app-incomplete')
    await assertRefused(
      linuxInstall(box, `local:${join(box.root, 'nope')}`, { runner }),
      'build-not-found'
    )
    assert.equal(await linuxMarker(box.appPath), 'new')
  } finally {
    await box.cleanup()
  }
})

test('Linux refuses candidate: (no Linux lab-candidate workflow)', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    const { runner, calls } = fakeLinuxRunner()
    await assert.rejects(linuxInstall(box, `candidate:${RUN_ID}`, { runner }), (error) => {
      assert.equal(error.code, 'linux-candidate-unavailable')
      assert.match(error.message, /local:/)
      return true
    })
    assert.deepEqual(calls, [])
  } finally {
    await box.cleanup()
  }
})

test(
  'Linux refuses while Videorc runs from the install or previous dir (/proc, no signals)',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old' }))
      const previous = previousAppPath(box.appPath)
      const procs = {
        1: '/usr/lib/systemd/systemd',
        // A sibling dir sharing the prefix is not "inside" the install dir.
        300: `${box.appPath}-other/videorc`,
        4242: join(box.appPath, 'videorc'),
        4243: `${join(previous, 'resources', 'videorc-backend')} (deleted)`,
        77: Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      assert.deepEqual(await linuxRunningPids(box.appPath, fakeProcfs(procs)), ['4242'])
      assert.deepEqual(await linuxRunningPids(previous, fakeProcfs(procs)), ['4243'])

      const { fetchImpl, requested } = linuxReleaseFetch(appImageBytes(linuxProfile()))
      const { runner, calls } = fakeLinuxRunner()
      await assert.rejects(
        linuxInstall(box, 'release', { runner, fetchImpl, procfs: fakeProcfs(procs) }),
        (error) => {
          assert.equal(error.code, 'app-running')
          assert.match(error.message, /pid 4242/)
          return true
        }
      )
      delete procs[4242]
      await assert.rejects(
        linuxInstall(box, 'release', { runner, fetchImpl, procfs: fakeProcfs(procs) }),
        (error) => {
          assert.equal(error.code, 'app-running')
          assert.match(error.message, /pid 4243/)
          return true
        }
      )
      assert.deepEqual(requested, [])
      assert.deepEqual(calls, [])
      assert.equal(await linuxMarker(box.appPath), 'old')
    } finally {
      await box.cleanup()
    }
  }
)

test(
  'Linux rollback swaps the dirs back, re-verifies, and a second rollback returns',
  posixOnly,
  async () => {
    const box = await linuxSandbox()
    try {
      await writeLinuxApp(box.appPath, linuxProfile({ marker: 'old', version: '0.9.140' }))
      const { fetchImpl } = linuxReleaseFetch(appImageBytes(linuxProfile()))
      await linuxInstall(box, 'release', { runner: fakeLinuxRunner().runner, fetchImpl })
      const rollback = () =>
        rollbackInstall({
          platform: LINUX,
          appPath: box.appPath,
          labDir: box.labDir,
          procfs: quietProcs()
        })

      const back = await rollback()
      assert.equal(await linuxMarker(box.appPath), 'old')
      assert.equal(await linuxMarker(previousAppPath(box.appPath)), 'new')
      assert.equal(back.version, '0.9.140')
      assert.equal(back.platform, 'linux')
      assert.equal(back.previous.version, LINUX_VERSION)
      assert.equal(back.previous.source, 'release')

      const forward = await rollback()
      assert.equal(await linuxMarker(box.appPath), 'new')
      assert.equal(forward.version, LINUX_VERSION)
      assert.equal(forward.source, 'release')
      assert.deepEqual(await leftovers(box.appPath), [])

      // A previous dir that lost a file is not swapped back in.
      await rm(join(previousAppPath(box.appPath), 'resources', 'videorc-backend'))
      await assertRefused(rollback(), 'app-incomplete')
      assert.equal(await linuxMarker(box.appPath), 'new')
      await rm(previousAppPath(box.appPath), { recursive: true })
      await assertRefused(rollback(), 'no-previous')
    } finally {
      await box.cleanup()
    }
  }
)

test('readAsarPackageVersion reads package.json from app.asar, else null', posixOnly, async () => {
  const box = await linuxSandbox()
  try {
    await mkdir(box.root, { recursive: true })
    const asar = join(box.root, 'app.asar')
    await writeFile(asar, asarWith({ name: 'videorc', version: '1.2.3' }))
    assert.equal(await readAsarPackageVersion(asar), '1.2.3')
    await writeFile(asar, 'not an asar at all')
    assert.equal(await readAsarPackageVersion(asar), null)
    assert.equal(await readAsarPackageVersion(join(box.root, 'missing.asar')), null)
  } finally {
    await box.cleanup()
  }
})
