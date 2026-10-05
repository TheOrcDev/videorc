// Twitch GIF Keyboard assets (plan 155). Twitch requires the `gif.url` it
// sends to be used unmodified, so Videorc cannot build the URL the way it
// does for emotes. Instead the URL is gated three times with this one rule:
// the backend when it parses the fragment (`twitch_chat.rs`, the Rust twin of
// `twitchGifAssetUrl`), the IPC contract, and main before it fetches.

/** Hosts a GIF asset may come from: GIPHY's media CDNs (`media0-4.giphy.com`,
 * `i.giphy.com`) and Twitch's own CDN. Mirrors `TWITCH_GIF_ASSET_HOSTS` in
 * `crates/videorc-backend/src/twitch_chat.rs`; change both together. */
export const TWITCH_GIF_ASSET_HOST_SUFFIXES = ['giphy.com', 'static-cdn.jtvnw.net'] as const

/** Longer than this is not a GIF asset URL (the chat-link bound). */
export const MAX_CHAT_GIF_URL_LENGTH = 2048

/** A GIPHY rendition can run to several MB; the avatar cap (2 MB) would drop
 * most of them. Past this the title stays and one `too-large` line is logged. */
export const CHAT_GIF_MAX_BYTES = 8 * 1024 * 1024

/** GIF fetches never ride the highlight relay budget (4 s): a 5 MB file over
 * a slow link needs longer, and nothing on stream waits for it. */
export const CHAT_GIF_FETCH_TIMEOUT_MS = 15_000

/**
 * The GIF URL as sent, or null: `https:` only, no username or password, a
 * bounded length, and a host on {@link TWITCH_GIF_ASSET_HOST_SUFFIXES}.
 * Returned untouched (never `parsed.toString()`): Twitch's rule is the
 * exact string.
 */
export function twitchGifAssetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CHAT_GIF_URL_LENGTH) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  const host = parsed.hostname.toLowerCase()
  if (!host) return null
  const allowed = TWITCH_GIF_ASSET_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  )
  return allowed ? value : null
}

/**
 * A GIF's title from its fragment text. Twitch sends the GIPHY title in
 * brackets with a ` GIF` suffix (`[Y A Y Yes GIF]` → `Y A Y Yes`); any other
 * shape is returned as is, trimmed. The Rust twin is `gif_title`.
 */
export function gifTitle(text: string): string {
  const trimmed = text.trim()
  const inner = (
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  ).trim()
  if (inner.endsWith(' GIF')) {
    const title = inner.slice(0, -' GIF'.length).trim()
    if (title) return title
  }
  return inner
}

/** Settings → General → "GIFs in Twitch chat" (plan 155, D6). Mirrors
 * `TwitchGifMode` in `crates/videorc-backend/src/seventv.rs`. */
export const TWITCH_GIF_MODES = ['animated', 'still', 'off'] as const
export type TwitchGifMode = (typeof TWITCH_GIF_MODES)[number]
export const DEFAULT_TWITCH_GIF_MODE: TwitchGifMode = 'animated'

export function isTwitchGifMode(value: unknown): value is TwitchGifMode {
  return typeof value === 'string' && (TWITCH_GIF_MODES as readonly string[]).includes(value)
}

/**
 * How a GIF row draws given the setting and the OS motion preference: a
 * system set to reduce motion never animates, whatever the setting says.
 * Off stays off.
 */
export function effectiveTwitchGifMode(mode: TwitchGifMode, reducedMotion: boolean): TwitchGifMode {
  if (mode === 'animated' && reducedMotion) return 'still'
  return mode
}

export type ChatImageKind = 'gif' | 'webp' | 'png'

/**
 * What an image body is, by its magic bytes, or null. A host suffix as wide
 * as `giphy.com` also serves HTML pages; only a real image is cached. MP4 is
 * refused on purpose: an `<img>` cannot play it.
 */
export function sniffChatImage(bytes: Uint8Array): ChatImageKind | null {
  if (bytes.length < 12) return null
  const ascii = (start: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(start, start + length))
  const head6 = ascii(0, 6)
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  if (
    bytes[0] === 0x89 &&
    ascii(1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png'
  }
  return null
}
