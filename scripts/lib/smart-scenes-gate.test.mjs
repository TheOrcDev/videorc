// Unit tests for the smoke:smart-scenes gates (plan 210 S11).
//
// Run: node --test scripts/lib/smart-scenes-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SHARP_HIDDEN_MAX,
  SHARP_LIVE_MIN,
  SMART_SCENES_BUDGET,
  followBudgetMs,
  followGate,
  frostFeaturesFromRawFrames,
  CONTENT_CLOCK,
  CONTENT_CLOCK_PERIOD_MS,
  HIDE_CONTENT_BUDGET,
  decodeContentClock,
  frostRunVerdict,
  hiddenContentVerdict,
  hideSpanVerdict,
  newScenesGate,
  passwordManagerGate,
  outOfSightGate,
  outOfSightRefusalCopyOk,
  relaunchGate,
  sharpFraction,
  smartScenesVerdict,
  switchGate
} from './smart-scenes-gate.mjs'

const WIDTH = 32
const HEIGHT = 18
const RED = [217, 26, 26]
const WHITE = [255, 255, 255]

/**
 * A fixture-like frame: red, with a white block whose left edge sits at
 * `blockX` (sharp) or, when `blurred`, ramps over four columns. `tick`
 * nudges one motion-strip pixel so the frame never repeats.
 */
function fixtureFrame({ blockX = 10, blurred = false, tick = 0, white = false } = {}) {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3
      let color = white ? WHITE : RED
      if (!white && y >= HEIGHT - 3 && x >= blockX && x < blockX + 4) color = WHITE
      if (!white && blurred && y >= HEIGHT - 3 && x >= blockX - 4 && x < blockX) {
        const t = (x - (blockX - 4) + 1) / 5
        color = RED.map((channel, index) => Math.round(channel + (WHITE[index] - channel) * t))
      }
      frame[offset] = color[0]
      frame[offset + 1] = color[1]
      frame[offset + 2] = color[2]
    }
  }
  if (!white && !blurred) {
    // Motion: one strip pixel toggles per tick.
    const offset = ((HEIGHT - 1) * WIDTH + (tick % 8)) * 3
    frame[offset + 1] = 120
  }
  return frame
}

/** Frames at 30 fps from a wall-clock script: [{fromMs, toMs, kind}]. */
function timeline(segments) {
  const frames = []
  const ptsMs = []
  let tick = 0
  for (const segment of segments) {
    for (let t = segment.fromMs; t < segment.toMs; t += 33.3) {
      ptsMs.push(t)
      frames.push(
        segment.kind === 'white'
          ? fixtureFrame({ white: true })
          : segment.kind === 'frosted'
            ? fixtureFrame({ blurred: true })
            : fixtureFrame({ tick: tick++ })
      )
    }
  }
  return { buffer: Buffer.concat(frames), ptsMs }
}

describe('sharpFraction', () => {
  it('sees hard edges in a live fixture frame and almost none in a frosted one', () => {
    const live = sharpFraction(fixtureFrame(), WIDTH, HEIGHT)
    const frosted = sharpFraction(fixtureFrame({ blurred: true }), WIDTH, HEIGHT)
    assert.ok(live >= SHARP_LIVE_MIN, `live ${live}`)
    // The block's right edge and top stay hard in this toy frame; the test
    // asserts the direction, the smoke's thresholds hold on the real frost.
    assert.ok(frosted < live, `frosted ${frosted} < live ${live}`)
  })
  it('is zero on a flat frame', () => {
    assert.equal(sharpFraction(fixtureFrame({ white: true }), WIDTH, HEIGHT), 0)
  })
})

describe('frostFeaturesFromRawFrames', () => {
  it('adds sharp to every frame feature', () => {
    const { buffer } = timeline([{ fromMs: 0, toMs: 90, kind: 'live' }])
    const features = frostFeaturesFromRawFrames(buffer, { width: WIDTH, height: HEIGHT })
    assert.equal(features.length, 3)
    for (const feature of features) {
      assert.equal(typeof feature.sharp, 'number')
      assert.equal(feature.centre, 'red')
    }
  })
})

