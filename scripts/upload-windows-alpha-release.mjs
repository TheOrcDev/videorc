import { stageCoordinatedPlan, releaseControllerEnabled } from './lib/release-coordinator.mjs'

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadChangelogEntries,
  mergeChangelogDocuments,
  requireChangelogEntryForRelease
} from './lib/changelog.mjs'
import {
  assertNoReleaseOriginPending,
  planReleaseUploadOrigins,
  writeReleaseOriginPending
} from './lib/release-upload-origins.mjs'
import { publishReleaseUploadArtifact } from './lib/release-upload-s3.mjs'
import { loadValidatedWindowsAcceptanceHistory } from './lib/windows-acceptance-history.mjs'
import { buildWindowsReleaseUploadPlan } from './lib/windows-release-upload.mjs'
import {
  assertWindowsFeedTransition,
  inspectRemoteArtifact,
  readRemoteTextObject
} from './lib/windows-release-publication.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  validateArtifactImmediatelyBeforeUpload({ manifestPath })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const controlled = await releaseControllerEnabled()
  if (controlled && process.env.VIDEORC_RELEASE_COORDINATED_PHASE !== 'stage')
    throw new Error(
      'Controlled Windows publication must use the protected staging/finalization workflow.'
    )
  // Promote the exact candidate's numeric version, not whatever main is now.
  // macOS may already have rolled the package.json forward; the skill allows
  // the Windows Alpha to stay on the already-built candidate.
  const sourcePackageShow = spawnSync(
    'git',
    ['show', `${manifest.sourceCommit}:apps/desktop/package.json`],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (sourcePackageShow.status !== 0) {
    throw new Error(
      `Could not read apps/desktop/package.json at candidate source ${manifest.sourceCommit}.`
    )
  }
  const sourcePackage = JSON.parse(sourcePackageShow.stdout)
  const acceptedReleaseIds = await loadValidatedWindowsAcceptanceHistory(
    join(repoRoot, 'docs', 'acceptance', 'windows-alpha')
  )
  if (!controlled) await assertNoReleaseOriginPending(repoRoot)
  const originPlan = await planReleaseUploadOrigins({
    allowMirrorOnly: ['1', 'true', 'yes', 'on'].includes(
      process.env.VIDEORC_RELEASE_ALLOW_MIRROR_ONLY?.trim().toLowerCase() ?? ''
    )
  })
  for (const origin of originPlan.blocked) {
    console.warn(
      `windows-alpha-release-upload: WARNING origin ${origin.name} is unreachable and will be skipped (${origin.reason})`
    )
  }
  // Feed-transition and changelog state are read from the best reachable
  // origin (the primary when it answers); every origin receives the same bytes.
  const config = originPlan.reachable.at(-1).config
  const changelogJsonPath =
    (process.env.VIDEORC_WINDOWS_RELEASE_STAGE?.trim() || 'public') === 'public'
      ? await prepareChangelog(manifest.releaseId, config)
      : null
  const plan = await buildWindowsReleaseUploadPlan({
    changelogJsonPath,
    ffmpegLicensePath: resolve(
      process.env.VIDEORC_WINDOWS_FFMPEG_LICENSE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'LICENSE.txt')
    ),
    ffmpegSourcePath: resolve(
      process.env.VIDEORC_WINDOWS_FFMPEG_SOURCE_PATH ??
        join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'SOURCE.txt')
    ),
    manifest,
    manifestPath,
    releaseDir
  })
  const nextFeedYml = await readFile(join(releaseDir, 'latest.yml'), 'utf8')
  const currentFeedYml = await readRemoteTextObject({
    config,
    objectKey: `${plan.updatesPrefix}/latest.yml`
  })
  const transition = assertWindowsFeedTransition({
    acceptedReleaseIds,
    currentFeedYml,
    nextFeedYml,
    stage: plan.stage,
    trustedCurrentVersion: sourcePackage.version
  })

  if (controlled) {
    await stageCoordinatedPlan({ repoRoot, platform: 'windows', plan, originPlan })
    console.log('windows-alpha-release-upload: immutable staging verified; finalization pending')
    return
  }
  for (const target of originPlan.reachable) {
    console.log(
      `windows-alpha-release-upload: ${plan.stage} ${plan.releaseId} (${transition.kind}) to ${target.name} s3://${target.config.bucket}/${plan.prefix}`
    )
    const targetFeed = await readRemoteTextObject({
      config: target.config,
      objectKey: `${plan.updatesPrefix}/latest.yml`
    })
    assertWindowsFeedTransition({
      acceptedReleaseIds,
      currentFeedYml: targetFeed,
      nextFeedYml,
      stage: plan.stage,
      trustedCurrentVersion: sourcePackage.version
    })
    for (const artifact of plan.artifacts) {
      const result = artifact.immutable
        ? await inspectRemoteArtifact({ artifact, config: target.config })
        : { state: 'mutable' }
      if (result.state === 'identical') {
        console.log(
          `windows-alpha-release-upload: [${target.name}] reused exact immutable ${artifact.label} -> ${artifact.objectKey}`
        )
      } else {
        await uploadArtifact({ artifact, config: target.config })
        console.log(
          `windows-alpha-release-upload: [${target.name}] uploaded ${artifact.label} -> ${artifact.objectKey}`
        )
      }
      console.log(
        `windows-alpha-release-upload: [${target.name}] verified SHA-256 ${artifact.objectKey}`
      )
    }
  }
  if (originPlan.blocked.length) {
    const pendingPaths = await writeReleaseOriginPending({
      artifacts: plan.artifacts,
      blocked: originPlan.blocked,
      platform: 'windows',
      releaseId: plan.releaseId,
      repoRoot
    })
    console.warn(
      `windows-alpha-release-upload: WARNING published WITHOUT ${originPlan.blocked.map((origin) => origin.name).join(', ')}. Run pnpm release:sync:origins -- --pending once it is reachable (${pendingPaths.join(', ')}).`
    )
  }
  console.log('windows-alpha-release-upload: PASS')
}

async function prepareChangelog(releaseId, config) {
  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  requireChangelogEntryForRelease(entries, releaseId, { requiredPlatform: 'windows' })
  const outPath = join(repoRoot, 'dist', 'changelog', 'changelog.json')
  const remoteText = await readRemoteTextObject({
    config,
    objectKey: 'changelog/changelog.json'
  })
  const remoteDocument = parseRemoteChangelog(remoteText)
  const document = mergeChangelogDocuments({
    publishingReleaseId: releaseId,
    publishingPlatform: 'windows',
    generatedAt: new Date().toISOString(),
    localEntries: entries,
    remoteDocument
  })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`)
  return outPath
}

function parseRemoteChangelog(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Published changelog/changelog.json is not valid JSON.')
  }
}

async function uploadArtifact({ artifact, config }) {
  return publishReleaseUploadArtifact({ artifact, config })
}

function validateArtifactImmediatelyBeforeUpload({ manifestPath }) {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'validate-windows-release-artifact.mjs')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VIDEORC_RELEASE_DIR: releaseDir,
        VIDEORC_RELEASE_MANIFEST_PATH: manifestPath
      },
      stdio: 'inherit'
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `release artifact validation failed immediately before upload (exit ${result.status ?? 'unknown'}).`
    )
  }
}

main().catch((error) => {
  console.error(`windows-alpha-release-upload: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
