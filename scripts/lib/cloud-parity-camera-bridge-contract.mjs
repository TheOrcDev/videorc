/** Plan 249 S13a camera-bridge acquisition contract and analyzer rules.
 * Pure: importing or calling these launches nothing. Thresholds are acceptance
 * BUDGETS, never measurements. Missing observations are unavailable, never zero.
 */
import assert from 'node:assert/strict'
import { createReadStream, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { clockBracket, mapClock } from './cloud-parity-pcm-acquisition-contract.mjs'

export const ROOM_FRAME = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/room-frame.json', import.meta.url), 'utf8')
)

export const CAMERA_BRIDGE_BUDGETS = Object.freeze({
  // Local real-LiveKit harness budgets; managed budgets are measured separately.
  nativeToDecodedUpperP95Ms: 250,
  driftGrowthMs: 80,
  minimumSpanSeconds: 1800,
  minimumGenerations: 25,
  minimumDecodedFrameRatio: 0.95,
  alphaTolerance: 16,
  colorTolerance: 24,
  flashOnLuma: 200,
  flashOffLuma: 55,
  memoryRiseFraction: 0.1,
  participants: 6,
  // Plan 249 acceptance: added dropped-frame rate <= 1 percentage point over
  // a matched no-bridge baseline.
  droppedFrameDeltaPoints: 1,
  expectedFps: 30,
  warmupWindows: 5,
  compositeTolerance: 24,
  notCameraDistance: 40
})

export function cameraBridgeConfig(env = {}) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    assert.ok(
      Number.isInteger(value) && value >= min && value <= max,
      `${name} must be ${min}..${max}`
    )
    return value
  }
  const mode = env.VIDEORC_CAMERA_BRIDGE_MODE ?? 'acquire-analyze'
  assert.ok(
    ['acquire', 'analyze', 'acquire-analyze', 'analyze-recording'].includes(mode),
    'Invalid camera-bridge mode'
  )
  // `baseline` is the matched no-bridge run: same guests, layout and duration,
  // the host publishing the ordinary browser camera instead of the bridge.
  const variant = env.VIDEORC_CAMERA_BRIDGE_VARIANT ?? 'bridge'
  assert.ok(['bridge', 'baseline'].includes(variant), 'Invalid camera-bridge variant')
  return {
    mode,
    variant,
    baselineEvidence: env.VIDEORC_CAMERA_BRIDGE_BASELINE_EVIDENCE ?? null,
    compositeEveryMs: integer('VIDEORC_CAMERA_BRIDGE_COMPOSITE_SECONDS', 60, 5, 3500) * 1000,
    durationMs: integer('VIDEORC_CAMERA_BRIDGE_SECONDS', 1805, 5, 3500) * 1000,
    cycles: integer('VIDEORC_CAMERA_BRIDGE_CYCLES', 25, 1, 50),
    guests: integer('VIDEORC_CAMERA_BRIDGE_GUESTS', 5, 0, 7),
    resetEveryMs: integer('VIDEORC_CAMERA_BRIDGE_RESET_SECONDS', 300, 10, 3500) * 1000,
    cycleMs: 4000,
    pollMs: 500,
    readinessMs: 30000,
    closeMs: 10000,
    maximumTraceBytes: 512 * 1024 * 1024,
    maximumArtifactBytes: 768 * 1024 * 1024
  }
}

/** 24-bit sequence + 8-bit check; mirrors `decodeFrameStamp` in shared/room-frame.ts. */
export function decodeFrameStamp(samples) {
  if (samples.length !== 32 || samples.some((v) => !Number.isFinite(v) || (v > 96 && v < 160)))
    return null
  let n = 0,
    check = 0
  for (let i = 0; i < 32; i++)
    if (samples[i] >= 160) {
      if (i < 24) n |= 1 << i
      else check |= 1 << (i - 24)
    }
  return (((n >>> 16) ^ (n >>> 8) ^ n) & 255) === check ? n : null
}

