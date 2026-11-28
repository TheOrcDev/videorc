// Which encoder-bridge video outputs carry a presentation time per frame, and
// what a take's duplicate-PTS gate should be for each.
//
// `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT` picks how the backend hands VideoToolbox
// frames to FFmpeg (`parse_encoder_bridge_video_output` in recording.rs):
//
// - MPEG-TS (the macOS default since plan 023 L1, `videotoolbox-h264-mpegts`):
//   every access unit is written with the PTS VideoToolbox gave it, so the take
//   keeps the capture clock however the frames are delivered. A bursty writer
//   or a slow reader cannot stamp two frames alike.
// - Annex-B (`videotoolbox-h264`, `h264`, `annex-b`, `annexb`, kept "for
//   diagnosis"): raw H.264 has no timestamps, and the bridge writes the bytes
//   only (`VideoToolboxH264PipeWriter::AnnexB`), so FFmpeg stamps each frame
//   with the wall-clock time it READ it (`-use_wallclock_as_timestamps 1`).
//   Frames the writer delivers in a burst are read, and stamped, together:
//   2026-11-28 takes of this output carry 61-155 near-zero inter-frame deltas
//   (runs of 2-18 frames on one stamp); the MPEG-TS takes of the same scene
//   carry none.
//
// So duplicate PTS is a defect in an MPEG-TS take (the gate is exactly zero) and
// a known property of an Annex-B take (reported, not gated). Every other gate
// (decode uniqueness, frame count, A/V) still applies to both.

const ANNEX_B_OUTPUTS = new Set(['videotoolbox-h264', 'h264', 'annex-b', 'annexb'])

/** True when the setting selects the timestamp-less Annex-B output. */
export function bridgeOutputStampsByArrival(setting) {
  const normalized = String(setting ?? '')
    .trim()
    .toLowerCase()
  return ANNEX_B_OUTPUTS.has(normalized)
}

/**
 * The `analyzeRecording` gates for a take's duplicate PTS under `setting`.
 * Exactly zero where frames carry their own PTS; not gated where FFmpeg stamps
 * them on arrival.
 */
export function duplicatePtsGatesForBridgeOutput(setting) {
  return bridgeOutputStampsByArrival(setting)
    ? {
        maxDuplicatePtsCount: Number.POSITIVE_INFINITY,
        maxDuplicatePtsRun: Number.POSITIVE_INFINITY
      }
    : { maxDuplicatePtsCount: 0, maxDuplicatePtsRun: 1 }
}

/** The note a take of the Annex-B output prints in place of a gate failure. */
export function arrivalStampedNote(duplicateCount, maxRun) {
  return (
    `the Annex-B output stamps frames when FFmpeg reads them, not when they were captured, ` +
    `so ${duplicateCount ?? 0} near-zero inter-frame delta(s) (longest same-stamp run ${maxRun ?? 1}) ` +
    `are expected here and not gated; the default MPEG-TS output carries VideoToolbox's own PTS ` +
    `and must have none`
  )
}
