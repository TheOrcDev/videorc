// Every stream platform, in Livestream order. The StreamPlatform union, the
// wire enum and every per-platform list cap derive from this one list, so a
// new platform can't be half-added again (plan 206: seven hard-coded
// `maxLength: 7` caps would have failed every audience, viewer and co-host
// event for an 8th). The Rust mirror is `StreamPlatform` in
// crates/videorc-backend/src/streaming.rs.
export const STREAM_PLATFORMS = [
  'youtube',
  'twitch',
  'kick',
  'x',
  'facebook',
  'tiktok',
  'instagram',
  'custom'
] as const

export type StreamPlatform = (typeof STREAM_PLATFORMS)[number]

export function isStreamPlatform(value: unknown): value is StreamPlatform {
  return typeof value === 'string' && (STREAM_PLATFORMS as readonly string[]).includes(value)
}
