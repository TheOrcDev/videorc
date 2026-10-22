import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Sidebar } from '@/components/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

// The footer's account menu, theme toggle and updater need the app's
// providers; the rows under test do not.
vi.mock('@/components/account-menu', () => ({ AccountMenu: () => null }))
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }))
const updater = vi.hoisted(() => ({ status: { phase: 'idle' } as Record<string, unknown> }))
vi.mock('@/hooks/use-updater', () => ({
  useUpdater: () => ({
    status: updater.status,
    check: () => undefined,
    install: () => undefined
  })
}))

const noop = (): void => undefined

type SidebarProps = Parameters<typeof Sidebar>[0]

function renderSidebar(overrides: Partial<SidebarProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Sidebar, {
        active: 'studio',
        activeStudioPanel: null,
        accountTier: null,
        onSelect: noop,
        onSelectStudioPanel: noop,
        onOpenSettings: noop,
        statusTone: 'good',
        statusLabel: 'Ready',
        statusPulse: false,
        live: false,
        onOpenCommand: noop,
        platform: 'win32',
        ...overrides
      })
    )
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

/** The sidebar's rows, top to bottom, by their trigger id. */
function triggers(markup: string): string[] {
  return [...markup.matchAll(/data-videorc-tab-trigger="([^"]+)"/g)].map((match) => match[1])
}

describe('sidebar top row', () => {
  // Plan 174 D18: Windows draws its own title bar with the icon and the name,
  // so the sidebar repeats neither; on macOS the brand lives in About and the
  // Dock. The row is the traffic lights' band, then Search.
  it('carries only Search: no brand mark on any platform', () => {
    for (const platform of ['win32', 'darwin']) {
      const markup = renderSidebar({ platform })
      expect(markup, platform).not.toContain('<img')
      expect(markup, platform).not.toMatch(/>Videorc</)
      expect(markup, platform).toContain('aria-label="Search"')
    }
  })

  it('keeps the win32 root attribute theme-bootstrap sets before the first paint', () => {
    const styles = readFileSync(join(__dirname, '../styles.css'), 'utf8')
    expect(styles).toContain("@custom-variant win32 (&:is([data-platform='win32'] *));")
    expect(bootstrapPlatform('Win32')).toBe('win32')
    expect(bootstrapPlatform('MacIntel')).toBe('darwin')
  })
})

describe('sidebar zones (plan 174 D8)', () => {
  it('keeps Buddy second under Studio, then Setup and Library, with Settings at the bottom', () => {
    const markup = renderSidebar()
    expect(triggers(markup)).toEqual([
      'studio',
      'ai',
      'sources',
      'layout',
      'assets',
      'streaming',
      'captions',
      'recording',
      'library',
      'settings'
    ])
    // Only Setup is labelled; the single rows carry no group label.
    const labels = [...markup.matchAll(/data-slot="section-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1]
    )
    expect(labels).toEqual(['Setup'])
    // Settings sits in the bottom block, after Library, above the account row.
    const bottom = markup.indexOf('data-testid="sidebar-bottom"')
    expect(bottom).toBeGreaterThan(markup.indexOf('data-videorc-tab-trigger="library"'))
    expect(markup.indexOf('data-videorc-tab-trigger="settings"')).toBeGreaterThan(bottom)
    expect(markup).not.toContain('data-videorc-tab-trigger="diagnostics"')
  })

  it('shows the live dot and clock on the Studio row while a session runs', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString()
    const live = renderSidebar({
      statusPulse: true,
      statusTone: 'live',
      statusLabel: 'On air',
      live: true,
      sessionStartedAt: startedAt
    })
    const studio = live.slice(
      live.indexOf('data-videorc-tab-trigger="studio"'),
      live.indexOf('data-videorc-tab-trigger="ai"')
    )
    expect(studio).toContain('data-testid="sidebar-session-clock"')
    expect(studio).toContain('data-tone="live"')
    expect(studio).toMatch(/1:0[4-6]</)
    // Hidden from assistive tech: the status bar already announces the state.
    expect(studio).toMatch(/aria-hidden="true"[^>]*data-testid="sidebar-session-clock"/)
    expect(renderSidebar()).not.toContain('data-testid="sidebar-session-clock"')
  })
})

describe('sidebar update chip (plan 174 A-25)', () => {
  it('is named by its visible words, says the update waits while live, and is green only when a click installs', () => {
    updater.status = { phase: 'downloaded', version: '1.2.3' }
    const idle = renderSidebar()
    expect(idle).toContain('>Restart to update<')
    expect(idle).toContain('aria-description="Restart to update to 1.2.3"')
    expect(idle).not.toContain('aria-label="Restart')
    expect(idle).toMatch(/glass-dot tone-success/)

    const live = renderSidebar({ live: true, statusPulse: true, statusTone: 'live' })
    expect(live).toContain('>Update after stop<')
    expect(live).toMatch(/glass-dot tone-neutral/)
    expect(live).not.toMatch(/glass-dot tone-success/)
    updater.status = { phase: 'idle' }
  })
})
