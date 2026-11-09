import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateCloudTalkShowReport,
  evaluateTilePlan,
  evaluateTones,
  goertzelPower,
  latestStageTiles,
  lumaOfHex,
  packetGapStats,
  parseStageTilesLine,
  pcm16ToFloats,
  tileCentreLuma,
  tonesDbBelowLoudest
} from './cloud-talk-show-gates.mjs'

describe('cloud talk-show gates: colours and tiles', () => {
  it('turns a flat colour into the luma the encoder writes', () => {
    assert.equal(lumaOfHex('000000'), 16)
    assert.equal(lumaOfHex('#FFFFFF'), 235)
    assert.equal(lumaOfHex('40C0FF'), 154)
    assert.equal(lumaOfHex('C02020'), 85)
    assert.equal(lumaOfHex('F0F060'), 208)
    assert.throws(() => lumaOfHex('red'))
  })

  it('reads the runner’s stage tiles line with colons in identities', () => {
    const line =
      '2026-11-09T01:02:03.456789Z  INFO videorc_runner::stage: stage tiles layout="side-by-side" canvas="1280x720" tiles="host:sh_0123:person:16,106,624,351 g_abc:person:656,106,624,351 host:sh_0123:screen:0,0,10,10"'
    const parsed = parseStageTilesLine(line)
    assert.equal(parsed.layout, 'side-by-side')
    assert.deepEqual(parsed.canvas, { width: 1280, height: 720 })
    assert.equal(parsed.atMs, Date.parse('2026-11-09T01:02:03.456Z'))
    assert.deepEqual(parsed.tiles[0], {
      identity: 'host:sh_0123',
      kind: 'person',
      x: 16,
      y: 106,
      w: 624,
      h: 351
    })
    assert.equal(parsed.tiles[1].identity, 'g_abc')
    assert.equal(parsed.tiles[2].kind, 'screen')
    assert.equal(parseStageTilesLine('something else'), null)
    const log = [line, line.replace('side-by-side', 'solo').replace('01:02:03', '01:02:09')].join(
      '\n'
    )
    assert.equal(latestStageTiles(log).layout, 'solo')
    assert.equal(latestStageTiles(log, { layout: 'side-by-side' }).layout, 'side-by-side')
    assert.equal(
      latestStageTiles(log, { afterMs: Date.parse('2026-11-09T01:02:05Z') }).layout,
      'solo'
    )
  })

  it('probes each tile’s centre in a scaled frame and judges the people', () => {
    const width = 64
    const height = 36
    const y = new Uint8Array(width * height).fill(20)
    // The canvas is 1280x720; the left tile is the host, the right a guest.
    const canvas = { width: 1280, height: 720 }
    const tiles = [
      { identity: 'host:sh_1', kind: 'person', x: 0, y: 0, w: 640, h: 720 },
      { identity: 'g_a', kind: 'person', x: 640, y: 0, w: 640, h: 720 },
      { identity: 'host:sh_1', kind: 'screen', x: 0, y: 0, w: 10, h: 10 }
    ]
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        y[py * width + px] = px < 32 ? 154 : 85
      }
    }
    const frame = { y, width, height }
    assert.equal(tileCentreLuma(frame, tiles[0], canvas), 154)
    assert.equal(tileCentreLuma(frame, tiles[1], canvas), 85)
    const verdict = evaluateTilePlan({
      frame,
      canvas,
      tiles,
      expected: { 'host:sh_1': 154, g_a: 85 }
    })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.probes[2].ok, null, 'the screen tile is reported, not judged')
    const wrong = evaluateTilePlan({
      frame,
      canvas,
      tiles,
      expected: { 'host:sh_1': 85, g_a: 154 }
    })
    assert.equal(wrong.ok, false)
    assert.equal(evaluateTilePlan({ frame, canvas, tiles: [], expected: {} }).ok, false)
  })
})

