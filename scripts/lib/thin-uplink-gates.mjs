// Pure helpers for the thin-uplink smoke (plan 218 S1): drop accounting,
// `FIFO queue full` attribution from the metrics journal's FFmpeg log, the
// received FLV's cadence, and the verdict.

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'

/** Stream drop share: at most 1 % once the stream holds its frame rate. */
export const MAX_STREAM_DROP_SHARE = 0.01
/** The longest hole viewers may see on a leg once the bitrate has settled. */
export const MAX_RECEIVED_GAP_MS = 1000
/** Frames per second a settled leg must deliver over the run's tail. */
export const MIN_SETTLED_FPS = 28
/** The run's last stretch, in which a capped uplink must be clean: the
 * adaptive bitrate (plan 218 S3a) learns the cap from the first overflows. */
export const SETTLE_TAIL_SECONDS = 60

/**
 * Frames the bridge coalesced before VideoToolbox, against the frames it
 * encoded, for the stream role. A stream-only session reports the stream
 * through the generic (shared) fields; a split session through the
 * stream-role fields.
 */
export function streamDropShare(sample) {
  const dropped = Number(
    sample?.encoderBridgeStreamQueueDroppedFrames ??
      sample?.encoderBridgeOutputQueueDroppedFrames ??
      0
  )
  const encodedStream = Number(sample?.encoderBridgeStreamVideoToolboxOutputFrames ?? 0)
  const encoded =
    encodedStream > 0 ? encodedStream : Number(sample?.encoderBridgeVideoToolboxOutputFrames ?? 0)
  const total = dropped + encoded
  return { dropped, encoded, total, share: total > 0 ? dropped / total : 0 }
}

const FIFO_LINE = /\[fifo @ (0x[0-9a-fA-F]+)\] (?:\[\w+\] )?(.*)$/
const RTMP_PORT = /rtmps?:\/\/[^/\s]*?:(\d+)\//

/**
 * Counts `FIFO queue full` per fifo log context in one FFmpeg log, and maps
 * each context to a leg where the log lets it: a fifo prints its URL only on
 * `Error opening <url>` (the journal keeps the host and port), and when all
 * but one leg have a known context the last one is the remaining leg.
 *
 * `legs` is `[{ id, port }]`; `byLeg` maps a leg id to its count.
 */
export function countFifoOverflowsByContext(logText, legs = []) {
  const byContext = new Map()
  const contextPorts = new Map()
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const match = FIFO_LINE.exec(line)
    if (!match) continue
    const [, context, message] = match
    if (message.startsWith('Error opening ')) {
      const port = RTMP_PORT.exec(message)?.[1]
      if (port) contextPorts.set(context, Number(port))
      continue
    }
    if (message.trim() === 'FIFO queue full') {
      byContext.set(context, (byContext.get(context) ?? 0) + 1)
    }
  }
  const byLeg = new Map()
  const knownPorts = new Set(contextPorts.values())
  const unknownLegs = legs.filter((leg) => !knownPorts.has(leg.port))
  const unknownContexts = [...byContext.keys()].filter((context) => !contextPorts.has(context))
  if (unknownLegs.length === 1 && unknownContexts.length === 1) {
    contextPorts.set(unknownContexts[0], unknownLegs[0].port)
  }
  let unattributed = 0
  for (const [context, count] of byContext) {
    const port = contextPorts.get(context)
    const leg = legs.find((candidate) => candidate.port === port)
    if (leg) byLeg.set(leg.id, (byLeg.get(leg.id) ?? 0) + count)
    else unattributed += count
  }
  return { byContext, byLeg, unattributed }
}

/**
 * Video packet cadence of a received FLV: frames, duration, delivered fps,
 * holes longer than 1.5 frame intervals and the longest one. Pure over a
 * list of pts seconds; `receivedStreamCadence` runs ffprobe for it.
 */
export function cadenceFromPts(ptsSeconds, fps) {
  const pts = ptsSeconds.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (pts.length < 2) {
    return { frames: pts.length, durationSeconds: 0, fps: 0, gapCount: 0, maxGapMs: 0 }
  }
  const interval = 1 / fps
  let gapCount = 0
  let maxGap = 0
  for (let index = 1; index < pts.length; index += 1) {
    const gap = pts[index] - pts[index - 1]
    if (gap > interval * 1.5) gapCount += 1
    if (gap > maxGap) maxGap = gap
  }
  const durationSeconds = pts.at(-1) - pts[0] + interval
  return {
    frames: pts.length,
    durationSeconds,
    fps: pts.length / durationSeconds,
    gapCount,
    maxGapMs: Math.round(maxGap * 1000)
  }
}

export async function receivedStreamCadence(
  path,
  { ffprobePath = 'ffprobe', fps = 30, tailSeconds = SETTLE_TAIL_SECONDS } = {}
) {
  const stdout = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    path
  ])
  const pts = stdout
    .split(/\r?\n/)
    .map((line) => Number.parseFloat(line.split(',')[0]))
    .filter((value) => Number.isFinite(value))
  const end = pts.length > 0 ? Math.max(...pts) : 0
  const tail = cadenceFromPts(
    pts.filter((value) => value >= end - tailSeconds),
    fps
  )
  return { ...cadenceFromPts(pts, fps), bytes: statSync(path).size, tail: { tailSeconds, ...tail } }
}

/**
 * The plan's done check: stream drops under 1 % and every leg got frames.
 * At the cap the adaptive bitrate may overflow while it learns the uplink,
 * so the judgement is the run's tail: no overflow inside it, and every leg
 * delivering its frame rate without a hole viewers would notice.
 */
export function thinUplinkVerdict({
  variant,
  capped,
  dropShare,
  legs,
  streamSeconds = 0,
  lastOverflowAtSeconds = null,
  settleTailSeconds = SETTLE_TAIL_SECONDS
}) {
  const failures = []
  if (dropShare >= MAX_STREAM_DROP_SHARE) {
    failures.push(
      `${variant}: the bridge dropped ${(dropShare * 100).toFixed(1)} % of stream frames before encode (limit ${MAX_STREAM_DROP_SHARE * 100} %)`
    )
  }
  const settledAt = streamSeconds - settleTailSeconds
  if (capped && lastOverflowAtSeconds !== null && lastOverflowAtSeconds > settledAt) {
    failures.push(
      `${variant}: a leg still overflowed its FFmpeg fifo ${lastOverflowAtSeconds.toFixed(0)} s in, inside the last ${settleTailSeconds} s`
    )
  }
  for (const leg of legs) {
    if (!(leg.received?.frames > 0)) {
      failures.push(`${variant}: ${leg.label} received no video`)
      continue
    }
    const tail = leg.received.tail ?? leg.received
    if (capped && tail.fps < MIN_SETTLED_FPS) {
      failures.push(
        `${variant}: ${leg.label} viewers got ${tail.fps.toFixed(1)} fps over the last ${settleTailSeconds} s (limit ${MIN_SETTLED_FPS})`
      )
    }
    if (capped && tail.maxGapMs > MAX_RECEIVED_GAP_MS) {
      failures.push(
        `${variant}: ${leg.label} viewers saw a ${tail.maxGapMs} ms hole in the last ${settleTailSeconds} s (limit ${MAX_RECEIVED_GAP_MS} ms)`
      )
    }
  }
  return { pass: failures.length === 0, failures }
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdout += text
    })
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout)
      else rejectRun(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
  })
}
