// Plan 076 A: an output stall must never retire a healthy microphone.
//
// FFmpeg (8.1.1, threaded scheduler) stops draining the session audio FIFO
// while its video input is late. The owner's 2026-09-28 live stream lost its
// microphone for good that way: the bus fell behind, refused every buffer for
// 2 s, and retired the producer. `smoke:output-stall` reproduces the stall
// through the real pipeline (a one-shot VideoToolbox FIFO writer pause) with
// the debug synthetic microphone (a continuous 440 Hz tone) and hands the
// decoded windows and health events to this gate.

export const OUTPUT_STALL_GATES = Object.freeze({
  /** A 440 Hz amplitude at or above this is the synthetic microphone. */
  toneAmplitude: 0.03,
  /** The microphone must be back this soon after the pause ends. */
  recoverWithinSeconds: 2.5,
  /** Windows this close to either end of the file are not judged. */
  edgeSeconds: 1
})

const SOURCE_LOSS_CODES = new Set(['microphone-input-lost', 'microphone-timeline-lost'])

/**
 * @param {object} input
 * @param {{ startSeconds: number, durationSeconds: number, amplitude440: number }[]} input.windows
 *   consecutive decoded windows covering the file
 * @param {{ code: string, message?: string }[]} input.health health events of the session
 * @param {number} input.pauseStartSeconds file time the video writer paused (frames / fps)
 * @param {number} input.pauseSeconds how long it paused
 * @param {number} input.fileSeconds the decoded audio length
 */
export function evaluateOutputStall({
  windows,
  health,
  pauseStartSeconds,
  pauseSeconds,
  fileSeconds,
  gates = OUTPUT_STALL_GATES
}) {
  const failures = []
  const tone = (window) => window.amplitude440 >= gates.toneAmplitude
  const judged = windows.filter(
    (window) =>
      window.startSeconds >= gates.edgeSeconds &&
      window.startSeconds + window.durationSeconds <= fileSeconds - gates.edgeSeconds
  )
  const before = judged.filter(
    (window) => window.startSeconds + window.durationSeconds <= pauseStartSeconds
  )
  if (before.length === 0) failures.push('No decoded window precedes the pause.')
  const silentBefore = before.filter((window) => !tone(window))
  if (silentBefore.length > 0) {
    failures.push(
      `The microphone was already silent before the pause at ${silentBefore
        .map((window) => `${window.startSeconds.toFixed(1)} s`)
        .join(', ')}.`
    )
  }
  const deadline = pauseStartSeconds + pauseSeconds + gates.recoverWithinSeconds
  const afterPause = judged.filter(
    (window) => window.startSeconds >= pauseStartSeconds + pauseSeconds
  )
  const resumedAt = afterPause.find(tone)?.startSeconds
  if (resumedAt === undefined) {
    failures.push('The microphone never came back after the stall (the 0.9.120 failure).')
  } else if (resumedAt > deadline) {
    failures.push(
      `The microphone came back at ${resumedAt.toFixed(1)} s, later than ${deadline.toFixed(1)} s.`
    )
  } else {
    const silentAfter = afterPause.filter(
      (window) => window.startSeconds >= resumedAt && !tone(window)
    )
    if (silentAfter.length > 0) {
      failures.push(
        `The microphone dropped out again after the stall at ${silentAfter
          .map((window) => `${window.startSeconds.toFixed(1)} s`)
          .join(', ')}.`
      )
    }
  }
  const losses = health.filter((event) => SOURCE_LOSS_CODES.has(event.code))
  if (losses.length > 0) {
    failures.push(
      `A healthy microphone was reported lost: ${losses.map((event) => event.code).join(', ')}.`
    )
  }
  const stalls = health.filter((event) => event.code === 'audio-output-stalled')
  if (stalls.length === 0) {
    failures.push(
      'No audio-output-stalled event: the pause never stalled the audio output, so this run proves nothing.'
    )
  }
  return { failures, resumedAt: resumedAt ?? null, stallEvents: stalls.length }
}
