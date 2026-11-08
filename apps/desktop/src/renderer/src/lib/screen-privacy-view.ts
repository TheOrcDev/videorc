import { DEFAULT_SCREEN_HIDE_SHORTCUT } from '../../../shared/global-shortcuts'
import type { ScreenPrivacy } from './backend'

// Plan 210 S8b: the words and the key every Hide screen surface shares (the
// Studio's Screen row and its Retro LCD twin, the Stream Manager, the Scene
// page). Studio's own module graph loads it, so it stays words and checks.

/** The state's one word (D9): the Studio's chip, the Stream Manager's stats chip. */
export const SCREEN_HIDDEN_LABEL = 'Screen hidden'

/** The action's name in its current state: the word on every button and menu item. */
export function screenPrivacyActionLabel(hidden: boolean): 'Hide screen' | 'Show screen' {
  return hidden ? 'Show screen' : 'Hide screen'
}

/**
 * The bound Hide screen key: the saved one, D9's default (⌃⌥H) when none was
 * ever saved, and nothing once the streamer cleared it in Settings → Shortcuts.
 */
export function screenHideAccelerator(saved: string | undefined): string | undefined {
  const accelerator = saved ?? DEFAULT_SCREEN_HIDE_SHORTCUT
  return accelerator || undefined
}

/**
 * Why the action can't run now, or null. Only a hide is ever refused (a
 * legacy recording, S7); showing again always runs, so a hidden screen is
 * never stuck behind a disabled button.
 */
export function screenPrivacyDisabledReason(
  privacy: Pick<ScreenPrivacy, 'hidden' | 'unavailable'>,
  connected = true
): string | null {
  if (!connected) return 'Videorc is reconnecting. Try again in a moment.'
  if (privacy.hidden) return null
  return privacy.unavailable ?? null
}