/** x positions (packed pixels) of the 32 stamp-cell centers on the color half. */
export function stampCellCenters(scaleX = 1) {
  return Array.from({ length: 32 }, (_, i) =>
    Math.round((((i + 0.5) * ROOM_FRAME.width) / 32) * scaleX)
  )
}
export const STAMP_ROW = ROOM_FRAME.height - 6
export const PATCH_ROW = 45
export const ALPHA_PATCH_PROBES = [
  { x: 80, rgba: [255, 0, 255, 255] },
  { x: 240, rgba: [0, 255, 0, 128] },
  { x: 400, rgba: [0, 0, 0, 0] }
]
export const FLASH_X = 560
/** Packed x of a logical pixel's alpha sample. */
export const alphaX = (x) => x + ROOM_FRAME.width + ROOM_FRAME.gutter
export const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Check one decoded sample of the packed camera role against S10 tolerances. */
export function assessPatches(sample, budgets = CAMERA_BRIDGE_BUDGETS) {
  const failures = []
  for (const probe of ALPHA_PATCH_PROBES) {
    const color = sample.color?.[probe.x],
      alpha = sample.alpha?.[probe.x]
    if (!color || !Number.isFinite(alpha)) {
      failures.push(`patch ${probe.x}: unavailable`)
      continue
    }
    if (Math.abs(alpha - probe.rgba[3]) > budgets.alphaTolerance)
      failures.push(`patch ${probe.x}: alpha ${alpha} vs ${probe.rgba[3]}`)
    // A fully transparent patch carries no meaningful color.
    if (probe.rgba[3] > 0)
      for (let c = 0; c < 3; c++)
        if (Math.abs(color[c] - probe.rgba[c]) > budgets.colorTolerance)
          failures.push(`patch ${probe.x}: color ${color} vs ${probe.rgba}`)
  }
  return failures
}

export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function prepare(anchors) {
  return anchors
    .sort((a, b) => a.domainUs - b.domainUs)
    .filter((a, i, all) => !i || a.domainUs !== all[i - 1].domainUs)
}
const compose = (interval, anchors) => {
  if (!interval) return null
  const low = mapClock(interval.lowUs, anchors),
    high = mapClock(interval.highUs, anchors)
  return low && high ? { lowUs: low.lowUs, highUs: high.highUs } : null
}

/**
 * Map native capture (ptsUs, generation domain) and program decoded
 * presentation (program performance domain) into the Node monotonic domain
 * through measured round-trip brackets only. Extrapolation is refused.
 */
export function deriveCameraClocks(records) {
  const renderer = [],
    program = [],
    native = []
  const written = new Map(),
    decoded = new Map()
  let generation = null,
    duplicateDecodes = 0
  for (const r of records) {
    const reply = r.reply
    if ((r.kind === 'renderer' || r.kind === 'program') && Number.isFinite(reply?.performanceMs))
      (r.kind === 'renderer' ? renderer : program).push(
        clockBracket(r.beforeUs, r.afterUs, reply.performanceMs * 1000)
      )
    for (const e of reply?.events ?? []) {
      if (r.kind === 'renderer' && e.phase === 'native-frame') {
        generation ??= e.generation
        if (e.generation !== generation) continue
        native.push(
          clockBracket(e.pullRequestedAtMs * 1000, e.pullReceivedAtMs * 1000, e.observedAtUs)
        )
        written.set(e.sequence, e)
      }
      if (r.kind === 'program' && e.phase === 'decoded' && Number.isInteger(e.sequence)) {
        if (decoded.has(e.sequence)) duplicateDecodes++
        else decoded.set(e.sequence, e)
      }
    }
  }
  prepare(renderer)
  prepare(program)
  prepare(native)
  const samples = [],
    unavailable = []
  for (const [sequence, event] of decoded) {
    const source = written.get(sequence)
    if (!source) {
      unavailable.push({ sequence, reason: 'Decoded stamp has no native write observation' })
      continue
    }
    const capture = compose(mapClock(source.ptsUs, native), renderer)
    const shown = mapClock(event.presentationTimeMs * 1000, program)
    if (!capture || !shown) {
      unavailable.push({
        sequence,
        reason: 'Missing bracketing clock event; extrapolation refused'
      })
      continue
    }
    samples.push({
      sequence,
      ptsUs: source.ptsUs,
      nativeCaptureUs: source.nativeCaptureUs ?? null,
      latency: { lowUs: shown.lowUs - capture.highUs, highUs: shown.highUs - capture.lowUs }
    })
  }
  samples.sort((a, b) => a.ptsUs - b.ptsUs)
  return {
    model:
      'native pull brackets -> renderer performance -> Node monotonic; program rVFC presentation -> Node monotonic; piecewise linear within 2 s; no extrapolation',
    generation,
    samples,
    unavailable,
    duplicateDecodes,
    writtenFrames: written.size,
    decodedFrames: decoded.size,
    anchors: { renderer: renderer.length, program: program.length, native: native.length }
  }
}

