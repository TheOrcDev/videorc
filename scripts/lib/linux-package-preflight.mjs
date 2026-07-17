import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED_BINARY = process.platform === 'linux' ? 'videorc-backend' : 'videorc-backend.exe'

export function resolveBackendBinaryPath({ repoRoot }) {
  const binName = REQUIRED_BINARY
  return resolve(repoRoot, 'target', 'release', binName)
}

export function validateLinuxPackagePreflight(manifest = {}) {
  const failures = []

  const backendPath = manifest.backendPath || resolveBackendBinaryPath({ repoRoot: manifest.repoRoot })
  if (!backendPath || !existsSync(backendPath)) {
    failures.push(`missing: backend binary at ${backendPath}`)
  } else if (!isExecutable(backendPath)) {
    failures.push(`invalid: backend binary not executable at ${backendPath}`)
  }

  const ffmpegPath = manifest.ffmpegPath || process.env.VIDEORC_BUNDLED_FFMPEG_PATH
  if (!ffmpegPath) {
    failures.push('missing: ffmpeg path (VIDEORC_BUNDLED_FFMPEG_PATH)')
  } else if (!existsSync(ffmpegPath)) {
    failures.push(`missing: ffmpeg binary at ${ffmpegPath}`)
  } else if (!isExecutable(ffmpegPath)) {
    failures.push(`invalid: ffmpeg binary not executable at ${ffmpegPath}`)
  }

  const ffprobePath = manifest.ffprobePath || process.env.VIDEORC_BUNDLED_FFPROBE_PATH
  if (!ffprobePath) {
    failures.push('missing: ffprobe path (VIDEORC_BUNDLED_FFPROBE_PATH)')
  } else if (!existsSync(ffprobePath)) {
    failures.push(`missing: ffprobe binary at ${ffprobePath}`)
  } else if (!isExecutable(ffprobePath)) {
    failures.push(`invalid: ffprobe binary not executable at ${ffprobePath}`)
  }

  const licensePath = manifest.licensePath || process.env.VIDEORC_BUNDLED_LICENSE_PATH
  if (licensePath && !existsSync(licensePath)) {
    failures.push(`missing: bundled license at ${licensePath}`)
  }

  const requiredArtifacts = manifest.requiredArtifacts || []
  for (const artifactPath of requiredArtifacts) {
    if (!existsSync(artifactPath)) {
      failures.push(`missing: required packaging artifact ${artifactPath}`)
    }
  }

  return failures
}

export function formatPreflightFailures(failures) {
  return failures.map((failure) => `[linux-package-preflight] ${failure}`)
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function runLinuxPackagePreflight(argv = process.argv) {
  const repoRoot = resolve(process.cwd(), argv[2] || '.')
  const manifest = {
    repoRoot,
    backendPath: argv[3],
    ffmpegPath: argv[4],
    ffprobePath: argv[5],
    licensePath: argv[6]
  }

  const failures = validateLinuxPackagePreflight(manifest)
  if (failures.length > 0) {
    formatPreflightFailures(failures).forEach((line) => console.error(line))
    return 1
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  const code = runLinuxPackagePreflight(process.argv)
  if (code !== 0) {
    process.exit(code)
  }
}
