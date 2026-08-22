// Hardware-only L1.5 acceptance. This runs the real dev app's 1080p30
// recording matrix once with forced OpenH264 and once with forced VAAPI, then
// emits named-machine evidence. CI and VMs intentionally cannot satisfy it.

import { spawnSync } from 'node:child_process'
import { cpus, platform, release, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assessLinuxEncoderAcceptanceHost,
  assessLinuxEncoderMatrixResults,
  parseLinuxEncoderAcceptanceArgs,
  parseOsRelease
} from './lib/linux-encoder-acceptance.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ffmpegPath = join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')
const ffprobePath = join(repoRoot, 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffprobe')
const fetchScript = join(repoRoot, 'scripts', 'fetch-ffmpeg-linux.mjs')
const matrixScript = join(repoRoot, 'scripts', 'smoke-recording-matrix-app.mjs')
const pinPath = join(repoRoot, 'vendor', 'ffmpeg', 'linux-pin.json')
const timestamp = new Date().toISOString().replaceAll(':', '-')
const outputRoot = resolve(
  process.env.VIDEORC_LINUX_ENCODER_EVIDENCE_DIR ??
    join(tmpdir(), `videorc-linux-encoder-acceptance-${timestamp}`)
)

function fail(message) {
  throw new Error(`linux-encoder-acceptance: ${message}`)
}

function runNode(script, env = process.env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit'
  })
  if (result.error) fail(`could not run ${script}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${script} exited with ${result.status ?? result.signal ?? 'unknown status'}`)
  }
}

async function devicePaths(directory, pattern) {
  const names = await readdir(directory).catch(() => [])
  return names.filter((name) => pattern.test(name)).sort().map((name) => join(directory, name))
}

async function main() {
  const { requested, backends } = parseLinuxEncoderAcceptanceArgs(process.argv.slice(2))
  const osRelease = parseOsRelease(await readFile('/etc/os-release', 'utf8').catch(() => ''))
  const videoDevices = await devicePaths('/dev', /^video\d+$/)
  const renderDevices = await devicePaths('/dev/dri', /^renderD\d+$/)
  const testerName = process.env.VIDEORC_LINUX_TESTER_NAME?.trim()
  const machineName = process.env.VIDEORC_LINUX_TESTER_MACHINE?.trim()
  const physicalHardware = process.env.VIDEORC_LINUX_PHYSICAL_HARDWARE
  const hostAssessment = assessLinuxEncoderAcceptanceHost({
    platform: platform(),
    arch: process.arch,
    osRelease,
    testerName,
    machineName,
    physicalHardware,
    videoDevices,
    renderDevices,
    backends
  })
  if (!hostAssessment.ok) fail(hostAssessment.problems.join('\n  - '))

  await mkdir(outputRoot, { recursive: true })
  runNode(fetchScript)
  if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) {
    fail('the verified Linux FFmpeg/FFprobe pair was not staged')
  }

  const pin = JSON.parse(await readFile(pinPath, 'utf8'))
  const runs = []
  for (const backend of backends) {
    const outputDirectory = join(outputRoot, backend)
    console.log(`\nLinux encoder acceptance: ${backend} -> ${outputDirectory}`)
    runNode(matrixScript, {
      ...process.env,
      VIDEORC_LINUX_H264_ENCODER: backend,
      VIDEORC_MATRIX_ONLY: '1080p30',
      VIDEORC_MATRIX_RECORDING_MS: process.env.VIDEORC_MATRIX_RECORDING_MS ?? '6000',
      VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS: '1',
      VIDEORC_SMOKE_FFMPEG_PATH: ffmpegPath,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_TIMEOUT_MS: process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? '180000'
    })

    const resultsPath = join(outputDirectory, 'recording-matrix-results.json')
    const results = JSON.parse(await readFile(resultsPath, 'utf8'))
    const assessment = assessLinuxEncoderMatrixResults({ backend, results })
    if (!assessment.ok) fail(`${backend}:\n  - ${assessment.problems.join('\n  - ')}`)
    runs.push({ requestedBackend: backend, result: assessment.result })
  }

  const complete = requested === 'all' && runs.length === 2
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    contract: 'linux-l1.5-1080p30',
    complete,
    tester: { name: testerName, machine: machineName },
    host: {
      distribution: osRelease.PRETTY_NAME,
      kernel: release(),
      architecture: process.arch,
      physicalHardwareAttested: true,
      cpu: cpus()[0]?.model ?? 'unknown',
      displaySession: process.env.XDG_SESSION_TYPE ?? 'unknown',
      waylandDisplayPresent: Boolean(process.env.WAYLAND_DISPLAY),
      videoDevices,
      renderDevices
    },
    ffmpeg: { path: ffmpegPath, url: pin.url, sha256: pin.sha256 },
    runs
  }
  const evidencePath = join(outputRoot, 'linux-encoder-acceptance.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

  if (!complete) {
    console.log(`\nDiagnostic backend run passed; full two-backend acceptance remains incomplete.`)
  } else {
    console.log(`\nLinux L1.5 hardware acceptance PASS.`)
  }
  console.log(`Evidence: ${evidencePath}`)
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