/** Least-squares slope of latency midpoints against native pts, reported as growth. */
export function driftGrowth(samples) {
  if (samples.length < 2) return null
  const xs = samples.map((s) => s.ptsUs / 1e6),
    ys = samples.map((s) => (s.latency.lowUs + s.latency.highUs) / 2000)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length,
    my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0,
    den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (den === 0) return null
  const span = xs.at(-1) - xs[0]
  return { slopeMsPerSecond: num / den, spanSeconds: span, growthMs: (num / den) * span }
}

/** Every owner observed closed; unavailable stays unavailable. */
export function cameraRemaining(main, renderer, publications) {
  const value = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
  const owners = Array.isArray(renderer?.owners) ? renderer.owners : null
  const sum = (key) =>
    owners ? owners.reduce((total, owner) => total + (value(owner[key]) ?? NaN), 0) : null
  const remaining = {
    nativeSources: value(main?.nativeSources),
    nativeLeases: value(main?.nativeLeases),
    mainSockets: value(main?.sockets),
    mainRequests: value(main?.ipcRequests),
    mainTimers: value(main?.timers),
    rendererOwners: owners ? owners.length : null,
    rendererGenerators: sum('generators'),
    rendererTimers: sum('timers'),
    rendererLeases: sum('leasesHeld'),
    rendererFrames: sum('framesOpen'),
    sfuPublications: Array.isArray(publications) ? publications.length : null
  }
  if (Object.values(remaining).some((v) => v === null || Number.isNaN(v)))
    return { status: 'unavailable', remaining }
  return { status: Object.values(remaining).every((v) => v === 0) ? 'closed' : 'live', remaining }
}

/** Exactly one camera publication from the host; its name is a label, not authority. */
export function cameraPublication(participant) {
  const tracks = (participant?.tracks ?? []).filter(
    (t) => t.source === 'CAMERA' || t.source === 1 || t.source === 'camera'
  )
  return tracks.length === 1 && !tracks[0].muted ? tracks[0] : null
}

/** Rises above the warm-up minimum by more than the budget fraction fail. */
export function memoryRise(samples, budget = CAMERA_BRIDGE_BUDGETS.memoryRiseFraction) {
  const values = samples.filter(Number.isFinite)
  if (values.length < 4) return null
  const warm = values.slice(Math.floor(values.length / 4))
  const base = Math.min(...warm.slice(0, Math.max(1, Math.floor(warm.length / 4))))
  const tail = warm.slice(-Math.max(1, Math.floor(warm.length / 4)))
  const end = tail.reduce((a, b) => a + b, 0) / tail.length
  const rise = base > 0 ? (end - base) / base : null
  return { base, end, rise, passed: rise !== null && rise <= budget }
}

