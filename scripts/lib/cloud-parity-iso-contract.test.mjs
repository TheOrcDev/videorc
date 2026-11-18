import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ISO_ANALYSIS,
  ISO_COLORS,
  ISO_CONSENTING,
  ISO_GUESTS,
  ISO_SOURCES,
  ISO_TONES,
  analyzeIsoEvidence,
  areaDropOnsets,
  audioGapOnsets,
  colorMatch,
  correlateMarkers,
  envelopeGapOnsets,
  isoAcquisitionConfig,
  isoLibraryId,
  markerErrors,
  toneEnvelope,
  toneKeyFor,
  videoMarkerOnsets
} from './cloud-parity-iso-contract.mjs'

const config = isoAcquisitionConfig({})
const ORIGIN = 1_800_000_001_000
const PROGRAM_START = ORIGIN - 3_000
const PROGRAM_MS = 40_000
const TAKE = 'tk_IsoFixture0001'
const PROGRAM_ID = 'rec_programFixture00000000'

test('fixture ids, tones, colours and config bounds', () => {
  for (const id of Object.values(ISO_GUESTS)) assert.match(id, /^g_[0-9A-Za-z]{22}$/)
  assert.equal(new Set(Object.values(ISO_TONES)).size, Object.keys(ISO_TONES).length)
  // The desktop's synthetic native microphone: 440 Hz, then 880 Hz after the switch.
  const mic = ISO_SOURCES.find((s) => s.key === 'host-microphone')
  assert.equal(ISO_TONES[toneKeyFor(mic, 1)], 440)
  assert.equal(ISO_TONES[toneKeyFor(mic, 2)], 880)
  assert.equal(
    ISO_TONES[
      toneKeyFor(
        ISO_SOURCES.find((s) => s.key === 'host-aux'),
        1
      )
    ],
    1000
  )
  for (const [a, ca] of Object.entries(ISO_COLORS))
    for (const [b, cb] of Object.entries(ISO_COLORS))
      if (a !== b)
        assert.ok(cb.some((v, i) => Math.abs(v - ca[i]) > 2 * ISO_ANALYSIS.colorTolerance))
  assert.equal(
    isoLibraryId(TAKE, { subject: 'host', role: 'host-camera', generation: 1 }),
    `cloud-iso-${TAKE}-host-host-camera-g1`
  )
  assert.throws(() => isoAcquisitionConfig({ VIDEORC_ISO_DURATION_MS: '1000' }))
  assert.throws(() => isoAcquisitionConfig({ VIDEORC_ISO_PROGRAM_TOLERANCE_MS: '5000' }))
  assert.throws(() => isoAcquisitionConfig({ VIDEORC_ISO_MODE: 'analyze' }))
  assert.equal(config.switchMicrophoneAtMs, config.durationMs / 2)
  // The requested ceiling covers the worst case the web admission computes.
  const { maxActiveEntries, maxMinutes, costCeilingMicros } = config.request
  assert.ok(maxActiveEntries * maxMinutes * 1_000 <= costCeilingMicros)
})

test('file marker detectors find flashes and tone gaps on the common grid', () => {
  const fps = 30
  const frames = Array.from({ length: 150 }, (_, i) =>
    i >= 60 && i < 66 ? [255, 255, 255] : [200, 40, 40]
  )
  assert.deepEqual(videoMarkerOnsets(frames, fps), [2000])
  assert.equal(colorMatch(frames, [200, 40, 40]), 144 / 150)
  const rate = 48000
  const samples = new Float32Array(rate * 3)
  for (let i = 0; i < samples.length; i++) {
    const gap = i >= rate * 1.5 && i < rate * 1.7
    samples[i] = gap ? 0 : 0.1 * Math.sin((2 * Math.PI * 440 * i) / rate)
  }
  assert.deepEqual(audioGapOnsets(samples, rate), [1500])
  samples.fill(0, rate * 0.5, rate * 0.53)
  assert.deepEqual(audioGapOnsets(samples, rate), [1500])
  assert.deepEqual(
    markerErrors({ onsetsMs: [2000, 6000], offsetMs: 1030, originAtMs: ORIGIN }),
    [30, 30]
  )
})

