#!/usr/bin/env node

// Validates a built Linux distro package (deb/rpm) against the payload and
// naming contract from plan 071. Usage:
//
//   node scripts/validate-linux-dist-package.mjs            # scan release dir for deb+rpm
//   node scripts/validate-linux-dist-package.mjs --format deb
//   node scripts/validate-linux-dist-package.mjs --artifact /path/to/Videorc-...-linux-x64.deb
//
// Defaults to VIDEORC_RELEASE_DIR or apps/desktop/release. Listing backends:
// deb → dpkg-deb -c (present wherever a deb is consumed) then bsdtar fallback;
// rpm → rpm -qpl then bsdtar fallback. The facts feed the pure assessor in
// scripts/lib/linux-dist-package.mjs, which is what the tests pin.

import { spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assessLinuxDistPackageFacts,
  formatLinuxDistPackageReport,
  isLinuxDistPackageFilename,
  LINUX_DIST_FORMATS
} from './lib/linux-dist-package.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(
  process.env.VIDEORC_RELEASE_DIR ?? join(repoRoot, 'apps', 'desktop', 'release')
)

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    return null
  }
  return result.stdout
}

function parseDpkgDebListing(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // Symlinks render as "./usr/bin/videorc -> /opt/Videorc/videorc"; keep
      // the link name, not the target, as the member path.
      const arrow = line.indexOf(' -> ')
      const head = arrow === -1 ? line : line.slice(0, arrow)
      return head.split(/\s+/).at(-1) ?? ''
    })
    .filter(Boolean)
}

function listDebViaBsdtar(artifactPath) {
  const membersText = runTool('bsdtar', ['-tf', artifactPath])
  if (membersText === null) return null
  const dataMember = membersText
    .split('\n')
    .map((line) => line.trim())
    .find((member) => /^data\.tar(\.|$)/.test(member))
  if (!dataMember) return null
  // bsdtar -xOf writes the (possibly compressed) data.tar member verbatim to
  // stdout; the second bsdtar auto-detects the compression from the stream.
  const payloadText = runTool('sh', [
    '-c',
    `bsdtar -xOf "$1" "$2" | bsdtar -tf -`,
    'sh',
    artifactPath,
    dataMember
  ])
  if (payloadText === null) return null
  return payloadText.split('\n').filter(Boolean)
}

function listPackagePaths(artifactPath, format) {
  if (format === 'deb') {
    const viaDpkg = runTool('dpkg-deb', ['-c', artifactPath])
    if (viaDpkg !== null) return parseDpkgDebListing(viaDpkg)
    const viaBsdtar = listDebViaBsdtar(artifactPath)
    if (viaBsdtar !== null) return viaBsdtar
    throw new Error('deb listing requires dpkg-deb or bsdtar on PATH.')
  }
  const viaRpm = runTool('rpm', ['-qpl', artifactPath])
  if (viaRpm !== null) return viaRpm.split('\n').filter(Boolean)
  const viaBsdtar = runTool('bsdtar', ['-tf', artifactPath])
  if (viaBsdtar !== null) return viaBsdtar.split('\n').filter(Boolean)
  throw new Error('rpm listing requires rpm or bsdtar on PATH.')
}

function parseArgs(argv) {
  const options = { format: null, artifactPath: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--format') {
      options.format = argv[++index]
    } else if (flag === '--artifact') {
      options.artifactPath = resolve(argv[++index])
    }
  }
  if (options.format !== null && !LINUX_DIST_FORMATS.includes(options.format)) {
    throw new Error(`--format must be one of ${LINUX_DIST_FORMATS.join(', ')}, got ${options.format}.`)
  }
  return options
}

function artifactExtension(artifactPath) {
  const extension = basename(artifactPath).split('.').at(-1)
  if (!LINUX_DIST_FORMATS.includes(extension)) {
    throw new Error(
      `Cannot infer --format from "${artifactPath}"; pass --format ${LINUX_DIST_FORMATS.join('|')}.`
    )
  }
  return extension
}

async function findDistArtifacts(format) {
  const entries = await readdir(releaseDir)
  const matches = entries.filter(
    (entry) => isLinuxDistPackageFilename(entry) && entry.endsWith(`.${format}`)
  )
  return matches.sort()
}

async function validateOne(artifactPath, format) {
  const filename = basename(artifactPath)
  const info = await stat(artifactPath)
  const payloadPaths = listPackagePaths(artifactPath, format)
  const result = assessLinuxDistPackageFacts({
    filename,
    format,
    payloadPaths,
    sizeBytes: info.size
  })
  const report = formatLinuxDistPackageReport(filename, result)
  console.log(report)
  return result.ok
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error(`Linux distro package validation must run on linux, got ${process.platform}.`)
  }
  const { format, artifactPath } = parseArgs(process.argv.slice(2))
  const inferredFormat =
    artifactPath === null && format === null
      ? null
      : (format ?? artifactExtension(artifactPath))
  const formats = inferredFormat === null ? LINUX_DIST_FORMATS : [inferredFormat]
  let validated = 0
  for (const currentFormat of formats) {
    const candidates =
      artifactPath === null
        ? (await findDistArtifacts(currentFormat)).map((entry) => join(releaseDir, entry))
        : [artifactPath]
    if (candidates.length === 0) {
      throw new Error(
        `No Videorc-*-linux-x64.${currentFormat} artifact found in ${releaseDir}.`
      )
    }
    for (const candidate of candidates) {
      const ok = await validateOne(candidate, currentFormat)
      if (!ok) {
        process.exitCode = 1
      }
      validated += 1
    }
  }
  if (validated === 0) {
    throw new Error(`No Linux distro packages to validate (formats: ${formats.join(', ')}).`)
  }
}

main().catch((error) => {
  console.error(`✘ ${error.message}`)
  process.exitCode = 1
})