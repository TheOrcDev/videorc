//! Every Clean cut tuning number, in one place (plan 119 decision 16
//! defaults). The owner's S0 calibration on real recordings is still owed:
//! change the numbers here and nowhere else.

/// Head: cut until this long before the first kept word.
pub const HEAD_LEAD_MS: u64 = 300;
/// Tail: cut from this long after the last kept word.
pub const TAIL_TRAIL_MS: u64 = 600;
/// A wordless, silent gap longer than this is shortened ...
pub const SILENCE_MIN_GAP_MS: u64 = 1_000;
/// ... to this much (the middle of the gap is removed).
pub const SILENCE_KEEP_MS: u64 = 400;
/// A wordless gap that is NOT silent (music, game sound, typing) is
/// shortened only when longer than this ...
pub const NOISY_GAP_MIN_MS: u64 = 4_000;
/// ... and then to this much.
pub const NOISY_GAP_KEEP_MS: u64 = 1_500;
/// Padding on each side of a filler word, clamped to the neighbouring words.
pub const FILLER_PAD_MS: u64 = 30;
/// Retakes and false starts at or above this confidence are applied; lower
/// ones are kept as switched-off suggestions.
pub const DROP_CONFIDENCE_ON: f64 = 0.6;
/// A kept sliver shorter than this between two removals is absorbed.
pub const SLIVER_MAX_MS: u64 = 250;
/// Silence is below the lower of this floor ...
pub const SILENCE_FLOOR_DBFS: f64 = -45.0;
/// ... and this far under the median speech level.
pub const SILENCE_BELOW_SPEECH_DB: f64 = 18.0;
/// The share of a gap's frames that must sit below the threshold for the
/// gap to count as silent (a click or a chair creak must not make a silence
/// "music").
pub const SILENCE_GAP_PERCENTILE: f64 = 0.9;
/// English v1 filler lexicon. The server tags the same words; the desktop
/// checks them again (lowercased, punctuation stripped).
pub const FILLER_LEXICON: &[&str] = &["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm"];
/// A pause at least this long ends a sentence.
pub const SENTENCE_PAUSE_MS: u64 = 700;
/// A sentence never holds more words than this.
pub const SENTENCE_MAX_WORDS: usize = 40;
/// The analysis job's input caps (docs/clean-cut-contract.md, part C).
pub const ANALYSIS_MAX_SEGMENTS: usize = 25_000;
pub const ANALYSIS_MAX_SEGMENT_CHARS: usize = 2_000;
pub const ANALYSIS_MAX_TOTAL_CHARS: usize = 1_200_000;

/// RMS frame length for silence detection and chunk cut points.
pub const RMS_FRAME_MS: u64 = 50;
/// The extracted audio: PCM s16le mono at this rate.
pub const SAMPLE_RATE: u32 = 16_000;

// Chunked verbatim transcription (docs/clean-cut-contract.md, part A).
/// A chunk is at most this long ...
pub const CHUNK_MAX_MS: u64 = 120_000;
/// ... and at most this many WAV bytes (120 s of 16 kHz s16le is 3 840 044).
pub const CHUNK_MAX_BYTES: usize = 4_000_000;
/// Each chunk ends at the quietest frame inside the last part of its window.
pub const CHUNK_CUT_SEARCH_MS: u64 = 10_000;
/// Consecutive chunks overlap by this much; stitching splits the overlap.
pub const CHUNK_OVERLAP_MS: u64 = 1_000;
/// Chunk uploads in flight at once.
pub const CHUNK_UPLOADS_IN_FLIGHT: usize = 2;
/// Attempts per chunk before a transport or server failure fails the job.
pub const CHUNK_UPLOAD_ATTEMPTS: u32 = 3;

/// Eligibility (decision 11): recordings shorter than this are refused.
pub const MIN_SOURCE_DURATION_MS: u64 = 10_000;

// Condensed mode (contract part C).
pub const CONDENSED_DEFAULT_TARGET_SECONDS: u32 = 900;
pub const CONDENSED_MIN_TARGET_SECONDS: u32 = 120;
pub const CONDENSED_MAX_TARGET_SECONDS: u32 = 3_600;

/// How long the analysis job may run on the server before the desktop gives
/// up polling. A 4-hour recording is about 25 windows.
pub const ANALYSIS_POLL_TIMEOUT_SECS: u64 = 90 * 60;

// Render (plan 119 S13, decisions 16 and 17).
/// Audio fade at each internal join; video cuts are hard. Calibrate after S0.
pub const JOIN_FADE_MS: u64 = 10;
/// Kept ranges one FFmpeg pass may carry: every range is a `split` output, a
/// `trim`, an `atrim` per audio track and a `concat` input. Beyond this the
/// render refuses with a plain message instead of a graph FFmpeg chokes on.
pub const RENDER_MAX_KEPT_RANGES: usize = 2_000;
/// A filter graph longer than this is written to a file and passed with
/// `-/filter_complex <file>` (FFmpeg 7+), never on the command line.
pub const RENDER_GRAPH_INLINE_MAX_BYTES: usize = 4_096;
/// Free space the render needs before it starts: this many tenths of the
/// source size (1.2x).
pub const RENDER_FREE_SPACE_TENTHS: u64 = 12;
/// The output video bitrate never drops under this, whatever the source says.
pub const RENDER_MIN_VIDEO_KBPS: u32 = 2_000;
/// Sources with no usable stream bitrate use this share of the container
/// bitrate (per mille).
pub const RENDER_FORMAT_BITRATE_PER_MILLE: u64 = 950;
/// AAC per audio track, or the source track's bitrate when that is lower.
pub const RENDER_MAX_AUDIO_KBPS: u32 = 192;
/// Progress events while rendering are throttled to this interval.
pub const RENDER_PROGRESS_INTERVAL_MS: u64 = 250;
/// The output's video and audio durations may differ from the kept duration
/// by at most this many frames (decision 17).
pub const RENDER_DURATION_TOLERANCE_FRAMES: u64 = 1;
/// Minutes a worker waits for the source's post-recording quality gate before
/// binding the source identity (S15); past this it proceeds and relies on the
/// identity check to re-run if the gate repairs the file later.
pub const GATE_WAIT_MAX_SECS: u64 = 30 * 60;
/// How often the gate wait re-checks.
pub const GATE_WAIT_POLL_MS: u64 = 2_000;
/// Re-timed SRT built from words when the source has no `.srt`: cue caps.
pub const SRT_CUE_MAX_MS: u64 = 7_000;
pub const SRT_CUE_MAX_CHARS: usize = 42;
