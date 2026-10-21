import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classifyFeedHandshake,
  dropTimings,
  estimateReceiverClockOffset,
  evaluateCloudSoloReport,
  evaluateHoldOnReceiver,
  firstPhaseAt,
  holdCardStats,
  parsePtsTimes,
  sortedGapStats
} from './cloud-solo-gates.mjs'

describe('cloud solo gates: the feed certificate probe (C1c)', () => {
  // FFmpeg 8.1 (OpenSSL) at level+debug against MediaMTX 1.21.2 with no
  // catch-all path, as the runner's dev/mediamtx.yml.tpl has it since C1b.
  const url = 'rtmps://localhost:47212/live/sh_probe-h?key=not-a-key'
  it('reads a probe refused after the RTMP connect as a passed handshake', () => {
    const lines = [
      '[rtmps @ 0x7f7030460] [debug] No default whitelist set',
      '[tls @ 0x7f6c2c300] [debug] Info method=SSL_connect state=SSLOK(SSL negotiation finished successfully), where=4097, ret=1',
      '[rtmps @ 0x7f7030460] [debug] Handshaking...',
      '[rtmps @ 0x7f7030460] [debug] Type answer 3',
      '[rtmps @ 0x7f7030460] [debug] Server version 0.0.0.0',
      "[rtmps @ 0x7f7030460] [debug] Sending publish command for 'sh_probe-h?key=not-a-key'",
      `[fifo @ 0x7f6c1c280] [error] Error opening ${url}: Input/output error`
    ]
    assert.equal(classifyFeedHandshake(lines), 'handshake-passed')
    // The same error with no RTMP line is not proof that TLS passed.
    assert.equal(classifyFeedHandshake(lines.slice(-1)), 'unknown')
    // An RTMP-level refusal at info level still counts (the old catch-all path).
    assert.equal(
      classifyFeedHandshake(['[rtmps @ 0x1] [error] Server error: Not authorized']),
      'handshake-passed'
    )
  })

  it('reads a refused certificate as rejected, RTMP lines or not', () => {
    const lines = [
      '[tls @ 0x929034300] [debug] Alert method=write state=SSLERR(error), where=16392, ret=560',
      '[tls @ 0x929024f80] [error] error:0A000086:SSL routines::certificate verify failed',
      '[rtmps @ 0x929038460] [error] Cannot open connection tls://localhost:47212',
      `[fifo @ 0x929020280] [error] Error opening ${url}: Input/output error`
    ]
    assert.equal(classifyFeedHandshake(lines), 'certificate-rejected')
    assert.equal(
      classifyFeedHandshake(['[rtmps @ 0x1] [debug] Handshaking...', ...lines]),
      'certificate-rejected'
    )
    assert.equal(classifyFeedHandshake([]), 'unknown')
  })
})

describe('cloud solo gates: receiver continuity', () => {
  it('parses ffprobe csv and measures the largest gap in presentation order', () => {
    const times = parsePtsTimes('0.000000,\n0.033000,\nN/A\n\n0.100000,\n0.066000,\n5.100000,\n')
    assert.deepEqual(times, [0, 0.033, 0.1, 0.066, 5.1])
    const stats = sortedGapStats(times)
    assert.equal(stats.packets, 5)
    assert.equal(stats.maxGapSeconds, 5)
    assert.equal(stats.maxGapAtSeconds, 0.1)
    assert.equal(stats.spanSeconds, 5.1)
    // B-frame reordering in file order is not a gap once sorted.
    assert.equal(sortedGapStats([0, 0.1, 0.033, 0.066]).maxGapSeconds, 0.034)
    assert.deepEqual(sortedGapStats([1]), {
      packets: 1,
      maxGapSeconds: null,
      maxGapAtSeconds: null,
      spanSeconds: null
    })
  })
})

