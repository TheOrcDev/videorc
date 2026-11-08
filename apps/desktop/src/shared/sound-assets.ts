// Sound files (plan 189). The backend stores `<id>.wav` (48 kHz stereo s16,
// trimmed) in the managed `Sounds` dir beside `Screens` and `Banners`; only
// the basename reaches a renderer, never a path. Main serves it under the
// `videorc-asset://sound/<file>` host (`resolveManagedSoundFile`). Pure: no fs
// or electron, so the rules are verified in node.

/** The managed protocol host for sound files. */
export const SOUND_ASSET_HOST = 'sound'
/** The backend-managed folder under userData, beside `Screens`. */
export const SOUNDS_FOLDER = 'Sounds'
/** Longest basename the wire contract carries for a sound file. */
export const SOUND_FILE_NAME_MAX_CHARS = 255
/** A starter sound's slug (`airhorn`, `sad-trombone`). */
export const SOUND_STARTER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SOUND_STARTER_SLUG_MAX_CHARS = 32

/** A bare `.wav` basename: no separators, no parent hops, no leading dot. */
export function isSoundFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 4 &&
    value.length <= SOUND_FILE_NAME_MAX_CHARS &&
    value.endsWith('.wav') &&
    !value.startsWith('.') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.includes('\0')
  )
}

export function isSoundStarterSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SOUND_STARTER_SLUG_MAX_CHARS &&
    SOUND_STARTER_SLUG_PATTERN.test(value)
  )
}

/**
 * The managed URL the monitor loads a sound from:
 * `videorc-asset://sound/<basename>`. Takes the basename defensively, the way
 * `bannerAssetUrl` does.
 */
export function soundAssetUrl(file: string): string {
  const normalized = file.replace(/\\/g, '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return `videorc-asset://${SOUND_ASSET_HOST}/${encodeURIComponent(basename)}`
}