describe('content clock (plan 210 D8)', () => {
  const W = 320
  const H = 180
  /** The fixture's strip, cell for cell (fixture-window.swift `contentClockCells`). */
  function cells(epochMs) {
    const value = Math.floor(epochMs / CONTENT_CLOCK.stepMs) % 2 ** CONTENT_CLOCK.dataBits
    const out = [true, false]
    let ones = 0
    for (let bit = CONTENT_CLOCK.dataBits - 1; bit >= 0; bit -= 1) {
      const on = ((value >> bit) & 1) === 1
      if (on) ones += 1
      out.push(on)
    }
    out.push(ones % 2 === 1)
    return out
  }
  function clockFrame(epochMs, { strip = cells(epochMs), blur = false } = {}) {
    const frame = Buffer.alloc(W * H * 3)
    for (let index = 0; index < W * H; index += 1) {
      frame[index * 3] = RED[0]
      frame[index * 3 + 1] = RED[1]
      frame[index * 3 + 2] = RED[2]
    }
    const x0 = CONTENT_CLOCK.x0 * W
    const cellWidth = ((CONTENT_CLOCK.x1 - CONTENT_CLOCK.x0) * W) / CONTENT_CLOCK.cells
    for (let y = Math.round(CONTENT_CLOCK.y0 * H); y < Math.round(CONTENT_CLOCK.y1 * H); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(CONTENT_CLOCK.x1 * W); x += 1) {
        const cell = Math.min(CONTENT_CLOCK.cells - 1, Math.floor((x + 0.5 - x0) / cellWidth))
        const value = strip[cell] ? 255 : 0
        frame.fill(value, (y * W + x) * 3, (y * W + x) * 3 + 3)
      }
    }
    if (!blur) return frame
    // A 3x3 box blur stands in for the encoder and the scaler.
    const out = Buffer.from(frame)
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          let sum = 0
          for (let dy = -1; dy <= 1; dy += 1)
            for (let dx = -1; dx <= 1; dx += 1) sum += frame[((y + dy) * W + x + dx) * 3 + c]
          out[(y * W + x) * 3 + c] = Math.round(sum / 9)
        }
      }
    }
    return out
  }

  it('reads back the draw time the fixture wrote, through a blur', () => {
    for (const epochMs of [1_795_365_580_047, 1_795_365_584_050, 1_795_365_600_000]) {
      const expected =
        Math.floor(epochMs / CONTENT_CLOCK.stepMs) * CONTENT_CLOCK.stepMs -
        Math.floor(epochMs / CONTENT_CLOCK_PERIOD_MS) * CONTENT_CLOCK_PERIOD_MS
      assert.equal(decodeContentClock(clockFrame(epochMs), W, H), expected)
      assert.equal(decodeContentClock(clockFrame(epochMs, { blur: true }), W, H), expected)
    }
  })

  it('reads nothing from a frame without the strip, or with a bad parity bit', () => {
    const flat = clockFrame(0, { strip: Array(CONTENT_CLOCK.cells).fill(false) })
    assert.equal(decodeContentClock(flat, W, H), null)
    const strip = cells(1_795_365_580_047)
    strip[CONTENT_CLOCK.cells - 1] = !strip[CONTENT_CLOCK.cells - 1]
    assert.equal(decodeContentClock(clockFrame(0, { strip }), W, H), null)
    const frosted = Buffer.alloc(W * H * 3, 60)
    assert.equal(decodeContentClock(frosted, W, H), null)
  })

  it('features carry the clock for each frame', () => {
    const buffer = Buffer.concat([clockFrame(1_795_365_580_047), clockFrame(1_795_365_580_080)])
    const features = frostFeaturesFromRawFrames(buffer, { width: W, height: H })
    assert.equal(features.length, 2)
    assert.ok(features.every((feature) => typeof feature.contentMs === 'number'))
    // Drawn 33 ms apart, read in 8 ms steps.
    const step = features[1].contentMs - features[0].contentMs
    assert.ok(step >= 32 && step <= 40, `step ${step}`)
  })
})

