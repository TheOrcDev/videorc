/** Plan 249 S22 ISO acceptance contract: fixture sources, configuration and the
 * pure analyzer. Importing this module launches nothing and reads no media.
 * Decoding happens in cloud-parity-iso.mjs; this file judges decoded facts.
 *
 * The case drives the real desktop app (host camera, native microphone with a
 * mid-take device switch, soundboard aux) and real GuestRoom guests in one
 * local LiveKit room, records the real program page for the same take, runs
 * the real durable web ISO runtime behind the fake web, and imports through
 * the desktop RPC. See docs/cloud/249-s22-handoff.md.
 */
import assert from 'node:assert/strict'

export const ISO_AUX_NAME = 'videorc:v2:host-aux:stereo'
/** Production guest id shape (`g_` + 22 base62), one per GuestRoom page. */
export const ISO_GUESTS = Object.freeze({
  ann: 'g_IsoAnnFixture000000000',
  bob: 'g_IsoBobFixture000000000',
  cid: 'g_IsoCidFixture000000000'
})
/** Who allows separate recording through the real consent card. */
export const ISO_CONSENTING = Object.freeze(['ann', 'cid'])
/** Every colour a fixture source paints (host: the desktop Y4M). */
export const ISO_COLORS = Object.freeze({
  'host-camera': [200, 40, 40],
  'ann-camera': [40, 80, 200],
  'bob-camera': [200, 180, 40],
  'cid-camera': [40, 200, 200]
})
/** Every tone a fixture source plays. The desktop's synthetic native
 * microphone plays 440 Hz on its first device and 880 Hz on the alternate
 * one (crates/videorc-backend/src/audio.rs), so a device switch changes it. */
export const ISO_TONES = Object.freeze({
  'host-microphone:g1': 440,
  'host-microphone:g2': 880,
  'host-aux': 1000,
  'ann-microphone': 1320,
  'bob-microphone': 1760,
  'cid-microphone': 2200
})
/**
 * Every source in the room. `publisher` says who makes the media: the real
 * desktop app (no wall-clock marker can ride its Y4M/WAV/native loops) or a
 * real GuestRoom page whose fixture devices flash white / gap the tone on a
 * shared wall-clock grid. `expect` is the ISO outcome the case requires.
 */
