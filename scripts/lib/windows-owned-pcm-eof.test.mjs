import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OWNED_PCM_SHORTEST_BUF_DURATION,
  ownedPcmEofVerdict,
  ownedPcmEofAggregate,
  ownedPcmReaderClosed,
  runOwnedPcmEof
} from './windows-owned-pcm-eof.mjs'

const valid = {
  exitCode: 0,
  childReaped: true,
  inputsClosed: true,
  keepAudioAlive: true,
  writtenVideoFrames: 120,
  writtenAudioFrames: 144000,
  fpsInputFrames: 120,
  fpsOutputFrames: 120,
  encodedVideoFrames: 120,
  firstOutputMs: 120,
  stopMs: 70,
  audioEofMs: null,
  captureStoppedMs: 3000,
  videoEofMs: 4000,
  audioPipeClosedAtMs: 4050,
  startSkewMs: 21,
  packetTail: { pass: true, videoEndSeconds: 4.021, tailMismatchMs: 11 }
}

test('destroyed keepalive writer is expected only after its observed reader closes past video EOF', () => {
  assert.equal(ownedPcmReaderClosed(valid, 'audio', 'ERR_STREAM_DESTROYED'), true)
  for (const delta of [
    { keepAudioAlive: false },
    { cancelled: true },
    { videoEofMs: null },
    { audioPipeClosedAtMs: null },
    { audioPipeClosedAtMs: 3999 }
  ])
    assert.equal(
      ownedPcmReaderClosed({ ...valid, ...delta }, 'audio', 'ERR_STREAM_DESTROYED'),
      false
    )
  assert.equal(ownedPcmReaderClosed(valid, 'video', 'ERR_STREAM_DESTROYED'), false)
  assert.equal(ownedPcmReaderClosed(valid, 'audio', 'EACCES'), false)
  assert.equal(
    ownedPcmEofVerdict({
      ...valid,
      audioProducerError: 'Cannot call write after a stream was destroyed'
    }).pass,
    false,
    'an unclassified producer error must remain a failed attempt'
  )
})

test('owned PCM EOF acceptance requires measured lifecycle, complete frame accounting and actual continued video', () => {
  assert.equal(ownedPcmEofVerdict(valid).pass, true)
  for (const field of [
    'firstOutputMs',
    'stopMs',
    'captureStoppedMs',
    'videoEofMs',
    'startSkewMs',
    'writtenAudioFrames',
    'encodedVideoFrames',
    'audioPipeClosedAtMs'
  ]) {
    for (const value of [null, undefined, NaN, Infinity])
      assert.equal(ownedPcmEofVerdict({ ...valid, [field]: value }).pass, false, field)
  }
  for (const delta of [
    { error: 'failed probe' },
    { cancelled: true },
    { timeout: true },
    { childReaped: false },
    { unsafeCleanup: true },
    { videoProducerError: 'socket closed' },
    { audioProducerError: 'socket closed' },
    { writtenVideoFrames: 119 },
    { writtenAudioFrames: 143520 },
    { inputsClosed: false },
    { audioEofMs: 3000 },
    { audioPipeClosedAtMs: 3999 },
    { fpsOutputFrames: 119 },
    { firstOutputMs: 1501 },
    { stopMs: 1501 },
    { startSkewMs: 101 },
    { videoEofMs: 3100 },
    { packetTail: { pass: true, videoEndSeconds: 3 } },
    { packetTail: { pass: true, videoEndSeconds: 4 } },
    { packetTail: { pass: false, videoEndSeconds: 4, reason: '101ms tail' } }
  ])
    assert.equal(ownedPcmEofVerdict({ ...valid, ...delta }).pass, false, JSON.stringify(delta))
})

test('spawn failure closes the owned loopback inputs and returns failed evidence', async () => {
  const output = mkdtempSync(join(tmpdir(), 'videorc-eof-spawn-'))
  try {
    const row = await runOwnedPcmEof({
      ffmpeg: join(output, 'missing-ffmpeg'),
      ffprobe: join(output, 'missing-ffprobe'),
      output,
      keepAudioAlive: true
    })
    assert.equal(row.verdict.pass, false)
    assert.equal(row.childReaped, true)
    assert.equal(row.unsafeCleanup, undefined)
    assert.ok(row.error)
    assert.equal(row.inputsClosed, true)
    assert.equal(row.argv.includes('-analyzeduration'), false)
    assert.equal(row.argv.includes('1024'), true)
    assert.equal(
      row.argv.some((value) => value.includes('arealtime')),
      false
    )
    // #1166: the default 10 s shortest queue froze startup for its whole window.
    const shortest = row.argv.indexOf('-shortest')
    assert.ok(shortest > row.argv.lastIndexOf('-i'), '-shortest belongs to the output')
    assert.deepEqual(row.argv.slice(shortest + 1, shortest + 3), [
      '-shortest_buf_duration',
      OWNED_PCM_SHORTEST_BUF_DURATION
    ])
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})

test('owned PCM shortest bound mirrors the backend raw-bridge bound', () => {
  const source = readFileSync(
    new URL('../../crates/videorc-backend/src/recording.rs', import.meta.url),
    'utf8'
  )
  const declared = source.match(/const LIVE_PCM_SHORTEST_BUF_DURATION: &str = "([^"]+)";/)
  assert.ok(declared, 'recording.rs declares LIVE_PCM_SHORTEST_BUF_DURATION')
  assert.equal(OWNED_PCM_SHORTEST_BUF_DURATION, declared[1])
})

test('owned PCM aggregate preserves the existing startup and stop p95 budgets', () => {
  const rows = [0, 600].flatMap((initialAudioDelayMs) =>
    Array.from({ length: 25 }, () => ({ ...valid, initialAudioDelayMs }))
  )
  assert.equal(ownedPcmEofAggregate(rows, 25).pass, true)
  assert.equal(ownedPcmEofAggregate(rows.slice(1), 25).pass, false)
  assert.equal(
    ownedPcmEofAggregate(
      rows.map((row) => ({ ...row, stopMs: 586 })),
      25
    ).pass,
    false,
    'rejected pacing stop regression must fail despite bounded cleanup'
  )
  assert.equal(
    ownedPcmEofAggregate(
      rows.map((row) => ({ ...row, firstOutputMs: 1001 })),
      25
    ).pass,
    false
  )
})
