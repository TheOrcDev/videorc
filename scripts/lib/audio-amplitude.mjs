import { spawn } from 'node:child_process'

export function measurePcm16Le(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const sampleCount = Math.floor(bytes.length / 2)
  if (sampleCount === 0) {
    return { sampleCount: 0, peak: 0, rms: 0 }
  }

  let peak = 0
  let sumSquares = 0
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const normalized = bytes.readInt16LE(offset) / 32_768
    const absolute = Math.abs(normalized)
    if (absolute > peak) peak = absolute
    sumSquares += normalized * normalized
  }
  return {
    sampleCount,
    peak,
    rms: Math.sqrt(sumSquares / sampleCount)
  }
}

export function inspectPcm16Wav(wav) {
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav ?? [])
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Caption upload did not contain a RIFF/WAVE payload.')
  }

  let format = null
  let pcm = null
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const payloadStart = offset + 8
    const payloadEnd = payloadStart + length
    if (payloadEnd > bytes.length) {
      throw new Error(`WAV ${kind} chunk exceeded the upload body.`)
    }
    if (kind === 'fmt ' && length >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(payloadStart),
        channels: bytes.readUInt16LE(payloadStart + 2),
        sampleRate: bytes.readUInt32LE(payloadStart + 4),
        bitsPerSample: bytes.readUInt16LE(payloadStart + 14)
      }
    } else if (kind === 'data') {
      pcm = bytes.subarray(payloadStart, payloadEnd)
    }
    offset = payloadEnd + (length % 2)
  }

  if (!format || !pcm) throw new Error('Caption WAV was missing fmt or data.')
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `Caption WAV must be PCM16, got format=${format.audioFormat} bits=${format.bitsPerSample}.`
    )
  }
  return { ...format, ...measurePcm16Le(pcm) }
}

export function inspectMultipartPcm16Wav(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? [])
  const start = bytes.indexOf(Buffer.from('RIFF'))
  if (start < 0 || start + 8 > bytes.length) {
    throw new Error('Caption multipart upload did not contain a WAV file.')
  }
  const length = bytes.readUInt32LE(start + 4) + 8
  if (length < 44 || start + length > bytes.length) {
    throw new Error('Caption multipart upload contained a truncated WAV file.')
  }
  return inspectPcm16Wav(bytes.subarray(start, start + length))
}

export async function analyzeMediaAudioAmplitude(
  filePath,
  { ffmpegPath = 'ffmpeg', sampleRate = 16_000 } = {}
) {
  const pcm = await runBinary(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    's16le',
    'pipe:1'
  ])
  return {
    file: filePath,
    channels: 1,
    sampleRate,
    bitsPerSample: 16,
    ...measurePcm16Le(pcm)
  }
}

function runBinary(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(Buffer.concat(stdout))
        return
      }
      rejectRun(
        new Error(`${command} failed: code=${code} signal=${signal} ${stderr.join('').trim()}`)
      )
    })
  })
}