describe('cloud solo gates: timings', () => {
  const states = [
    { atMs: 1000, phase: 'live' },
    { atMs: 3000, phase: 'live' },
    { atMs: 4600, phase: 'hold' },
    { atMs: 6000, phase: 'hold' },
    { atMs: 15000, phase: 'hold' },
    { atMs: 17400, phase: 'live' }
  ]

  it('finds the first phase after an instant', () => {
    assert.equal(firstPhaseAt(states, 3000, 'hold'), 4600)
    assert.equal(firstPhaseAt(states, 3000, 'live'), 3000)
    assert.equal(firstPhaseAt(states, 14000, 'live'), 17400)
    assert.equal(firstPhaseAt(states, 18000, 'live'), null)
  })

  it('measures a drop from the cut and the restore', () => {
    const drop = dropTimings(states, { cutMs: 3000, restoreMs: 14000 })
    assert.equal(drop.timeToHoldSeconds, 1.6)
    assert.equal(drop.timeToResumeSeconds, 3.4)
    assert.equal(drop.holdMs, 4600)
    assert.equal(drop.liveMs, 17400)
    const unresolved = dropTimings(states, { cutMs: 16000, restoreMs: null })
    assert.equal(unresolved.timeToHoldSeconds, null)
    assert.equal(unresolved.timeToResumeSeconds, null)
    assert.equal(unresolved.restoreAt, null)
  })
})

describe('cloud solo gates: the hold card on a receiver', () => {
  const fileStartMs = 100_000
  // Hold at +10 s in the file, live again at +22 s.
  const holdMs = fileStartMs + 10_000
  const liveMs = fileStartMs + 22_000
  const endMs = fileStartMs + 40_000

  it('passes when one freeze covers the card window and nothing freezes after', () => {
    const verdict = evaluateHoldOnReceiver({
      freezes: [
        { start: 10.0, duration: 1.0 },
        { start: 11.4, duration: 10.5 }
      ],
      fileStartMs,
      holdMs,
      liveMs,
      endMs
    })
    assert.equal(verdict.pass, true, verdict.reason)
    assert.ok(verdict.coverage > 0.95, String(verdict.coverage))
    assert.deepEqual(verdict.expectedWindowSeconds, [11.3, 22])
    assert.deepEqual(verdict.bestFreeze, { start: 11.4, duration: 10.5 })
  })

  it('fails when the card never settled or the picture froze after the resume', () => {
    const partial = evaluateHoldOnReceiver({
      freezes: [{ start: 11.4, duration: 3 }],
      fileStartMs,
      holdMs,
      liveMs,
      endMs
    })
    assert.equal(partial.pass, false)
    assert.match(partial.reason, /covered 28%/)
    const stuck = evaluateHoldOnReceiver({
      freezes: [
        { start: 11.4, duration: 10.5 },
        { start: 26, duration: 4 }
      ],
      fileStartMs,
      holdMs,
      liveMs,
      endMs
    })
    assert.equal(stuck.pass, false)
    assert.match(stuck.reason, /froze again 1 time/)
    assert.deepEqual(stuck.frozenAfterResume, [{ start: 26, duration: 4 }])
    // A short stutter after the resume is not a hold.
    const stutter = evaluateHoldOnReceiver({
      freezes: [
        { start: 11.4, duration: 10.5 },
        { start: 26, duration: 1.2 }
      ],
      fileStartMs,
      holdMs,
      liveMs,
      endMs
    })
    assert.equal(stutter.pass, true)
    assert.equal(
      evaluateHoldOnReceiver({ freezes: [], fileStartMs, holdMs: null, liveMs, endMs }).pass,
      false
    )
    // The next drop's own hold is not a freeze after this resume: the motion
    // check stops at that drop's cut.
    const nextDropCutMs = fileStartMs + 30_000
    const twoDrops = evaluateHoldOnReceiver({
      freezes: [
        { start: 11.4, duration: 10.5 },
        { start: 31.5, duration: 12 }
      ],
      fileStartMs,
      holdMs,
      liveMs,
      endMs,
      untilMs: nextDropCutMs
    })
    assert.equal(twoDrops.pass, true, twoDrops.reason)
    assert.equal(twoDrops.motionCheckedUntilSeconds, 30)
  })

  it('anchors the file clock on the first hold card edge', () => {
    // The card edge sits 2.4 s later than the naive mapping says: the
    // runner's encoder lookahead plus the keyframe wait before the first byte.
    const freezes = [
      { start: 13.231, duration: 2.5 },
      { start: 15.997, duration: 14.1 },
      { start: 41.031, duration: 13.733 }
    ]
    const anchor = estimateReceiverClockOffset({
      freezes,
      fileStartMs,
      holdMs: fileStartMs + 12_329
    })
    assert.deepEqual(anchor, {
      offsetSeconds: 2.368,
      freeze: { start: 15.997, duration: 14.1 }
    })
    const corrected = fileStartMs - anchor.offsetSeconds * 1000
    const verdict = evaluateHoldOnReceiver({
      freezes,
      fileStartMs: corrected,
      holdMs: fileStartMs + 12_329,
      liveMs: fileStartMs + 27_711,
      endMs: fileStartMs + 60_000,
      untilMs: fileStartMs + 38_000
    })
    assert.ok(verdict.coverage > 0.95, String(verdict.coverage))
    assert.equal(verdict.pass, true, verdict.reason)
    // Nothing near the expected edge: no anchor rather than a wrong one.
    assert.equal(
      estimateReceiverClockOffset({ freezes, fileStartMs, holdMs: fileStartMs + 30_000 }),
      null
    )
    assert.equal(estimateReceiverClockOffset({ freezes, fileStartMs, holdMs: null }), null)
  })

  it('recognises the dark card with bright text and rejects the test pattern', () => {
    const width = 8
    const height = 4
    const card = Buffer.alloc(width * height * 3)
    for (let index = 0; index < width * height; index += 1) {
      card[index * 3] = 13
      card[index * 3 + 1] = 13
      card[index * 3 + 2] = 15
    }
    // Two white text pixels.
    card.fill(250, 0, 6)
    const stats = holdCardStats(card, width, height)
    assert.equal(stats.isHoldCard, true)
    assert.equal(stats.brightRatio, 0.063)
    assert.ok(stats.darkRatio > 0.9)
    const pattern = Buffer.alloc(width * height * 3)
    for (let index = 0; index < pattern.length; index += 1) pattern[index] = (index * 37) % 256
    assert.equal(holdCardStats(pattern, width, height).isHoldCard, false)
    assert.equal(holdCardStats(Buffer.alloc(0), width, height).isHoldCard, false)
    // All dark with no text is not the card either (a black frame).
    const black = Buffer.alloc(width * height * 3)
    assert.equal(holdCardStats(black, width, height).isHoldCard, false)
  })
})

