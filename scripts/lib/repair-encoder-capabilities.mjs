// Fail-closed capability assessment for the repair encoder in a bundled FFmpeg.
//
// The post-recording repair once hardcoded GPL `libx264 -crf 18`; every shipped
// (LGPL-only) build rejected `-crf` with "Unrecognized option 'crf'" and users
// got an error toast after ordinary recordings. Dev never reproduced it because
// PATH ffmpeg (Homebrew, GPL) has libx264 — the same dev/bundled capability
// confound as the 0.9.23 rtmps/TLS failure. These helpers mirror the backend's
// probe (crates/videorc-backend/src/repair.rs) so packaging gates and smokes
// refuse a bundle whose ffmpeg cannot run a transcode repair.
//
// Pure parsing lives here (covered by test:scripts); running the binary is the
// caller's job.

/** Repair-encoder preference, mirroring RepairVideoEncoder in repair.rs:
 * quality-controllable software x264 first (dev/full builds), then the
 * platform hardware encoders the LGPL bundles ship. */
export const REPAIR_ENCODER_PREFERENCE = ['libx264', 'h264_videotoolbox', 'h264_mf']

/** The per-encoder quality args build_repair_args (repair.rs) emits, kept here
 * so the smoke exercises the exact command shape the app ships. */
export const REPAIR_ENCODER_ARGS = {
  libx264: ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-threads', '1'],
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-allow_sw', '1'],
  h264_mf: ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '90']
}

/** Encoders every shipped macOS ffmpeg must expose: the repair/record H.264
 * path, AAC for MP4 audio, and PCM for Noise Cleanup's MKV output policy. */
export const REQUIRED_MACOS_FFMPEG_ENCODERS = ['h264_videotoolbox', 'aac', 'pcm_s16le']

/** Audio filters required by Premium local creative transforms. `afftdn` is
 * built into the LGPL FFmpeg bundle and needs no separately licensed model. */
export const REQUIRED_MACOS_FFMPEG_FILTERS = ['afftdn']

/** Protocols every shipped macOS ffmpeg must expose. rtmps implies a TLS
 * backend was linked (static OpenSSL since 0.9.23); tls is listed separately
 * so a partial TLS wiring still fails loudly. */
export const REQUIRED_MACOS_FFMPEG_PROTOCOLS = ['rtmp', 'rtmps', 'tls']

/**
 * Parses encoder names from `ffmpeg -hide_banner -encoders` output. Lines look
 * like ` V....D libx264   H.264 ...`: a capability-flags field, then the name.
 */
export function parseEncoderNames(output) {
  const names = []
  for (const line of output.split('\n')) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 2) {
      continue
    }
    const [flags, name] = tokens
    const isFlagsField = /^[VASFXBDET.]+$/.test(flags) && /[^.]/.test(flags)
    if (isFlagsField && name !== '=') {
      names.push(name)
    }
  }
  return names
}

/** Picks the repair encoder the backend would select, or null when the binary
 * cannot run transcode repairs at all. */
export function selectRepairEncoder(encoderNames) {
  return REPAIR_ENCODER_PREFERENCE.find((name) => encoderNames.includes(name)) ?? null
}

function hasWord(output, word) {
  return new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, 'm').test(output)
}

/**
 * Assesses `ffmpeg -protocols` / `ffmpeg -encoders` output against the macOS
 * bundle's required capability set (streaming TLS + repair/record encoders).
 * Returns `{ ok, missing }` with `protocol:<name>` / `encoder:<name>` entries.
 */
export function assessMacosFfmpegCapabilities({
  protocolsOutput = '',
  encodersOutput = '',
  filtersOutput = ''
}) {
  const missing = []
  for (const protocol of REQUIRED_MACOS_FFMPEG_PROTOCOLS) {
    if (!hasWord(protocolsOutput, protocol)) {
      missing.push(`protocol:${protocol}`)
    }
  }
  for (const encoder of REQUIRED_MACOS_FFMPEG_ENCODERS) {
    if (!hasWord(encodersOutput, encoder)) {
      missing.push(`encoder:${encoder}`)
    }
  }
  for (const filter of REQUIRED_MACOS_FFMPEG_FILTERS) {
    if (!hasWord(filtersOutput, filter)) {
      missing.push(`filter:${filter}`)
    }
  }
  return { ok: missing.length === 0, missing }
}

/**
 * Runs a bundled ffmpeg and assesses the macOS capability set. Callers must
 * only invoke this with a binary the host can execute.
 */
export function probeMacosFfmpegCapabilities(ffmpegPath, { execFileSync }) {
  const run = (flag) =>
    execFileSync(ffmpegPath, ['-hide_banner', flag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  return assessMacosFfmpegCapabilities({
    protocolsOutput: run('-protocols'),
    encodersOutput: run('-encoders'),
    filtersOutput: run('-filters')
  })
}
