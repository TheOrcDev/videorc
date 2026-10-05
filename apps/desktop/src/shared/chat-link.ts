// The one rule for a chat link Videorc will open (plan 151, D14). Shared by
// the renderer, which only offers links that pass it, the IPC contract, and
// main, which checks every call again before `shell.openExternal`.

/** Longer than this is not a link anyone pasted on purpose. */
export const MAX_CHAT_LINK_LENGTH = 2048

/**
 * The URL to open, or null. Only `http:` and `https:`, never with a username
 * or password, never longer than {@link MAX_CHAT_LINK_LENGTH}.
 */
export function openableChatLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CHAT_LINK_LENGTH) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password || !parsed.hostname) return null
  return parsed.toString()
}
