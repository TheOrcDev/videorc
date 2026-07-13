import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const NOISE_CLEANUP_PRESET = 'speech-v1'
export const NOISE_CLEANUP_FILTER = 'afftdn=nr=18:nf=-34:tn=1'
export const NOISE_CLEANUP_CANDIDATES = Object.freeze([
  { name: 'gentle', filter: 'afftdn=nr=12:nf=-38:tn=1' },
  { name: NOISE_CLEANUP_PRESET, filter: NOISE_CLEANUP_FILTER },
  { name: 'strong', filter: 'afftdn=nr=24:nf=-30:tn=1' }
])

export function noiseCleanupArgs(inputPath, outputPath, filter = NOISE_CLEANUP_FILTER) {
  const audioCodecArgs = outputPath.toLowerCase().endsWith('.mkv')
    ? ['-c:a', 'pcm_s16le']
    : ['-c:a', 'aac', '-b:a', '192k']
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-i',
    inputPath,
    '-map',
    '0',
    '-map_metadata',
    '0',
    '-c',
    'copy',
    ...audioCodecArgs,
    '-af',
    filter,
    '-progress',
    'pipe:1',
    outputPath
  ]
}

export function noisySpeechFixtureArgs(outputPath) {
  const audioCodecArgs = outputPath.toLowerCase().endsWith('.mkv')
    ? ['-c:a', 'pcm_s16le']
    : ['-c:a', 'aac', '-b:a', '192k']
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=8',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.18*sin(2*PI*180*t)+0.12*sin(2*PI*360*t)+0.08*sin(2*PI*720*t):s=48000:d=8',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=8:seed=1337',
    '-filter_complex',
    "[1:a]volume='if(between(t,2,6),1,0)':eval=frame[voice];[voice][2:a]amix=inputs=2:normalize=0[a]",
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuv420p',
    ...audioCodecArgs,
    '-shortest',
    outputPath
  ]
}

export function parseMeanVolume(stderr) {
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)
  if (!match) {
    throw new Error(`volumedetect did not report mean_volume: ${stderr.slice(-500)}`)
  }
  return Number(match[1])
}

export function parseStreamHash(stdout) {
  const match = stdout.match(/SHA256=([a-f0-9]{64})/i)
  if (!match) {
    throw new Error(`ffmpeg did not report a SHA256 stream hash: ${stdout.slice(-500)}`)
  }
  return match[1].toLowerCase()
}

export async function runNoiseCleanupArtifactSmoke({
  ffmpegPath,
  ffprobePath,
  sourcePath,
  outputPath,
  filter = NOISE_CLEANUP_FILTER
}) {
  await run(ffmpegPath, noisySpeechFixtureArgs(sourcePath))
  const sourceFileHashBefore = await fileSha256(sourcePath)
  await run(ffmpegPath, noiseCleanupArgs(sourcePath, outputPath, filter))
  const sourceFileHashAfter = await fileSha256(sourcePath)

  const [sourceNoiseDb, outputNoiseDb, sourceVoiceDb, outputVoiceDb] = await Promise.all([
    meanVolume(ffmpegPath, sourcePath, 0.5, 1),
    meanVolume(ffmpegPath, outputPath, 0.5, 1),
    meanVolume(ffmpegPath, sourcePath, 3, 1),
    meanVolume(ffmpegPath, outputPath, 3, 1)
  ])
  const [sourceVideoHash, outputVideoHash] = await Promise.all([
    videoStreamHash(ffmpegPath, sourcePath),
    videoStreamHash(ffmpegPath, outputPath)
  ])
  const [sourceDuration, outputDuration] = await Promise.all([
    durationSeconds(ffprobePath, sourcePath),
    durationSeconds(ffprobePath, outputPath)
  ])
  const [referenceSamples, sourceSamples, outputSamples] = await Promise.all([
    referenceVoiceSamples(ffmpegPath),
    decodedVoiceSamples(ffmpegPath, sourcePath),
    decodedVoiceSamples(ffmpegPath, outputPath)
  ])
  const sourceSnrDb = signalToNoiseRatioDb(referenceSamples, sourceSamples)
  const outputSnrDb = signalToNoiseRatioDb(referenceSamples, outputSamples)

  return {
    preset: NOISE_CLEANUP_PRESET,
    filter,
    sourceFileUnchanged: sourceFileHashBefore === sourceFileHashAfter,
    videoStreamCopied: sourceVideoHash === outputVideoHash,
    noiseReductionDb: sourceNoiseDb - outputNoiseDb,
    sourceSnrDb,
    outputSnrDb,
    snrImprovementDb: outputSnrDb - sourceSnrDb,
    voiceLevelDeltaDb: Math.abs(sourceVoiceDb - outputVoiceDb),
    durationDeltaMs: Math.abs(sourceDuration - outputDuration) * 1000,
    sourceDuration,
    outputDuration
  }
}

