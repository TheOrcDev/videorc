#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sha256File, sha512File } from './lib/windows-alpha-release.mjs'
import { validateDownloadedWindowsCandidate } from './lib/windows-release-candidate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

async function main() {
  if (process.platform !== 'win32') {
    throw new Error(
      `Candidate Authenticode verification must run on win32, got ${process.platform}.`
    )
  }
  const manifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'))
  const installerPath = join(releaseDir, manifest.filename)
  const unpackedAppPath = join(releaseDir, 'win-unpacked', 'Videorc.exe')
  const result = validateDownloadedWindowsCandidate({
    actualInstallerSha256: await sha256File(installerPath),
    actualInstallerSha512: await sha512File(installerPath),
    actualInstallerSizeBytes: (await stat(installerPath)).size,
    appUpdateYml: await readFile(
      join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml'),
      'utf8'
    ),
    appSignature: readAuthenticodeSignature(unpackedAppPath),
    expectedInstallerSha256: requiredEnv('VIDEORC_RELEASE_EXPECTED_SHA256'),
    expectedPublisher: requiredEnv('VIDEORC_WINDOWS_PUBLISHER_NAME'),
    expectedReleaseId: requiredEnv('VIDEORC_RELEASE_ID'),
    expectedSourceCommit: requiredEnv('VIDEORC_RELEASE_SOURCE_COMMIT'),
    feedYml: await readFile(join(releaseDir, 'latest.yml'), 'utf8'),
    manifest,
    requiredFileSizes: {
      blockmap: await requiredSize(join(releaseDir, `${manifest.filename}.blockmap`)),
      ffmpegLicense: await requiredSize(join(releaseDir, 'FFMPEG-LICENSE.txt')),
      ffmpegSource: await requiredSize(join(releaseDir, 'FFMPEG-SOURCE.txt')),
      validationApp: await requiredSize(unpackedAppPath),
      validationAppUpdate: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml')
      ),
      validationBackend: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'videorc-backend.exe')
      ),
      validationFfmpeg: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'bin', 'ffmpeg.exe')
      ),
      validationFfmpegLicense: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'LICENSE.txt')
      ),
      validationFfmpegSource: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'SOURCE.txt')
      ),
      validationFfprobe: await requiredSize(
        join(releaseDir, 'win-unpacked', 'resources', 'ffmpeg', 'bin', 'ffprobe.exe')
      )
    },
    sha256FileText: await readFile(join(releaseDir, `${manifest.filename}.sha256`), 'utf8'),
    signature: readAuthenticodeSignature(installerPath)
  })
  console.log(`windows-release-candidate-verify: PASS (${result.candidateIdentity})`)
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
    throw new Error('Get-AuthenticodeSignature failed for the downloaded candidate.')
  }
  return JSON.parse(result.stdout.trim())
}

async function requiredSize(path) {
  const size = (await stat(path)).size
  if (size <= 0) throw new Error(`Candidate file is empty: ${path}.`)
  return size
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

main().catch((error) => {
  console.error(`windows-release-candidate-verify: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exit(1)
})
