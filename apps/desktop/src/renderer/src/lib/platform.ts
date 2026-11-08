import {
  acceleratorAriaKeyShortcuts,
  acceleratorLabel,
  commandModifierHeld
} from '@/lib/accelerator'

// Platform awareness for copy and keyboard glyphs. Pass the real platform
// when the app knows it ('darwin' | 'win32' | 'linux' | …; Electron's
// process.platform). Without one, `data-platform` on <html> (set before the
// first paint) stands in, then the user agent, so nothing flashes "Ctrl" on
// a Mac.

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
export function osSettingsName(platform?: string): string {
  switch (appPlatform(currentPlatform(platform))) {
    case 'darwin': {
      return 'System Settings'
    }
    case 'win32': {
      return 'Windows Settings'
    }
    default: {
      return 'system settings'
    }
  }
}

// A glyph authored mac-style, for the platform: ⌘ → Ctrl, ⌥ → Alt, ⇧ → Shift.
// Shortcuts are authored as accelerators and shown through ShortcutKeys /
// shortcutLabel; this stays for a lone modifier.
const NON_MAC_KEY_GLYPHS: Record<string, string> = {
  '⇧': 'Shift',
  '⌘': 'Ctrl',
  '⌥': 'Alt'
}

/** Translates a single displayed key glyph for the platform (⌘ → Ctrl, etc.). */
export function displayKeyGlyph(glyph: string, platform: string | undefined): string {
  if (appPlatform(currentPlatform(platform)) === 'darwin') {
    return glyph
  }
  return NON_MAC_KEY_GLYPHS[glyph] ?? glyph
}

// Non-React callers (toasts) cannot read app state. The user agent names the
// host OS reliably enough, so it stands in ONLY when no explicit platform was
// passed.
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
 * The platform to print keys for: the one passed, else `data-platform` on
 * <html>, else the user agent.
 */
export function currentPlatform(platform?: string): string | undefined {
  if (platform) {
    return platform
  }
  const bootstrapped =
    typeof document === 'undefined' ? undefined : document.documentElement?.dataset?.platform
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

/** A shell shortcut's modifier: ⌘ alone on macOS, Ctrl elsewhere. */
export function isCommandKey(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform?: string
): boolean {
  return commandModifierHeld(
    { control: event.ctrlKey, meta: event.metaKey },
    currentPlatform(platform)
  )
}

/** Label for "reveal this file in the OS file manager" actions. */
export function revealInFileManagerLabel(platform?: string): string {
  switch (appPlatform(currentPlatform(platform))) {
    case 'darwin': {
      return 'Show in Finder'
    }
    case 'win32': {
      return 'Show in Explorer'
    }
    default: {
      return 'Show in folder'
    }
  }
}

/** The OS's name for where a deleted file goes. */
export function trashName(platform?: string): string {
  return appPlatform(currentPlatform(platform)) === 'win32' ? 'Recycle Bin' : 'Trash'
}
