// The hard-content pass asks 1080p60 to hold full cadence under per-frame
// noise, headroom proven on the hardware encoders. Real sessions on the
// OpenH264 software encoder run `-allow_skip_frames 1` on purpose
// (recording.rs, the #149 skip-on-overshoot posture; only the performance
// check turns it off), and OpenH264's bitrate rate control answers
// incompressible noise by skipping most frames. On that backend the hard
// combo is held to the stress contract instead (survival, preview liveness,
// colorimetry, level), with a WARN that names the skipped cadence, so the
// gate never demands a cadence the product deliberately does not promise.

export const OPENH264_ENCODE_BACKEND = 'software-open-h264'

/**
 * Whether a combo runs under the stress contract: a declared stress combo,
 * or hard content encoded by OpenH264 with frame skipping on.
 */
export function hardContentStressReason({ stress, hardContent, encodeBackend }) {
  if (stress) return 'stress combo'
  if (hardContent && encodeBackend === OPENH264_ENCODE_BACKEND) {
    return 'OpenH264 skips frames on incompressible noise by design (allow_skip_frames, #149)'
  }
  return null
}

/** The WARN a software-skip combo carries instead of a cadence failure. */
export function softwareSkipWarning({ label, requestedFps, observedFps }) {
  const observed = Number.isFinite(observedFps) ? `${observedFps.toFixed(2)} fps` : 'unknown fps'
  return (
    `${label}: OpenH264 held ${observed} of ${requestedFps} under per-frame noise; ` +
    'frame skipping on overshoot is the software encoder posture, so cadence is not gated here'
  )
}
