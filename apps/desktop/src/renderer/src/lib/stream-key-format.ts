// Stream-key shape heuristics. Pure and deliberately conservative: they only
// flag a paste when it confidently matches ANOTHER platform's well-known key
// format (the "Twitch key pasted into the YouTube field" accident). They never
// block a save — platforms change formats, and a warned save is still a save.

import type { StreamPlatform } from '@/lib/backend'

// Twitch keys look like `live_123456789_AbCdEf...`.
const TWITCH_KEY_PATTERN = /^live_\d+_[A-Za-z0-9]+$/
// YouTube keys are dash-grouped quads like `abcd-efgh-ijkl-mnop` (4-6 groups).
const YOUTUBE_KEY_PATTERN = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3,5}$/i
// Kick keys look like `sk_us-west-2_AbCd…_EfGh…`: an `sk_` prefix, an AWS
// region, then two opaque segments. Kept permissive on segment lengths.
const KICK_KEY_PATTERN = /^sk_[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+_[A-Za-z0-9]+$/

/** Best-effort guess at which platform a pasted key belongs to. */
export function detectStreamKeyPlatform(key: string): StreamPlatform | null {
  const trimmed = key.trim()
  if (TWITCH_KEY_PATTERN.test(trimmed)) {
    return 'twitch'
  }
  if (YOUTUBE_KEY_PATTERN.test(trimmed)) {
    return 'youtube'
  }
  if (KICK_KEY_PATTERN.test(trimmed)) {
    return 'kick'
  }
  return null
}

const PLATFORM_LABEL: Record<string, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  x: 'X',
  custom: 'Custom RTMP'
}

/**
 * A warning when the pasted key confidently looks like it belongs to a
 * different platform than the field it is being saved to, else null.
 */
export function streamKeyPlatformMismatch(
  fieldPlatform: StreamPlatform,
  key: string
): string | null {
  const detected = detectStreamKeyPlatform(key)
  if (!detected || detected === fieldPlatform) {
    return null
  }
  const detectedLabel = PLATFORM_LABEL[detected] ?? detected
  const fieldLabel = PLATFORM_LABEL[fieldPlatform] ?? fieldPlatform
  return `This looks like a ${detectedLabel} stream key, but you are saving it to ${fieldLabel}.`
}

/** Client-side masked tail, mirroring the backend's hint format. */
export function streamKeyTailHint(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length < 8) {
    return '••••'
  }
  return `••••${trimmed.slice(-4)}`
}
