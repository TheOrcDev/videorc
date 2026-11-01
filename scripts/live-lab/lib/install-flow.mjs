import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { DIR_MODE } from './config.mjs'
import {
  LINUX_EXECUTABLE,
  LINUX_REQUIRED_FILES,
  extractAppImage,
  fetchLinuxFile,
  fetchLinuxRelease,
  readLinuxAppVersion,
  stageLocalBuild,
  verifyLinuxApp
} from './install-linux.mjs'
import {
  DEFAULT_REPO,
  RELEASE_FEED_URL,
  fetchCandidate,
  fetchRelease,
  resolveBuildPath
} from './install-sources.mjs'
import {
  INSTALL_RECORD_SCHEMA,
  assertNotRunning,
  createStaging,
  extractZip,
  previousAppPath,
  readInstallRecord,
  removeStaging,
  swapBack,
  swapIn,
  withoutPrevious,
  writeInstallRecord
} from './install-swap.mjs'
import { refuse } from './install-runner.mjs'
import { LAB_TEAM_ID, readBundleVersion, verifyApp } from './install-verify.mjs'
import { LINUX, isLinux } from './platform.mjs'

// The lsof check, whatever host runs the tests (CI is Linux).
const MAC_RUNNING = { platform: 'darwin' }

export const DEFAULT_APP_PATH = '/Applications/Videorc.app'

// Plan 179: on Linux the build under test is a directory the lab user owns
// (the extracted AppImage); the harness runs <appPath>/videorc.
export function defaultAppPath(platform = process.platform, home = homedir()) {
  return isLinux(platform)
    ? join(home, '.local', 'share', 'videorc-lab', 'Videorc')
    : DEFAULT_APP_PATH
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false
  )
}

export async function installBuild({ platform = process.platform, ...options }) {
  if (isLinux(platform)) return installLinuxBuild(options)
  if (options.spec?.kind !== 'release' && options.spec?.kind !== 'candidate') {
    throw new Error(`--build ${options.spec?.kind}: is for the Linux lab only.`)
  }
  return installMacBuild(options)
}

export async function rollbackInstall({ platform = process.platform, ...options }) {
  return isLinux(platform) ? rollbackLinuxInstall(options) : rollbackMacInstall(options)
}

// Plan 178 U5. Order matters: refuse a running app before downloading
// anything, verify the extracted app where it will be swapped from, and write
// the record only after the swap. Every shell-out uses `runner`, every HTTP
// request `fetchImpl`, so tests run the whole flow offline.
async function installMacBuild({
  spec,
  appPath = DEFAULT_APP_PATH,
  labDir,
  runner,
  fetchImpl = globalThis.fetch,
  repo = DEFAULT_REPO,
  feedUrl = RELEASE_FEED_URL,
  teamId = LAB_TEAM_ID,
  now = () => new Date(),
  log = () => {}
}) {
  await assertNotRunning(runner, appPath, MAC_RUNNING)
  await assertNotRunning(runner, previousAppPath(appPath), MAC_RUNNING)

  await mkdir(labDir, { recursive: true, mode: DIR_MODE })
  const downloadDir = join(labDir, 'downloads', `${Date.now()}`)
  await mkdir(downloadDir, { recursive: true })
  let stagingDir = null
  try {
    log(spec.kind === 'release' ? 'Reading the release feed...' : 'Fetching the lab candidate...')
    const fetched =
      spec.kind === 'release'
        ? await fetchRelease({ fetchImpl, feedUrl, downloadDir })
        : await fetchCandidate({ runner, repo, spec, downloadDir })
    log(`Downloaded ${basename(fetched.zipPath)} (${fetched.record.version}); hash verified.`)

    stagingDir = await createStaging(appPath)
    const stagedApp = await extractZip(runner, fetched.zipPath, stagingDir, basename(appPath))
    const verified = await verifyApp(runner, stagedApp, {
      teamId,
      gatekeeper: spec.kind === 'release',
      expectedVersion: fetched.expectedVersion
    })
    log(`Verified: team ${verified.teamId}, Gatekeeper ${verified.gatekeeper}.`)

    // A swap could have raced a launch since the first check.
    await assertNotRunning(runner, appPath, MAC_RUNNING)
    const previousVersion = await readBundleVersion(runner, appPath)
    const existing = await readInstallRecord(labDir)
    await swapIn({ stagedApp, appPath, stagingDir })

    const at = now().toISOString()
    let previous = null
    if (previousVersion !== null) {
      previous =
        existing && existing.version === previousVersion
          ? withoutPrevious(existing)
          : { source: 'unknown', version: previousVersion, sha: null }
    }
    const record = {
      schema: INSTALL_RECORD_SCHEMA,
      ...fetched.record,
      teamId: verified.teamId,
      gatekeeper: verified.gatekeeper,
      appPath,
      verifiedAt: at,
      installedAt: at,
      previous
    }
    await writeInstallRecord(labDir, record)
    log(`Installed ${record.version} at ${appPath}.`)
    return record
  } finally {
    if (stagingDir) await removeStaging(stagingDir)
    await rm(downloadDir, { recursive: true, force: true })
  }
}