/** Evaluate acquired evidence against the declared budgets. */
export function assessCameraBridge(evidence, budgets = CAMERA_BRIDGE_BUDGETS, options = {}) {
  const gates = {}
  const unavailable = [...(evidence.unavailable ?? [])]
  const clock = evidence.clock
  const uppers = (clock?.samples ?? []).map((s) => s.latency.highUs / 1000)
  const p95 = percentile(uppers, 95)
  gates.nativeToDecodedLatency =
    p95 === null
      ? { status: 'unavailable' }
      : { status: p95 <= budgets.nativeToDecodedUpperP95Ms ? 'passed' : 'failed', upperP95Ms: p95 }
  const drift = driftGrowth(clock?.samples ?? [])
  gates.drift30Minutes = !drift
    ? { status: 'unavailable' }
    : {
        status:
          drift.spanSeconds >= budgets.minimumSpanSeconds &&
          Math.abs(drift.growthMs) <= budgets.driftGrowthMs
            ? 'passed'
            : 'failed',
        ...drift
      }
  const patches = evidence.patchSamples ?? []
  const patchFailures = patches.flatMap((s) => assessPatches(s, budgets))
  gates.transportAlphaPatches = patches.length
    ? {
        status: patchFailures.length ? 'failed' : 'passed',
        samples: patches.length,
        failures: patchFailures.slice(0, 20)
      }
    : { status: 'unavailable' }
  // The adapters' own output, per surface: real alpha in logical coordinates.
  const surfaces = new Map()
  for (const sample of evidence.unpackedSamples ?? []) {
    const list = surfaces.get(sample.surface) ?? []
    list.push(sample)
    surfaces.set(sample.surface, list)
  }
  for (const surface of ['program', 'monitor', ...(evidence.guestSurfaces ?? [])]) {
    const samples = surfaces.get(surface) ?? []
    const failures = samples.flatMap((s) => assessPatches(s, budgets))
    gates[`unpackedPatches.${surface}`] = samples.length
      ? {
          status: failures.length ? 'failed' : 'passed',
          samples: samples.length,
          failures: failures.slice(0, 20)
        }
      : { status: 'unavailable' }
  }
  const exposure = evidence.packedExposure ?? []
  gates.packedNeverShown = exposure.length
    ? {
        status: exposure.some((e) => e.visible) ? 'failed' : 'passed',
        observations: exposure.length,
        visible: exposure.filter((e) => e.visible).length
      }
    : { status: 'unavailable' }
  const checks = evidence.authorityChecks ?? []
  gates.authorityMatchesSfu = checks.length
    ? {
        status: checks.every((c) => c.participantSid && c.trackSid && c.packedDescriptor)
          ? 'passed'
          : 'failed',
        checks: checks.length
      }
    : { status: 'unavailable' }
  const flashes = evidence.flashSamples ?? []
  const flashBad = flashes.filter((f) =>
    f.sequence % ROOM_FRAME.fps === 0 ? f.luma < budgets.flashOnLuma : f.luma > budgets.flashOffLuma
  )
  gates.flash = flashes.some((f) => f.sequence % ROOM_FRAME.fps === 0)
    ? {
        status: flashBad.length ? 'failed' : 'passed',
        samples: flashes.length,
        wrong: flashBad.length
      }
    : { status: 'unavailable' }
  const ratio = clock?.writtenFrames ? clock.decodedFrames / clock.writtenFrames : null
  const load = evidence.load
  gates.sixPersonLoad =
    !load || ratio === null
      ? { status: 'unavailable' }
      : {
          status:
            load.participants >= budgets.participants &&
            ratio >= budgets.minimumDecodedFrameRatio &&
            load.maxNativeLeases <= ROOM_FRAME.leaseSlots
              ? 'passed'
              : 'failed',
          participants: load.participants,
          decodedFrameRatio: ratio,
          maxNativeLeases: load.maxNativeLeases
        }
  const memory = memoryRise(evidence.memorySamples ?? [])
  gates.memory = memory
    ? { status: memory.passed ? 'passed' : 'failed', ...memory }
    : { status: 'unavailable' }
  const resets = evidence.resets ?? []
  gates.surfaceReset = resets.length
    ? {
        status: resets.every(
          (r) => r.epochAdvanced && r.framesAfter > 0 && r.leasesAfter <= ROOM_FRAME.leaseSlots
        )
          ? 'passed'
          : 'failed',
        resets: resets.length
      }
    : { status: 'unavailable' }
  const closes = evidence.closeCycles ?? []
  const generations = new Set(closes.map((c) => c.generation).filter(Boolean))
  gates.resourceRelease =
    closes.length === 0
      ? { status: 'unavailable' }
      : {
          status:
            closes.every((c) => c.status === 'closed' && c.browserContexts === 0) &&
            generations.size >= budgets.minimumGenerations
              ? 'passed'
              : 'failed',
          cycles: closes.length,
          generations: generations.size
        }
  gates.replacement = evidence.replacement
    ? {
        status:
          evidence.replacement.generationAdvanced && evidence.replacement.framesAfter > 0
            ? 'passed'
            : 'failed',
        ...evidence.replacement
      }
    : { status: 'unavailable' }
  // Final composited pixels (browser compositor / desktop window captures).
  const composites = evidence.composites ?? []
  for (const surface of ['program', 'monitor', ...(evidence.guestSurfaces ?? [])]) {
    const all = composites.filter((c) => c.surface === surface)
    const list = all.filter((c) => Array.isArray(c.samples))
    const captureFailures = all
      .filter((c) => c.status === 'capture-failed')
      .map((c) => `capture failed: ${c.reason}`)
    if (!list.length && !captureFailures.length) {
      gates[`compositedPixels.${surface}`] = {
        status: 'unavailable',
        observations: all.map((c) => c.status)
      }
      continue
    }
    const results = list.map((c) => assessComposite(c, budgets))
    const failures = [...captureFailures, ...results.flatMap((r) => r.failures)]
    const checked = results.reduce((n, r) => n + r.checked.length, 0)
    gates[`compositedPixels.${surface}`] = {
      status: failures.length ? 'failed' : checked ? 'passed' : 'unavailable',
      captures: list.length,
      checkedProbes: checked,
      skipped: [...new Set(results.flatMap((r) => r.skipped))],
      failures: failures.slice(0, 20)
    }
  }
  if (options.baseline) {
    const reasons = matchBaseline(evidence, options.baseline)
    const bridge = decodeHealth(evidence.rateEvents ?? [], budgets)
    const base = decodeHealth(options.baseline.rateEvents ?? [], budgets)
    gates.droppedFrameDelta =
      reasons.length || !bridge || !base
        ? { status: 'unavailable', reasons: reasons.length ? reasons : ['missing decode windows'] }
        : {
            status:
              (bridge.dropRate - base.dropRate) * 100 <= budgets.droppedFrameDeltaPoints
                ? 'passed'
                : 'failed',
            bridgeDropRate: bridge.dropRate,
            baselineDropRate: base.dropRate,
            deltaPoints: (bridge.dropRate - base.dropRate) * 100
          }
  } else gates.droppedFrameDelta = { status: 'unavailable', reason: 'No matched baseline evidence' }
  const recording = evidence.recordingAnalysis
  gates.compositedRecording = recording
    ? { ...recording, status: recording.status }
    : { status: 'unavailable', reason: 'No finalized composited recording analyzed' }
  // Encoded-frame observation (renderer encoded transform; never wire timing).
  gates.encoderObservation = evidence.encoderObservation ?? {
    status: 'unavailable',
    reason: 'No encoded-frame observation in this evidence'
  }
  // S12 scene geometry on the unpacked camera, from final composited captures.
  for (const scene of evidence.sceneCases ?? []) {
    const captures = (evidence.composites ?? []).filter(
      (c) => c.sceneCase === scene.id && Array.isArray(c.samples)
    )
    gates[`sceneGeometry.${scene.id}`] = assessSceneCase(scene, captures, budgets)
  }
  for (const item of unavailable) gates[item.measurement] = { status: 'unavailable', ...item }
  const statuses = Object.values(gates).map((g) => g.status)
  return {
    status: statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
    productionQualified: false,
    platform: evidence.platform ?? null,
    budgets,
    gates
  }
}

