import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const pulse = async (args) =>
  (await exec('pactl', args, { timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim()

// Development-only sources. Tones play into owned null sinks, never speakers.
// Remapped sources exercise the production Pulse worker and device identity.
// Only module IDs returned by our loads are unloaded; system defaults stay put.
export async function startLinuxPulseFixtures({
  ffmpegPath,
  command = pulse,
  tone = startTone,
  otherFrequency = 880,
  prefix = `videorc_beta_${randomUUID().replaceAll('-', '')}`
}) {
  if (!/^videorc_beta_[a-z0-9_]+$/.test(prefix)) throw new Error('Invalid fixture prefix.')
  if (
    !Number.isInteger(otherFrequency) ||
    otherFrequency < 100 ||
    otherFrequency > 10_000 ||
    otherFrequency === 440
  ) {
    throw new Error('The other fixture tone must be a distinct frequency between 100 and 10000 Hz.')
  }
  const modules = []
  const players = []
  const sources = []
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    const errors = []
    for (const player of players.toReversed()) {
      try {
        await player.stop()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const id of modules.toReversed()) {
      try {
        await command(['unload-module', id])
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Pulse fixture cleanup failed.')
  }
  const load = async (...args) => {
    const id = await command(['load-module', ...args])
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
      throw new Error('Pulse did not return an owned module ID.')
    modules.push(id)
    return id
  }
  try {
    for (const frequency of [440, otherFrequency]) {
      const sink = `${prefix}_${frequency}`
      const source = `${sink}_source`
      await load('module-null-sink', `sink_name=${sink}`, 'rate=48000', 'channels=2')
      let sourceModule = await load(
        'module-remap-source',
        `master=${sink}.monitor`,
        `source_name=${source}`
      )
      const player = await tone({ ffmpegPath, sink, frequency })
      players.push(player)
      sources.push({
        frequency,
        deviceId: `microphone:linux-pulse:${Buffer.from(source).toString('hex')}`,
        source,
        disconnect: async () => {
          if (stopped) throw new Error('Pulse fixtures are stopped.')
          if (sourceModule === null) return
          await command(['unload-module', sourceModule])
          modules.splice(modules.indexOf(sourceModule), 1)
          sourceModule = null
        },
        reconnect: async () => {
          if (stopped) throw new Error('Pulse fixtures are stopped.')
          if (sourceModule !== null) return
          sourceModule = await load(
            'module-remap-source',
            `master=${sink}.monitor`,
            `source_name=${source}`
          )
        }
      })
    }
    return { sources, stop }
  } catch (error) {
    try {
      await stop()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Pulse fixture setup and cleanup failed.')
    }
    throw error
  }
}

// One owned null sink for an app smoke's playback. The smoke plays its tones
// there and runs the app with PULSE_SINK set to it, so neither reaches the
// speakers. Only the module ID this load returned is unloaded.
export async function startOwnedNullSink({
  command = pulse,
  prefix = `videorc_beta_${randomUUID().replaceAll('-', '')}`
} = {}) {
  if (!/^videorc_beta_[a-z0-9_]+$/.test(prefix)) throw new Error('Invalid fixture prefix.')
  const id = await command([
    'load-module',
    'module-null-sink',
    `sink_name=${prefix}`,
    'rate=48000',
    'channels=2'
  ])
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error('Pulse did not return an owned module ID.')
  let stopped = false
  return {
    sink: prefix,
    stop: async () => {
      if (stopped) return
      stopped = true
      await command(['unload-module', id])
    }
  }
}

// The environment that sends an app's playback to an owned sink. PULSE_SINK
// names the sink, but the session's routing can still move the stream: a
// default-metadata target outranks the stream's own in WirePlumber, and a
// desktop that once moved "Chromium" keeps moving it. node.dont-move, after
// whatever PULSE_PROP the run already had, makes WirePlumber leave the stream
// on the sink it named, the way the backend pins its microphone streams.
export function ownedSinkPlaybackEnv(sink, existingProp) {
  const kept = (existingProp ?? '').trim()
  return {
    PULSE_SINK: sink,
    PULSE_PROP: kept ? `${kept} node.dont-move=true` : 'node.dont-move=true'
  }
}

// The playback streams, sinks and clients as `pactl -f json` lists them.
export async function readPulsePlayback(command = pulse) {
  const list = async (kind) => JSON.parse(await command(['-f', 'json', 'list', kind]))
  return {
    sinkInputs: await list('sink-inputs'),
    clients: await list('clients'),
    sinks: await list('sinks')
  }
}

/**
 * The playback streams not in `before` that carry `property`, on the stream or
 * on its client, each with the name of the sink it plays to (null when that
 * sink is not listed).
 */
export function newPlaybackWithProperty({ before, sinkInputs, clients, sinks, property }) {
  const known = new Set(before.map((input) => String(input.index)))
  const clientProperties = new Map(
    clients.map((client) => [String(client.index), client.properties ?? {}])
  )
  const sinkNames = new Map(sinks.map((sink) => [String(sink.index), sink.name]))
  return sinkInputs
    .filter((input) => !known.has(String(input.index)))
    .filter(
      (input) =>
        Object.hasOwn(input.properties ?? {}, property) ||
        Object.hasOwn(clientProperties.get(String(input.client)) ?? {}, property)
    )
    .map((input) => ({ index: input.index, sink: sinkNames.get(String(input.sink)) ?? null }))
}

async function startTone({ ffmpegPath, sink, frequency }) {
  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-stats_period',
      '0.1',
      '-progress',
      'pipe:1',
      '-re',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:sample_rate=48000`,
      '-ac',
      '2',
      '-f',
      'pulse',
      '-device',
      sink,
      `videorc-beta-fixture-${frequency}`
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096)
  })
  let closed = false
  const completion = new Promise((resolve) =>
    child.once('close', () => {
      closed = true
      resolve()
    })
  )
  const stop = async () => {
    if (closed) return
    child.kill('SIGTERM')
    const kill = setTimeout(() => {
      if (!closed) child.kill('SIGKILL')
    }, 3000)
    let deadline
    try {
      await Promise.race([
        completion,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Owned tone process did not close.')), 6000)
        })
      ])
    } finally {
      clearTimeout(kill)
      clearTimeout(deadline)
    }
  }
  try {
    await new Promise((resolve, reject) => {
      let progress = ''
      const timer = setTimeout(
        () => finish(new Error('Tone output did not start within 10s.')),
        10000
      )
      const finish = (error) => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('close', onClose)
        if (error) reject(error)
        else resolve()
      }
      const onData = (chunk) => {
        progress = (progress + chunk).slice(-4096)
        if (/(?:^|\n)out_time_us=[1-9]\d*\r?\n/.test(progress)) finish()
      }
      const onError = (error) => finish(error)
      const onClose = () => finish(new Error(`Tone output closed before readiness: ${stderr}`))
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('close', onClose)
    })
    return { stop }
  } catch (error) {
    await stop()
    throw error
  }
}
