// Fail-closed capability assessment for the bundled Windows FFmpeg.
//
// The 0.9.23 macOS release shipped an ffmpeg without a TLS stack: rtmps://
// connects stalled silently and X playback starved at 0.0 fps — file-exists
// preflights cannot catch that class of failure. This module asserts the
// capabilities the product actually depends on from `ffmpeg -protocols` /
// `ffmpeg -encoders` output, so the Windows package gate refuses a build
// whose ffmpeg cannot stream rtmps or encode H.264.
//
// Pure parsing lives here (covered by test:scripts); running the .exe is the
// caller's job and only possible on a Windows host.

import { CLEAN_CUT_FFMPEG_FILTERS } from './clean-cut-ffmpeg-filters.mjs'

/** Protocols every shipped Windows ffmpeg must expose. rtmps implies a TLS
 * backend was linked (schannel on BtbN win64 builds); tls is listed
 * separately so a partial TLS wiring still fails loudly. */
export const REQUIRED_WINDOWS_FFMPEG_PROTOCOLS = ['rtmp', 'rtmps', 'tls']

/** Encoders the Windows recording/stream path selects: MediaFoundation H.264,
 * AAC for MP4 audio, and PCM for Noise Cleanup's MKV output policy. Clean cut
 * renders with `h264_mf` too and falls back to `libopenh264`, which is
 * reported with the optional set below rather than required. */
export const REQUIRED_WINDOWS_FFMPEG_ENCODERS = ['h264_mf', 'aac', 'pcm_s16le']
/** `afftdn` for Noise Cleanup plus the trim/concat set Clean cut renders with
 * (plan 119 S13). */
export const REQUIRED_WINDOWS_FFMPEG_FILTERS = ['afftdn', ...CLEAN_CUT_FFMPEG_FILTERS]

/** Encoders the app uses when present and lives without when absent: Intel
 * Quick Sync for the Windows raw path (plan 090 C). Reported, never required,
 * so a future pin without it degrades to software instead of failing the
 * package gate. */
export const OPTIONAL_WINDOWS_FFMPEG_ENCODERS = ['h264_qsv', 'libopenh264']

function hasWord(output, word) {
  return new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, 'm').test(output)
}

/**
 * Assesses `ffmpeg -protocols` and `ffmpeg -encoders` output against the
 * required capability set. Returns `{ ok, missing }` where `missing` entries
 * are `protocol:<name>` / `encoder:<name>` strings suitable for error copy.
 */
export function assessWindowsFfmpegCapabilities({
  protocolsOutput = '',
  encodersOutput = '',
  filtersOutput = ''
}) {
  const missing = []
  for (const protocol of REQUIRED_WINDOWS_FFMPEG_PROTOCOLS) {
    if (!hasWord(protocolsOutput, protocol)) {
      missing.push(`protocol:${protocol}`)
    }
  }
  for (const encoder of REQUIRED_WINDOWS_FFMPEG_ENCODERS) {
    if (!hasWord(encodersOutput, encoder)) {
      missing.push(`encoder:${encoder}`)
    }
  }
  for (const filter of REQUIRED_WINDOWS_FFMPEG_FILTERS) {
    if (!hasWord(filtersOutput, filter)) {
      missing.push(`filter:${filter}`)
    }
  }
  const optionalMissing = OPTIONAL_WINDOWS_FFMPEG_ENCODERS.filter(
    (encoder) => !hasWord(encodersOutput, encoder)
  ).map((encoder) => `encoder:${encoder}`)
  return { ok: missing.length === 0, missing, optionalMissing }
}

/**
 * Runs the bundled ffmpeg.exe and assesses its capabilities. Windows-only:
 * the .exe cannot execute on the macOS cross-check host, so callers skip
 * (with a printed note, never silently) off-Windows.
 */
export function probeWindowsFfmpegCapabilities(ffmpegPath, { execFileSync }) {
  const run = (flag) =>
    execFileSync(ffmpegPath, ['-hide_banner', flag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  return assessWindowsFfmpegCapabilities({
    protocolsOutput: run('-protocols'),
    encodersOutput: run('-encoders'),
    filtersOutput: run('-filters')
  })
}
