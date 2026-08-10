// Fetches the pinned prebuilt LGPL win64 FFmpeg (BtbN build) and lays it out
// as vendor/ffmpeg/windows-x64/{bin/{ffmpeg.exe,ffprobe.exe},LICENSE.txt,
// SOURCE.txt} — the shape apps/desktop/electron-builder.yml bundles for the
// Windows target. ffprobe ships too: the backend resolves it as a sibling of
// the bundled ffmpeg (ffmpeg.rs), and repair/import/probe break without it.
// The pin (URL + sha256) lives in vendor/ffmpeg/windows-pin.json and is the
// committed reproducibility record; the payload itself is gitignored.
//
// Mirrors the LGPL discipline of scripts/build-ffmpeg-macos.sh: never pin an
// asset whose name lacks "lgpl". SOURCE.txt records the exact upstream URL —
// the LGPL source-offer breadcrumb that ships inside the app bundle.
//
// Usage: node scripts/fetch-ffmpeg-windows.mjs [--force]

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, copyFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { assessFfmpegWindowsPin, autobuildDurability } from './lib/ffmpeg-windows-pin.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinPath = join(repoRoot, 'vendor', 'ffmpeg', 'windows-pin.json')
const downloadPath = join(repoRoot, 'vendor', 'ffmpeg', '_build', 'windows-download.zip')
const extractDir = join(repoRoot, 'vendor', 'ffmpeg', '_build', 'windows-extract')
const outputDir = join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64')
const force = process.argv.includes('--force')

function fail(message) {
  console.error(`fetch-ffmpeg-windows: ${message}`)
  process.exit(1)
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sha256Of(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

const pin = JSON.parse(await readFile(pinPath, 'utf8'))
const assessment = assessFfmpegWindowsPin(pin)
if (!assessment.ok) {
  fail(`${pinPath} is unusable:\n  - ${assessment.problems.join('\n  - ')}`)
}

const ffmpegExe = join(outputDir, 'bin', 'ffmpeg.exe')
const ffprobeExe = join(outputDir, 'bin', 'ffprobe.exe')
const sourceTxt = join(outputDir, 'SOURCE.txt')
if (
  !force &&
  (await fileExists(ffmpegExe)) &&
  (await fileExists(ffprobeExe)) &&
  (await fileExists(sourceTxt))
) {
  const recorded = await readFile(sourceTxt, 'utf8')
  if (recorded.includes(pin.sha256)) {
    console.log(
      `Pinned FFmpeg already present at ${ffmpegExe} — skipping download (use --force to re-fetch).`
    )
    process.exit(0)
  }
}

// Reuse a previously downloaded zip when its checksum matches the pin.
let haveZip = false
if (!force && (await fileExists(downloadPath))) {
  haveZip = (await sha256Of(downloadPath)) === pin.sha256
}
if (!haveZip) {
  console.log(`Downloading ${pin.url}`)
  await mkdir(dirname(downloadPath), { recursive: true })
  const response = await fetch(pin.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    // A 404 on a BtbN autobuild almost always means upstream pruned the
    // release. Say so, rather than leaving the next reader to rediscover it.
    const pruned =
      response.status === 404 && autobuildDurability(pin.url)
        ? '\nThis release looks pruned upstream. Re-pin the last autobuild of a recent month and update the sha256.'
        : ''
    fail(`download failed: HTTP ${response.status} for ${pin.url}${pruned}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(downloadPath))
}

const actualSha = await sha256Of(downloadPath)
if (actualSha !== pin.sha256) {
  fail(
    `checksum mismatch for ${downloadPath}\n  expected: ${pin.sha256}\n  actual:   ${actualSha}\nRefusing to install. Re-run with --force to re-download, or update the pin deliberately.`
  )
}

await rm(extractDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
// tar handles zips on Windows 10+ (bsdtar); unzip is the POSIX default.
if (process.platform === 'win32') {
  execFileSync('tar', ['-xf', downloadPath, '-C', extractDir], { stdio: 'inherit' })
} else {
  execFileSync('unzip', ['-oq', downloadPath, '-d', extractDir], { stdio: 'inherit' })
}

const extracted = (await readdir(extractDir)).filter((name) => name.startsWith('ffmpeg-'))
if (extracted.length !== 1) {
  fail(`expected one ffmpeg-* dir inside the zip, found: ${extracted.join(', ') || '(none)'}`)
}
const zipRoot = join(extractDir, extracted[0])

await rm(outputDir, { recursive: true, force: true })
await mkdir(join(outputDir, 'bin'), { recursive: true })
await copyFile(join(zipRoot, 'bin', 'ffmpeg.exe'), ffmpegExe).catch(() =>
  fail(`zip layout drift: ${extracted[0]}/bin/ffmpeg.exe not found`)
)
await copyFile(join(zipRoot, 'bin', 'ffprobe.exe'), ffprobeExe).catch(() =>
  fail(`zip layout drift: ${extracted[0]}/bin/ffprobe.exe not found`)
)
await copyFile(join(zipRoot, 'LICENSE.txt'), join(outputDir, 'LICENSE.txt')).catch(() =>
  fail(`zip layout drift: ${extracted[0]}/LICENSE.txt not found`)
)
await writeFile(
  sourceTxt,
  [
    'Prebuilt FFmpeg (LGPL) for the Videorc Windows bundle.',
    `URL: ${pin.url}`,
    `SHA256: ${pin.sha256}`,
    `Fetched: ${new Date().toISOString()}`,
    'Corresponding source: https://github.com/BtbN/FFmpeg-Builds (see the release tag in the URL).',
    ''
  ].join('\n')
)

if (!(await fileExists(ffmpegExe))) {
  fail(`assembly finished but ${ffmpegExe} is missing`)
}
if (!(await fileExists(ffprobeExe))) {
  fail(`assembly finished but ${ffprobeExe} is missing`)
}
console.log(`FFmpeg (win64 LGPL) ready at ${outputDir}`)