test('program detectors separate one tone gap and one tile flash inside a mix', () => {
  const rate = 48000
  const mix = new Float32Array(rate * 3)
  for (let i = 0; i < mix.length; i++) {
    const t = i / rate
    const gap = t >= 1.2 && t < 1.4
    mix[i] =
      0.1 * Math.sin(2 * Math.PI * 1000 * t) +
      (gap ? 0 : 0.1 * Math.sin(2 * Math.PI * 1320 * t)) +
      0.1 * Math.sin(2 * Math.PI * 880 * t)
  }
  const gapped = envelopeGapOnsets(toneEnvelope(mix, rate, 1320))
  assert.equal(gapped.length, 1)
  assert.ok(Math.abs(gapped[0] - 1200) <= 30, `onset ${gapped[0]}`)
  // A neighbouring tone 120 Hz away keeps playing: no marker there.
  assert.deepEqual(envelopeGapOnsets(toneEnvelope(mix, rate, 1000)), [])
  assert.deepEqual(envelopeGapOnsets(toneEnvelope(mix, rate, 880)), [])
  const area = Array.from({ length: 90 }, (_, i) => (i >= 45 && i < 51 ? 0 : 0.12))
  assert.deepEqual(areaDropOnsets(area, 30), [1500])
  // A source mostly off screen yields no markers rather than false ones.
  assert.deepEqual(areaDropOnsets(new Array(90).fill(0), 30), [])
})

test('ISO markers map onto the program through take origin and manifest offset', () => {
  const pairs = correlateMarkers({
    isoOnsetsMs: [2_960, 6_960],
    offsetMs: 1_000,
    originAtMs: ORIGIN,
    programStartedAtMs: PROGRAM_START,
    programDurationMs: PROGRAM_MS,
    programOnsetsMs: [6_990, 11_050]
  })
  assert.deepEqual(
    pairs.map((p) => p.errorMs),
    [30, 90]
  )
  const lost = correlateMarkers({
    isoOnsetsMs: [2_960],
    offsetMs: 1_000,
    originAtMs: ORIGIN,
    programStartedAtMs: PROGRAM_START,
    programDurationMs: PROGRAM_MS,
    programOnsetsMs: []
  })
  assert.deepEqual(lost, [{ mappedMs: 6_960, programMs: null, errorMs: null }])
})

