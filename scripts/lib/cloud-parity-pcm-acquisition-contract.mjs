import assert from 'node:assert/strict'

export function pcmAcquisitionConfig(env = {}) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    assert.ok(
      Number.isInteger(value) && value >= min && value <= max,
      `${name} must be ${min}..${max}`
    )
    return value
  }
  const mode = env.VIDEORC_PCM_MODE ?? 'acquire-analyze'
  assert.ok(['acquire', 'analyze', 'acquire-analyze'].includes(mode), 'Invalid PCM mode')
  return {
    mode,
    durationMs: integer('VIDEORC_PCM_SECONDS', 1805, 5, 3500) * 1000,
    cycles: integer('VIDEORC_PCM_CYCLES', 25, 1, 50),
    cycleMs: 4000,
    pollMs: 500,
    readinessMs: 30000,
    closeMs: 10000,
    maximumArtifactBytes: 768 * 1024 * 1024,
    maximumTraceBytes: 512 * 1024 * 1024
  }
}

/** Bound an external observation, and always retire the owned deadline timer.
 * Timing out does not turn missing evidence into a successful observation. */
export async function pcmWithDeadline(label, ms, operation, timers = { setTimeout, clearTimeout }) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = timers.setTimeout(
          () => reject(new Error(`${label} unavailable: deadline exceeded`)),
          ms
        )
      })
    ])
  } finally {
    timers.clearTimeout(timer)
  }
}

/** Called by real acquisition and deterministic fake-clock tests. Cleanup runs on
 * capture failure too; missing observations never become successful zeros. */
export async function drivePcmCapture(config, io) {
  let started = false
  try {
    const start = await io.start()
    started = true
    await io.record('start', start)
    const deadline = io.now() + config.durationMs
    do {
      await io.record('sample', await io.poll())
      const remaining = deadline - io.now()
      if (remaining <= 0) break
      await io.wait(Math.min(config.pollMs, remaining))
    } while (io.now() <= deadline)
  } finally {
    if (started) await io.record('stop', await io.stop())
  }
}

/** LiveKit's protobuf JSON omits default false booleans. An observed track
 * with absent muted is unmuted; an absent track is never proof of publication. */
export function pcmMicrophonePublication(participant) {
  assert.ok(participant && typeof participant === 'object', 'Missing SFU participant')
  assert.ok(participant.tracks === undefined || Array.isArray(participant.tracks))
  const microphones = (participant.tracks ?? []).filter(
    (track) => track.source === 'MICROPHONE' || track.source === 2
  )
  assert.ok(microphones.length <= 1, 'Duplicate microphone publications')
  const microphone = microphones[0]
  if (!microphone) return null
  assert.ok(typeof microphone.sid === 'string' && microphone.sid.length > 0)
  assert.ok(microphone.muted === undefined || typeof microphone.muted === 'boolean')
  return microphone.muted ? null : microphone
}

export function pcmRemaining(main, renderer, publications) {
  const fields = ['nativeSources', 'sockets', 'ipcRequests', 'timers']
  if (
    !main ||
    !fields.every((k) => Number.isSafeInteger(main[k]) && main[k] >= 0) ||
    !Array.isArray(renderer?.owners) ||
    !Array.isArray(publications)
  )
    return {
      status: 'unavailable',
      reason: 'Native/main/renderer/SFU resource observation missing'
    }
  const remaining = {
    ...main,
    worklets: 0,
    contexts: 0,
    tracks: 0,
    rendererRequests: 0,
    publications: publications.length
  }
  for (const owner of renderer.owners) {
    if (
      owner.closeError ||
      !['worklets', 'contexts', 'tracks', 'timers', 'ipcRequests'].every(
        (k) => Number.isSafeInteger(owner[k]) && owner[k] >= 0
      )
    )
      return {
        status: 'unavailable',
        reason: 'Renderer close acknowledgement or resource state missing'
      }
    for (const key of ['worklets', 'contexts', 'tracks', 'timers']) remaining[key] += owner[key]
    remaining.rendererRequests += owner.ipcRequests
  }
  return { status: Object.values(remaining).every((v) => v === 0) ? 'closed' : 'live', remaining }
}

/** A round-trip bounds an observed remote clock reading in the caller's clock.
 * Do not replace slow probes with fabricated precision. */