/**
 * Final composited pixels. Map the S10 patch probes from logical camera
 * coordinates to page coordinates through the canvas's actual drawn box
 * (CSS fit, transforms, mirror), and add crop and mask probes from the
 * clipping tile. Probes outside the tile are crop expectations, never
 * silently dropped.
 */
export function compositeProbes(g) {
  const lw = g.logical.w,
    lh = g.logical.h
  const toPage = (x, y) => ({
    x: g.content.x + (g.mirrored ? 1 - (x + 0.5) / lw : (x + 0.5) / lw) * g.content.w,
    y: g.content.y + ((y + 0.5) / lh) * g.content.h
  })
  const toLogical = (px, py) => {
    let fx = (px - g.content.x) / g.content.w
    if (g.mirrored) fx = 1 - fx
    return { x: fx * lw, y: ((py - g.content.y) / g.content.h) * lh }
  }
  const inTile = (p) =>
    !g.tile ||
    (p.x >= g.tile.x + 2 &&
      p.x <= g.tile.x + g.tile.w - 2 &&
      p.y >= g.tile.y + 2 &&
      p.y <= g.tile.y + g.tile.h - 2)
  // Inside the tile's mask shape too: an ellipse for a circle clip-path, the
  // corner arcs for a border radius (3 px margin either way).
  const inShape = (p) => {
    if (!g.tile) return true
    const cx = g.tile.x + g.tile.w / 2,
      cy = g.tile.y + g.tile.h / 2
    if (/^(circle|ellipse)/.test(g.clipPath)) {
      const rx = Math.min(g.tile.w, g.tile.h) / 2 - 3
      const ry = /^ellipse/.test(g.clipPath) ? g.tile.h / 2 - 3 : rx
      return ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1
    }
    const r = g.radius + 3
    if (r <= 3) return true
    const nx = Math.min(p.x - g.tile.x, g.tile.x + g.tile.w - p.x)
    const ny = Math.min(p.y - g.tile.y, g.tile.y + g.tile.h - p.y)
    return nx >= r || ny >= r || (r - nx) ** 2 + (r - ny) ** 2 <= (r - 3) ** 2
  }
  const visible = (p) => inTile(p) && inShape(p)
  // The patch band is the logical top quarter; probe a row inside its visible
  // part (zoom or a top crop can hide row 45), else every patch is cropped.
  const topVisible = g.tile ? Math.ceil(toLogical(g.tile.x + g.tile.w / 2, g.tile.y + 3).y) : 0
  const row = Math.max(PATCH_ROW, Math.min(lh / 4 - 3, topVisible + 2))
  // Magenta is solid and frame-independent in this region of every frame.
  // The patch band a logical point falls in, away from band edges; the
  // transparent band and the per-frame flash band prove nothing here.
  const bandAt = (l) => {
    if (!(l.x >= 2 && l.y >= 2 && l.y < lh / 4 - 2)) return null
    const index = Math.floor(l.x / (lw / 4))
    const edge = Math.min(l.x - index * (lw / 4), (index + 1) * (lw / 4) - l.x)
    if (index > 1 || edge < 2) return null
    return index === 0 ? [255, 0, 255, 255] : [0, 255, 0, 128]
  }
  const probes = ALPHA_PATCH_PROBES.map((patch) => {
    const page = toPage(patch.x, row)
    return visible(page)
      ? { name: `patch-${patch.x}`, page, expect: 'camera', rgba: patch.rgba }
      : { name: `patch-${patch.x}`, page, expect: 'cropped', rgba: patch.rgba }
  })
  // Edge probes either side of each patch-band boundary (at least 4 drawn
  // pixels away): any misplacement or rescale moves a boundary across one.
  const bands = [
    [255, 0, 255, 255],
    [0, 255, 0, 128],
    [0, 0, 0, 0]
  ]
  const offset = Math.min(60, Math.max(6, Math.ceil(4 / (g.content.w / lw))))
  for (const boundary of [160, 320, 480])
    for (const side of [-1, 1]) {
      const lx = boundary + side * offset
      const band = Math.floor(lx / 160)
      if (band > 2) continue // the flash band changes every frame
      const page = toPage(lx, row)
      probes.push({
        name: `edge-${boundary}-${side < 0 ? 'l' : 'r'}`,
        page,
        expect: visible(page) ? 'camera' : 'cropped',
        rgba: bands[band]
      })
    }
  if (g.tile) {
    const masked = g.radius >= 4 || g.clipPath !== 'none'
    const corner = { x: g.tile.x + 1, y: g.tile.y + 1 }
    const cornerBand = bandAt(toLogical(corner.x, corner.y))
    if (cornerBand)
      probes.push({
        name: 'mask-corner',
        page: corner,
        expect: masked ? 'not-camera' : 'camera',
        rgba: cornerBand
      })
    // Just outside the tile, where cover-fit content would extend if unclipped.
    for (const [name, outside] of [
      ['crop-left', { x: g.tile.x - 2, y: g.tile.y + g.tile.h * 0.1 }],
      ['crop-top', { x: g.tile.x + g.tile.w * 0.1, y: g.tile.y - 2 }]
    ])
      if (
        outside.x >= 0 &&
        outside.y >= 0 &&
        outside.x >= g.content.x &&
        outside.y >= g.content.y
      ) {
        const band = bandAt(toLogical(outside.x, outside.y))
        if (band) probes.push({ name, page: outside, expect: 'not-camera', rgba: band })
      }
  }
  return probes
}

