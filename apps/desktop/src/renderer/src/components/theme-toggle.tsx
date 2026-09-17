import { DarkModeIcon, LightModeIcon } from '@/components/icons'
import { useTheme } from 'next-themes'
import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { useThemeToggle } from '@/hooks/use-theme-toggle'

export function ThemeToggle(): ReactElement {
  const { resolvedTheme } = useTheme()
  const { toggleTheme } = useThemeToggle()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = resolvedTheme === 'dark'

  return (
    <Button
      aria-label="Toggle color theme"
      size="icon"
      title={isDark ? 'Switch to light theme (D)' : 'Switch to dark theme (D)'}
      variant="ghost"
      onClick={toggleTheme}
    >
      {mounted && isDark ? <DarkModeIcon weight="fill" /> : <LightModeIcon weight="fill" />}
    </Button>
  )
}
