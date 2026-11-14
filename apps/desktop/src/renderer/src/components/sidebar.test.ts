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

/** One row's markup, by its trigger id. */
function rowOf(markup: string, trigger: string): string {
  const pattern = new RegExp(
    `<button[^>]*data-videorc-tab-trigger="${trigger}"[^>]*>.*?</button>`,
    's'
  )
  return pattern.exec(markup)?.[0] ?? ''
}

describe('sidebar zones (plan 174 D8, plan 235 D6)', () => {
  it('leads with Studio, then Setup, then Livestream (Destinations and Buddy) and Library, with Settings at the bottom', () => {
    const markup = renderSidebar()
    // Page ids and legacy trigger ids never change: Destinations is `streaming`.
    expect(triggers(markup)).toEqual([
      'studio',
      'sources',
      'layout',
      'assets',
      'captions',
      'recording',
      'streaming',
      'ai',
      'library',
      'settings'
    ])
    // Two labelled groups; the single rows carry no group label.
    const labels = [...markup.matchAll(/data-slot="section-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1]
    )
    expect(labels).toEqual(['Setup', 'Livestream'])
    expect(rowOf(markup, 'streaming')).toContain('>Destinations<')
    // Settings sits in the bottom block, after Library, above the account row.
    const bottom = markup.indexOf('data-testid="sidebar-bottom"')
    expect(bottom).toBeGreaterThan(markup.indexOf('data-videorc-tab-trigger="library"'))
    expect(markup.indexOf('data-videorc-tab-trigger="settings"')).toBeGreaterThan(bottom)
    expect(markup).not.toContain('data-videorc-tab-trigger="diagnostics"')
  })

  // Plan 235 D8: the shortcuts run down the rows, ⌘1 to ⌘9.
  it('puts ⌘1–⌘9 on the rows top to bottom', () => {
    const markup = renderSidebar({ platform: 'darwin' })
    const keys = [...markup.matchAll(/aria-keyshortcuts="Meta\+(\d)"/g)].map((match) => match[1])
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  // Plan 235 D7: a plain glyph like its neighbours, never the Buddy artwork,
  // whatever Buddy the streamer has.
  it('draws the Sidekick row with a plain glyph, filled while it is the page', () => {
    const idle = rowOf(renderSidebar(), 'ai')
    expect(idle).toContain('>Sidekick<')
    expect(idle).not.toContain('<image')
    expect(idle).not.toContain('buddy-emblem')
    expect(idle).not.toContain('aria-current')
    const current = rowOf(renderSidebar({ active: 'ai' }), 'ai')
    expect(current).toContain('aria-current="page"')
    expect(current).toContain('chrome-plate')
  })

  // Plan 235 D5: the way home is the sidebar's big button.
  it('draws Studio as a 40 px chrome slab on every page, its icon filled only on Studio', () => {
    const onStudio = rowOf(renderSidebar(), 'studio')
    const elsewhere = rowOf(renderSidebar({ active: 'library' }), 'studio')
    for (const slab of [onStudio, elsewhere]) {
      expect(slab).toMatch(/class="chrome-fill [^"]*\bh-10\b/)
      expect(slab).toContain('data-testid="sidebar-studio-slab"')
      expect(slab).not.toContain('chrome-plate')
      expect(slab).not.toContain('chrome-led')
    }
    expect(onStudio).toContain('aria-current="page"')
    expect(elsewhere).not.toContain('aria-current')
    // The filled glyph and the regular one draw different paths.
    expect(onStudio.replace(/aria-current="page" /, '')).not.toEqual(elsewhere)
    // Its key chip takes the slab's ink, never the gray glass keycap's.
    expect(onStudio).toMatch(/data-slot="kbd"/)
    expect(onStudio).toContain('text-current')
    expect(onStudio).not.toContain('text-muted-foreground')
  })

  it('shows the live dot and clock on the Studio slab while a session runs', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString()
    const live = renderSidebar({
      statusPulse: true,
      statusTone: 'live',
      statusLabel: 'On air',
      live: true,
      sessionStartedAt: startedAt
    })
    const studio = rowOf(live, 'studio')
    expect(studio).toContain('data-testid="sidebar-session-clock"')
    expect(studio).toContain('data-tone="live"')
    expect(studio).toMatch(/1:0[4-6]</)
    // Hidden from assistive tech: the status bar already announces the state.
    expect(studio).toMatch(/aria-hidden="true"[^>]*data-testid="sidebar-session-clock"/)
    // On the slab the time reads in the slab's ink, not the secondary gray.
    const clockClass = /class="([^"]*)" data-testid="sidebar-session-clock"/.exec(studio)?.[1]
    expect(clockClass).toBeDefined()
    expect(clockClass).not.toContain('text-muted-foreground')
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
