import { mkdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { DIR_MODE } from './config.mjs'
import { DEFAULT_REPO, RELEASE_FEED_URL, fetchCandidate, fetchRelease } from './install-sources.mjs'
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

export const DEFAULT_APP_PATH = '/Applications/Videorc.app'

// Plan 178 U5. Order matters: refuse a running app before downloading
// anything, verify the extracted app where it will be swapped from, and write
// the record only after the swap. Every shell-out uses `runner`, every HTTP
// request `fetchImpl`, so tests run the whole flow offline.
export async function installBuild({
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
  await assertNotRunning(runner, appPath)
  await assertNotRunning(runner, previousAppPath(appPath))

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
    await assertNotRunning(runner, appPath)
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

export async function rollbackInstall({
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
  await assertNotRunning(runner, appPath)
  await assertNotRunning(runner, previousPath)
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