async function rollbackMacInstall({
  appPath = DEFAULT_APP_PATH,
  labDir,
  runner,
  teamId = LAB_TEAM_ID,
  now = () => new Date(),
  log = () => {}
}) {
  const previousPath = previousAppPath(appPath)
  const hasPrevious = await stat(previousPath).then(
    () => true,
    () => false
  )
  if (!hasPrevious) {
    refuse('no-previous', `There is no ${basename(previousPath)} to roll back to.`)
  }
  await assertNotRunning(runner, appPath, MAC_RUNNING)
  await assertNotRunning(runner, previousPath, MAC_RUNNING)
  // Re-verify what goes back in: it may have sat on disk for days.
  const verified = await verifyApp(runner, previousPath, { teamId, gatekeeper: false })
  const existing = await readInstallRecord(labDir)
  const stagingDir = await createStaging(appPath)
  try {
    await swapBack({ appPath, stagingDir })
  } finally {
    await removeStaging(stagingDir)
  }
  const at = now().toISOString()
  const restored =
    existing?.previous && existing.previous.version === verified.version
      ? existing.previous
      : { source: 'unknown', version: verified.version, sha: null }
  const record = {
    schema: INSTALL_RECORD_SCHEMA,
    ...restored,
    teamId: verified.teamId,
    appPath,
    verifiedAt: at,
    rolledBackAt: at,
    previous: withoutPrevious(existing)
  }
  await writeInstallRecord(labDir, record)
  log(`Rolled back to ${record.version} at ${appPath}.`)
  return record
}

const LOCAL_BUILD_WARNING =
  'WARNING: local-build. This unpacked build has no published hash; only its structure is checked. It is recorded as source local-build, verified local. Never read its results as a verdict on a release.'

