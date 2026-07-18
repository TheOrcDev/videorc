#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256File, sha512File } from './lib/windows-alpha-release.mjs'
import {
  formatWindowsReleaseValidationReport,
  validateWindowsReleaseFacts
} from './lib/windows-release-artifact-validation.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  if (process.platform !== 'win32') {
    throw new Error(`Windows release validation must run on win32, got ${process.platform}.`)
  }
  const manifestPath = resolve(
    process.env.VIDEORC_RELEASE_MANIFEST_PATH ?? join(releaseDir, 'release.json')
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const installerPath = join(releaseDir, manifest.filename)
  const installerInfo = await stat(installerPath)
  const unpackedResources = join(releaseDir, 'win-unpacked', 'resources')
  const unpackedApp = join(releaseDir, 'win-unpacked', 'Videorc.exe')

  const result = validateWindowsReleaseFacts({
    actualSha256: await sha256File(installerPath),
    actualSha512: await sha512File(installerPath),
    actualSizeBytes: installerInfo.size,
    appSignature: readAuthenticodeSignature(unpackedApp),
    appUpdateYml: await readFile(join(unpackedResources, 'app-update.yml'), 'utf8'),
    expectedPublisher: process.env.VIDEORC_WINDOWS_PUBLISHER_NAME?.trim(),
    expectedSourceCommit: expectedSourceCommit(),
    feedYml: await readFile(join(releaseDir, 'latest.yml'), 'utf8'),
    files: {
      backend: existsSync(join(unpackedResources, 'videorc-backend.exe')),
      packagedApp: existsSync(unpackedApp),
      blockmap: existsSync(join(releaseDir, `${manifest.filename}.blockmap`)),
      ffmpeg: existsSync(join(unpackedResources, 'ffmpeg', 'bin', 'ffmpeg.exe')),
      ffmpegLicense: existsSync(join(unpackedResources, 'ffmpeg', 'LICENSE.txt')),
      ffmpegSource: existsSync(join(unpackedResources, 'ffmpeg', 'SOURCE.txt')),
      ffprobe: existsSync(join(unpackedResources, 'ffmpeg', 'bin', 'ffprobe.exe'))
    },
    manifest,
    sha256FileText: await readFile(join(releaseDir, `${manifest.filename}.sha256`), 'utf8'),
    signature: readAuthenticodeSignature(installerPath)
  })

  console.log(formatWindowsReleaseValidationReport(result))
}

function readAuthenticodeSignature(installerPath) {
  const script = [
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:VIDEORC_SIGNATURE_TARGET',
    '$publisher = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }',
    '[pscustomobject]@{ status = [string]$sig.Status; publisher = $publisher; timestampPresent = ($null -ne $sig.TimeStamperCertificate) } | ConvertTo-Json -Compress'
  ].join('; ')
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, VIDEORC_SIGNATURE_TARGET: installerPath }
    }
  )
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Get-AuthenticodeSignature failed for the Windows installer.')
  }
  return JSON.parse(result.stdout.trim())
}

function currentCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  if (result.status !== 0 || !/^[a-f0-9]{40}$/i.test(result.stdout?.trim() ?? '')) {
    throw new Error('Unable to resolve the exact checked-out source commit.')
  }
  return result.stdout.trim()
}

function expectedSourceCommit() {
  const explicit = process.env.VIDEORC_RELEASE_SOURCE_COMMIT?.trim()
  if (explicit) {
    if (!/^[a-f0-9]{40}$/.test(explicit)) {
      throw new Error(
        'VIDEORC_RELEASE_SOURCE_COMMIT must be a lowercase full 40-character Git SHA.'
      )
    }
    return explicit
  }
  return currentCommit()
}

main().catch((error) => {
  console.error(`windows-release-artifact: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
