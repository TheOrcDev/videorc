import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  holdCardStats,
  evaluateHoldOnReceiver,
  parsePtsTimes,
  sortedGapStats
} from './cloud-solo-gates.mjs'
import { runMedia } from './cloud-managed-smoke.mjs'

// Deliberately reads the PROGRAM receiver, never the ingress/feed recording.
// A local ingress cannot contain a card rendered by a different web process.
// D18's program receiver supplies a finalized snapshot and its observed clock:
//   <file>.clock.json: { firstFrameAtMs: <wall clock of decoded first frame> }
// For --repeat use {pass} in VIDEORC_MANAGED_PROGRAM_RECORDING.
export function assertManagedProgramHold(h, timings, pass) {
  const file = process.env.VIDEORC_MANAGED_PROGRAM_RECORDING?.replaceAll('{pass}', String(pass))
  assert.ok(
    file && existsSync(file) && existsSync(`${file}.clock.json`),
    'Hold-card/continuity gate needs VIDEORC_MANAGED_PROGRAM_RECORDING and its .clock.json from the D18 program receiver; the ingress alone cannot prove this.'
  )
  const { firstFrameAtMs } = JSON.parse(readFileSync(`${file}.clock.json`, 'utf8'))
  assert.ok(Number.isFinite(firstFrameAtMs), 'program receiver must stamp its first decoded frame')
  const seconds = (timings.endMs - firstFrameAtMs) / 1000
  assert.ok(seconds > 0)
  const rgb = runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-i',
    file,
    '-t',
    String(seconds),
    '-an',
    '-vf',
    'fps=10,scale=160:90',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
  const evidence = managedProgramFrames(rgb, firstFrameAtMs, timings)
  assert.ok(evidence.cardFrames > 0, 'no hold card reached the program receiver')
  assert.ok(evidence.motionAfterReturn, 'picture did not return at the program receiver')
  const hold = evaluateHoldOnReceiver({
    freezes: evidence.freezes,
    fileStartMs: firstFrameAtMs,
    ...timings
  })
  assert.ok(hold.pass, hold.reason)
  const pts = runMedia(h.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    file
  ]).toString()
  const gap = sortedGapStats(parsePtsTimes(pts))
  assert.ok(
    gap.packets > 10 && gap.maxGapSeconds <= 2,
    'program continuity broke across hold/return'
  )
  return { ...evidence, hold, gap }
}
export function managedProgramFrames(rgb, firstFrameAtMs, { holdMs, liveMs }) {
  const size = 160 * 90 * 3,
    count = Math.floor(rgb.length / size),
    freezes = []
  let stillStart = null,
    cardFrames = 0,
    motionAfterReturn = false
  for (let i = 0; i < count; i++) {
    const at = firstFrameAtMs + i * 100,
      frame = rgb.subarray(i * size, (i + 1) * size)
    if (at >= holdMs + 1300 && at < liveMs && holdCardStats(frame, 160, 90).isHoldCard) cardFrames++
    if (!i) continue
    const previous = rgb.subarray((i - 1) * size, i * size)
    let delta = 0
    for (let j = 0; j < size; j++) delta += Math.abs(frame[j] - previous[j])
    const still = delta / size < 0.5
    if (still && stillStart === null) stillStart = (i - 1) / 10
    if (!still && stillStart !== null) {
      freezes.push({ start: stillStart, duration: i / 10 - stillStart })
      stillStart = null
    }
    if (at >= liveMs + 2500 && !still) motionAfterReturn = true
  }
  if (stillStart !== null) freezes.push({ start: stillStart, duration: count / 10 - stillStart })
  return { freezes, cardFrames, motionAfterReturn }
}
