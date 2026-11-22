import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessCleanStop,
  assessToneContinuity,
  parseWindowRms,
  windowRmsArgs
} from './linux-mic-continuity-gates.mjs'

const printed = [
  'frame:0    pts:0       pts_time:0',
  'lavfi.astats.Overall.RMS_level=-21.07',
  'frame:1    pts:4800    pts_time:0.1',
  'lavfi.astats.Overall.RMS_level=-inf',
  'frame:2    pts:9600    pts_time:0.2',
  'lavfi.astats.Overall.RMS_level=-80.5'
].join('\n')

// 100 ms windows from `from` to `to` seconds at `rmsDb`.
function windows(from, to, rmsDb = -21) {
  const out = []
  for (let index = Math.round(from * 10); index < Math.round(to * 10); index += 1) {
    out.push({ time: index / 10, rmsDb })
  }
  return out
}

test('window RMS args read the first audio stream 100 ms at a time by default', () => {
  const args = windowRmsArgs('/r/take.mp4')
  assert.equal(args[args.indexOf('-i') + 1], '/r/take.mp4')
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0')
  assert.match(args[args.indexOf('-af') + 1], /asetnsamples=n=4800:p=0/)
  assert.match(windowRmsArgs('/r/take.mp4', 48000)[args.indexOf('-af') + 1], /n=48000/)
})

test('ametadata print output parses into windows, -inf as digital silence', () => {
  const parsed = parseWindowRms(printed)
  assert.deepEqual(
    parsed.map((entry) => entry.time),
    [0, 0.1, 0.2]
  )
  assert.equal(parsed[1].rmsDb, -Infinity)
  assert.equal(parsed[2].rmsDb, -80.5)
  assert.deepEqual(parseWindowRms(''), [])
})

test('a continuous tone passes and a half-second hole fails, naming its seconds', () => {
  const clean = assessToneContinuity(windows(0, 10), { toneStartSeconds: 0, toneEndSeconds: 10 })
  assert.equal(clean.ok, true)
  assert.equal(clean.minRmsDb, -21)
  // The audit's failure a whole second would hide: 0.5 s of silence.
  const holed = [...windows(0, 4.7), ...windows(4.7, 5.2, -Infinity), ...windows(5.2, 10)]
  const verdict = assessToneContinuity(holed, { toneStartSeconds: 0, toneEndSeconds: 10 })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.silentMs, 500)
  assert.deepEqual(verdict.silentSeconds, [4, 5])
  assert.match(verdict.failures[0], /500 ms under -60 dB .*first at 4.7s; seconds 4,5/)
})

test('a silent tail (a Stop that cut the audio short) fails', () => {
  const tail = [...windows(0, 29.4), ...windows(29.4, 31, -Infinity)]
  const verdict = assessToneContinuity(tail, { toneStartSeconds: 0, toneEndSeconds: 31 })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.silentSeconds, [29, 30])
})

test('audio that ends before the tone fails; the margins keep the edges out', () => {
  const short = assessToneContinuity(windows(0, 6), { toneStartSeconds: 0, toneEndSeconds: 10 })
  assert.equal(short.ok, false)
  assert.match(short.failures[0], /audio ends before the tone does/)
  const edges = [
    ...windows(0, 0.4, -Infinity),
    ...windows(0.4, 9.6),
    ...windows(9.6, 10, -Infinity)
  ]
  assert.equal(assessToneContinuity(edges, { toneStartSeconds: 0, toneEndSeconds: 10 }).ok, true)
})

test('an empty tone window is a failure, not a pass', () => {
  const verdict = assessToneContinuity([], { toneStartSeconds: 0, toneEndSeconds: 1 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures[0], /window .* is empty/)
})

test('a forced stop, a missing file or a slow Stop fails the clean-stop gate', () => {
  assert.equal(
    assessCleanStop({
      healthCodes: ['recording-stop-requested'],
      stopMs: 900,
      outputPath: '/r/a.mp4'
    }).ok,
    true
  )
  const forced = assessCleanStop({
    healthCodes: ['recording-stop-escalated', 'recording-stop-forced', 'recording-stop-forced'],
    stopMs: 21412,
    outputPath: null
  })
  assert.equal(forced.ok, false)
  assert.deepEqual(forced.failures, [
    'Stop was forced: recording-stop-escalated, recording-stop-forced',
    'no published recording',
    'Stop took 21412 ms (budget 15000 ms)'
  ])
})