describe('hiddenContentVerdict', () => {
  const hideGateAtMs = 1_795_365_580_050
  const showAtMs = hideGateAtMs + 4000
  const wrap = (epochMs) =>
    (Math.floor(epochMs / CONTENT_CLOCK.stepMs) * CONTENT_CLOCK.stepMs) % CONTENT_CLOCK_PERIOD_MS
  /** One output frame per entry: a drawn time (live) or null (the frost). */
  function features(drawnTimes) {
    return {
      features: drawnTimes.map((drawnAtMs, index) => ({
        index,
        centre: 'red',
        sharp: drawnAtMs == null ? 0 : 0.0013,
        contentMs: drawnAtMs == null ? null : wrap(drawnAtMs)
      })),
      ptsMs: drawnTimes.map((_, index) => index * 33.3)
    }
  }
  const live = (fromMs, toMs, stepMs = 100) => {
    const out = []
    for (let t = fromMs; t < toMs; t += stepMs) out.push(t, t, t)
    return out
  }
  const frost = (count) => Array(count).fill(null)

  it('passes when the frost covers every picture of the hidden span', () => {
    const input = features([
      ...live(hideGateAtMs - 2000, hideGateAtMs - 30),
      ...frost(120),
      ...live(showAtMs + 20, showAtMs + 2000)
    ])
    const verdict = hiddenContentVerdict({ ...input, hideGateAtMs, showAtMs })
    assert.deepEqual(verdict.failures, [])
    // Read in 8 ms steps.
    assert.ok(verdict.lastBeforeHideMs >= 30, `before ${verdict.lastBeforeHideMs}`)
    assert.ok(verdict.firstAfterShowMs >= 12, `after ${verdict.firstAfterShowMs}`)
  })

  it('names the picture held while hidden and published at the show (the S3 leak)', () => {
    // The capture's last frame before the show was taken 70 ms before it;
    // the show published it, then the first frame taken after the show.
    const input = features([
      ...live(hideGateAtMs - 2000, hideGateAtMs - 30),
      ...frost(120),
      showAtMs - 70,
      showAtMs - 70,
      showAtMs - 70,
      ...live(showAtMs + 30, showAtMs + 2000)
    ])
    const verdict = hiddenContentVerdict({ ...input, hideGateAtMs, showAtMs })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.leaks.length, 3)
    const { drawnBeforeShowMs } = verdict.leaks[0]
    assert.ok(drawnBeforeShowMs >= 70 && drawnBeforeShowMs < 78, `${drawnBeforeShowMs}`)
    assert.match(verdict.failures.join('; '), /show the screen while it was hidden/)
  })

  it('names a picture drawn after the gate closed at the hide edge', () => {
    const input = features([
      ...live(hideGateAtMs - 2000, hideGateAtMs - 30),
      hideGateAtMs + 40,
      ...frost(120),
      ...live(showAtMs + 20, showAtMs + 2000)
    ])
    const verdict = hiddenContentVerdict({ ...input, hideGateAtMs, showAtMs })
    assert.equal(verdict.leaks.length, 1)
    const { drawnAfterHideMs } = verdict.leaks[0]
    assert.ok(drawnAfterHideMs > 32 && drawnAfterHideMs <= 40, `${drawnAfterHideMs}`)
  })

  it('lets a picture drawn within one refresh of the show through', () => {
    const input = features([
      ...live(hideGateAtMs - 2000, hideGateAtMs - 30),
      ...frost(120),
      showAtMs - HIDE_CONTENT_BUDGET.showDisplaySlackMs + 9,
      ...live(showAtMs + 20, showAtMs + 2000)
    ])
    assert.deepEqual(hiddenContentVerdict({ ...input, hideGateAtMs, showAtMs }).failures, [])
  })

  it('refuses to judge blind, and names an old picture coming back', () => {
    const blind = features([...live(hideGateAtMs - 2000, hideGateAtMs - 30), ...frost(120)])
    for (const feature of blind.features) feature.contentMs = null
    assert.match(
      hiddenContentVerdict({ ...blind, hideGateAtMs, showAtMs }).failures.join('; '),
      /readable on only 0\/60 live frames/
    )
    const stale = features([
      ...live(hideGateAtMs - 2000, hideGateAtMs - 30),
      ...frost(120),
      ...live(showAtMs + 20, showAtMs + 600),
      hideGateAtMs - 500,
      ...live(showAtMs + 700, showAtMs + 2000)
    ])
    assert.match(
      hiddenContentVerdict({ ...stale, hideGateAtMs, showAtMs }).failures.join('; '),
      /ran backwards 1 time/
    )
  })
})

