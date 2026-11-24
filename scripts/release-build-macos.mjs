import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
import { requireRelease } from './lib/release-github.mjs'
import { buildReleaseUploadPlan } from './lib/release-upload-s3.mjs'
import { hashFile, verifyMacosBundleIntegrity } from './lib/release-macos-integrity.mjs'
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { request: { type: 'string' }, platform: { type: 'string' } }
  })
  requireRelease(
    process.platform === 'darwin',
    'macos-host',
    'Use the authorized macOS signing host.'
  )
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const store = createReleaseControlStore(controlStoreConfig())
  try {
    const requestId = values.request ?? process.env.RELEASE_REQUEST_ID
    const state = (await store.read('state.json')).value
    const request = state.requests[requestId]
    requireRelease(
      request && state.active.macos === requestId,
      'macos-request',
      'Activate the exact release request first.'
    )
    const head = () =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const clean = () =>
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8'
      }).trim() === ''
    requireRelease(
      head() === request.identity.sourceSha && clean(),
      'macos-source',
      'Build from the clean frozen source checkout.'
    )
    requireRelease(
      !(await store.read(`local-builds/${requestId}/macos-start.json`)),
      'macos-build-started',
      'This request already started signing. Reconcile its original local output; do not re-sign blindly.'
    )
    requireRelease(
      process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD,
      'macos-notarization',
      'Authorized Apple notarization credentials must be present before build.'
    )
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    requireRelease(
      identities.includes('C2PA37RB58') || process.env.CSC_LINK,
      'macos-signing-identity',
      'Configured Developer ID identity is missing.'
    )
    const env = { ...process.env, VIDEORC_RELEASE_ID: request.identity.releaseIds.macos }
    for (const args of [
      ['release:preflight:macos'],
      ['package:backend:macos'],
      ['ffmpeg:build:macos'],
      ['libsrt:build:macos'],
      ['package:preflight:macos'],
      ['--filter', '@videorc/desktop', 'dist:release'],
      ['release:manifest:macos'],
      ['release:validate:macos']
    ]) {
      if (args.includes('dist:release'))
        await store.write(`local-builds/${requestId}/macos-start.json`, {
          requestId,
          sourceSha: head()
        })
      execFileSync('pnpm', args, { cwd: root, env, stdio: 'inherit' })
    }
    requireRelease(
      head() === request.identity.sourceSha && clean(),
      'macos-build-drift',
      'Source changed during the signed build.'
    )
    const releaseDir = join(root, 'apps/desktop/release')
    const manifestPath = join(releaseDir, 'release.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const plan = await buildReleaseUploadPlan({ releaseDir, manifest, manifestPath })
    const integrity = await verifyMacosBundleIntegrity({
      releaseDir,
      manifest,
      artifacts: plan.artifacts
    })
    const receipt = {
      requestId,
      sourceSha: request.identity.sourceSha,
      releaseId: manifest.releaseId,
      manifestHash: await hashFile(manifestPath),
      integrity,
      artifacts: await Promise.all(
        plan.artifacts.map(async (artifact) => ({
          objectKey: artifact.objectKey,
          sha256: await hashFile(artifact.path)
        }))
      )
    }
    await store.write(`local-builds/${requestId}/macos-complete.json`, receipt)
    console.log(
      'macOS signed build verified. Complete physical acceptance, then release:upload:macos stages these exact bytes.'
    )
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`release-build-macos: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