export function clockBracket(beforeUs, afterUs, remoteUs, quantumUs = 0) {
  assert.ok([beforeUs, afterUs, remoteUs, quantumUs].every(Number.isFinite))
  assert.ok(afterUs >= beforeUs && quantumUs >= 0)
  return { domainUs: remoteUs, lowUs: beforeUs - quantumUs, highUs: afterUs + quantumUs }
}
export function mapClock(valueUs, anchors, maxSpanUs = 2_000_000) {
  if (!Number.isFinite(valueUs)) return null
  // Sorting once at acquisition-finalization keeps the real-time path bounded.
  let left = 0,
    right = anchors.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (anchors[middle].domainUs < valueUs) left = middle + 1
    else right = middle
  }
  const upper = anchors[left],
    lower = upper?.domainUs === valueUs ? upper : anchors[left - 1]
  if (!lower || !upper || upper.domainUs - lower.domainUs > maxSpanUs) return null
  const fraction =
    upper.domainUs === lower.domainUs
      ? 0
      : (valueUs - lower.domainUs) / (upper.domainUs - lower.domainUs)
  return {
    lowUs: lower.lowUs + fraction * (upper.lowUs - lower.lowUs),
    highUs: lower.highUs + fraction * (upper.highUs - lower.highUs)
  }
}
const prepare = (anchors) =>
  anchors
    .sort((a, b) => a.domainUs - b.domainUs)
    .filter((a, i, all) => !i || a.domainUs !== all[i - 1].domainUs)
function compose(interval, anchors) {
  if (!interval) return null
  const low = mapClock(interval.lowUs, anchors),
    high = mapClock(interval.highUs, anchors)
  return low && high ? { lowUs: low.lowUs, highUs: high.highUs } : null
}

/** Derive observations from actual message brackets and decoded second IDs.
 * Nothing here fills missing clocks/video/encoder timings with guessed values. */
export function derivePcmClocks(records) {
  const rendererClock = [],
    programClock = [],
    nativeClock = [],
    sourceClock = [],
    receiverClock = []
  const sourceMarkers = new Map(),
    programMarkers = new Map()
  let generation = null,
    dropped = 0
  for (const r of records) {
    if (r.kind === 'renderer' || r.kind === 'program') {
      const value = r.reply
      if (Number.isFinite(value?.performanceMs))
        (r.kind === 'renderer' ? rendererClock : programClock).push(
          clockBracket(r.beforeUs, r.afterUs, value.performanceMs * 1000)
        )
      dropped = Math.max(dropped, value?.dropped ?? 0)
      for (const d of value?.events ?? []) {
        if (r.kind === 'renderer') {
          if (d.phase === 'native-frame') {
            generation ??= d.generation
            if (generation !== d.generation)
              throw new Error('Clock capture contains multiple source generations')
            nativeClock.push(
              clockBracket(d.pullRequestedAtMs * 1000, d.pullReceivedAtMs * 1000, d.observedAtUs)
            )
          }
          if (d.phase === 'worklet') {
            if (d.clock)
              sourceClock.push(
                clockBracket(
                  d.clock.requestedAtMs * 1000,
                  d.receivedAtMs * 1000,
                  d.clock.frame / 0.048,
                  128 / 0.048
                )
              )
            if (d.marker) sourceMarkers.set(d.marker.second, d.marker)
            dropped = Math.max(dropped, d.lostMarkers ?? 0)
          }
        } else {
          if (d.clock)
            receiverClock.push(
              clockBracket(
                d.clock.requestedAtMs * 1000,
                d.receivedAtMs * 1000,
                d.clock.frame / 0.048,
                128 / 0.048
              )
            )
          dropped = Math.max(dropped, d.dropped ?? 0)
          for (const event of d.events ?? []) {
            if (programMarkers.has(event.second)) throw new Error('Repeated program marker ID')
            programMarkers.set(event.second, event)
          }
        }
      }
    }
  }
  for (const anchors of [rendererClock, programClock, nativeClock, sourceClock, receiverClock])
    prepare(anchors)
  const samples = [],
    unavailable = []
  for (const [second, program] of programMarkers) {
    const source = sourceMarkers.get(second)
    const capture = compose(mapClock(second * 1e6, nativeClock), rendererClock)
    const worklet =
      source && compose(mapClock(source.workletFrame / 0.048, sourceClock), rendererClock)
    const decoded = compose(mapClock(program.audioFrame / 0.048, receiverClock), programClock)
    if (!capture || !worklet || !decoded) {
      unavailable.push({ second, reason: 'Missing bracketing clock event; extrapolation refused' })
      continue
    }
    const detectionUs = program.uncertaintyFrames / 0.048
    samples.push({
      second,
      generation,
      capture,
      worklet,
      program: { lowUs: decoded.lowUs - detectionUs, highUs: decoded.highUs + detectionUs }
    })
  }
  return {
    model:
      'measured round-trip brackets; piecewise linear interpolation within 2 seconds; worklet quantum and marker detection uncertainty included',
    generation,
    samples,
    unavailable,
    dropped,
    anchors: {
      renderer: rendererClock,
      program: programClock,
      native: nativeClock,
      sourceWorklet: sourceClock,
      programWorklet: receiverClock
    }
  }
}