export const ISO_SOURCES = Object.freeze([
  {
    key: 'host-camera',
    who: 'host',
    publisher: 'desktop',
    source: 'camera',
    role: 'host-camera',
    color: 'host-camera',
    expect: 'recorded'
  },
  {
    key: 'host-microphone',
    who: 'host',
    publisher: 'desktop',
    source: 'microphone',
    role: 'host-microphone',
    tones: ['host-microphone:g1', 'host-microphone:g2'],
    replaced: true,
    expect: 'recorded'
  },
  {
    key: 'host-aux',
    who: 'host',
    publisher: 'desktop',
    source: 'screen_share_audio',
    name: ISO_AUX_NAME,
    role: 'host-aux',
    tones: ['host-aux'],
    expect: 'recorded'
  },
  {
    key: 'ann-camera',
    who: 'ann',
    publisher: 'guest-page',
    source: 'camera',
    role: 'guest-camera',
    color: 'ann-camera',
    expect: 'recorded'
  },
  {
    key: 'ann-microphone',
    who: 'ann',
    publisher: 'guest-page',
    source: 'microphone',
    role: 'guest-microphone',
    tones: ['ann-microphone'],
    expect: 'recorded'
  },
  {
    key: 'bob-camera',
    who: 'bob',
    publisher: 'guest-page',
    source: 'camera',
    role: 'guest-camera',
    color: 'bob-camera',
    expect: 'refused:guest-consent-missing'
  },
  {
    key: 'bob-microphone',
    who: 'bob',
    publisher: 'guest-page',
    source: 'microphone',
    role: 'guest-microphone',
    tones: ['bob-microphone'],
    expect: 'refused:guest-consent-missing'
  },
  {
    key: 'cid-camera',
    who: 'cid',
    publisher: 'guest-page',
    source: 'camera',
    role: 'guest-camera',
    color: 'cid-camera',
    // The local track-egress stand-in refuses this start (code "refused").
    expect: 'failed:start-failed'
  },
  {
    key: 'cid-microphone',
    who: 'cid',
    publisher: 'guest-page',
    source: 'microphone',
    role: 'guest-microphone',
    tones: ['cid-microphone'],
    expect: 'recorded'
  }
])
/** Named, never passed: what this local case cannot exercise, and why. */
export const ISO_NOT_EXERCISED = Object.freeze([
  {
    check: 'unnamed-host-screen-audio-refused',
    reason:
      'The desktop publisher never publishes host screen_share_audio without the exact S3 aux name, and a second host:<show> connection would replace the desktop (one identity, one connection). Covered by web tests/cloud-iso.test.ts (roles), not by this case.'
  },
  {
    check: 'guest-screen-role',
    reason:
      'The local GuestRoom fixture grants no screen share (screenShareAllowed:false, no screen_share source in the guest grant), so the forced start failure is on a guest camera instead.'
  },
  {
    check: 'host-file-wall-clock-markers',
    reason:
      'Desktop Y4M, WAV and native synthetic microphone loops cannot carry wall-clock markers: host files are judged on uniqueness, generations and duration only.'
  },
  {
    check: 'managed-provider',
    reason:
      'A local livekit-server --dev has no Egress service: the hidden EG_ MediaRecorder page stands in for raw track egress. Managed cost, concurrency, metering and provider clock stay unmeasured.'
  }
])
export const ISO_ANALYSIS = Object.freeze({
  /** Wall-clock grid every guest page marks: white flash or 200 ms tone gap. */
  markerPeriodMs: 4000,
  markerLengthMs: 200,
  colorTolerance: 45,
  minimumColorFraction: 0.3,
  absentColorFraction: 0.01,
  audibleDbfs: -45,
  absentDbfs: -60,
  /** Program: a source is on screen in a frame above this pixel fraction. */
  programPixelFraction: 0.005,
  /** Program: on screen in at least this share of decoded frames. */
  programPresentFrames: 0.5,
  /** Program tone envelopes (Hann-windowed Goertzel). */
  envelopeWindowMs: 40,
  envelopeHopMs: 10,
  gapDropDb: 20,
  minimumGapMs: 80,
  /** Program colour marker: below this share of the source's median area. */
  colorDropRatio: 0.25,
  /** Each correlated ISO file needs this many markers found in the program. */
  minimumProgramMatches: 2,
  /** Decoded file length vs manifest duration. */
  durationSlackMs: 1000,
  durationSlackRatio: 0.1
})