export function signalToNoiseRatioDb(reference, observed) {
  const lag = bestCorrelationLag(reference, observed)
  const referenceStart = Math.max(0, -lag)
  const observedStart = Math.max(0, lag)
  const length = Math.min(reference.length - referenceStart, observed.length - observedStart)
  if (length === 0) {
    throw new Error('cannot calculate SNR from empty sample arrays')
  }
  let signalPower = 0
  let errorPower = 0
  for (let index = 0; index < length; index += 1) {
    const expected = reference[referenceStart + index]
    const error = observed[observedStart + index] - expected
    signalPower += expected * expected
    errorPower += error * error
  }
  if (signalPower === 0 || errorPower === 0) {
    return errorPower === 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  }
  return 10 * Math.log10(signalPower / errorPower)
}

function bestCorrelationLag(reference, observed) {
  const maxLag = Math.min(8192, reference.length - 1, observed.length - 1)
  const sampleLength = Math.min(reference.length, observed.length, 48_000)
  const stride = 32
  let bestLag = 0
  let bestScore = Number.NEGATIVE_INFINITY
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const referenceStart = Math.max(0, -lag)
    const observedStart = Math.max(0, lag)
    const length = Math.min(
      sampleLength - referenceStart,
      sampleLength - observedStart,
      reference.length - referenceStart,
      observed.length - observedStart
    )
    if (length <= 0) continue
    let dot = 0
    let referencePower = 0
    let observedPower = 0
    for (let index = 0; index < length; index += stride) {
      const expected = reference[referenceStart + index]
      const actual = observed[observedStart + index]
      dot += expected * actual
      referencePower += expected * expected
      observedPower += actual * actual
    }
    const score = dot / Math.sqrt(referencePower * observedPower)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  return bestLag
}

async function run(executable, args) {
  return execFileAsync(executable, args, { maxBuffer: 8 * 1024 * 1024 })
}

async function runBinary(executable, args) {
  return execFileAsync(executable, args, {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024
  })
}

async function referenceVoiceSamples(ffmpegPath) {
  const { stdout } = await runBinary(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.18*sin(2*PI*180*t)+0.12*sin(2*PI*360*t)+0.08*sin(2*PI*720*t):s=48000:d=4',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1'
  ])
  return float32Samples(stdout)
}

async function decodedVoiceSamples(ffmpegPath, filePath) {
  const { stdout } = await runBinary(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    '2',
    '-t',
    '4',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1'
  ])
  return float32Samples(stdout)
}

function float32Samples(buffer) {
  const aligned = buffer.byteLength - (buffer.byteLength % 4)
  return new Float32Array(buffer.buffer, buffer.byteOffset, aligned / 4)
}

async function meanVolume(ffmpegPath, filePath, startSeconds, durationSecondsValue) {
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner',
    '-ss',
    String(startSeconds),
    '-t',
    String(durationSecondsValue),
    '-i',
    filePath,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  return parseMeanVolume(stderr)
}

async function videoStreamHash(ffmpegPath, filePath) {
  const { stdout } = await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-f',
    'hash',
    '-hash',
    'sha256',
    'pipe:1'
  ])
  return parseStreamHash(stdout)
}

async function durationSeconds(ffprobePath, filePath) {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ])
  const duration = Number(stdout.trim())
  if (!Number.isFinite(duration)) {
    throw new Error(`ffprobe returned an invalid duration for ${filePath}: ${stdout}`)
  }
  return duration
}

async function fileSha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}
