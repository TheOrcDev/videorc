// The libavfilter filters the legacy FFmpeg camera key chain names (plan
// 227), mirroring `ffmpegFilters` in protocol-fixtures/chroma-key.json and
// `camera_chroma_key_filter` in crates/videorc-backend/src/recording.rs: the
// green-screen key (`chromakey`), its spill suppression (`despill`) and Hide
// edges, which clear each hidden side with a transparent `drawbox`. All three
// are LGPL and in every shipped bundle; every platform's package gate requires
// them so a bundle that cannot key fails before it ships, and the backend test
// `camera_chroma_key_chain_names_only_bundle_policy_filters` keeps the chain
// inside this list.
export const CHROMA_KEY_FFMPEG_FILTERS = ['chromakey', 'despill', 'drawbox']
