import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Sidebar } from '@/components/sidebar'

// The footer's account menu, theme toggle and updater need the app's
// providers; the top row under test does not.
vi.mock('@/components/account-menu', () => ({ AccountMenu: () => null }))
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }))
vi.mock('@/hooks/use-updater', () => ({
  useUpdater: () => ({
    status: { phase: 'idle' },
    check: () => undefined,
    install: () => undefined
  })
}))

const noop = (): void => undefined

function renderSidebar(): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      active: 'studio',
      activeStudioPanel: null,
      accountTier: null,
      onSelect: noop,
      onSelectStudioPanel: noop,
      onOpenSettings: noop,
      statusTone: 'good',
      statusLabel: 'Connected',
      live: false,
      onOpenCommand: noop,
      platform: 'win32'
    })
  )
}

/** The platform theme-bootstrap.js stamps on the root before the first paint. */
function bootstrapPlatform(navigatorPlatform: string): string | undefined {
  const dataset: Record<string, string> = {}
  runInNewContext(readFileSync(join(__dirname, '../../theme-bootstrap.js'), 'utf8'), {
    window: { localStorage: { getItem: () => 'dark' }, matchMedia: () => ({ matches: true }) },
    document: { documentElement: { classList: { add: noop }, dataset } },
    navigator: { platform: navigatorPlatform }
  })
  return dataset.platform
}

describe('sidebar top row', () => {
  it('leads with the app icon and name on Windows only', () => {
    const markup = renderSidebar()
    const mark = markup.match(
      /<span class="([^"]*)"><img alt="" class="size-4" src="[^"]+"\/>Videorc<\/span>/
    )
    expect(mark).not.toBeNull()
    const classes = (mark?.[1] ?? '').split(' ')
    // Hidden by default: on macOS the brand lives in About and the Dock.
    expect(classes).toContain('hidden')
    // Shown by the root attribute rather than runtime info, so a Windows
    // window has it from the first paint.
    expect(classes).toContain('win32:flex')
    // Search stays at the end of the row, after the mark.
    expect(markup.indexOf('Videorc</span>')).toBeLessThan(markup.indexOf('aria-label="Search'))
  })

  it('keys the win32 variant on the attribute theme-bootstrap sets before the first paint', () => {
    const styles = readFileSync(join(__dirname, '../styles.css'), 'utf8')
    expect(styles).toContain("@custom-variant win32 (&:is([data-platform='win32'] *));")
    expect(bootstrapPlatform('Win32')).toBe('win32')
    expect(bootstrapPlatform('MacIntel')).toBe('darwin')
  })
})
