import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function hasCaptureClockProtocol(help) {
  return /^\s*-videorc_audio_clock\s+<boolean>.*Videorc AVF clock protocol 1\).*$/m.test(help)
}

export function probeCaptureClock(binary, run = execFileSync) {
  const help = run(binary, ['-hide_banner', '-h', 'demuxer=avfoundation'], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!hasCaptureClockProtocol(help))
    throw new Error(
      'Bundled FFmpeg lacks Videorc AVF capture clock protocol 1; rebuild the macOS bundle.'
    )
  return { protocol: 1 }
}

export function verifyCaptureClockManifest(bundle, patch) {
  const fingerprint = createHash('sha256').update(readFileSync(patch)).digest('hex')
  for (const file of ['SOURCE.txt', 'BUILD-CONFIG.txt']) {
    const manifest = readFileSync(join(bundle, file), 'utf8')
    if (
      !manifest.split(/\r?\n/).includes('Videorc AVF clock protocol: 1') ||
      !manifest.split(/\r?\n/).includes(`Videorc AVF clock patch SHA-256: ${fingerprint}`)
    )
      throw new Error(`${file} does not identify the maintained capture-clock patch.`)
  }
  const distributedPatch = readFileSync(
    join(bundle, 'source-patches', 'avfoundation-capture-clock.patch')
  )
  if (createHash('sha256').update(distributedPatch).digest('hex') !== fingerprint)
    throw new Error('Bundled source patch differs from the build manifest.')
  return fingerprint
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = resolve(process.argv[2] ?? 'vendor/ffmpeg/current')
  const patch = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'patches/avfoundation-capture-clock.patch'
  )
  const fingerprint = verifyCaptureClockManifest(bundle, patch)
  console.log(JSON.stringify({ ...probeCaptureClock(join(bundle, 'bin', 'ffmpeg')), fingerprint }))
}
