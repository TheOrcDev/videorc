import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cadenceFromPts,
  countFifoOverflowsByContext,
  streamDropShare,
  thinUplinkVerdict
} from './thin-uplink-gates.mjs'

describe('thin-uplink stream drop share', () => {
  it('reads the stream role in a split session', () => {
    assert.deepEqual(
      streamDropShare({
        encoderBridgeStreamQueueDroppedFrames: 300,
        encoderBridgeStreamVideoToolboxOutputFrames: 700,
        encoderBridgeVideoToolboxOutputFrames: 2000
      }),
      { dropped: 300, encoded: 700, total: 1000, share: 0.3 }
    )
  })

  it('falls back to the shared fields in a stream-only session', () => {
    assert.deepEqual(
      streamDropShare({
        encoderBridgeOutputQueueDroppedFrames: 10,
        encoderBridgeStreamVideoToolboxOutputFrames: 0,
        encoderBridgeVideoToolboxOutputFrames: 990
      }),
      { dropped: 10, encoded: 990, total: 1000, share: 0.01 }
    )
    assert.equal(streamDropShare({}).share, 0)
  })
})

describe('FIFO queue full attribution', () => {
  const legs = [
    { id: 'youtube', port: 13035 },
    { id: 'x', port: 13036 }
  ]

  it('attributes a context that printed its URL, and the last leg by elimination', () => {
    const log = [
      '[fifo @ 0x1] [error] Error opening rtmp://127.0.0.1:13036/<redacted>: Connection refused',
      '[fifo @ 0x1] [warning] FIFO queue full',
      '[fifo @ 0x2] [warning] FIFO queue full',
      '[fifo @ 0x2] [info] FIFO queue flushed',
      '[fifo @ 0x2] [warning] FIFO queue full'
    ].join('\n')
    const result = countFifoOverflowsByContext(log, legs)
    assert.deepEqual(
      [...result.byContext],
      [
        ['0x1', 1],
        ['0x2', 2]
      ]
    )
    assert.deepEqual(
      [...result.byLeg],
      [
        ['x', 1],
        ['youtube', 2]
      ]
    )
    assert.equal(result.unattributed, 0)
  })

  it('leaves two unknown contexts unattributed instead of guessing', () => {
    const log = '[fifo @ 0xa] [warning] FIFO queue full\n[fifo @ 0xb] [warning] FIFO queue full\n'
    const result = countFifoOverflowsByContext(log, legs)
    assert.equal(result.unattributed, 2)
    assert.equal(result.byLeg.size, 0)
  })

  it('attributes a single destination without any URL line', () => {
    const result = countFifoOverflowsByContext('[fifo @ 0xa] FIFO queue full', [legs[0]])
    assert.deepEqual([...result.byLeg], [['youtube', 1]])
  })
})

describe('received FLV cadence', () => {
  it('counts holes longer than 1.5 frame intervals', () => {
    const pts = [0, 1 / 30, 2 / 30, 3 / 30, 10 / 30, 11 / 30]
    const cadence = cadenceFromPts(pts, 30)
    assert.equal(cadence.frames, 6)
    assert.equal(cadence.gapCount, 1)
    assert.equal(cadence.maxGapMs, 233)
    assert.ok(cadence.fps > 14 && cadence.fps < 16)
  })

  it('handles an empty capture', () => {
    assert.deepEqual(cadenceFromPts([], 30), {
      frames: 0,
      durationSeconds: 0,
      fps: 0,
      gapCount: 0,
      maxGapMs: 0
    })
  })
})

describe('thin-uplink verdict', () => {
  const healthy = {
    label: 'YouTube',
    received: { frames: 4500, maxGapMs: 40, tail: { fps: 30, maxGapMs: 40 } },
    overflowCount: 0
  }

  it('passes a capped stream whose tail is clean after the bitrate settled', () => {
    assert.deepEqual(
      thinUplinkVerdict({
        variant: 'split',
        capped: true,
        dropShare: 0.004,
        legs: [healthy],
        streamSeconds: 150,
        lastOverflowAtSeconds: 55
      }),
      { pass: true, failures: [] }
    )
  })

  it('names drops, a late overflow, a slow or holed tail, and a silent leg', () => {
    const verdict = thinUplinkVerdict({
      variant: 'stream-only',
      capped: true,
      dropShare: 0.3,
      legs: [
        {
          ...healthy,
          received: { frames: 100, maxGapMs: 6200, tail: { fps: 5.5, maxGapMs: 6200 } }
        },
        { label: 'X', received: null }
      ],
      streamSeconds: 150,
      lastOverflowAtSeconds: 120
    })
    assert.equal(verdict.pass, false)
    assert.equal(verdict.failures.length, 5)
    assert.match(verdict.failures[0], /30\.0 %/)
    assert.match(verdict.failures[1], /overflowed .* 120 s in/)
    assert.match(verdict.failures[2], /5\.5 fps over the last 60 s/)
    assert.match(verdict.failures[3], /6200 ms hole/)
    assert.match(verdict.failures[4], /X received no video/)
  })

  it('judges only drops and silence when the uplink is uncapped', () => {
    const verdict = thinUplinkVerdict({
      variant: 'audio-late',
      capped: false,
      dropShare: 0,
      legs: [
        { ...healthy, received: { frames: 10, maxGapMs: 5000, tail: { fps: 2, maxGapMs: 5000 } } }
      ],
      streamSeconds: 90,
      lastOverflowAtSeconds: 80
    })
    assert.equal(verdict.pass, true)
  })
})
