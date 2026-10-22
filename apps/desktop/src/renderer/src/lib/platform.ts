// Renderer-side platform awareness. The main process reports the real
// platform through runtimeInfo.platform ('darwin' | 'win32' | 'linux' | …);
// components read it to pick OS-correct copy, permission flows, and keyboard
// glyphs. Before runtimeInfo arrives (and in the windows that never get it)
// the platform the theme bootstrap wrote on <html> before the first paint
// stands in, so nothing flashes "Ctrl" on a Mac (plan 174 S1.2).

import {
  acceleratorAriaKeyShortcuts,
  acceleratorLabel,
  commandModifierHeld
} from '../../../shared/accelerator-format'

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

// A glyph authored mac-style, for the platform: ⌘ → Ctrl, ⌥ → Alt, ⇧ → Shift.
// Shortcuts are authored as accelerators now (lib/shortcuts.ts) and shown
// through ShortcutKeys / shortcutLabel; this stays for a lone modifier.
const NON_MAC_KEY_GLYPHS: Record<string, string> = {
  '⌘': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift'
}

/** Translates a single displayed key glyph for the platform (⌘ → Ctrl, etc.). */
export function displayKeyGlyph(glyph: string, platform: string | undefined): string {
  if (appPlatform(currentPlatform(platform)) === 'darwin') {
    return glyph
  }
  return NON_MAC_KEY_GLYPHS[glyph] ?? glyph
}

// Non-React callers (sonner toasts) cannot read runtimeInfo. Electron's
// user agent names the host OS reliably, so it stands in ONLY when no
// explicit platform was passed.
function detectedPlatform(): string | undefined {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Macintosh')) {
    return 'darwin'
  }
  return userAgent ? 'linux' : undefined
}

/**
 * The platform to print keys for: the one passed (runtimeInfo), else the one
 * theme-bootstrap.js / window-theme-bootstrap.js set on <html> before the
 * first paint, else the user agent.
 */
export function currentPlatform(platform?: string): string | undefined {
  if (platform) return platform
  const bootstrapped =
    typeof document === 'undefined' ? undefined : document.documentElement?.dataset.platform
  return bootstrapped || detectedPlatform()
}

/** A shortcut in running copy and titles: "⇧⌘J" on macOS, "Ctrl+Shift+J" elsewhere. */
export function shortcutLabel(accelerator: string, platform?: string): string {
  return acceleratorLabel(accelerator, currentPlatform(platform))
}

/** `aria-keyshortcuts` for an accelerator: "Meta+K" on macOS, "Control+K" elsewhere. */
export function shortcutAriaKeys(accelerator: string, platform?: string): string {
  return acceleratorAriaKeyShortcuts(accelerator, currentPlatform(platform))
}

/** A shell shortcut's modifier: ⌘ alone on macOS, Ctrl elsewhere (A-17). */
export function isCommandKey(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform?: string
): boolean {
  return commandModifierHeld(
    { meta: event.metaKey, control: event.ctrlKey },
    currentPlatform(platform)
  )
}

/** Label for "reveal this file in the OS file manager" actions. */
export function revealInFileManagerLabel(
  platform: string | undefined = detectedPlatform()
): string {
  switch (appPlatform(platform)) {
    case 'darwin':
      return 'Show in Finder'
    case 'win32':
      return 'Show in Explorer'
    default:
      return 'Show in folder'
  }
}

/** The OS's name for where a deleted file goes: a Library delete moves there (plan 174 E-2). */
export function trashName(platform: string | undefined = detectedPlatform()): string {
  return appPlatform(platform) === 'win32' ? 'Recycle Bin' : 'Trash'
}
