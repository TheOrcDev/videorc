import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

// 0.31.1: the Guests row follows the cloud's talk-show allowance.
const cloud = vi.hoisted(() => ({ cloudStatus: null as unknown }))
vi.mock('@/hooks/use-studio', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStudioCloud: () => ({ cloudStatus: cloud.cloudStatus })
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

describe('sidebar zones (plan 174 D8, plan 235 D6, plan 239)', () => {
  it('leads with Studio, then Setup, Livestream and Assets (Images and Sounds), with Library and Settings at the bottom', () => {
    const markup = renderSidebar()
    // Page ids and legacy trigger ids never change: Destinations is `streaming`.
    expect(triggers(markup)).toEqual([
      'studio',
      'sources',
      'layout',
      'captions',
      'recording',
      'streaming',
      'avatar',
      'ai',
      'assets',
      'sounds',
      'library',
      'settings'
    ])
    // Three labelled groups; the single rows carry no group label.
    const labels = [...markup.matchAll(/data-slot="section-label"[^>]*>([^<]*)</g)].map(
      (match) => match[1]
    )
    expect(labels).toEqual(['Setup', 'Livestream', 'Assets'])
    expect(rowOf(markup, 'assets')).toContain('>Images<')
    expect(rowOf(markup, 'sounds')).toContain('>Sounds<')
    expect(rowOf(markup, 'streaming')).toContain('>Destinations<')
    expect(rowOf(markup, 'avatar')).toContain('>Avatar<')
    // Owner 2026-11-20: Library sits in the bottom block, above Settings,
    // above the account row.
    const bottom = markup.indexOf('data-testid="sidebar-bottom"')
    const library = markup.indexOf('data-videorc-tab-trigger="library"')
    expect(library).toBeGreaterThan(bottom)
    expect(markup.indexOf('data-videorc-tab-trigger="settings"')).toBeGreaterThan(library)
    expect(markup).not.toContain('data-sidebar-zone="library"')
    expect(markup).not.toContain('data-videorc-tab-trigger="diagnostics"')
  })

  // Owner 2026-11-20: ⌘1–⌘9 run down the nine rows above Assets with no gap,
  // Hidden Guests takes no digit; Images ⇧⌘G,
  // Sounds ⇧⌘S, Library ⌘0, Settings ⌘,.
  it('puts ⌘1–⌘9 on the top rows, ⇧⌘G and ⇧⌘S on Images and Sounds, ⌘0 on Library and ⌘, on Settings', () => {
    const markup = renderSidebar({ platform: 'darwin' })
    const keys = [...markup.matchAll(/aria-keyshortcuts="([^"]+)"/g)].map((match) => match[1])
    expect(keys).toEqual([
      'Meta+K',
      'Meta+1',
      'Meta+2',
      'Meta+3',
      'Meta+4',
      'Meta+5',
      'Meta+6',
      'Meta+7',
      'Meta+8',
      'Shift+Meta+G',
      'Shift+Meta+S',
      'Meta+0',
      'Meta+,'
    ])
    expect(rowOf(markup, 'ai')).toContain('aria-keyshortcuts="Meta+8"')
    expect(rowOf(markup, 'library')).toContain('aria-keyshortcuts="Meta+0"')
    // The chips print the same keys.
    expect(rowOf(markup, 'assets')).toContain('data-accelerator="CmdOrCtrl+Shift+G"')
    expect(rowOf(markup, 'sounds')).toContain('data-accelerator="CmdOrCtrl+Shift+S"')
    // Windows and Linux use Ctrl.
    const win = renderSidebar({ platform: 'win32' })
    expect(rowOf(win, 'sounds')).toContain('aria-keyshortcuts="Control+Shift+S"')
    expect(rowOf(win, 'sounds')).toContain('>Ctrl+Shift+S<')
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

  // Plan 239: the avatar's row wears a plain glyph too; the streamer's own
  // avatar shows on the page itself.
  it('draws the Avatar row with a plain glyph of its own, filled while it is the page', () => {
    const idle = rowOf(renderSidebar(), 'avatar')
    expect(idle).toContain('>Avatar<')
    expect(idle).not.toContain('<image')
    expect(idle).not.toContain('buddy-emblem')
    expect(idle).not.toContain('aria-current')
    expect(idle.replace(/>Avatar</, '')).not.toEqual(
      rowOf(renderSidebar(), 'ai').replace(/>Sidekick</, '')
    )
    const current = rowOf(renderSidebar({ active: 'avatar' }), 'avatar')
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

// 0.31.1: Guests is its own page under Livestream, between Destinations and
// Avatar, shown only with talk shows (the rule ⌘K follows too). It keeps ⌘7
// only while visible; the following rows close the gap (Q187).
describe('the Guests row', () => {
  it('updates Avatar and Sidekick chips as Guests appears and disappears', () => {
    for (const shown of [false, true, false]) {
      cloud.cloudStatus = { allowance: { enabled: true, talkShows: shown } }
      const markup = renderSidebar({ platform: 'darwin' })
      expect(rowOf(markup, 'avatar')).toContain(`aria-keyshortcuts="Meta+${shown ? 8 : 7}"`)
      expect(rowOf(markup, 'ai')).toContain(`data-accelerator="CmdOrCtrl+${shown ? 9 : 8}"`)
    }
  })
  const triggers = (html: string): string[] =>
    [...html.matchAll(/data-videorc-tab-trigger="([a-z]+)"/g)].map((match) => match[1])

  afterEach(() => {
    cloud.cloudStatus = null
  })

  it('shows right under Destinations only with talk shows', () => {
    expect(triggers(renderSidebar())).not.toContain('guests')
    cloud.cloudStatus = { allowance: { enabled: true, talkShows: true } }
    const rows = triggers(renderSidebar())
    expect(rows.slice(rows.indexOf('streaming'), rows.indexOf('streaming') + 3)).toEqual([
      'streaming',
      'guests',
      'avatar'
    ])
  })

  it('wears ⌘7, between Destinations ⌘6 and Avatar ⌘8', () => {
    cloud.cloudStatus = { allowance: { enabled: true, talkShows: true } }
    const markup = renderSidebar({ platform: 'darwin' })
    expect(rowOf(markup, 'guests')).toContain('aria-keyshortcuts="Meta+7"')
    expect(rowOf(markup, 'streaming')).toContain('aria-keyshortcuts="Meta+6"')
    expect(rowOf(markup, 'avatar')).toContain('aria-keyshortcuts="Meta+8"')
  })

  it('stays while a room is open, even without the allowance', () => {
    cloud.cloudStatus = { room: { phase: 'open' } }
    expect(triggers(renderSidebar())).toContain('guests')
  })
})
