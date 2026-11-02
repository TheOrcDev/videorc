// The libavfilter filters the legacy FFmpeg camera look chain names (plan
// 213 I), mirroring `CAMERA_LOOK_FFMPEG_FILTERS` in
// crates/videorc-backend/src/recording.rs and `ffmpegFilters` in
// protocol-fixtures/camera-look.json. The chain converts the camera layer to
// full-range BT.709 YUV, grades brightness and contrast on Y and saturation
// on U and V through `lutyuv`'s per-plane lookup tables, and converts back.
//
// 0.18.0 graded with FFmpeg's `eq` instead. `eq` is GPL-only
// (`eq_filter_deps="gpl"` in FFmpeg's configure) and every FFmpeg Videorc
// ships is an LGPL build, so a recording or stream on the legacy path with a
// non-neutral look failed to start with `No such filter: 'eq'`. The Homebrew
// GPL ffmpeg on the dev host has `eq`, which is why the parity test passed.
// Every platform's package gate requires these filters so a bundle that
// cannot grade the camera fails before it ships, and the backend test
// `camera_look_chain_names_only_bundle_policy_filters` keeps the chain inside
// this list so a GPL filter cannot slip back in.
export const CAMERA_LOOK_FFMPEG_FILTERS = ['format', 'scale', 'lutyuv']

/** The GPL-only filter the shipped bundles do not have; no required list and
 * no camera look chain may name it. */
export const GPL_ONLY_EQ_FILTER = 'eq'