describe('frostRunVerdict', () => {
  const hideAtMs = 3000
  const showAtMs = 7000
  /** [{fromMs, toMs, kind}] in the file's own timeline (pts), 30 fps. */
  function run(segments) {
    const features = []
    const ptsMs = []
    let tick = 0
    for (const segment of segments) {
      for (let t = segment.fromMs; t < segment.toMs; t += 33.3) {
        ptsMs.push(t)
        const frosted = segment.kind === 'frosted'
        features.push({
          index: features.length,
          centre: segment.kind === 'white' ? 'white' : 'red',
          sharp: frosted ? 0 : 0.0013,
          repeated: frosted ? features.length > 0 : tick++ % 3 !== 0
        })
      }
    }
    return { features, ptsMs }
  }

  it('judges the frost in the file timeline when the flash anchor is 400 ms early (S3)', () => {
    // The file shows the frost from pts 3030 to 7030; the anchor puts every
    // frame 400 ms early on the wall clock, so the frost "starts" before the
    // press. hideSpanVerdict reads that as live frames before the show.
    const input = run([
      { fromMs: 0, toMs: 3030, kind: 'live' },
      { fromMs: 3030, toMs: 7030, kind: 'frosted' },
      { fromMs: 7030, toMs: 10_000, kind: 'live' }
    ])
    const old = hideSpanVerdict({ ...input, offsetMs: -400, hideAtMs, showAtMs })
    assert.equal(old.ok, false, 'the wall-clock judge misreads the shifted file')
    const verdict = frostRunVerdict({ ...input, offsetMs: -400, hideAtMs, showAtMs })
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.hidden.leaks.length, 0)
    assert.ok(verdict.frost.durationMs >= 3990 && verdict.frost.durationMs <= 4040)
  })

  it('names a live frame inside the frost, wherever the anchor puts it', () => {
    const input = run([
      { fromMs: 0, toMs: 3030, kind: 'live' },
      { fromMs: 3030, toMs: 5000, kind: 'frosted' },
      { fromMs: 5000, toMs: 5020, kind: 'live' },
      { fromMs: 5020, toMs: 7030, kind: 'frosted' },
      { fromMs: 7030, toMs: 10_000, kind: 'live' }
    ])
    const verdict = frostRunVerdict({ ...input, offsetMs: 0, hideAtMs, showAtMs })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.hidden.leaks.length, 1)
    assert.match(verdict.failures.join('; '), /1 live frame\(s\) inside the frost/)
  })

  it('names a frost much shorter than the press span', () => {
    const input = run([
      { fromMs: 0, toMs: 3800, kind: 'live' },
      { fromMs: 3800, toMs: 6200, kind: 'frosted' },
      { fromMs: 6200, toMs: 10_000, kind: 'live' }
    ])
    assert.match(
      frostRunVerdict({ ...input, offsetMs: 0, hideAtMs, showAtMs }).failures.join('; '),
      /the frost lasts \d+ ms in the file, the screen was hidden for 4000 ms/
    )
  })

  it('names a file with no frost at all', () => {
    const input = run([{ fromMs: 0, toMs: 10_000, kind: 'live' }])
    assert.match(
      frostRunVerdict({ ...input, offsetMs: 0, hideAtMs, showAtMs }).failures.join('; '),
      /no frosted frame/
    )
  })
})

