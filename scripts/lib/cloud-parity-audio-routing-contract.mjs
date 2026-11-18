import assert from 'node:assert/strict'
export const SCREEN_TONE_HZ = 1760
export function audioRoutingConfig(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback)
    assert.ok(Number.isInteger(n) && n >= min && n <= max, `${key} must be ${min}–${max}`)
    return n
  }
  return {
    seconds: integer('VIDEORC_PARITY_AUDIO_SECONDS', 3, 3, 8),
    cycles: integer('VIDEORC_PARITY_AUDIO_CYCLES', 3, 2, 5),
    deadlineMs: integer('VIDEORC_PARITY_AUDIO_DEADLINE_MS', 240000, 60000, 600000)
  }
}
/** Measurements must come from the final recipient artifact, not a source meter. */
export function assertAudioRoutes(captures, routes, reference = null) {
  assert.equal(
    captures.length,
    Object.keys(routes).length,
    'Every intended recipient must be measured'
  )
  for (const [recipient, stems] of Object.entries(routes)) {
    const measured = captures.find((c) => c.name === recipient)?.settledTones
    assert.ok(measured, `${recipient}: final artifact unavailable`)
    for (const [stem, expected] of Object.entries(stems)) {
      const db = measured[stem]
      assert.ok(Number.isFinite(db), `${recipient}/${stem}: measurement unavailable`)
      if (expected === false)
        assert.ok(db < -60, `${recipient}/${stem}: unintended return ${db} dBFS`)
      else {
        assert.ok(db > -45, `${recipient}/${stem}: missing audio ${db} dBFS`)
        if (typeof expected === 'number') {
          const before = reference?.find((c) => c.name === recipient)?.settledTones[stem]
          assert.ok(Number.isFinite(before), `${recipient}/${stem}: reference unavailable`)
          assert.ok(
            Math.abs(db - before - expected) < 2,
            `${recipient}/${stem}: gain/copy changed by ${db - before} dB, expected ${expected}`
          )
        }
      }
    }
  }
}
export function routingTable({
  takeover = false,
  system = true,
  sounds = true,
  host = true,
  programAux = true,
  programSpeech = true,
  screenOwner = null
} = {}) {
  const result = {}
  for (const name of ['program', 'guest1', 'guest2']) {
    const program = name === 'program'
    const speech = !program || (!takeover && programSpeech)
    result[name] = {
      host: host && speech,
      guest1: name !== 'guest1' && speech,
      guest2: name !== 'guest2' && speech,
      system: system && (!program || programAux),
      soundboard: sounds && (!program || programAux),
      screen: screenOwner !== null && name !== screenOwner && (!program || programAux)
    }
  }
  return result
}
/**
 * Plan 249 S13a clock on the system source, from the renderer's raw
 * `native-frame` observations (each may appear in several raw snapshots).
 * Within one generation the origin and incarnation never move; every
 * generation of one run shares one backend incarnation, and a later
 * generation never starts earlier on the anchor. `originUs + observedAtUs`
 * must stay a safe integer. A null origin is recorded as unavailable, never
 * as zero. This is the CAPTURE timeline; drift, latency and A/V alignment are
 * not measured here.
 */
export function deriveSystemClock(rawObservations) {
  const frames = new Map()
  for (const raw of rawObservations ?? [])
    for (const event of raw?.observations?.events ?? []) {
      if (event?.phase !== 'native-frame') continue
      const key = `${event.generation}:${event.sequence}`
      const seen = frames.get(key)
      if (seen) {
        assert.equal(seen.originUs, event.originUs, `Frame ${key} changed its clock origin`)
        assert.equal(seen.incarnation, event.incarnation, `Frame ${key} changed its incarnation`)
        continue
      }
      frames.set(key, event)
    }
  const generations = new Map()
  const incarnations = new Set()
  for (const frame of frames.values()) {
    assert.equal(frame.timeline, 'capture', 'System frames must be on the capture timeline')
    assert.ok(frame.originUs === null || frame.incarnation !== null, 'Origin without incarnation')
    assert.notEqual(frame.originUs, 0, 'An absent origin must be null, never zero')
    if (frame.originUs !== null)
      assert.ok(
        Number.isSafeInteger(frame.originUs + frame.observedAtUs),
        'System clock sum is not a safe integer'
      )
    incarnations.add(frame.incarnation)
    const entry = generations.get(frame.generation) ?? {
      generation: frame.generation,
      originUs: frame.originUs,
      incarnation: frame.incarnation,
      frames: 0,
      firstNativeCaptureUs: null,
      lastNativeCaptureUs: null
    }
    assert.equal(entry.originUs, frame.originUs, 'Clock origin moved within a generation')
    assert.equal(entry.incarnation, frame.incarnation, 'Incarnation moved within a generation')
    entry.frames++
    const nativeUs = frame.originUs === null ? null : frame.originUs + frame.firstSampleUs
    if (nativeUs !== null) {
      entry.firstNativeCaptureUs = Math.min(entry.firstNativeCaptureUs ?? nativeUs, nativeUs)
      entry.lastNativeCaptureUs = Math.max(entry.lastNativeCaptureUs ?? nativeUs, nativeUs)
    }
    generations.set(frame.generation, entry)
  }
  assert.ok(incarnations.size <= 1, 'System frames span several backend incarnations')
  const ordered = [...generations.values()].sort((a, b) => a.generation - b.generation)
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].originUs !== null && ordered[i - 1].originUs !== null)
      assert.ok(
        ordered[i].originUs >= ordered[i - 1].originUs,
        'A later system generation started earlier on the anchor'
      )
  const available = ordered.length > 0 && ordered.every((g) => g.originUs !== null)
  return {
    timeline: 'capture',
    commonClockOrigin: available ? 'available' : 'unavailable',
    incarnation: available ? ordered[0].incarnation : null,
    generations: ordered,
    clockQualification: 'unavailable',
    unmeasured: ['drift', 'latency', 'final A/V alignment']
  }
}
export function assertSystemReleased(native, renderer) {
  assert.ok(native && renderer, 'Cleanup observation unavailable')
  for (const key of ['nativeSources', 'sockets', 'ipcRequests', 'timers'])
    assert.equal(native[key], 0, `System ${key} not released`)
  assert.deepEqual(renderer.resources, [], 'Renderer system owners still retained')
}
/** Reap only the exact owned player; never scan or kill by process name. */
export async function stopOwnedRoutingPlayer(
  child,
  exit,
  wait = async (promise) => {
    let timer
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 2000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
) {
  if (!child || child.exitCode !== null || child.signalCode) return
  child.kill('SIGTERM')
  if (await wait(exit)) return
  child.kill('SIGKILL')
  if (!(await wait(exit))) throw new Error('Owned routing player cleanup unconfirmed')
}
