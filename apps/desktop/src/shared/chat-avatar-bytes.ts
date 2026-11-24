// Cached chat images (avatars, emotes, Twitch GIFs) live in the backend since
// plan 220 S1.6a: `chatImages.cache` fetches an allowlisted image once and
// answers with this run's loopback route for the file,
// `http://127.0.0.1:<port>/chat-images/<file>?key=<key>`, which a window's
// <img> loads. The highlight card still reads the bytes over IPC (plan 095,
// S3): it paints on an OffscreenCanvas, and a cross-origin <img> would taint
// it so `convertToBlob` throws. Main fetches them from the same route. Pure
// parsing lives here so the preload contract, main and the renderer agree.

/** Refuse to hand the card a cached image past this size: the backend's
 * avatar cap (the web's 2 MB account-avatar upload cap). */
export const CHAT_AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** The path every cached chat image is served under (`chat_images.rs`). */
export const CHAT_IMAGE_ROUTE_PATH = '/chat-images/'

/** `<32 hex of sha256(url)>.<extension>`: the only names the backend serves. */
const CHAT_IMAGE_FILE_NAME = /^[a-f0-9]{32}\.(?:png|jpg|jpeg|webp|gif|img)$/

const CHAT_IMAGE_ROUTE_URL =
  /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/chat-images\/([a-f0-9]{32}\.(?:png|jpg|jpeg|webp|gif|img))\?key=([a-f0-9]{32})$/

export interface ChatImageRoute {
  port: number
  fileName: string
  key: string
}

/**
 * The parts of a backend chat image URL, or null for anything else: another
 * host or scheme, another path, a name that is not a cache file name, extra
 * query parameters or a key that is not 32 hex. Exact, so main never fetches
 * a URL a renderer composed.
 */
export function chatImageRoute(localUrl: unknown): ChatImageRoute | null {
  if (typeof localUrl !== 'string' || localUrl.length > 256) return null
  const match = CHAT_IMAGE_ROUTE_URL.exec(localUrl)
  if (!match) return null
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { port, fileName: match[2]!, key: match[3]! }
}

/** The route URL for one cached file on a backend: what `chatImageRoute`
 * parses, rebuilt from its parts. */
export function chatImageRouteUrl(route: ChatImageRoute): string {
  if (!CHAT_IMAGE_FILE_NAME.test(route.fileName) || !/^[a-f0-9]{32}$/.test(route.key)) {
    throw new Error('Not a chat image route.')
  }
  return `http://127.0.0.1:${route.port}${CHAT_IMAGE_ROUTE_PATH}${route.fileName}?key=${route.key}`
}

/** Bytes a renderer may receive for one cached image: present and within the cap. */
export function chatAvatarBytesWithinCap(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength <= CHAT_AVATAR_MAX_BYTES
}