describe('hideSpanVerdict', () => {
  const hideAtMs = 3000
  const showAtMs = 7000
  // Frames that are flat red (no block at all) stand in for the frost here:
  // sharp is exactly zero and they repeat, like the real still.
  const flat = () => fixtureFrame({ blockX: WIDTH + 10 })
  function frames(script) {
    const list = []
    const ptsMs = []
    let tick = 0
    for (const segment of script) {
      for (let t = segment.fromMs; t < segment.toMs; t += 33.3) {
        ptsMs.push(t)
        list.push(segment.kind === 'frosted' ? flat() : fixtureFrame({ tick: tick++ }))
      }
    }
    return {
      features: frostFeaturesFromRawFrames(Buffer.concat(list), { width: WIDTH, height: HEIGHT }),
      ptsMs
    }
  }

  it('passes a clean hide: live, frosted and still, live again', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 150, kind: 'live' },
      { fromMs: hideAtMs + 150, toMs: showAtMs + 200, kind: 'frosted' },
      { fromMs: showAtMs + 200, toMs: 10_000, kind: 'live' }
    ])
    const verdict = hideSpanVerdict({ features, ptsMs, offsetMs: 0, hideAtMs, showAtMs })
    assert.deepEqual(verdict.failures, [])
    assert.ok(verdict.ok)
    assert.ok(
      verdict.hideLatencyMs >= 150 && verdict.hideLatencyMs < 250,
      `hide ${verdict.hideLatencyMs}`
    )
    assert.ok(
      verdict.showLatencyMs >= 200 && verdict.showLatencyMs < 300,
      `show ${verdict.showLatencyMs}`
    )
    assert.equal(verdict.hidden.leaks.length, 0)
    assert.ok(verdict.hidden.frames > 60)
  })

  it('does not count the first live frame landing one frame before Show as a leak', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 150, kind: 'live' },
      { fromMs: hideAtMs + 150, toMs: showAtMs - 40, kind: 'frosted' },
      { fromMs: showAtMs - 40, toMs: 10_000, kind: 'live' }
    ])
    const verdict = hideSpanVerdict({ features, ptsMs, offsetMs: 0, hideAtMs, showAtMs })
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.hidden.leaks.length, 0)
  })

  it('leaves the white alignment flash out of the live share after Show (issue #1329)', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 150, kind: 'live' },
      { fromMs: hideAtMs + 150, toMs: showAtMs + 200, kind: 'frosted' },
      { fromMs: showAtMs + 200, toMs: 10_000, kind: 'live' }
    ])
    // A clip cut soon after the end flash: half of its live-after frames
    // are the flash (white, no edges).
    const flashed = features.map((feature) =>
      ptsMs[feature.index] >= 8500 ? { ...feature, sharp: 0, centre: 'white' } : feature
    )
    const verdict = hideSpanVerdict({
      features: flashed,
      ptsMs,
      offsetMs: 0,
      hideAtMs,
      showAtMs
    })
    assert.deepEqual(verdict.failures, [])
    assert.equal(verdict.liveAfter.sharpFrames, verdict.liveAfter.frames)
    // A dark, edgeless picture after Show still fails: only the flash is spared.
    const dull = features.map((feature) =>
      ptsMs[feature.index] >= 8500 ? { ...feature, sharp: 0 } : feature
    )
    assert.match(
      hideSpanVerdict({ features: dull, ptsMs, offsetMs: 0, hideAtMs, showAtMs }).failures.join(
        '; '
      ),
      /frames after Show are live-sharp/
    )
  })

  it('fails a live frame leaking inside the hidden span and names it', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 150, kind: 'live' },
      { fromMs: hideAtMs + 150, toMs: 5000, kind: 'frosted' },
      { fromMs: 5000, toMs: 5040, kind: 'live' },
      { fromMs: 5040, toMs: showAtMs + 200, kind: 'frosted' },
      { fromMs: showAtMs + 200, toMs: 10_000, kind: 'live' }
    ])
    const verdict = hideSpanVerdict({ features, ptsMs, offsetMs: 0, hideAtMs, showAtMs })
    assert.ok(!verdict.ok)
    assert.equal(verdict.hidden.leaks.length, 2)
    assert.match(verdict.failures.join('; '), /2 live frame\(s\) inside the hidden span/)
    assert.match(verdict.failures.join('; '), /the hidden picture moved/)
  })

  it('fails when the picture never comes back after Show', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 150, kind: 'live' },
      { fromMs: hideAtMs + 150, toMs: 10_000, kind: 'frosted' }
    ])
    const verdict = hideSpanVerdict({ features, ptsMs, offsetMs: 0, hideAtMs, showAtMs })
    assert.ok(!verdict.ok)
    assert.match(verdict.failures.join('; '), /after Show are live-sharp/)
    assert.match(verdict.failures.join('; '), /no live frame after Show/)
  })

  it('fails a frost that lands too late', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: hideAtMs + 1200, kind: 'live' },
      { fromMs: hideAtMs + 1200, toMs: showAtMs + 200, kind: 'frosted' },
      { fromMs: showAtMs + 200, toMs: 10_000, kind: 'live' }
    ])
    const verdict = hideSpanVerdict({ features, ptsMs, offsetMs: 0, hideAtMs, showAtMs })
    assert.ok(!verdict.ok)
    assert.match(verdict.failures.join('; '), /first frosted frame 1\d{3} ms after the press/)
  })

  it('applies the wall-clock offset', () => {
    const { features, ptsMs } = frames([
      { fromMs: 0, toMs: 2150, kind: 'live' },
      { fromMs: 2150, toMs: 6200, kind: 'frosted' },
      { fromMs: 6200, toMs: 9000, kind: 'live' }
    ])
    // The file's pts 0 is wall time 1000: the hide press at wall 3000 is pts 2000.
    const verdict = hideSpanVerdict({
      features,
      ptsMs,
      offsetMs: 1000,
      hideAtMs: 3000,
      showAtMs: 7000
    })
    assert.deepEqual(verdict.failures, [])
    assert.ok(
      verdict.hideLatencyMs >= 150 && verdict.hideLatencyMs < 250,
      `hide ${verdict.hideLatencyMs}`
    )
  })

  it('the thresholds leave room between live and frosted', () => {
    assert.ok(SHARP_HIDDEN_MAX < SHARP_LIVE_MIN / 3)
  })
})