const bounded = (env, name, fallback, min, max) => {
  const value = env[name] === undefined ? fallback : Number(env[name])
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} out of bounds`)
  return value
}

export function isoAcquisitionConfig(env = process.env) {
  const mode = env.VIDEORC_ISO_MODE ?? 'acquire-analyze'
  assert.ok(['acquire', 'analyze', 'acquire-analyze'].includes(mode), 'VIDEORC_ISO_MODE')
  if (mode === 'analyze') assert.ok(env.VIDEORC_ISO_EVIDENCE, 'VIDEORC_ISO_EVIDENCE required')
  const durationMs = bounded(env, 'VIDEORC_ISO_DURATION_MS', 24_000, 12_000, 120_000)
  return {
    mode,
    durationMs,
    switchMicrophoneAtMs: Math.round(durationMs / 2),
    reconcileEveryMs: 1_000,
    readinessMs: bounded(env, 'VIDEORC_ISO_READINESS_MS', 30_000, 5_000, 120_000),
    /** After the take stops: files finalize, keys are revoked. */
    settleMs: bounded(env, 'VIDEORC_ISO_SETTLE_MS', 30_000, 5_000, 120_000),
    importMs: bounded(env, 'VIDEORC_ISO_IMPORT_MS', 120_000, 10_000, 600_000),
    /** ISO file markers vs the wall-clock grid (local recorder start latency included). */
    clockToleranceMs: bounded(env, 'VIDEORC_ISO_CLOCK_TOLERANCE_MS', 250, 20, 1_000),
    /** ISO file markers mapped through manifest offsets onto the program recording. */
    programToleranceMs: bounded(env, 'VIDEORC_ISO_PROGRAM_TOLERANCE_MS', 400, 50, 2_000),
    maximumArtifactBytes: bounded(
      env,
      'VIDEORC_ISO_MAX_ARTIFACT_BYTES',
      64 << 20,
      1 << 20,
      512 << 20
    ),
    /** The ISO limits the desktop asks for (worst case 10 x 5 min x $0.001). */
    request: { maxActiveEntries: 10, maxMinutes: 5, costCeilingMicros: 50_000 },
    failSource: 'cid-camera'
  }
}

/** The tone key a recorded audio entry must carry. */
export function toneKeyFor(source, generation) {
  if (!source.tones) return null
  return source.tones[Math.min(generation, source.tones.length) - 1]
}

/** Library id the desktop registers for one ISO file (contract section 5). */
export function isoLibraryId(takeId, entry) {
  return `cloud-iso-${takeId}-${entry.subject}-${entry.role}-g${entry.generation}`
}

/** Onsets (ms from file start) of marker flashes: luma rises above 220. */
export function videoMarkerOnsets(frames, fps) {
  assert.ok(fps > 0)
  const onsets = []
  let bright = true
  frames.forEach(([r, g, b], index) => {
    const now = 0.299 * r + 0.587 * g + 0.114 * b > 220
    if (now && !bright) onsets.push(Math.round((index * 1000) / fps))
    bright = now
  })
  return onsets
}

/** Fraction of frames whose mean colour matches. */
export function colorMatch(frames, color, tolerance = ISO_ANALYSIS.colorTolerance) {
  if (!frames.length) return 0
  const hits = frames.filter((rgb) => color.every((v, c) => Math.abs(rgb[c] - v) <= tolerance))
  return hits.length / frames.length
}

/** Onsets (ms) of marker gaps: 10 ms windows falling below a tenth of the median level. */
export function audioGapOnsets(samples, sampleRate) {
  const step = Math.round(sampleRate / 100)
  const rms = []
  for (let i = 0; i + step <= samples.length; i += step) {
    let sum = 0
    for (let j = i; j < i + step; j++) sum += samples[j] * samples[j]
    rms.push(Math.sqrt(sum / step))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  if (median <= 1e-4) return []
  const onsets = []
  let quiet = true
  rms.forEach((level, index) => {
    const now = level < median / 10
    // A gap must last at least 80 ms to be a marker, not a codec blip.
    if (now && !quiet && rms.slice(index, index + 8).every((l) => l < median / 10))
      onsets.push(index * 10)
    quiet = now
  })
  return onsets
}

/**
 * One tone's level over time in a mix: a Hann-windowed Goertzel per window,
 * in dBFS, every `hopMs`. Element i covers [i*hop, i*hop + window).
 */
export function toneEnvelope(
  samples,
  sampleRate,
  hz,
  windowMs = ISO_ANALYSIS.envelopeWindowMs,
  hopMs = ISO_ANALYSIS.envelopeHopMs
) {
  const size = Math.round((sampleRate * windowMs) / 1000)
  const hop = Math.round((sampleRate * hopMs) / 1000)
  assert.ok(size > 1 && hop > 0, 'envelope window')
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate)
  const hann = Float64Array.from(
    { length: size },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  )
  const gain = hann.reduce((sum, w) => sum + w, 0) / 2
  const out = []
  for (let start = 0; start + size <= samples.length; start += hop) {
    let s1 = 0,
      s2 = 0
    for (let i = 0; i < size; i++) {
      const s0 = samples[start + i] * hann[i] + coefficient * s1 - s2
      s2 = s1
      s1 = s0
    }
    const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
    out.push(20 * Math.log10(Math.max(1e-10, Math.sqrt(Math.max(0, power)) / gain)))
  }
  return out
}

/** Onsets (ms) where a tone envelope drops `dropDb` under its median for `minimumMs`. */
export function envelopeGapOnsets(
  envelopeDb,
  {
    hopMs = ISO_ANALYSIS.envelopeHopMs,
    windowMs = ISO_ANALYSIS.envelopeWindowMs,
    dropDb = ISO_ANALYSIS.gapDropDb,
    minimumMs = ISO_ANALYSIS.minimumGapMs
  } = {}
) {
  if (!envelopeDb.length) return []
  const sorted = [...envelopeDb].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const floor = median - dropDb
  const run = Math.max(1, Math.round(minimumMs / hopMs))
  const onsets = []
  let low = true
  envelopeDb.forEach((level, index) => {
    const now = level < floor
    if (now && !low && envelopeDb.slice(index, index + run).every((l) => l < floor))
      // The window first dips once its leading half is in the gap.
      onsets.push(Math.round(index * hopMs + windowMs / 2))
    low = now
  })
  return onsets
}

/** Onsets (ms) where a source's on-screen area falls under `ratio` of its median. */
export function areaDropOnsets(
  fractions,
  fps,
  { ratio = ISO_ANALYSIS.colorDropRatio, minimumFrames = 2 } = {}
) {
  assert.ok(fps > 0)
  const present = fractions
    .filter((f) => f > ISO_ANALYSIS.programPixelFraction)
    .sort((a, b) => a - b)
  if (present.length < fractions.length / 2) return []
  const median = present[Math.floor(present.length / 2)]
  const floor = median * ratio
  const onsets = []
  let low = true
  fractions.forEach((fraction, index) => {
    const now = fraction < floor
    if (now && !low && fractions.slice(index, index + minimumFrames).every((f) => f < floor))
      onsets.push(Math.round((index * 1000) / fps))
    low = now
  })
  return onsets
}

/** Error of each marker against the shared wall-clock grid, in show time. */
export function markerErrors({
  onsetsMs,
  offsetMs,
  originAtMs,
  periodMs = ISO_ANALYSIS.markerPeriodMs
}) {
  return onsetsMs.map((onset) => {
    const wall = originAtMs + offsetMs + onset
    const truth = Math.round(wall / periodMs) * periodMs
    return wall - truth
  })
}

/**
 * Maps each ISO file marker onto the program recording through the manifest:
 * program time = take origin + entry offset + file time - program start. The
 * nearest program marker of the same source within half a period is its pair
 * (`errorMs` = program - mapped); none is an unmatched marker.
 */
export function correlateMarkers({
  isoOnsetsMs,
  offsetMs,
  originAtMs,
  programStartedAtMs,
  programDurationMs,
  programOnsetsMs,
  periodMs = ISO_ANALYSIS.markerPeriodMs,
  edgeMs = ISO_ANALYSIS.markerLengthMs
}) {
  const pairs = []
  for (const onset of isoOnsetsMs) {
    const at = originAtMs + offsetMs + onset - programStartedAtMs
    if (at < edgeMs || at > programDurationMs - edgeMs) continue
    let best = null
    for (const candidate of programOnsetsMs)
      if (best === null || Math.abs(candidate - at) < Math.abs(best - at)) best = candidate
    pairs.push(
      best !== null && Math.abs(best - at) < periodMs / 2
        ? { mappedMs: at, programMs: best, errorMs: best - at }
        : { mappedMs: at, programMs: null, errorMs: null }
    )
  }
  return pairs
}

export const percentile = (values, p) => {
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null
}

const subjectOf = (who) => (who === 'host' ? 'host' : ISO_GUESTS[who])

/**
 * Judge acquired evidence.
 * - `decoded[entryId]`: `{ video?: { colors, onsetsMs, durationMs } }` or
 *   `{ audio?: { tones, onsetsMs, durationMs } }`, measured for every key of
 *   ISO_COLORS / ISO_TONES.
 * - `program`: the decoded mixed program recording, or null:
 *   `{ durationMs, presence: { [colorKey]: share of frames },
 *      tones: { [toneKey]: dBFS }, onsetsMs: { [colorKey|toneKey]: ms[] } }`.
 */
export function analyzeIsoEvidence({ evidence, manifest, decoded, program, config }) {
  const failures = []
  const checks = {}
  const check = (name, ok, detail) => {
    checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }
    if (!ok) failures.push(name)
  }
  const entries = manifest?.entries ?? []
  const sidsOf = (key) => evidence.published?.[key] ?? []
  const entriesOf = (source) => entries.filter((e) => sidsOf(source.key).includes(e.trackSid))

  // 1. The manifest, its take and the fixture-only qualification.
  check('manifest-parsed', evidence.manifestValid === true)
  check('not-production-qualified', manifest?.productionQualified === false)
  check(
    'qualification-injected',
    evidence.qualification?.injectedBy === 'harness-dependency' &&
      evidence.qualification?.fromEnvironment === false,
    evidence.qualification
  )
  const take = evidence.programTake ?? {}
  check(
    'program-take-shared',
    !!manifest &&
      manifest.takeId === take.takeId &&
      manifest.clock?.originAtMs === take.originAtMs &&
      evidence.routeChecks?.programRecordingId === take.programRecordingId,
    {
      manifestTake: manifest?.takeId ?? null,
      programTake: take.takeId ?? null,
      origin: [manifest?.clock?.originAtMs ?? null, take.originAtMs ?? null]
    }
  )

  // 2. Roles, generations, failure isolation and refusals.
  for (const source of ISO_SOURCES) {
    const sids = sidsOf(source.key)
    check(`${source.key}:published`, sids.length >= 1, { sids: sids.length })
    const mine = entriesOf(source)
    if (source.expect === 'recorded') {
      check(`${source.key}:generations`, mine.length === (source.replaced ? 2 : 1), {
        generations: mine.map((e) => e.generation)
      })
      check(
        `${source.key}:role`,
        mine.length > 0 &&
          mine.every((e) => e.role === source.role && e.subject === subjectOf(source.who))
      )
      check(
        `${source.key}:complete`,
        mine.length > 0 && mine.every((e) => e.state === 'complete' && e.objectKey),
        { states: mine.map((e) => e.state) }
      )
    } else if (source.expect.startsWith('failed:')) {
      check(
        `${source.key}:isolated-failure`,
        mine.length === 1 &&
          mine[0].state === 'failed' &&
          mine[0].failure === source.expect.slice('failed:'.length),
        { states: mine.map((e) => [e.state, e.failure]) }
      )
    } else {
      const reason = source.expect.slice('refused:'.length)
      check(
        `${source.key}:refused`,
        sids.length > 0 &&
          sids.every((sid) =>
            (manifest?.refused ?? []).some((r) => r.trackSid === sid && r.reason === reason)
          ) &&
          mine.length === 0
      )
    }
  }
  const microphone = entries
    .filter((e) => e.role === 'host-microphone')
    .sort((a, b) => a.generation - b.generation)
  check(
    'microphone-replacement-new-generation',
    microphone.length === 2 &&
      microphone[0].trackSid !== microphone[1].trackSid &&
      microphone[0].endReason === 'unpublished' &&
      evidence.microphoneSwitch?.via === 'desktop-device-switch',
    {
      generations: microphone.map((e) => [e.generation, e.endReason, e.overlap]),
      via: evidence.microphoneSwitch?.via ?? null
    }
  )

  // 3. Host camera: v1 never knows the frame layout.
  const camera = entries.find((e) => e.role === 'host-camera')
  const layout = camera?.frameLayout ?? null
  check(
    'host-camera:frame-layout-unknown',
    layout?.basis === 'unavailable' && layout?.layout === 'unknown',
    layout
  )
  const judgeCameraPicture =
    evidence.hostCamera?.assumption === 'opaque-desktop-fixture' &&
    (layout?.declared === null || layout?.declared === 'opaque')
  checks['host-camera:picture-judged'] = {
    ok: true,
    detail: {
      judged: judgeCameraPicture,
      assumption: evidence.hostCamera?.assumption ?? null,
      declared: layout?.declared ?? null
    }
  }

  // 4. Each file carries only its own colour / tone; aux never in a mic file.
  const clockErrors = []
  const durationSlack = (ms) =>
    Math.max(ISO_ANALYSIS.durationSlackMs, ISO_ANALYSIS.durationSlackRatio * ms)
  for (const source of ISO_SOURCES.filter((s) => s.expect === 'recorded')) {
    for (const entry of entriesOf(source)) {
      const facts = decoded?.[entry.id]
      if (!facts) {
        check(`${entry.id}:decoded`, false)
        continue
      }
      const media = source.color ? facts.video : facts.audio
      if (source.color && (source.key !== 'host-camera' || judgeCameraPicture)) {
        const own = media?.colors?.[source.color] ?? 0
        const others = Object.keys(ISO_COLORS)
          .filter((k) => k !== source.color)
          .map((k) => media?.colors?.[k] ?? 1)
        check(
          `${entry.id}:own-picture`,
          own >= ISO_ANALYSIS.minimumColorFraction &&
            others.every((f) => f <= ISO_ANALYSIS.absentColorFraction),
          { own, maxOther: Math.max(...others) }
        )
      } else if (!source.color) {
        const key = toneKeyFor(source, entry.generation)
        const own = media?.tones?.[key] ?? -200
        const others = Object.keys(ISO_TONES)
          .filter((k) => k !== key)
          .map((k) => media?.tones?.[k] ?? 0)
        check(
          `${entry.id}:own-sound`,
          own >= ISO_ANALYSIS.audibleDbfs && others.every((d) => d <= ISO_ANALYSIS.absentDbfs),
          { tone: key, own, maxOther: Math.max(...others) }
        )
      }
      const decodedMs = media?.durationMs ?? null
      check(
        `${entry.id}:duration`,
        decodedMs !== null &&
          entry.durationMs !== null &&
          Math.abs(decodedMs - entry.durationMs) <= durationSlack(entry.durationMs),
        { decodedMs, manifestMs: entry.durationMs }
      )
      if (source.publisher !== 'guest-page') continue
      const errors =
        entry.offsetMs === null
          ? []
          : markerErrors({
              onsetsMs: media?.onsetsMs ?? [],
              offsetMs: entry.offsetMs,
              originAtMs: manifest.clock.originAtMs
            })
      check(`${entry.id}:markers`, errors.length >= 1, { markers: errors.length })
      clockErrors.push(...errors.map((error) => ({ entry: entry.id, error })))
    }
  }
  check(
    'aux-never-in-microphone',
    microphone.length > 0 &&
      microphone.every(
        (e) => (decoded?.[e.id]?.audio?.tones?.['host-aux'] ?? 0) <= ISO_ANALYSIS.absentDbfs
      )
  )
  const p95 = percentile(
    clockErrors.map((e) => e.error),
    95
  )
  check('common-clock', p95 !== null && p95 <= config.clockToleranceMs, {
    p95AbsMs: p95,
    toleranceMs: config.clockToleranceMs,
    samples: clockErrors.length,
    entries: [...new Set(clockErrors.map((e) => e.entry))],
    basis: 'provider-egress-start emulated by the local recorder start; guest-page files only'
  })

  // 5. The mixed program recording of the same take.
  const programCorrelation = []
  check('program-recorded', !!program && evidence.program?.sha256, evidence.program?.file ?? null)
  if (program) {
    check(
      'program-covers-take',
      !!manifest &&
        evidence.program.startedAtWallMs <= manifest.clock.originAtMs &&
        evidence.program.endedAtWallMs >= (manifest.stoppedAtMs ?? Infinity),
      {
        programWallMs: [evidence.program.startedAtWallMs, evidence.program.endedAtWallMs],
        takeWallMs: [manifest?.clock?.originAtMs ?? null, manifest?.stoppedAtMs ?? null]
      }
    )
    for (const key of Object.keys(ISO_COLORS))
      check(
        `program-shows:${key}`,
        (program.presence?.[key] ?? 0) >= ISO_ANALYSIS.programPresentFrames,
        { framesShare: program.presence?.[key] ?? 0 }
      )
    for (const key of Object.keys(ISO_TONES))
      check(`program-plays:${key}`, (program.tones?.[key] ?? -200) >= ISO_ANALYSIS.audibleDbfs, {
        dbfs: program.tones?.[key] ?? null
      })
    for (const source of ISO_SOURCES.filter(
      (s) => s.expect === 'recorded' && s.publisher === 'guest-page'
    )) {
      for (const entry of entriesOf(source)) {
        const facts = decoded?.[entry.id]
        const media = source.color ? facts?.video : facts?.audio
        const key = source.color ?? toneKeyFor(source, entry.generation)
        const pairs =
          entry.offsetMs === null || !media
            ? []
            : correlateMarkers({
                isoOnsetsMs: media.onsetsMs ?? [],
                offsetMs: entry.offsetMs,
                originAtMs: manifest.clock.originAtMs,
                programStartedAtMs: evidence.program.startedAtWallMs,
                programDurationMs: program.durationMs,
                programOnsetsMs: program.onsetsMs?.[key] ?? []
              })
        const matched = pairs.filter((p) => p.errorMs !== null)
        check(
          `${entry.id}:in-program`,
          matched.length >= ISO_ANALYSIS.minimumProgramMatches && matched.length === pairs.length,
          { matched: matched.length, mapped: pairs.length }
        )
        programCorrelation.push(...matched.map((p) => ({ entry: entry.id, ...p })))
      }
    }
    const programP95 = percentile(
      programCorrelation.map((p) => p.errorMs),
      95
    )
    check('program-correlation', programP95 !== null && programP95 <= config.programToleranceMs, {
      p95AbsMs: programP95,
      toleranceMs: config.programToleranceMs,
      samples: programCorrelation.length,
      mapping: 'take origin + manifest offsetMs + file time - program recorder start (wall clock)'
    })
  }

  // 6. Owner route, guest consent through the real handler.
  check(
    'owner-route',
    evidence.routeChecks?.ownerStatus === 200 &&
      evidence.routeChecks?.ownerManifestMatches === true &&
      evidence.routeChecks?.strangerStatus === 404 &&
      evidence.routeChecks?.strangerFileStatus === 404,
    evidence.routeChecks
  )
  check(
    'file-route-host-camera-unknown',
    evidence.routeChecks?.hostCameraFile?.status === 200 &&
      evidence.routeChecks.hostCameraFile.frameLayout === 'unknown',
    evidence.routeChecks?.hostCameraFile ?? null
  )
  const consent = evidence.consent ?? {}
  check(
    'guest-consent-real-handler',
    ISO_CONSENTING.every(
      (who) => consent.answers?.[who]?.status === 200 && consent.answers[who].consented === true
    ) &&
      !consent.answers?.bob &&
      JSON.stringify([...(consent.stateGuests ?? [])].sort()) ===
        JSON.stringify(ISO_CONSENTING.map((who) => ISO_GUESTS[who]).sort()),
    consent
  )

  // 7. Desktop: enable and import through its own RPC, then Library.
  const desktop = evidence.desktop ?? {}
  check('desktop-iso-rpc', desktop.rpc === 'present', {
    rpc: desktop.rpc ?? null,
    error: desktop.rpcError ?? null
  })
  check('desktop-enable', desktop.enable?.via === 'desktop-rpc' && desktop.enable?.ok === true)
  const importable = entries.filter((e) => e.state === 'complete' || e.state === 'partial')
  const imported = evidence.imported ?? []
  check(
    'desktop-import',
    imported.length === importable.length &&
      imported.every(
        (item) =>
          item.via === 'desktop-rpc' &&
          item.bytes > 0 &&
          item.sha256 !== null &&
          item.sha256 === item.storageSha256
      ),
    {
      imported: imported.length,
      importable: importable.length,
      via: [...new Set(imported.map((i) => i.via))]
    }
  )
  const rows = evidence.library?.rows ?? []
  check(
    'library-rows',
    importable.length > 0 &&
      importable.every((entry) => {
        const row = rows.find((r) => r.id === isoLibraryId(manifest.takeId, entry))
        return (
          row &&
          row.mode === 'cloud-recording' &&
          row.takeId === evidence.library.takeGroup &&
          row.recordingRole === `iso:${entry.role}` &&
          row.listed === true
        )
      }),
    { rows: rows.length, takeGroup: evidence.library?.takeGroup ?? null }
  )
  const cameraRow = camera ? rows.find((r) => r.id === isoLibraryId(manifest.takeId, camera)) : null
  check(
    'library-host-camera-layout-unknown',
    cameraRow?.frameLayout === 'unknown' && cameraRow?.ordinaryPlaybackPath === null,
    cameraRow?.frameLayout ?? null
  )
  check('desktop-disable', desktop.disable?.ok === true)

  // 8. Cleanup: nothing left recording, keys revoked, owned processes gone.
  check(
    'egress-stopped',
    evidence.egress?.activeAtEnd === 0 && (evidence.egress?.started ?? 0) > 0,
    evidence.egress
  )
  check('iso-keys-revoked', evidence.isoState?.keys === 0, evidence.isoState ?? null)
  check('cleanup', evidence.cleanup?.ok === true, evidence.cleanup)
  return {
    status: failures.length ? 'failed' : 'passed',
    kind: 'local-livekit-iso-desktop',
    productionQualified: false,
    managed: 'not-run',
    providerCost: 'unmeasured',
    providerConcurrency: 'unmeasured',
    notExercised: ISO_NOT_EXERCISED,
    blockers: evidence.blockers ?? [],
    checks,
    failures,
    clockErrors,
    programCorrelation
  }
}
