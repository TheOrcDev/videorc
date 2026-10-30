#!/usr/bin/env node
// Development investigation for plan 212. Only owned tones/null sinks are used.
// This proves a routing primitive, not Videorc's system-audio implementation,
// process exclusion policy, timestamps, device recovery, or Beta acceptance.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startLinuxPulseFixtures } from './lib/linux-pulse-fixture.mjs'
import { evaluateSourceIdentity, measureSourceWindow } from './lib/live-source-switch-gates.mjs'

if (process.platform !== 'linux') throw new Error('This routing probe requires Linux/PipeWire.')
const exec = promisify(execFile)
const command = (binary, args) => exec(binary, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
const graph = async () => JSON.parse((await command('pw-dump', [])).stdout)
const sinkInputs = async () =>
  JSON.parse((await command('pactl', ['-f', 'json', 'list', 'sink-inputs'])).stdout)
const directory = await mkdtemp(join(tmpdir(), 'videorc-linux-audio-routing-'))
const reportPath = join(directory, 'routing.json')
const report = {
  scope: 'owned-fixture-pipewire-routing',
  completePlanAcceptance: false,
  pass: false,
  startedAt: new Date().toISOString()
}
let fixtures
const captures = []
try {
  fixtures = await startLinuxPulseFixtures({
    ffmpegPath:
      process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? resolve('vendor/ffmpeg/linux-x64/bin/ffmpeg')
  })
  const initial = await graph()
  const sinks = fixtures.sources.map((source) => source.source.replace(/_source$/, ''))
  const nodes = sinks.map((sink) => {
    const matching = initial.filter(
      (node) =>
        node.info?.props?.['media.class'] === 'Stream/Output/Audio' &&
        node.info.props['target.object'] === sink
    )
    assert.equal(matching.length, 1, 'An exact owned playback node is required.')
    return matching[0]
  })
  const [included, excluded] = nodes
  const serial = (node) => String(node.info.props['object.serial'])
  await command('pactl', ['move-sink-input', serial(excluded), sinks[0]])
  // pactl acknowledges the request before PipeWire completes its route change.
  await until('owned tones sharing one sink', async () => {
    const inputs = await sinkInputs()
    const routes = nodes.map((node) =>
      inputs.find((input) => String(input.properties['object.serial']) === serial(node))
    )
    return routes.every(Boolean) && routes[0].sink === routes[1].sink
  })

  // The simultaneous control mixes both outputs, proving the excluded source
  // is actually audible while the selective capture omits it.
  for (const selected of [[included], nodes]) {
    const capture = startCapture()
    captures.push(capture)
    await routeOwnedOutputs(capture, selected, initial)
  }
  const [selective, control] = await Promise.all(captures.map((capture) => capture.result()))
  const { bytes, exit } = selective
  const measurements = measureStereo(bytes)
  const controlMeasurements = measureStereo(control.bytes)
  assert.ok(
    controlMeasurements.every(
      (sample) => sample.amplitude440 >= 0.05 && sample.amplitude880 >= 0.05
    ),
    'The simultaneous control must contain both audible tones.'
  )
  assert.deepEqual(
    measurements.flatMap((sample) => evaluateSourceIdentity(sample, 440)),
    []
  )
  assert.ok(
    measurements.every((sample) => sample.amplitude880 < 0.0001),
    'Excluded tone leaked.'
  )
  Object.assign(report, {
    pass: true,
    sameSink: true,
    includedToneHz: 440,
    excludedToneHz: 880,
    stopReason: 'measurement-complete-requested-SIGINT',
    bytes: bytes.length,
    exit,
    measurements,
    control: { bytes: control.bytes.length, exit: control.exit, measurements: controlMeasurements }
  })
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  for (const stop of [...captures.map((capture) => () => capture.stop()), () => fixtures?.stop()]) {
    try {
      await stop()
    } catch (error) {
      report.pass = false
      ;(report.cleanupErrors ??= []).push(error.message)
      process.exitCode = 1
    }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(`Linux routing primitive ${report.pass ? 'PASS' : 'FAIL'}: ${reportPath}`)
  if (report.error) console.error(report.error)
}

async function routeOwnedOutputs(capture, selected, initial) {
  const { node, ports } = await until('owned stereo capture ports', async () => {
    const current = await graph()
    const node = current.find((entry) => entry.info?.props?.['node.name'] === capture.name)
    const client = node
      ? current.find((entry) => entry.id === Number(node.info.props['client.id']))
      : null
    if (Number(client?.info?.props?.['pipewire.sec.pid']) !== capture.pid) return false
    const ports = node ? portsFor(current, node, 'input') : []
    return ports.length === 2 && { node, ports }
  })
  for (const selectedNode of selected) {
    const outputs = portsFor(initial, selectedNode, 'output')
    for (const input of ports) {
      const matches = outputs.filter(
        (output) => output.info.props['audio.channel'] === input.info.props['audio.channel']
      )
      assert.equal(matches.length, 1, 'An exact owned channel match is required.')
      await command('pw-link', [String(matches[0].id), String(input.id)])
    }
  }
  await until('exact owned capture links', async () => {
    const routed = await graph()
    const incoming = routed.filter(
      (entry) =>
        entry.type === 'PipeWire:Interface:Link' && entry.info?.['input-node-id'] === node.id
    )
    assert.ok(incoming.length <= selected.length * 2, 'Capture acquired unexpected links.')
    assert.ok(
      incoming.every((link) => selected.some((source) => link.info['output-node-id'] === source.id))
    )
    return incoming.length === selected.length * 2
  })
}

function measureStereo(bytes) {
  return [0, 1].flatMap((channel) => {
    const samples = Float32Array.from({ length: Math.floor(bytes.length / 8) }, (_, index) =>
      bytes.readFloatLE(index * 8 + channel * 4)
    )
    return [0.5, 1.5].map((startSeconds) => ({
      channel,
      ...measureSourceWindow(samples, { startSeconds })
    }))
  })
}

function portsFor(entries, node, direction) {
  return entries.filter(
    (entry) =>
      entry.type === 'PipeWire:Interface:Port' &&
      Number(entry.info?.props?.['node.id']) === node.id &&
      entry.info.direction === direction
  )
}

async function until(label, observe) {
  const deadline = Date.now() + 5000
  do {
    const value = await observe()
    if (value) return value
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}.`)
}

function startCapture() {
  const name = `videorc_loopback_probe_${randomUUID().replaceAll('-', '')}`
  const child = spawn(
    'pw-record',
    [
      '--target',
      '0', // Never ask WirePlumber to choose a microphone or speaker.
      '--properties',
      `node.name=${name} node.dont-reconnect=true node.dont-fallback=true`,
      '--rate',
      '48000',
      '--channels',
      '2',
      '--format',
      'f32',
      '--raw',
      '-'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let length = 0
  let closed = false
  let measured = false
  let interruptedAfterMeasurement = false
  let stderr = ''
  const chunks = []
  const completion = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error: error.message }))
    child.once('close', (code, signal) => {
      closed = true
      resolveExit({ code, signal })
    })
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2048)
  })
  child.stdout.on('data', (chunk) => {
    length += chunk.length
    if (length > 2 * 1024 * 1024) {
      child.kill('SIGKILL')
      return
    }
    chunks.push(chunk)
    if (!measured && length >= 3 * 48000 * 2 * 4) {
      measured = true
      interruptedAfterMeasurement = child.kill('SIGINT')
    }
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  completion.then(() => clearTimeout(timer))
  return {
    name,
    pid: child.pid,
    async result() {
      const exit = await boundedCompletion()
      assert.ok(measured && interruptedAfterMeasurement, 'Capture ended before its requested stop.')
      // pw-cat 1.6.8 returns 0 only after a playback drain; its capture SIGINT
      // handler quits without setting `drained` and therefore returns 1.
      // Accept that exact owned interruption only after PCM readiness. Retain
      // the real exit in evidence and fail on stderr, premature exit or a kill.
      assert.equal(exit.signal, null)
      assert.ok([0, 1].includes(exit.code), `Unexpected capture exit: ${JSON.stringify(exit)}`)
      assert.equal(stderr.trim(), '', stderr)
      return { bytes: Buffer.concat(chunks), exit }
    },
    async stop() {
      if (!closed) child.kill('SIGKILL')
      await boundedCompletion()
    }
  }
  async function boundedCompletion() {
    let deadline
    try {
      return await Promise.race([
        completion,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Owned capture did not close.')), 18000)
        })
      ])
    } finally {
      clearTimeout(deadline)
    }
  }
}
