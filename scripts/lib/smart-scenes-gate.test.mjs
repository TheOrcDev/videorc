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
  hideSpanVerdict,
  newScenesGate,
  passwordManagerGate,
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
  it('fails p95 over 150 ms, any black or wrong-layout frame, and a missing cut', () => {
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
    assert.equal(verdict.failures.length, 5)
    assert.match(verdict.failures[0], /p95 151 ms > 150 ms/)
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
      'hid after 1200 ms (> 1000 ms)',
      'a manual hide was auto-shown when the app left the front'
    ])
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
      'scene "Fixture Alpha 2" pins audio; New scene… keeps none',
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