// Plan 179, the Linux twin of installMacBuild: same order (refuse a running
// app before fetching, verify where the swap happens, record after the swap),
// with the hash as the only trust anchor. `procfs` ({ listProcs, readlink })
// replaces /proc in tests.
async function installLinuxBuild({
  spec,
  home = homedir(),
  appPath = defaultAppPath(LINUX, home),
  labDir,
  runner,
  fetchImpl = globalThis.fetch,
  feedUrl = RELEASE_FEED_URL,
  sha256 = null,
  procfs,
  now = () => new Date(),
  log = () => {}
}) {
  if (spec.kind === 'candidate') {
    refuse(
      'linux-candidate-unavailable',
      'There is no Linux lab-candidate workflow yet. Build the branch on this machine (pnpm package:desktop:linux) and use --build local:apps/desktop/release/linux-unpacked, or download an AppImage and use --build file:<AppImage>.'
    )
  }
  if (!['release', 'file', 'local'].includes(spec.kind)) {
    throw new Error(`Unknown build kind ${spec.kind}.`)
  }
  const running = { platform: LINUX, procfs }
  await assertNotRunning(runner, appPath, running)
  await assertNotRunning(runner, previousAppPath(appPath), running)

  await mkdir(labDir, { recursive: true, mode: DIR_MODE })
  const downloadDir = join(labDir, 'downloads', `${Date.now()}`)
  await mkdir(downloadDir, { recursive: true })
  let stagingDir = null
  try {
    let fetched
    if (spec.kind === 'release') {
      log('Reading the Linux release feed...')
      fetched = await fetchLinuxRelease({ fetchImpl, feedUrl, downloadDir })
      log(
        `Downloaded ${basename(fetched.appImagePath)} (${fetched.record.version}); sha512 verified.`
      )
    } else if (spec.kind === 'file') {
      const path = resolveBuildPath(spec.path, { home })
      fetched = await fetchLinuxFile({ path, sha256, downloadDir })
      log(`Copied ${basename(path)}; sha256 verified against ${fetched.hashFrom}.`)
    } else {
      const localDir = resolveBuildPath(spec.path, { home })
      log(LOCAL_BUILD_WARNING)
      fetched = {
        localDir,
        expectedVersion: null,
        verified: 'local',
        record: { source: 'local-build', version: null, sha: null, localDir }
      }
    }

    stagingDir = await createStaging(appPath)
    const stagedApp = fetched.localDir
      ? await stageLocalBuild(fetched.localDir, stagingDir)
      : await extractAppImage(runner, fetched.appImagePath, stagingDir)
    const verified = await verifyLinuxApp(stagedApp, { expectedVersion: fetched.expectedVersion })
    log(
      `Verified: ${LINUX_REQUIRED_FILES.join(', ')} present; version ${verified.version ?? '(unknown)'}.`
    )

    // A swap could have raced a launch since the first check.
    await assertNotRunning(runner, appPath, running)
    const hadApp = await exists(appPath)
    const previousVersion = hadApp ? (await readLinuxAppVersion(appPath)).version : null
    const existing = await readInstallRecord(labDir)
    await swapIn({ stagedApp, appPath, stagingDir })

    const at = now().toISOString()
    let previous = null
    if (hadApp) {
      previous =
        existing && existing.version === previousVersion
          ? withoutPrevious(existing)
          : { source: 'unknown', version: previousVersion, sha: null }
    }
    const record = {
      schema: INSTALL_RECORD_SCHEMA,
      ...fetched.record,
      version: verified.version,
      platform: LINUX,
      verified: fetched.verified,
      appPath,
      verifiedAt: at,
      installedAt: at,
      previous
    }
    await writeInstallRecord(labDir, record)
    log(
      `Installed ${record.version ?? '(unknown version)'} at ${appPath}; the harness runs ${join(appPath, LINUX_EXECUTABLE)}.`
    )
    if (record.source === 'local-build') log(LOCAL_BUILD_WARNING)
    return record
  } finally {
    if (stagingDir) await removeStaging(stagingDir)
    await rm(downloadDir, { recursive: true, force: true })
  }
}

async function rollbackLinuxInstall({
  home = homedir(),
  appPath = defaultAppPath(LINUX, home),
  labDir,
  runner,
  procfs,
  now = () => new Date(),
  log = () => {}
}) {
  const previousPath = previousAppPath(appPath)
  if (!(await exists(previousPath))) {
    refuse('no-previous', `There is no ${basename(previousPath)} to roll back to.`)
  }
  const running = { platform: LINUX, procfs }
  await assertNotRunning(runner, appPath, running)
  await assertNotRunning(runner, previousPath, running)
  // Re-verify what goes back in: it may have sat on disk for days.
  const verified = await verifyLinuxApp(previousPath)
  const existing = await readInstallRecord(labDir)
  const stagingDir = await createStaging(appPath)
  try {
    await swapBack({ appPath, stagingDir })
  } finally {
    await removeStaging(stagingDir)
  }
  const at = now().toISOString()
  const restored =
    existing?.previous && existing.previous.version === verified.version
      ? existing.previous
      : { source: 'unknown', version: verified.version, sha: null }
  const record = {
    schema: INSTALL_RECORD_SCHEMA,
    ...restored,
    platform: LINUX,
    appPath,
    verifiedAt: at,
    rolledBackAt: at,
    previous: withoutPrevious(existing)
  }
  await writeInstallRecord(labDir, record)
  log(`Rolled back to ${record.version ?? '(unknown version)'} at ${appPath}.`)
  return record
}