/** Builds evidence for a perfect run, then lets each test break one thing. */
function perfect() {
  const published = {}
  const entries = []
  const refused = []
  const decoded = {}
  const subjectOf = (who) => (who === 'host' ? 'host' : ISO_GUESTS[who])
  const programOnsets = {}
  const gridIn = (fromWall, toWall) => {
    const out = []
    for (let w = Math.ceil(fromWall / 4000) * 4000; w <= toWall; w += 4000) out.push(w)
    return out
  }
  for (const source of ISO_SOURCES) {
    const sids = (source.replaced ? [1, 2] : [1]).map((n) =>
      `TR_${source.key}${n}`.replace(/-/g, '')
    )
    published[source.key] = sids
    if (source.expect.startsWith('refused:')) {
      for (const sid of sids) refused.push({ trackSid: sid, reason: source.expect.slice(8) })
      continue
    }
    sids.forEach((trackSid, i) => {
      const generation = i + 1
      const subject = subjectOf(source.who)
      const id = `${subject}/${source.role}/g${generation}`
      const failed = source.expect.startsWith('failed:')
      const offsetMs = 1000 + i * 9000
      entries.push({
        id,
        role: source.role,
        subject,
        generation,
        kind: source.color ? 'video' : 'audio',
        trackSid,
        state: failed ? 'failed' : 'complete',
        failure: failed ? 'start-failed' : null,
        objectKey: failed ? null : `talk/x/${id}.webm`,
        offsetMs: failed ? null : offsetMs,
        durationMs: failed ? null : 8000,
        overlap: false,
        frameLayout: !source.color
          ? null
          : source.role === 'host-camera'
            ? { basis: 'unavailable', layout: 'unknown', declared: 'opaque' }
            : { basis: 'role-opaque', layout: 'opaque', declared: null },
        endReason: source.replaced && i === 0 ? 'unpublished' : 'take-ended'
      })
      if (failed) return
      const fileStart = ORIGIN + offsetMs
      const onsetsMs =
        source.publisher === 'guest-page'
          ? gridIn(fileStart, fileStart + 8000).map((w) => w - fileStart + 40)
          : []
      const tone = toneKeyFor(source, generation)
      decoded[id] = source.color
        ? {
            video: {
              colors: Object.fromEntries(
                Object.keys(ISO_COLORS).map((k) => [k, k === source.color ? 0.9 : 0])
              ),
              onsetsMs,
              durationMs: 8100
            }
          }
        : {
            audio: {
              tones: Object.fromEntries(
                Object.keys(ISO_TONES).map((k) => [k, k === tone ? -20 : -90])
              ),
              onsetsMs,
              durationMs: 8100
            }
          }
    })
  }
  for (const key of [...Object.keys(ISO_COLORS), ...Object.keys(ISO_TONES)])
    programOnsets[key] = gridIn(PROGRAM_START, PROGRAM_START + PROGRAM_MS).map(
      (w) => w - PROGRAM_START + 60
    )
  const manifest = {
    takeId: TAKE,
    productionQualified: false,
    clock: { originAtMs: ORIGIN },
    stoppedAtMs: ORIGIN + 24_000,
    entries,
    refused
  }
  const importable = entries.filter((e) => e.state === 'complete')
  return {
    evidence: {
      manifestValid: true,
      qualification: { injectedBy: 'harness-dependency', fromEnvironment: false },
      programTake: { takeId: TAKE, originAtMs: ORIGIN, programRecordingId: PROGRAM_ID },
      program: {
        file: 'program.webm',
        sha256: 'a'.repeat(64),
        startedAtWallMs: PROGRAM_START,
        endedAtWallMs: PROGRAM_START + PROGRAM_MS
      },
      published,
      microphoneSwitch: { via: 'desktop-device-switch' },
      hostCamera: { assumption: 'opaque-desktop-fixture' },
      routeChecks: {
        ownerStatus: 200,
        ownerManifestMatches: true,
        programRecordingId: PROGRAM_ID,
        strangerStatus: 404,
        strangerFileStatus: 404,
        hostCameraFile: { status: 200, frameLayout: 'unknown' }
      },
      consent: {
        answers: Object.fromEntries(
          ISO_CONSENTING.map((who) => [who, { status: 200, consented: true }])
        ),
        stateGuests: ISO_CONSENTING.map((who) => ISO_GUESTS[who])
      },
      desktop: {
        rpc: 'present',
        enable: { via: 'desktop-rpc', ok: true },
        disable: { via: 'desktop-rpc', ok: true }
      },
      imported: importable.map((e) => ({
        entryId: e.id,
        via: 'desktop-rpc',
        bytes: 10,
        sha256: 'b'.repeat(64),
        storageSha256: 'b'.repeat(64)
      })),
      library: {
        takeGroup: PROGRAM_ID,
        rows: importable.map((e) => ({
          id: isoLibraryId(TAKE, e),
          mode: 'cloud-recording',
          takeId: PROGRAM_ID,
          recordingRole: `iso:${e.role}`,
          frameLayout: e.role === 'host-camera' ? 'unknown' : 'opaque',
          ordinaryPlaybackPath: e.role === 'host-camera' ? null : 'fixture.webm',
          listed: true
        }))
      },
      egress: { started: importable.length + 1, activeAtEnd: 0 },
      isoState: { keys: 0 },
      cleanup: { ok: true }
    },
    manifest,
    decoded,
    program: {
      durationMs: PROGRAM_MS,
      presence: Object.fromEntries(Object.keys(ISO_COLORS).map((k) => [k, 0.95])),
      tones: Object.fromEntries(Object.keys(ISO_TONES).map((k) => [k, -24])),
      onsetsMs: programOnsets
    },
    config
  }
}

