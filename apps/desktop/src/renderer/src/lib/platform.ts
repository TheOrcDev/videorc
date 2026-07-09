// Renderer-side platform awareness. The main process reports the real
// platform through runtimeInfo.platform ('darwin' | 'win32' | 'linux' | …);
// components read it to pick OS-correct copy, permission flows, and keyboard
// glyphs. Defaults to 'darwin' only as a pre-runtimeInfo boot fallback — the
// value is replaced the moment runtimeInfo arrives.

export type AppPlatform = 'darwin' | 'win32' | 'other'

export function appPlatform(platform: string | undefined): AppPlatform {
  if (platform === 'darwin') {
    return 'darwin'
  }
  if (platform === 'win32') {
    return 'win32'
  }
  return 'other'
}

export function isMacPlatform(platform: string | undefined): boolean {
  return appPlatform(platform) === 'darwin'
}

export function isWindowsPlatform(platform: string | undefined): boolean {
  return appPlatform(platform) === 'win32'
}

/** Human name for the OS Settings app, for permission copy. */
export function osSettingsName(platform: string | undefined): string {
  switch (appPlatform(platform)) {
    case 'darwin':
      return 'System Settings'
    case 'win32':
      return 'Windows Settings'
    default:
      return 'system settings'
  }
}

// macOS uses ⌘ (Cmd) as the primary modifier; Windows/Linux use Ctrl. The
// keydown handlers already accept `metaKey || ctrlKey`, so only the DISPLAYED
// glyph needs translating. Shortcut data is authored with mac glyphs
// (shortcuts.ts) and rendered through this map.
const NON_MAC_KEY_GLYPHS: Record<string, string> = {
  '⌘': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift'
}

/** Translates a single displayed key glyph for the platform (⌘ → Ctrl, etc.). */
export function displayKeyGlyph(glyph: string, platform: string | undefined): string {
  if (appPlatform(platform) === 'darwin') {
    return glyph
  }
  return NON_MAC_KEY_GLYPHS[glyph] ?? glyph
}

/** Translates every glyph in a key sequence (shortcuts.ts `keys` arrays). */
export function displayKeyGlyphs(keys: readonly string[], platform: string | undefined): string[] {
  return keys.map((key) => displayKeyGlyph(key, platform))
}
