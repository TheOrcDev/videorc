/**
 * Pure gates for `smoke:cloud-talk-show` (plan 224 S-G1): the colour of a
 * flat tile as luma, the runner's "stage tiles" log line, a probe of each
 * tile's centre in a decoded receiver frame, the tones in the mix
 * (Goertzel), and the report's verdict. Nothing here touches a process or a
 * file, so each rule is a unit test.
 */

/** A hex colour (`RRGGBB`) as BT.709 limited-range luma, the Y the encoder writes. */
export function lumaOfHex(hex) {
  const clean = String(hex).replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Not a hex colour: ${hex}`)
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255)
}

/**
 * The runner's `stage tiles` log line (`stage.rs`), one per layout change:
 * `… layout=side-by-side canvas=1280x720 tiles="host:sh_x:person:0,0,640,360 g_y:person:…"`.
 * Returns `{ atMs, layout, canvas: { width, height }, tiles }` or null.
 */
export function parseStageTilesLine(line) {
  if (!line.includes('stage tiles')) return null
  const stamp = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?)/.exec(line)
  const layout = /layout="?([a-z-]+)"?/.exec(line)
  const canvas = /canvas="?(\d+)x(\d+)"?/.exec(line)
  const tiles = /tiles="([^"]*)"/.exec(line) ?? /tiles=(\S*)/.exec(line)
  if (!layout || !canvas || !tiles) return null
  const parsed = []
  for (const token of tiles[1].trim().split(/\s+/).filter(Boolean)) {
    const parts = token.split(':')
    if (parts.length < 3) continue
    const rect = parts.pop()
    const kind = parts.pop()
    const identity = parts.join(':')
    const numbers = rect.split(',').map((value) => Number(value))
    if (numbers.length !== 4 || numbers.some((value) => !Number.isInteger(value))) continue
    const [x, y, w, h] = numbers
    parsed.push({ identity, kind, x, y, w, h })
  }
  const at = stamp ? Date.parse(stamp[1].endsWith('Z') ? stamp[1] : `${stamp[1]}Z`) : Number.NaN
  return {
    atMs: Number.isFinite(at) ? at : null,
    layout: layout[1],
    canvas: { width: Number(canvas[1]), height: Number(canvas[2]) },
    tiles: parsed
  }
}

/** The newest `stage tiles` entry of a runner log for `layout`, or the newest at all. */
export function latestStageTiles(logText, { layout = null, afterMs = null } = {}) {
  let latest = null
  for (const line of String(logText).split('\n')) {
    const parsed = parseStageTilesLine(line)
    if (!parsed) continue
    if (layout && parsed.layout !== layout) continue
    if (afterMs !== null && parsed.atMs !== null && parsed.atMs < afterMs) continue
    latest = parsed
  }
  return latest
}

/**
 * The mean luma of a small square around a tile's centre in a probe frame
 * (`y` is the frame's luma plane, `width` by `height`, a scaled copy of
 * the canvas). `radius` is in probe pixels.
 */
export function tileCentreLuma({ y, width, height }, tile, canvas, radius = 3) {
  const sx = width / canvas.width
  const sy = height / canvas.height
  const cx = Math.round((tile.x + tile.w / 2) * sx)
  const cy = Math.round((tile.y + tile.h / 2) * sy)
  let total = 0
  let count = 0
  for (let py = Math.max(0, cy - radius); py <= Math.min(height - 1, cy + radius); py += 1) {
    for (let px = Math.max(0, cx - radius); px <= Math.min(width - 1, cx + radius); px += 1) {
      total += y[py * width + px]
      count += 1
    }
  }
  return count ? total / count : Number.NaN
}

/**
 * Every tile's centre against the colour its identity publishes: the
 * verdict per tile and overall. `expected` maps identity to luma; a tile
 * whose identity is not in it (the screen, a plate) is reported, not judged.
 */
export function evaluateTilePlan({ frame, canvas, tiles, expected, tolerance = 18 }) {
  const probes = tiles.map((tile) => {
    const measured = tileCentreLuma(frame, tile, canvas)
    const want = expected[tile.identity]
    const judged = want !== undefined && tile.kind === 'person'
    const ok = judged ? Math.abs(measured - want) <= tolerance : null
    return {
      identity: tile.identity,
      kind: tile.kind,
      rect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      expected: judged ? want : null,
      measured: Math.round(measured * 10) / 10,
      ok
    }
  })
  const judged = probes.filter((probe) => probe.ok !== null)
  return {
    ok: judged.length > 0 && judged.every((probe) => probe.ok),
    probes
  }
}

/** Goertzel power of `freq` in `samples` (floats, -1..1) at `rate`. */
export function goertzelPower(samples, rate, freq) {
  const n = samples.length
  if (n === 0) return 0
  const k = Math.floor(0.5 + (n * freq) / rate)
  const w = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (const x of samples) {
    s0 = x + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Signed 16-bit little-endian PCM as floats. */
export function pcm16ToFloats(buffer) {
  const count = Math.floor(buffer.length / 2)
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    out[index] = buffer.readInt16LE(index * 2) / 32768
  }
  return out
}

/**
 * Each tone's power in dB below the loudest of them (0 for the loudest):
 * a tone on stage sits within a few dB of the top; one nobody sends sits
 * 30 dB and more below it.
 */
export function tonesDbBelowLoudest(samples, rate, tones) {
  const powers = Object.fromEntries(
    Object.entries(tones).map(([name, hz]) => [name, goertzelPower(samples, rate, hz)])
  )
  const top = Math.max(...Object.values(powers), 0) + 1e-12
  return Object.fromEntries(
    Object.entries(powers).map(([name, power]) => {
      const db = Math.round(10 * Math.log10(power / top + 1e-12) * 10) / 10
      return [name, db === 0 ? 0 : db]
    })
  )
}

/**
 * The mix verdict for one phase: every `present` tone within `presentMaxDb`
 * of the loudest, every `absent` tone at least `absentMinDb` below it.
 */
export function evaluateTones(
  dbByName,
  { present, absent, presentMaxDb = -12, absentMinDb = -30 }
) {
  const problems = []
  for (const name of present) {
    const db = dbByName[name]
    if (db === undefined) problems.push(`${name}: not measured`)
    else if (db < presentMaxDb) problems.push(`${name}: ${db} dB, under ${presentMaxDb}`)
  }
  for (const name of absent) {
    const db = dbByName[name]
    if (db === undefined) problems.push(`${name}: not measured`)
    else if (db > absentMinDb) problems.push(`${name}: ${db} dB, should be under ${absentMinDb}`)
  }
  return { ok: problems.length === 0, problems }
}

/** The largest gap between consecutive packet times, and how many there were. */
export function packetGapStats(times) {
  let maxGap = 0
  for (let index = 1; index < times.length; index += 1) {
    maxGap = Math.max(maxGap, times[index] - times[index - 1])
  }
  return { packets: times.length, maxGapSeconds: Math.round(maxGap * 1000) / 1000 }
}

/**
 * The whole run's verdict from the report the smoke writes: every scenario
 * that must hold, named when it does not. Pure, so the rules are tests.
 */
export function evaluateCloudTalkShowReport(report) {
  const problems = []
  const need = (condition, text) => {
    if (!condition) problems.push(text)
  }
  need(report.room?.opened === true, 'the room never opened')
  need(report.room?.hostJoined === true, 'the host never joined the room')
  need(report.guests?.letIn === 2, `let in ${report.guests?.letIn ?? 0} guests, expected 2`)
  need(report.guests?.inRoom === 2, `${report.guests?.inRoom ?? 0} guests in the room, expected 2`)
  need(report.goLive?.legsLive === true, 'the legs never went live')
  need(report.goLive?.receiversTakingBytes === true, 'the receivers took no bytes')
  for (const phase of report.layouts ?? []) {
    need(
      phase.tiles?.ok === true,
      `layout ${phase.layout}: tile probes failed (${phase.tiles?.detail ?? '?'})`
    )
    need(
      phase.tones?.ok === true,
      `layout ${phase.layout}: tones ${(phase.tones?.problems ?? []).join('; ')}`
    )
  }
  need((report.layouts ?? []).length >= 3, 'fewer than 3 layouts were probed')
  need(report.hostOnAfterBringOn?.tile === true, "the host's tile left the program after Bring on")
  need(report.hostOnAfterBringOn?.tone === true, "the host's tone left the mix after Bring on")
  need(report.return?.guestRefused === true, 'a guest was not refused the return')
  need(report.return?.guestHeardProgram === false, 'a guest heard the program')
  need(
    report.recording?.ffprobeOk === true || report.recording?.gap,
    'the cloud recording failed ffprobe'
  )
  need(report.legsEnd?.acked === true, 'legs.end was not acked')
  need(report.legsEnd?.taps?.every((tap) => tap.ok) === true, 'a leg did not end cleanly')
  need(report.legsEnd?.roomStayed === true, 'the room did not stay after legs.end')
  need(report.legsEnd?.liveAgain === true, 'Go Live again did not bring the legs back')
  need(report.hostAway?.seen === true, 'the runner never reported the host away')
  need(
    report.hostAway?.receiversKept === true,
    'a receiver lost its connection while the host was away'
  )
  need(
    report.hostAway?.skipped === true || report.hostAway?.plateShown === true,
    `the host's tile kept the host's camera while away (luma ${report.hostAway?.plateLuma ?? '?'}, the camera ${report.hostAway?.hostLuma ?? '?'})`
  )
  need(report.resume?.hostBack === true, 'the host did not come back after Resume')
  need(report.moderation?.removedGuestSawIt === true, 'the removed guest did not read removed')
  need(report.invite?.oldSlugInvalid === true, 'the old invite slug still answers')
  need(report.close?.showEnded === true, 'the show did not end on the web')
  need((report.leaks ?? []).length === 0, `secrets leaked: ${(report.leaks ?? []).join(', ')}`)
  for (const receiver of report.receivers ?? []) {
    need(
      receiver.maxGapSeconds === null || receiver.maxGapSeconds <= 2,
      `${receiver.name}: a ${receiver.maxGapSeconds} s packet gap`
    )
  }
  return { ok: problems.length === 0, problems }
}