test('a run with every source, the program take and the desktop import passes', () => {
  const result = analyzeIsoEvidence(perfect())
  assert.deepEqual(result.failures, [])
  assert.equal(result.status, 'passed')
  assert.equal(result.productionQualified, false)
  assert.equal(result.checks['common-clock'].detail.p95AbsMs, 40)
  assert.equal(result.checks['program-correlation'].detail.p95AbsMs, 20)
  assert.deepEqual(result.checks['common-clock'].detail.entries.sort(), [
    `${ISO_GUESTS.ann}/guest-camera/g1`,
    `${ISO_GUESTS.ann}/guest-microphone/g1`,
    `${ISO_GUESTS.cid}/guest-microphone/g1`
  ])
  assert.ok(result.notExercised.some((n) => n.check === 'unnamed-host-screen-audio-refused'))
})

test('aux leaking into a mic file, swapped colours or a merged generation fail', () => {
  const leak = perfect()
  leak.decoded['host/host-microphone/g1'].audio.tones['host-aux'] = -30
  const leaked = analyzeIsoEvidence(leak).failures
  assert.ok(leaked.includes('host/host-microphone/g1:own-sound'))
  assert.ok(leaked.includes('aux-never-in-microphone'))

  const wrongGeneration = perfect()
  const g2 = wrongGeneration.decoded['host/host-microphone/g2'].audio.tones
  ;[g2['host-microphone:g1'], g2['host-microphone:g2']] = [-20, -90]
  assert.ok(
    analyzeIsoEvidence(wrongGeneration).failures.includes('host/host-microphone/g2:own-sound')
  )

  const swapped = perfect()
  const ann = swapped.decoded[`${ISO_GUESTS.ann}/guest-camera/g1`].video.colors
  ;[ann['ann-camera'], ann['bob-camera']] = [0, 0.9]
  assert.ok(
    analyzeIsoEvidence(swapped).failures.includes(`${ISO_GUESTS.ann}/guest-camera/g1:own-picture`)
  )

  const merged = perfect()
  merged.manifest.entries = merged.manifest.entries.filter(
    (e) => e.id !== 'host/host-microphone/g2'
  )
  const failures = analyzeIsoEvidence(merged).failures
  assert.ok(failures.includes('host-microphone:generations'))
  assert.ok(failures.includes('microphone-replacement-new-generation'))

  const fixtureSwitch = perfect()
  fixtureSwitch.evidence.microphoneSwitch.via = 'fixture-publisher'
  assert.ok(
    analyzeIsoEvidence(fixtureSwitch).failures.includes('microphone-replacement-new-generation')
  )
})

test('the host camera is never a normal picture unless the opaque fixture is declared', () => {
  const opaque = perfect()
  opaque.manifest.entries.find((e) => e.role === 'host-camera').frameLayout = {
    basis: 'role-opaque',
    layout: 'opaque',
    declared: null
  }
  assert.ok(analyzeIsoEvidence(opaque).failures.includes('host-camera:frame-layout-unknown'))

  const packed = perfect()
  packed.manifest.entries.find((e) => e.role === 'host-camera').frameLayout.declared =
    'rgb-left-alpha-right:g8'
  packed.decoded['host/host-camera/g1'].video.colors['host-camera'] = 0
  const result = analyzeIsoEvidence(packed)
  assert.equal(result.checks['host-camera:picture-judged'].detail.judged, false)
  assert.ok(!result.failures.includes('host/host-camera/g1:own-picture'))

  const unflagged = perfect()
  unflagged.evidence.library.rows.find((r) => r.recordingRole === 'iso:host-camera').frameLayout =
    'opaque'
  assert.ok(analyzeIsoEvidence(unflagged).failures.includes('library-host-camera-layout-unknown'))
})