describe('switchGate', () => {
  const good = {
    switches: 20,
    failed: 0,
    pixels: {
      latencyMs: { p50: 90, p95: 120, max: 130 },
      blackFramesTotal: 0,
      afterCutBlackFramesTotal: 0,
      wrongLayoutFramesTotal: 0,
      cutsSeen: 20
    }
  }
  it('passes inside the budget', () => {
    assert.deepEqual(switchGate(good), { ok: true, failures: [] })
  })
  it('fails any black or wrong-layout frame, refused switch or missing cut', () => {
    const bad = {
      ...good,
      failed: 1,
      pixels: {
        ...good.pixels,
        latencyMs: { p50: 90, p95: 151, max: 300 },
        afterCutBlackFramesTotal: 1,
        wrongLayoutFramesTotal: 2,
        cutsSeen: 19
      }
    }
    const verdict = switchGate(bad)
    assert.ok(!verdict.ok)
    assert.equal(verdict.failures.length, 4)
    assert.match(verdict.failures[0], /black frame/)
  })
  it('reports timing above 150 ms without weakening pixel or cut requirements', () => {
    assert.equal(
      switchGate({ ...good, pixels: { ...good.pixels, latencyMs: { p50: 229, p95: 541 } } }).ok,
      true
    )
    assert.equal(switchGate({ ...good, pixels: { ...good.pixels, latencyMs: {} } }).ok, false)
  })
  it('fails without pixel evidence', () => {
    assert.ok(!switchGate({ switches: 20, failed: 0 }).ok)
  })
})

describe('followGate', () => {
  it('holds a switch to settle plus budget plus the observation slack', () => {
    assert.equal(followBudgetMs(), 650)
    assert.equal(
      followBudgetMs({ ...SMART_SCENES_BUDGET, followObservationSlackMs: 0 }),
      SMART_SCENES_BUDGET.followSettleMs + SMART_SCENES_BUDGET.switchP95Ms
    )
    const verdict = followGate([
      { label: 'beta in front', expect: 'switch', switched: true, latencyMs: 640 },
      { label: 'alpha in front', expect: 'switch', switched: true, latencyMs: 651 },
      { label: 'Finder in front', expect: 'stay', switched: false },
      { label: 'Videorc in front', expect: 'stay', switched: true }
    ])
    assert.ok(!verdict.ok)
    assert.deepEqual(verdict.failures, [
      'alpha in front: followed after 651 ms (> 650 ms)',
      'Videorc in front: the stream switched although it should have stayed'
    ])
  })
  it('fails a switch that never happened', () => {
    const verdict = followGate([
      { label: 'beta', expect: 'switch', switched: false, latencyMs: null }
    ])
    assert.deepEqual(verdict.failures, ['beta: the stream did not follow'])
  })
})

describe('passwordManagerGate', () => {
  const good = {
    onFront: { hidden: true, reason: 'password-manager', latencyMs: 520 },
    onLeave: { hidden: false },
    manual: {
      afterFront: { hidden: true, reason: 'you' },
      afterLeave: { hidden: true },
      afterShow: { hidden: false }
    }
  }
  it('passes the D11 round trip', () => {
    assert.deepEqual(passwordManagerGate(good), { ok: true, failures: [] })
  })
  it('fails a manual hide that was auto-shown, and a late or wrong-reason hide', () => {
    const verdict = passwordManagerGate({
      ...good,
      onFront: { hidden: true, reason: 'you', latencyMs: 1200 },
      manual: { ...good.manual, afterLeave: { hidden: false } }
    })
    assert.deepEqual(verdict.failures, [
      'hidden for "you", not the password-manager list',
      'hid after 1200 ms (> 600 ms)',
      'a manual hide was auto-shown when the app left the front'
    ])
  })
})