describe('cloud talk-show gates: the mix', () => {
  function tone(hz, seconds = 1, rate = 48000, amplitude = 0.3) {
    const out = new Float32Array(Math.round(seconds * rate))
    for (let index = 0; index < out.length; index += 1) {
      out[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / rate)
    }
    return out
  }

  it('finds the tones that play and not the ones that do not', () => {
    const a = tone(440)
    const b = tone(659)
    const mix = new Float32Array(a.length)
    for (let index = 0; index < mix.length; index += 1) mix[index] = a[index] + b[index]
    assert.ok(goertzelPower(mix, 48000, 440) > 1000 * goertzelPower(mix, 48000, 523))
    const db = tonesDbBelowLoudest(mix, 48000, { host: 440, ada: 523, bo: 659, none: 2200 })
    assert.equal(db.host, 0)
    assert.ok(db.bo > -3)
    assert.ok(db.ada < -40)
    assert.ok(db.none < -40)
    assert.equal(evaluateTones(db, { present: ['host', 'bo'], absent: ['ada', 'none'] }).ok, true)
    const wrong = evaluateTones(db, { present: ['ada'], absent: ['bo'] })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.problems.length, 2)
    assert.equal(
      evaluateTones({}, { present: ['host'], absent: [] }).problems[0],
      'host: not measured'
    )
  })

  it('decodes 16-bit PCM and measures packet gaps', () => {
    const buffer = Buffer.alloc(6)
    buffer.writeInt16LE(0, 0)
    buffer.writeInt16LE(16384, 2)
    buffer.writeInt16LE(-32768, 4)
    assert.deepEqual([...pcm16ToFloats(buffer)], [0, 0.5, -1])
    assert.deepEqual(packetGapStats([0, 0.033, 0.066, 2.5]), { packets: 4, maxGapSeconds: 2.434 })
    assert.deepEqual(packetGapStats([]), { packets: 0, maxGapSeconds: 0 })
  })
})

describe('cloud talk-show gates: the report', () => {
  function goodReport() {
    return {
      room: { opened: true, hostJoined: true },
      guests: { letIn: 2, inRoom: 2 },
      goLive: { legsLive: true, receiversTakingBytes: true },
      layouts: [
        { layout: 'solo', tiles: { ok: true }, tones: { ok: true } },
        { layout: 'side-by-side', tiles: { ok: true }, tones: { ok: true } },
        { layout: 'spotlight', tiles: { ok: true }, tones: { ok: true } }
      ],
      hostOnAfterBringOn: { tile: true, tone: true },
      return: { guestRefused: true, guestHeardProgram: false },
      recording: { ffprobeOk: true },
      legsEnd: {
        acked: true,
        taps: [{ ok: true }, { ok: true }],
        roomStayed: true,
        liveAgain: true
      },
      hostAway: { seen: true, receiversKept: true, plateShown: true, plateLuma: 69, hostLuma: 154 },
      resume: { hostBack: true },
      moderation: { removedGuestSawIt: true },
      invite: { oldSlugInvalid: true },
      close: { showEnded: true },
      leaks: [],
      receivers: [{ name: 'receiver-1', maxGapSeconds: 0.2 }]
    }
  }

  it('passes a complete run and names every missing scenario', () => {
    assert.deepEqual(evaluateCloudTalkShowReport(goodReport()), { ok: true, problems: [] })
    const bad = goodReport()
    bad.guests.letIn = 1
    bad.hostOnAfterBringOn.tone = false
    bad.return.guestHeardProgram = true
    bad.legsEnd.taps[1].ok = false
    bad.leaks = ['a host token']
    bad.receivers[0].maxGapSeconds = 2.5
    const verdict = evaluateCloudTalkShowReport(bad)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.problems.length, 6)
    assert.ok(verdict.problems.some((problem) => problem.includes('host token')))
    assert.ok(verdict.problems.some((problem) => problem.includes('2.5 s packet gap')))
  })

  it("wants the away plate on the host's tile unless the death was skipped", () => {
    const kept = goodReport()
    kept.hostAway.plateShown = false
    kept.hostAway.plateLuma = 150
    const verdict = evaluateCloudTalkShowReport(kept)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.problems.some((problem) => problem.includes('luma 150, the camera 154')))
    const skipped = goodReport()
    skipped.hostAway = { seen: true, receiversKept: true, skipped: true }
    assert.equal(evaluateCloudTalkShowReport(skipped).ok, true)
  })

  it('accepts a recording gap the smoke recorded instead of a file', () => {
    const report = goodReport()
    report.recording = { ffprobeOk: false, gap: 'no local target' }
    assert.equal(evaluateCloudTalkShowReport(report).ok, true)
  })
})
