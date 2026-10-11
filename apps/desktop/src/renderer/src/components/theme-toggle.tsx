import { DarkModeIcon, LightModeIcon } from '@/components/icons'
import { useTheme } from 'next-themes'
import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useThemeToggle } from '@/hooks/use-theme-toggle'

export function ThemeToggle(): ReactElement {
  const { resolvedTheme } = useTheme()
  const { toggleTheme } = useThemeToggle()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = resolvedTheme === 'dark'

  // A tooltip with the key, never a native title (plan 174 S1.10). The name
  // stays "Toggle color theme": scripts/smoke-scene-presets-app.mjs clicks it.
  return (
    <ShortcutTooltip
      accelerator="D"
      label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Button aria-label="Toggle color theme" size="icon" variant="ghost" onClick={toggleTheme}>
        {mounted && isDark ? <DarkModeIcon weight="fill" /> : <LightModeIcon weight="fill" />}
      </Button>
    </ShortcutTooltip>
  )
}