test('refusals, failure isolation, clock drift and cleanup are each required', () => {
  const recorded = perfect()
  recorded.manifest.refused = recorded.manifest.refused.filter(
    (r) => r.trackSid !== recorded.evidence.published['bob-camera'][0]
  )
  assert.ok(analyzeIsoEvidence(recorded).failures.includes('bob-camera:refused'))

  const cascade = perfect()
  for (const e of cascade.manifest.entries) if (e.subject === ISO_GUESTS.cid) e.state = 'failed'
  assert.ok(analyzeIsoEvidence(cascade).failures.includes('cid-microphone:complete'))

  const drift = perfect()
  for (const facts of Object.values(drift.decoded)) {
    const onsets = (facts.video ?? facts.audio).onsetsMs
    for (let i = 0; i < onsets.length; i++) onsets[i] += 900
  }
  const drifted = analyzeIsoEvidence(drift).failures
  assert.ok(drifted.includes('common-clock'))
  assert.ok(drifted.includes('program-correlation'))

  const leak = perfect()
  leak.evidence.cleanup = { ok: false, leaked: ['recorder'] }
  leak.evidence.isoState.keys = 1
  leak.evidence.egress.activeAtEnd = 1
  const leaked = analyzeIsoEvidence(leak).failures
  for (const name of ['cleanup', 'iso-keys-revoked', 'egress-stopped'])
    assert.ok(leaked.includes(name))
})

test('the program take must be shared, cover the take and contain every source', () => {
  const otherTake = perfect()
  otherTake.evidence.programTake.takeId = 'tk_OtherTake00001'
  assert.ok(analyzeIsoEvidence(otherTake).failures.includes('program-take-shared'))

  const late = perfect()
  late.evidence.program.startedAtWallMs = ORIGIN + 500
  assert.ok(analyzeIsoEvidence(late).failures.includes('program-covers-take'))

  const missing = perfect()
  missing.program.presence['bob-camera'] = 0
  missing.program.tones['host-aux'] = -90
  const failures = analyzeIsoEvidence(missing).failures
  assert.ok(failures.includes('program-shows:bob-camera'))
  assert.ok(failures.includes('program-plays:host-aux'))

  const unmatched = perfect()
  unmatched.program.onsetsMs['cid-microphone'] = []
  assert.ok(
    analyzeIsoEvidence(unmatched).failures.includes(
      `${ISO_GUESTS.cid}/guest-microphone/g1:in-program`
    )
  )

  const none = perfect()
  none.program = null
  none.evidence.program = null
  assert.ok(analyzeIsoEvidence(none).failures.includes('program-recorded'))
})

test('without the desktop ISO RPC the run fails on every desktop check, and only there', () => {
  const fallback = perfect()
  fallback.evidence.desktop = {
    rpc: 'missing',
    rpcError: 'Unknown backend method: cloud.iso.status',
    enable: { via: 'harness-http-fallback', ok: false, httpOk: true },
    disable: { via: 'harness-http-fallback', ok: false, httpOk: true }
  }
  for (const item of fallback.evidence.imported) item.via = 'harness-http-fallback'
  fallback.evidence.library = { takeGroup: PROGRAM_ID, rows: [] }
  const result = analyzeIsoEvidence(fallback)
  assert.deepEqual(result.failures.sort(), [
    'desktop-disable',
    'desktop-enable',
    'desktop-import',
    'desktop-iso-rpc',
    'library-host-camera-layout-unknown',
    'library-rows'
  ])

  const mismatch = perfect()
  mismatch.evidence.imported[0].sha256 = 'c'.repeat(64)
  assert.ok(analyzeIsoEvidence(mismatch).failures.includes('desktop-import'))

  const group = perfect()
  group.evidence.library.rows[0].takeId = 'cloud-iso-elsewhere'
  assert.ok(analyzeIsoEvidence(group).failures.includes('library-rows'))
})

test('consent counts only through the real handler, and only for who allowed', () => {
  const extra = perfect()
  extra.evidence.consent.answers.bob = { status: 200, consented: true }
  extra.evidence.consent.stateGuests.push(ISO_GUESTS.bob)
  assert.ok(analyzeIsoEvidence(extra).failures.includes('guest-consent-real-handler'))

  const refusedAnswer = perfect()
  refusedAnswer.evidence.consent.answers.ann = { status: 403, consented: null }
  assert.ok(analyzeIsoEvidence(refusedAnswer).failures.includes('guest-consent-real-handler'))

  const envQualified = perfect()
  envQualified.evidence.qualification.fromEnvironment = true
  assert.ok(analyzeIsoEvidence(envQualified).failures.includes('qualification-injected'))
})