/** RGB at a page point from a decoded RGBA capture whose origin is `clip`. */
export function captureRgb(capture, point) {
  const x = Math.floor((point.x - capture.clip.x) * capture.scale)
  const y = Math.floor((point.y - capture.clip.y) * capture.scale)
  if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) return null
  const i = (y * capture.width + x) * 4
  return [capture.rgba[i], capture.rgba[i + 1], capture.rgba[i + 2]]
}

/**
 * Assess one composited capture. The background under a translucent camera is
 * the transparent probe's measured pixel, which must match the tile's CSS
 * ground; the half-alpha probe must equal the blend over that background and
 * be distinguishable from an unblended source.
 */
export function assessComposite(capture, budgets = CAMERA_BRIDGE_BUDGETS) {
  const t = budgets.compositeTolerance
  const near = (a, b, tol = t) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= tol)
  const failures = [],
    checked = [],
    skipped = []
  const sample = Object.fromEntries(capture.samples.map((s) => [s.name, s.rgb]))
  // The transparent patch measures the background only where it is visible.
  const transparent = capture.probes.find((p) => p.name === 'patch-400')
  const background = transparent?.expect === 'camera' ? sample['patch-400'] : null
  if (capture.ground && background && !near(background, capture.ground))
    failures.push(`transparent patch ${background} is not the tile ground ${capture.ground}`)
  for (const probe of capture.probes) {
    const actual = sample[probe.name]
    if (probe.expect === 'cropped') {
      skipped.push(`${probe.name}: outside the tile (crop)`)
      continue
    }
    if (!actual) {
      failures.push(`${probe.name}: not in the capture`)
      continue
    }
    checked.push(probe.name)
    if (probe.expect === 'not-camera') {
      // What the camera would have drawn there: solid, or blended over the
      // measured background (the CSS ground when no transparent probe shows).
      const [cr, cg, cb, ca] = probe.rgba
      const under = background ?? capture.ground
      const camera = ca === 255 ? [cr, cg, cb] : under ? blendPixel([cr, cg, cb], ca, under) : null
      if (!camera) skipped.push(`${probe.name}: no background to predict the camera colour`)
      else if (near(actual, camera, budgets.notCameraDistance))
        failures.push(`${probe.name}: camera drawn where crop/mask should clip it`)
      continue
    }
    const [r, g, b, a] = probe.rgba
    if (a === 0) {
      // Fully transparent: the background itself, wherever it is visible.
      if (background && !near(actual, background))
        failures.push(`${probe.name}: ${actual} vs background ${background}`)
      continue
    }
    if (a === 255) {
      if (!near(actual, [r, g, b])) failures.push(`${probe.name}: ${actual} vs solid ${[r, g, b]}`)
      continue
    }
    if (!background) {
      failures.push(`${probe.name}: no measured background for the blend`)
      continue
    }
    const expected = blendPixel([r, g, b], a, background)
    if (!near(actual, expected)) failures.push(`${probe.name}: ${actual} vs blend ${expected}`)
    if (near(expected, [r, g, b]))
      failures.push(`${probe.name}: background too close to the source to prove blending`)
  }
  return { failures, checked, skipped }
}

