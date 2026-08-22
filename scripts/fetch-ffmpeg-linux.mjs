// Fetch the pinned Linux x64 LGPL FFmpeg bundle and stage the exact files the
// future AppImage will carry. The executable configuration is verified on the
// Linux host before it is accepted: VAAPI and OpenH264 are required, while
// x264/x265/fdk-aac, GPL, and nonfree builds fail closed.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import {
  assessFfmpegLinuxPin,
  assessLinuxFfmpegCapabilities
} from './lib/ffmpeg-linux-pin.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinPath = join(repoRoot, 'vendor', 'ffmpeg', 'linux-pin.json')
const downloadPath = join(repoRoot, 'vendor', 'ffmpeg', '_build', 'linux-download.tar.xz')
const extractDir = join(repoRoot, 'vendor', 'ffmpeg', '_build', 'linux-extract')
const outputDir = join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64')
const force = process.argv.includes('--force')

function fail(message) {
  console.error(`fetch-ffmpeg-linux: ${message}`)
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
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function runText(executable, args) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function verifyOpenH264Encoder(executable) {
  execFileSync(
    executable,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=128x72:r=30',
      '-frames:v',
      '3',
      '-an',
      '-c:v',
      'libopenh264',
      '-profile:v',
      'high',
      '-rc_mode',
      'bitrate',
      '-b:v',
      '1000k',
      '-f',
      'null',
      '-'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

if (process.platform !== 'linux' || process.arch !== 'x64') {
  fail(`requires Linux x64, got ${process.platform}/${process.arch}`)
}

const pin = JSON.parse(await readFile(pinPath, 'utf8'))
const pinAssessment = assessFfmpegLinuxPin(pin)
if (!pinAssessment.ok) {
  fail(`${pinPath} is unusable:\n  - ${pinAssessment.problems.join('\n  - ')}`)
}

const ffmpegBin = join(outputDir, 'bin', 'ffmpeg')
const ffprobeBin = join(outputDir, 'bin', 'ffprobe')
const sourceTxt = join(outputDir, 'SOURCE.txt')
const buildConfigTxt = join(outputDir, 'BUILD-CONFIG.txt')

if (
  !force &&
  (await fileExists(ffmpegBin)) &&
  (await fileExists(ffprobeBin)) &&
  (await fileExists(sourceTxt)) &&
  (await fileExists(buildConfigTxt))
) {
  const recorded = await readFile(sourceTxt, 'utf8')
  if (recorded.includes(pin.sha256)) {
    const capabilities = assessLinuxFfmpegCapabilities({
      versionOutput: runText(ffmpegBin, ['-version']),
      encodersOutput: runText(ffmpegBin, ['-hide_banner', '-encoders'])
    })
    if (capabilities.ok) {
      verifyOpenH264Encoder(ffmpegBin)
      console.log(`Pinned Linux FFmpeg already verified at ${ffmpegBin}`)
      process.exit(0)
    }
  }
}

let haveTarball = false
if (!force && (await fileExists(downloadPath))) {
  haveTarball = (await sha256Of(downloadPath)) === pin.sha256
}
if (!haveTarball) {
  console.log(`Downloading ${pin.url}`)
  await mkdir(dirname(downloadPath), { recursive: true })
  const response = await fetch(pin.url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    fail(`download failed: HTTP ${response.status} for ${pin.url}`)
  }

  const totalBytes = Number(response.headers.get('content-length') || 0)
  let downloadedBytes = 0
  let lastUpdate = 0
  const startTime = Date.now()
  const interactive = process.stdout.isTTY === true
  const updateIntervalMs = interactive ? 100 : 10_000
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length
      const now = Date.now()
      if (now - lastUpdate >= updateIntervalMs) {
        lastUpdate = now
        const elapsedSeconds = Math.max(0.001, (now - startTime) / 1000)
        const currentMiB = (downloadedBytes / 1024 / 1024).toFixed(1)
        const speedMiB = (downloadedBytes / 1024 / 1024 / elapsedSeconds).toFixed(1)
        const suffix = totalBytes
          ? ` / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB (${Math.floor((downloadedBytes / totalBytes) * 100)}%)`
          : ''
        const line = `${currentMiB}${suffix} at ${speedMiB} MiB/s`
        if (interactive) process.stdout.write(`\r  ${line}`)
        else console.log(`  ${line}`)
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (interactive) process.stdout.write('\n')
      callback()
    }
  })
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(downloadPath))
}

const actualSha256 = await sha256Of(downloadPath)
if (actualSha256 !== pin.sha256) {
  fail(
    `checksum mismatch for ${downloadPath}\n  expected: ${pin.sha256}\n  actual:   ${actualSha256}`
  )
}

await rm(extractDir, { recursive: true, force: true })
await mkdir(extractDir, { recursive: true })
execFileSync('tar', ['-xJf', downloadPath, '-C', extractDir], { stdio: 'inherit' })

const extracted = (await readdir(extractDir)).filter((name) => name.startsWith('ffmpeg-'))
if (extracted.length !== 1) {
  fail(`expected one ffmpeg-* directory, found ${extracted.join(', ') || '(none)'}`)
}
const tarRoot = join(extractDir, extracted[0])

await rm(outputDir, { recursive: true, force: true })
await mkdir(join(outputDir, 'bin'), { recursive: true })
await copyFile(join(tarRoot, 'bin', 'ffmpeg'), ffmpegBin).catch(() =>
  fail(`archive layout drift: ${extracted[0]}/bin/ffmpeg is missing`)
)
await copyFile(join(tarRoot, 'bin', 'ffprobe'), ffprobeBin).catch(() =>
  fail(`archive layout drift: ${extracted[0]}/bin/ffprobe is missing`)
)
await copyFile(join(tarRoot, 'LICENSE.txt'), join(outputDir, 'LICENSE.txt')).catch(() =>
  fail(`archive layout drift: ${extracted[0]}/LICENSE.txt is missing`)
)
await chmod(ffmpegBin, 0o755)
await chmod(ffprobeBin, 0o755)

const versionOutput = runText(ffmpegBin, ['-version'])
const encodersOutput = runText(ffmpegBin, ['-hide_banner', '-encoders'])
const capabilityAssessment = assessLinuxFfmpegCapabilities({ versionOutput, encodersOutput })
if (!capabilityAssessment.ok) {
  await rm(outputDir, { recursive: true, force: true })
  fail(`archive violates the Linux encoder policy:\n  - ${capabilityAssessment.problems.join('\n  - ')}`)
}
try {
  verifyOpenH264Encoder(ffmpegBin)
} catch (error) {
  await rm(outputDir, { recursive: true, force: true })
  const stderr = error?.stderr?.toString().trim()
  fail(`the staged libopenh264 encoder failed a real encode${stderr ? `: ${stderr}` : ''}`)
}

await writeFile(
  sourceTxt,
  [
    'Prebuilt FFmpeg and FFprobe (Linux x64, LGPL) for Videorc.',
    `Binary archive: ${pin.url}`,
    `Binary SHA-256: ${pin.sha256}`,
    'Corresponding source and reproducible build scripts: https://github.com/BtbN/FFmpeg-Builds',
    'The release tag in the binary URL identifies the exact source/build revision.',
    ''
  ].join('\n')
)
await writeFile(buildConfigTxt, versionOutput)

console.log(`Linux FFmpeg verified: VAAPI + OpenH264, LGPL-only (${outputDir})`)
