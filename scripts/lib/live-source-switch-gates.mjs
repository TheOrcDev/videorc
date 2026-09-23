import { spawn } from 'node:child_process'

export function measureSourceWindow(
  samples,
  { startSeconds, durationSeconds = 0.5, sampleRate = 48000 } = {}
) {
  const start = Math.round(startSeconds * sampleRate)
  const count = Math.round(durationSeconds * sampleRate)
  if (!Number.isFinite(start) || start < 0 || count < 1 || start + count > samples.length) {
    throw new Error('The required source identity window is missing from the decoded artifact.')
  }
  let energy = 0
  const frequencies = [440, 880]
  const sums = frequencies.map(() => ({ real: 0, imaginary: 0 }))
  for (let index = 0; index < count; index += 1) {
    const sample = samples[start + index]
    if (!Number.isFinite(sample)) throw new Error('Decoded PCM contains a non-finite sample.')
    energy += sample * sample
    frequencies.forEach((frequency, bin) => {
      const phase = (index * frequency * 2 * Math.PI) / sampleRate
      sums[bin].real += sample * Math.cos(phase)
      sums[bin].imaginary += sample * Math.sin(phase)
    })
  }
  return {
    startSeconds,
    durationSeconds,
    rms: Math.sqrt(energy / count),
    amplitude440: (2 * Math.hypot(sums[0].real, sums[0].imaginary)) / count,
    amplitude880: (2 * Math.hypot(sums[1].real, sums[1].imaginary)) / count
  }
}

export function evaluateSourceIdentity(measurement, expected) {
  const failures = []
  if (
    !measurement ||
    !['rms', 'amplitude440', 'amplitude880'].every((key) => Number.isFinite(measurement[key]))
  ) {
    return ['A required decoded source measurement is missing.']
  }
  if (expected === null || expected === 'muted') {
    if (measurement.rms > 0.005) failures.push('Intentional silence contains audible source PCM.')
  } else {
    if (![440, 880].includes(expected))
      return ['The expected fixture source identity is unsupported.']
    const wanted = measurement[`amplitude${expected}`]
    const other = measurement[`amplitude${expected === 440 ? 880 : 440}`]
    if (wanted < 0.05) failures.push(`Expected ${expected} Hz source is absent from output.`)
    if (wanted < other * 5)
      failures.push('The previous or wrong microphone dominates the output window.')
  }
  return failures
}

export function evaluatePacketDts(packets) {
  if (!Array.isArray(packets) || packets.length === 0)
    return ['Encoded packet evidence is missing.']
  const previous = new Map()
  const failures = []
  for (const packet of packets) {
    const stream = packet.stream_index
    const dts = Number(packet.dts_time)
    if (!Number.isInteger(stream) || packet.dts_time == null || !Number.isFinite(dts)) {
      failures.push('Encoded packet DTS or stream identity is missing.')
      continue
    }
    if (previous.has(stream) && dts < previous.get(stream))
      failures.push(`Stream ${stream} DTS regressed.`)
    previous.set(stream, dts)
    // B-frame PTS may legally reorder; DTS is the decode-order invariant.
  }
  return [...new Set(failures)]
}

export async function decodeSourcePcm(file, { ffmpegPath = 'ffmpeg' } = {}) {
  const bytes = await runMediaTool(ffmpegPath, [
    '-v',
    'error',
    '-i',
    file,
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
  if (bytes.length === 0 || bytes.length % 4 !== 0)
    throw new Error('Artifact has no complete decoded PCM stream.')
  return Float32Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4))
}

export async function readSourcePackets(file, { ffprobePath = 'ffprobe' } = {}) {
  const bytes = await runMediaTool(ffprobePath, [
    '-v',
    'error',
    '-show_packets',
    '-show_entries',
    'packet=stream_index,dts_time,pts_time,duration_time',
    '-of',
    'json',
    file
  ])
  return JSON.parse(bytes.toString('utf8')).packets
}

function runMediaTool(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let length = 0
    let stderr = ''
    let failure
    const timer = setTimeout(() => {
      failure = new Error('Source artifact decoding exceeded its 30s deadline.')
      child.kill('SIGKILL')
    }, 30000)
    child.stdout.on('data', (chunk) => {
      length += chunk.length
      if (length > 256 * 1024 * 1024) {
        failure = new Error('Source artifact decoding exceeded its bounded output budget.')
        child.kill('SIGKILL')
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4096)
    })
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0)
        reject(failure ?? new Error(`Source artifact decoder failed: ${stderr}`))
      else resolve(Buffer.concat(chunks))
    })
  })
}