export function blendPixel(rgb, alpha, background) {
  const a = Math.max(0, Math.min(255, alpha)) / 255
  return [0, 1, 2].map((i) => Math.round(rgb[i] * a + background[i] * (1 - a)))
}

/**
 * One S12 scene case on the camera role: the receipt says applied, composited
 * pixels pass, and the measured geometry shows the expected mirror, mask and
 * crop. A capture without the case's camera canvas is unavailable, never a pass.
 */
export function assessSceneCase(scene, captures, budgets = CAMERA_BRIDGE_BUDGETS) {
  if (scene.receipt?.status?.state !== 'applied')
    return { status: 'failed', reason: 'No applied S12 scene receipt' }
  const program = captures.find((c) => c.surface === 'program')
  if (!program) return { status: 'unavailable', reason: 'No composited program capture' }
  const composite = assessComposite(program, budgets)
  const failures = [...composite.failures]
  if (!composite.checked.some((name) => name.startsWith('patch-')))
    failures.push('no visible camera patch to prove blending in this scene')
  const expect = scene.expect ?? {}
  const g = program.geometry
  if (expect.mirror !== undefined && g.mirrored !== expect.mirror)
    failures.push(`mirror ${g.mirrored}, expected ${expect.mirror}`)
  const masked = g.radius >= 4 || g.clipPath !== 'none'
  if (expect.mask && masked !== (expect.mask !== 'rectangle'))
    failures.push(`mask ${masked ? 'present' : 'absent'}, expected ${expect.mask}`)
  const clipped = program.probes.some((p) => p.expect === 'cropped' || p.name.startsWith('crop-'))
  if (expect.cropped && !clipped) failures.push('no crop observed for a cropped scene')
  return {
    status: failures.length ? 'failed' : 'passed',
    receipt: scene.receipt.status,
    failures: failures.slice(0, 20)
  }
}

