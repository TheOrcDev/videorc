'use client'

import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'

import { DarkModeIcon, LightModeIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useThemeToggle } from '@/hooks/use-theme-toggle'

const subscribe = (): (() => void) => () => {
  // Mounted once, never unmounted while the page is open: nothing to watch.
}

/**
 * True once the client renders. The theme is unknown on the server, so the
 * icon waits for it instead of flashing the wrong one as it hydrates.
 */
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}

/**
 * The mode switcher: a ghost icon button that flips dark and light, with D
 * as its shortcut (from `useThemeToggle`) in its tooltip, never a native
 * title. A flip back to the computer's own look returns to System.
 */
function ThemeToggle(): ReactElement {
  const { resolvedTheme } = useTheme()
  const { toggleTheme } = useThemeToggle()
  const mounted = useMounted()
  const isDark = mounted && resolvedTheme === 'dark'

  // The button's name stays "Toggle color theme" whatever the theme, so
  // scripts and tests find it; the tooltip says what a click does.
  return (
    <ShortcutTooltip
      accelerator="D"
      label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Button
        aria-label="Toggle color theme"
        data-slot="theme-toggle"
        onClick={toggleTheme}
        size="icon"
        variant="ghost"
      >
        {isDark ? <DarkModeIcon weight="fill" /> : <LightModeIcon weight="fill" />}
      </Button>
    </ShortcutTooltip>
  )
}

export { ThemeToggle }
