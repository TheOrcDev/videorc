import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeWireRateByEvent, wireRateByEvent } from './wire-rate-breakdown.mjs'

// The 2026-11-28 detached run (Mac16,1, main + #2584): 85.8 KiB/s over 30.7 s.
const BYTES = {
  'backend.ready': 146,
  'compositor.status': 34063,
  'diagnostics.stats': 1821043,
  'preview.frameReady': 643600,
  'preview.surface.status': 137932
}
const COUNTS = {
  'backend.ready': 1,
  'compositor.status': 16,
  'diagnostics.stats': 136,
  'preview.frameReady': 1861,
  'preview.surface.status': 136
}

test('names the events that dominate the wire, biggest first', () => {
  const rows = wireRateByEvent(BYTES, COUNTS, 30.7)
  assert.deepEqual(
    rows.map((row) => row.event),
    ['diagnostics.stats', 'preview.frameReady', 'preview.surface.status']
  )
  assert.equal(Math.round(rows[0].share * 100), 69)
  assert.equal(rows[0].averageBytes, 13390)
  assert.ok(Math.abs(rows[0].kibPerSecond - 57.9) < 0.2, String(rows[0].kibPerSecond))
})

test('the description reads as a failure suffix', () => {
  const text = describeWireRateByEvent(BYTES, COUNTS, 30.7, 2)
  assert.match(
    text,
    /^diagnostics\.stats 57\.\d KiB\/s \(69%, 136 x 13390 B\); preview\.frameReady/
  )
})

test('says nothing without bytes or a window', () => {
  assert.deepEqual(wireRateByEvent({}, {}, 30), [])
  assert.deepEqual(wireRateByEvent(BYTES, COUNTS, 0), [])
  assert.equal(describeWireRateByEvent(undefined, undefined, 30), '')
})
