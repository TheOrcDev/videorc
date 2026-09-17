import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { afterEach, describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const configPath = '../../apps/desktop/electron-builder.windows-signed.cjs'
const unsignedConfigPath = '../../apps/desktop/electron-builder.windows-unsigned.cjs'
const requiredEnv = {
  VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME: 'videorc-public-trust',
  VIDEORC_WINDOWS_PUBLISHER_NAME: 'Videorc Test Publisher',
  VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME: 'videorc-signing',
  VIDEORC_WINDOWS_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net'
}

afterEach(() => {
  for (const name of Object.keys(requiredEnv)) {
    delete process.env[name]
  }
  delete require.cache[require.resolve(configPath)]
  delete require.cache[require.resolve(unsignedConfigPath)]
})

describe('signed Windows electron-builder config', () => {
  it('fails immediately when the exact publisher or service configuration is absent', () => {
    assert.throws(() => require(configPath), /VIDEORC_WINDOWS_SIGNING_ENDPOINT/)
  })

  it('forces signing, executable metadata, SHA-256, and the exact publisher', async () => {
    Object.assign(process.env, requiredEnv)
    const config = require(configPath)

    assert.equal(config.forceCodeSigning, true)
    assert.equal(config.win.signAndEditExecutable, true)
    assert.equal(config.win.verifyUpdateCodeSignature, true)
    assert.deepEqual(config.win.azureSignOptions, {
      ExcludeAzureDeveloperCliCredential: 'true',
      ExcludeAzurePowerShellCredential: 'true',
      ExcludeEnvironmentCredential: 'true',
      ExcludeInteractiveBrowserCredential: 'true',
      ExcludeManagedIdentityCredential: 'true',
      ExcludeSharedTokenCacheCredential: 'true',
      ExcludeVisualStudioCodeCredential: 'true',
      ExcludeVisualStudioCredential: 'true',
      ExcludeWorkloadIdentityCredential: 'true',
      certificateProfileName: 'videorc-public-trust',
      codeSigningAccountName: 'videorc-signing',
      endpoint: 'https://weu.codesigning.azure.net',
      fileDigest: 'SHA256',
      publisherName: 'Videorc Test Publisher',
      timestampDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com'
    })

    const desktopRequire = createRequire(
      new URL('../../apps/desktop/package.json', import.meta.url)
    )
    const electronBuilderRequire = createRequire(
      desktopRequire.resolve('electron-builder/package.json')
    )
    const configModulePath = electronBuilderRequire.resolve(
      'app-builder-lib/out/util/config/config.js'
    )
    const appBuilderRequire = createRequire(configModulePath)
    const { validateConfiguration } = appBuilderRequire(configModulePath)
    const { DebugLogger } = appBuilderRequire('builder-util/out/DebugLogger.js')

    await assert.doesNotReject(() => validateConfiguration(config, new DebugLogger()))

    const signingManager = await readFile(
      new URL('../../patches/app-builder-lib@26.8.1.patch', import.meta.url),
      'utf8'
    )
    const addedSigningManagerLines = signingManager
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n')
    assert.match(signingManager, /TrustedSigning module version 0\.5\.0/)
    assert.match(signingManager, /-RequiredVersion '0\.5\.0'/)
    assert.match(signingManager, /Azure CLI workload-identity session/)
    assert.match(signingManager, /az account show --output json/)
    assert.match(signingManager, /Long-lived Azure credential environment variables are forbidden/)
    assert.match(signingManager, /Azure Trusted Signing must exclude every credential except/)
    assert.match(signingManager, /return \[\.\.\.res, `-\$\{field\}`\]/)
    assert.doesNotMatch(addedSigningManagerLines, /Install-(?:Module|PackageProvider)/)
    assert.doesNotMatch(addedSigningManagerLines, /verifyPrinciple(?:Secret|Certificate)/)

    const patchHash = createHash('sha256').update(signingManager).digest('hex')
    const lockfile = await readFile(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8')
    assert.match(
      lockfile,
      new RegExp(`app-builder-lib@26\\.8\\.1: ${patchHash}`),
      'pnpm lockfile must bind the exact signing patch bytes'
    )
  })

  it('builds resource-edited unsigned staging without any signing provider', async () => {
    process.env.VIDEORC_WINDOWS_PUBLISHER_NAME = 'Videorc Test Publisher'
    const config = require(unsignedConfigPath)

    assert.equal(config.forceCodeSigning, false)
    assert.deepEqual(config.publish, {
      provider: 'generic',
      publisherName: ['Videorc Test Publisher'],
      url: 'https://www.videorc.com/api/updates/'
    })
    assert.equal(config.win.signAndEditExecutable, true)
    assert.equal(config.win.azureSignOptions, null)
    assert.equal(config.win.signtoolOptions, null)
    assert.equal(config.win.verifyUpdateCodeSignature, true)

    const desktopRequire = createRequire(
      new URL('../../apps/desktop/package.json', import.meta.url)
    )
    const electronBuilderRequire = createRequire(
      desktopRequire.resolve('electron-builder/package.json')
    )
    const configModulePath = electronBuilderRequire.resolve(
      'app-builder-lib/out/util/config/config.js'
    )
    const appBuilderRequire = createRequire(configModulePath)
    const { validateConfiguration } = appBuilderRequire(configModulePath)
    const { DebugLogger } = appBuilderRequire('builder-util/out/DebugLogger.js')

    await assert.doesNotReject(() => validateConfiguration(config, new DebugLogger()))
  })

  it('refuses unsigned staging without the exact update publisher', () => {
    assert.throws(() => require(unsignedConfigPath), /VIDEORC_WINDOWS_PUBLISHER_NAME/)
  })

  it('keeps the unsigned build and protected OIDC signing jobs trust-separated', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/release-windows-alpha.yml', import.meta.url),
      'utf8'
    )
    const unsignedStart = workflow.indexOf('\n  unsigned:')
    const signingStart = workflow.indexOf('\n  sign:')
    assert.ok(unsignedStart >= 0, 'workflow must define the unsigned job')
    assert.ok(signingStart > unsignedStart, 'signing job must follow the unsigned job')

    const unsignedJob = workflow.slice(unsignedStart, signingStart)
    const signingJob = workflow.slice(signingStart)

    assert.match(unsignedJob, /pnpm package:desktop:windows:unsigned/)
    assert.match(unsignedJob, /function Invoke-NativeGate/)
    assert.equal((unsignedJob.match(/Invoke-NativeGate '/g) ?? []).length, 9)
    assert.match(unsignedJob, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/)
    assert.match(unsignedJob, /retention-days: 1/)
    assert.match(unsignedJob, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/)
    assert.match(
      unsignedJob,
      /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/
    )
    assert.match(
      unsignedJob,
      /manifest_sha256: \$\{\{ steps\.handoff\.outputs\.manifest_sha256 \}\}/
    )
    assert.doesNotMatch(unsignedJob, /environment: windows-alpha-release/)
    assert.doesNotMatch(unsignedJob, /id-token: write/)
    assert.doesNotMatch(unsignedJob, /azure\/login@/)
    assert.doesNotMatch(unsignedJob, /\$\{\{ secrets\./)

    assert.match(signingJob, /needs: unsigned/)
    assert.match(signingJob, /environment: windows-alpha-release/)
    assert.match(signingJob, /id-token: write/)
    assert.match(signingJob, /pnpm install --frozen-lockfile --ignore-scripts/)
    assert.match(signingJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/)
    assert.match(signingJob, /artifact-ids: \$\{\{ needs\.unsigned\.outputs\.artifact_id \}\}/)
    assert.match(signingJob, /merge-multiple: true/)
    assert.match(
      signingJob,
      /EXPECTED_MANIFEST_SHA256: \$\{\{ needs\.unsigned\.outputs\.manifest_sha256 \}\}/
    )
    assert.match(signingJob, /azure\/login@532459ea530d8321f2fb9bb10d1e0bcf23869a43/)
    assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1)
    assert.doesNotMatch(workflow, /\$\{\{ secrets\.AZURE_CLIENT_SECRET \}\}/)
    assert.doesNotMatch(workflow, /pnpm dist:desktop:windows:release/)

    const prewarm = signingJob.indexOf('- name: Prewarm NSIS before Azure login')
    const login = signingJob.indexOf('- name: Log in to Azure with GitHub OIDC')
    const build = signingJob.indexOf(
      '- name: Sign staged executables and build signed NSIS installer'
    )
    const logout = signingJob.indexOf('- name: Clear Azure CLI session immediately')
    const validate = signingJob.indexOf('- name: Validate exact signed release bundle after logout')
    const store = signingJob.indexOf('- name: Store immutable private candidate')
    assert.ok(prewarm >= 0 && prewarm < login)
    assert.ok(login < build && build < logout)
    assert.ok(logout < validate && validate < store)

    const cleanupStep = signingJob.slice(logout, validate)
    assert.match(cleanupStep, /az logout/)
    assert.match(cleanupStep, /az account clear/)
    assert.match(cleanupStep, /throw "Azure CLI cleanup failed:/)
    assert.doesNotMatch(cleanupStep, /SilentlyContinue|exit 0/)

    const promotionWorkflow = await readFile(
      new URL('../../.github/workflows/promote-windows-alpha.yml', import.meta.url),
      'utf8'
    )
    assert.match(
      promotionWorkflow,
      /pnpm release:upload:preflight:windows\n\s+if \(\$LASTEXITCODE -ne 0\)/
    )
    assert.match(promotionWorkflow, /pnpm release:upload:windows\n\s+if \(\$LASTEXITCODE -ne 0\)/)
  })
})