describe('cloud solo gates: the run verdict', () => {
  const receiver = (name) => ({
    name,
    video: { codec: 'h264' },
    audio: { codec: 'aac' },
    gaps: { maxGapSeconds: 0.034 },
    durationSeconds: 70,
    minDurationSeconds: 60,
    stayedConnected: true,
    exitedAfterStop: true,
    holds: [{ kind: 'feed-cut', pass: true, card: { isHoldCard: true } }]
  })
  const passing = () => ({
    drops: [
      {
        kind: 'feed-cut',
        timeToHoldSeconds: 1.7,
        timeToResumeSeconds: 4.1,
        desktopSawHold: true,
        desktopSawLive: true
      },
      {
        kind: 'computer-died',
        timeToHoldSeconds: 1.9,
        timeToResumeSeconds: 7.2,
        maxResumeSeconds: 30,
        destinationsSetAfterResume: 0
      }
    ],
    receivers: [receiver('receiver-1'), receiver('receiver-2')],
    stop: {
      webEndCalled: true,
      showEndedOnNode: true,
      runnerExited: true,
      recordingFinalized: true
    },
    platformRowsLive: true,
    tls: {
      rightRoots: { outcome: 'handshake-passed' },
      wrongCa: { outcome: 'certificate-rejected' },
      otherName: { outcome: 'certificate-rejected' }
    },
    cloudTest: {
      ok: true,
      timeToLiveMs: 2_300,
      uploads: [{ orientation: 'horizontal', targetKbps: 4000, measuredKbps: 4150 }],
      webCreateStatus: 201,
      agentKind: 'solo',
      agentMaxShowSeconds: 30,
      webEndStatus: 200,
      currentDuringTest: null,
      destinationsSet: 0,
      receiversUntouched: true,
      usageMetered: 0,
      usageIgnored: 1
    },
    testCap: {
      agentKind: 'solo',
      agentMaxShowSeconds: 30,
      endReason: 'max-show',
      liveToEndSeconds: 30.4,
      webClosed: true
    },
    secretLeaks: []
  })

  it('passes a clean run', () => {
    assert.deepEqual(evaluateCloudSoloReport(passing()), [])
    // A run without the test steps (an older report) is judged on the rest.
    const { cloudTest: _omitted, testCap: _cap, ...withoutTest } = passing()
    assert.deepEqual(evaluateCloudSoloReport(withoutTest), [])
  })

  it('names every broken gate of the cloud test (C6b)', () => {
    const report = passing()
    report.cloudTest = {
      ok: false,
      reason: 'too-slow',
      message: 'ffmpeg exited 0',
      timeToLiveMs: 25_000,
      uploads: [{ orientation: 'horizontal', targetKbps: 4000 }],
      webCreateStatus: 503,
      agentKind: 'solo',
      agentMaxShowSeconds: 43_200,
      webEndStatus: null,
      currentDuringTest: { id: 'sh_test' },
      destinationsSet: 1,
      receiversUntouched: false,
      desktopShowStayedOff: false,
      usageMetered: 1,
      usageIgnored: 0
    }
    assert.deepEqual(evaluateCloudSoloReport(report), [
      'the cloud test failed (too-slow: ffmpeg exited 0)',
      'the cloud test took 25000 ms to go live (limit 20 s)',
      'the cloud test measured no upload',
      'the web did not see the test show created',
      'the web asked the node for a solo show capped at 43200 s, not a solo show capped at 30 s',
      'the web did not see the test show ended',
      'GET /api/cloud/shows/current listed the test show as current',
      'the runner applied destinations.set 1 time(s) during the test',
      'a receiver took bytes during the test',
      "the desktop's own cloud show changed during the test",
      '1 usage report(s) of the test show were metered',
      "the node's usage report for the test show never reached the web"
    ])
    report.cloudTest = { ...passing().cloudTest, timeToLiveMs: null }
    assert.deepEqual(evaluateCloudSoloReport(report), ['the cloud test never saw the runner live'])
  })

  it('holds a test show nobody ends to the 30 s cap (C6b)', () => {
    const report = passing()
    // On the cap's edges: a second early is jitter, eight late is the end
    // sequence; past either is a broken cap.
    for (const seconds of [29, 38]) {
      report.testCap = { ...passing().testCap, liveToEndSeconds: seconds }
      assert.deepEqual(evaluateCloudSoloReport(report), [])
    }
    report.testCap = { ...passing().testCap, liveToEndSeconds: 61 }
    assert.deepEqual(evaluateCloudSoloReport(report), [
      'the unended test show ended 61 s after it went live (cap 30 s)'
    ])
    report.testCap = {
      agentKind: 'test',
      agentMaxShowSeconds: 43_200,
      endReason: 'no-feed',
      liveToEndSeconds: 60,
      webClosed: false
    }
    assert.deepEqual(evaluateCloudSoloReport(report), [
      'the capped test show reached the node as a test show capped at 43200 s',
      'the unended test show ended with no-feed, not max-show',
      'the web never closed the capped test show'
    ])
  })

  it('names every broken gate', () => {
    const report = passing()
    report.drops[0].timeToHoldSeconds = 9
    report.drops[1].timeToResumeSeconds = null
    report.drops[1].destinationsSetAfterResume = 1
    report.receivers[0].gaps.maxGapSeconds = 2.5
    report.receivers[1].audio = {}
    report.receivers[1].stayedConnected = false
    report.receivers[1].holds[0] = {
      kind: 'feed-cut',
      pass: false,
      reason: 'no card',
      card: { isHoldCard: false, darkRatio: 0.1, brightRatio: 0.3 }
    }
    report.stop.recordingFinalized = false
    report.platformRowsLive = false
    report.tls.wrongCa = { outcome: 'handshake-passed' }
    report.tls.otherName = { outcome: 'handshake-passed' }
    report.secretLeaks = ['ingest key']
    report.web = { droppedSrt: [{ showId: 'sh_x', orientation: 'horizontal', problem: 'url' }] }
    const failures = evaluateCloudSoloReport(report)
    assert.deepEqual(failures, [
      'feed-cut: hold took 9 s (limit 6 s)',
      'computer-died: the show never came back live after the resume',
      'computer-died: the runner applied destinations.set 1 time(s) after the Resume click',
      'receiver-1: largest packet gap 2.5 s (limit 2 s)',
      'receiver-2: no audio stream',
      'receiver-2: its connection dropped during a drop',
      'receiver-2 feed-cut: no card',
      'receiver-2 feed-cut: the frame inside the hold is not the hold card (dark 0.1, bright 0.3)',
      'the local recording did not finalize',
      "the runner's platform leg states never reached the desktop as live",
      'the feed accepted a certificate its roots did not sign (handshake-passed)',
      'the feed accepted a certificate for another name (handshake-passed)',
      'a secret reached the renderer events: ingest key',
      "the web dropped the node's srt block (horizontal: url)"
    ])
    assert.ok(evaluateCloudSoloReport({}).includes('no drop was measured'))
  })
})
