import { useTheme } from 'next-themes'
import { useCallback, useEffect } from 'react'

import { isModalOpen } from '@/lib/modal-open'
import { nextToggledTheme } from '@/lib/theme-toggle'

/**
 * Shadcn mode-switcher hook: toggle dark/light and listen for D (outside
 * editable fields, and never from under a dialog or a menu: plan 174 A-2). A
 * flip back to the computer's own look returns to System (plan 174 I-30).
 */
export function useThemeToggle(): { toggleTheme: () => void } {
  const { setTheme, resolvedTheme, systemTheme } = useTheme()

  const toggleTheme = useCallback(() => {
    setTheme(nextToggledTheme({ resolvedTheme, systemTheme }))
  }, [resolvedTheme, setTheme, systemTheme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== 'd') {
        return
      }

      if (
        (event.target instanceof HTMLElement && event.target.isContentEditable) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return
      }
      if (isModalOpen(document)) {
        return
      }

      event.preventDefault()
      toggleTheme()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleTheme])

  return { toggleTheme }
}