/** Decode health from fixed 1 s windows of unique presented frames. */
export function decodeHealth(events, budgets = CAMERA_BRIDGE_BUDGETS, surface = 'program') {
  const byKey = new Map()
  for (const e of events)
    if (e.phase === 'rate' && e.surface === surface && Number.isFinite(e.windowMs)) {
      const list = byKey.get(e.key) ?? []
      list.push(e)
      byKey.set(e.key, list)
    }
  let expected = 0,
    decoded = 0,
    windows = 0
  for (const list of byKey.values())
    for (const e of list.slice(budgets.warmupWindows)) {
      expected += (e.windowMs / 1000) * budgets.expectedFps
      decoded += Math.min(e.frames, Math.ceil((e.windowMs / 1000) * budgets.expectedFps) + 1)
      windows++
    }
  if (!windows || expected <= 0) return null
  return {
    videos: byKey.size,
    windows,
    expected,
    decoded,
    dropRate: Math.max(0, 1 - decoded / expected)
  }
}

/** The baseline must match the bridge run in everything but the camera producer. */
export function matchBaseline(bridge, baseline) {
  const reasons = []
  if (baseline?.variant !== 'baseline') reasons.push('baseline evidence is not a baseline variant')
  if (bridge?.variant !== 'bridge') reasons.push('bridge evidence is not a bridge variant')
  for (const key of ['platform'])
    if (bridge?.[key] !== baseline?.[key]) reasons.push(`${key} differs`)
  // Provenance: the same desktop source (revision and uncommitted diff), the
  // same web revision and emitted program bundle. Missing is never a match.
  for (const key of ['desktop', 'desktopDiffSha256', 'web', 'programBundleSha256']) {
    const a = bridge?.revisions?.[key],
      b = baseline?.revisions?.[key]
    if (!a || !b) reasons.push(`missing ${key} provenance`)
    else if (a !== b) reasons.push(`${key} differs`)
  }
  // The same workload shape: viewports, layout, logical camera, guest CSS.
  for (const key of [
    'programViewport',
    'guestViewport',
    'layout',
    'logicalCamera',
    'guestFixtureCss'
  ])
    if (JSON.stringify(bridge?.workload?.[key]) !== JSON.stringify(baseline?.workload?.[key]))
      reasons.push(`workload ${key} differs`)
  if (bridge?.config?.guests !== baseline?.config?.guests) reasons.push('guest count differs')
  const a = bridge?.config?.durationMs,
    b = baseline?.config?.durationMs
  if (!a || !b || Math.abs(a - b) / Math.max(a, b) > 0.05) reasons.push('duration differs by >5%')
  return reasons
}

/** Analyze acquired evidence: verify every retained artifact hash first. */
async function readVerified(file) {
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(evidence.kind, 'local-livekit-camera-bridge', 'Not camera-bridge evidence')
  for (const item of evidence.artifacts ?? []) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(resolve(dirname(file), item.file)))
      hash.update(chunk)
    assert.equal(
      hash.digest('hex'),
      item.sha256,
      `Artifact changed after acquisition: ${item.file}`
    )
  }
  return evidence
}

/** Analyze acquired evidence after verifying every retained artifact hash. A
 * matched no-bridge baseline (its own evidence file) enables the dropped-frame
 * delta; a baseline file alone is acquisition evidence, never qualification. */
export async function analyzeCameraBridgeEvidence(file, baselineFile = null) {
  const evidence = await readVerified(file)
  if (evidence.acquisition !== 'completed')
    return { status: 'failed', productionQualified: false, reason: 'Acquisition incomplete' }
  if (evidence.variant === 'baseline')
    return {
      status: 'baseline-acquired',
      productionQualified: false,
      decodeHealth: decodeHealth(evidence.rateEvents ?? [])
    }
  const baseline = baselineFile ? await readVerified(baselineFile) : null
  if (baseline && baseline.acquisition !== 'completed')
    return { status: 'failed', productionQualified: false, reason: 'Baseline incomplete' }
  return assessCameraBridge(evidence, CAMERA_BRIDGE_BUDGETS, { baseline })
}
