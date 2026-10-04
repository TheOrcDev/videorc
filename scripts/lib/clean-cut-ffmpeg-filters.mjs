// The libavfilter filters Clean cut's render needs (plan 119 S13, mirroring
// `REQUIRED_FILTERS` in crates/videorc-backend/src/clean_cut/render.rs). The
// one-pass render splits the decoded streams, trims each kept range by frame
// and sample, fades the audio at every internal join, concatenates and
// converts the pixel format for the encoder. Every platform's package gate
// requires them so a bundle that cannot render a clean cut fails before it
// ships, the same way `afftdn` is required for Noise Cleanup.
export const CLEAN_CUT_FFMPEG_FILTERS = [
  'trim',
  'atrim',
  'concat',
  'afade',
  'split',
  'asplit',
  'setpts',
  'asetpts',
  'format'
]