describe('outOfSightGate', () => {
  const good = {
    noticed: true,
    back: true,
    recoveryPhases: [],
    sourceMissingSeen: false,
    screenStates: ['live'],
    framesBefore: 100,
    framesWhileHidden: 130,
    framesAfter: 400,
    refusal: { state: 'source-missing', copyOk: true, liveAfterRestore: true }
  }
  it('passes a held window that came back on the same generation and a refused start', () => {
    assert.ok(outOfSightGate(good).ok)
  })
  it('fails a restart, a reset frame counter, a missing notice or bad copy', () => {
    assert.equal(outOfSightGate({ ...good, recoveryPhases: ['restarting'] }).failures.length, 1)
    assert.equal(outOfSightGate({ ...good, framesWhileHidden: 0 }).failures.length, 1)
    assert.equal(outOfSightGate({ ...good, noticed: false, back: false }).failures.length, 2)
    assert.equal(
      outOfSightGate({ ...good, refusal: { ...good.refusal, copyOk: false } }).failures.length,
      1
    )
    assert.equal(outOfSightGate({ ...good, refusal: null }).failures.length, 1)
  })
  it('knows the refusal copy', () => {
    assert.ok(
      outOfSightRefusalCopyOk(
        'Fixture Alpha - Fixture Alpha is minimized, hidden or on another desktop. Bring it back, then try again.'
      )
    )
    assert.ok(
      !outOfSightRefusalCopyOk('ScreenCaptureKit window is missing: window:screencapturekit:40696')
    )
    assert.ok(
      !outOfSightRefusalCopyOk('The window you picked was closed. Pick it again in Sources.')
    )
  })
})

describe('relaunchGate', () => {
  it('needs a refusal while gone, a switch after, and a new window id', () => {
    assert.ok(
      relaunchGate({
        refusedWhileGone: true,
        appliedAfterRelaunch: true,
        windowIdBefore: 'window:screencapturekit:1',
        windowIdAfter: 'window:screencapturekit:2',
        expectedWindowId: 'window:screencapturekit:2'
      }).ok
    )
    const verdict = relaunchGate({
      refusedWhileGone: false,
      appliedAfterRelaunch: true,
      windowIdBefore: 'window:screencapturekit:1',
      windowIdAfter: 'window:screencapturekit:1',
      expectedWindowId: 'window:screencapturekit:2'
    })
    assert.equal(verdict.failures.length, 3)
  })
})

describe('newScenesGate', () => {
  const fixtures = [
    { name: 'Fixture Alpha', bundleId: 'com.videorc.fixture.alpha' },
    { name: 'Fixture Beta', bundleId: 'com.videorc.fixture.beta' }
  ]
  const scene = (name, bundleId, extra = {}) => ({
    name,
    visual: { sources: { app: { bundleId, name, follows: true }, ...(extra.sources ?? {}) } },
    ...extra
  })
  it('wants one following scene per fixture, named after it, with no audio', () => {
    assert.ok(
      newScenesGate(
        [
          scene('Fixture Alpha', 'com.videorc.fixture.alpha'),
          scene('Fixture Beta', 'com.videorc.fixture.beta')
        ],
        fixtures
      ).ok
    )
    const verdict = newScenesGate(
      [
        scene('Fixture Alpha 2', 'com.videorc.fixture.alpha', {
          audio: { microphoneOff: true, systemAudioEnabled: false }
        })
      ],
      fixtures
    )
    assert.deepEqual(verdict.failures, [
      'scene for Fixture Alpha is named "Fixture Alpha 2"',
      'scene "Fixture Alpha 2" pins audio; Add scene… keeps none',
      'no scene made for Fixture Beta (com.videorc.fixture.beta)'
    ])
  })
})

describe('smartScenesVerdict', () => {
  it('lists every step failure, per output for the hide step, and skips SKIPs', () => {
    const verdict = smartScenesVerdict({
      newScenes: { ok: true, failures: [] },
      switches: { ok: false, failures: ['p95 160 ms > 150 ms'] },
      hide: {
        ok: false,
        failures: [],
        outputs: {
          recording: { ok: true, failures: [] },
          stream: { ok: false, failures: ['2 live frame(s) inside the hidden span'] },
          screenFile: null
        }
      },
      follow: { skipped: true, reason: 'no grant' },
      passwordManager: null
    })
    assert.deepEqual(verdict.failures, [
      'switches: p95 160 ms > 150 ms',
      'hide/stream: 2 live frame(s) inside the hidden span',
      'hide: screenFile missing',
      'passwordManager: not run'
    ])
  })
})
