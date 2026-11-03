// The hard-content pass asks 1080p60 to hold full cadence under per-frame
// noise, headroom proven on the hardware encoders. Real sessions on the
// OpenH264 software encoder run `-allow_skip_frames 1` on purpose
// (recording.rs, the #149 skip-on-overshoot posture; only the performance
// check turns it off), and OpenH264's bitrate rate control answers
// incompressible noise by skipping most frames. On that backend the hard
// combo relaxes only what frame skipping changes (frame count, cadence, and a
// container longer than its frames at the requested rate) and prints a WARN
// that names the cadence it held. Forced keyframes are never skipped, so the
// 2 s keyframe cadence and the A/V stop tail stay gated.

export const OPENH264_ENCODE_BACKEND = 'software-open-h264'

/**
 * The contract a combo is held to: 'stress' for a declared stress combo,
 * 'software-skip' for hard content encoded by OpenH264 with frame skipping
 * on, 'full' otherwise.
 */
export function hardContentContract({ stress, hardContent, encodeBackend }) {
  if (stress) return 'stress'
  if (hardContent && encodeBackend === OPENH264_ENCODE_BACKEND) return 'software-skip'
  return 'full'
}

/** The matrix gates with only the frame-skipping laws relaxed. */
export function softwareSkipGates(matrixGates) {
  return Object.freeze({
    ...matrixGates,
    frameCountTolerance: Number.POSITIVE_INFINITY,
    cadenceMismatchTolerancePct: Number.POSITIVE_INFINITY,
    maxDurationStretchRatio: Number.POSITIVE_INFINITY
  })
}

/** The WARN a software-skip combo carries instead of a cadence failure. */
export function softwareSkipWarning({ label, requestedFps, observedFps }) {
  const observed = Number.isFinite(observedFps) ? `${observedFps.toFixed(2)} fps` : 'unknown fps'
  return (
    `${label}: OpenH264 held ${observed} of ${requestedFps} under per-frame noise; ` +
    'frame skipping on overshoot is the software encoder posture, so cadence is not gated here'
  )
}
