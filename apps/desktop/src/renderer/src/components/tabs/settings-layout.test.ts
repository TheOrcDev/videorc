import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SETTINGS_TABS } from '@/lib/settings-tabs'

import { REMOTE_CONTROL_OFF_HINT } from '../settings/remote-settings'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const shellSource = read('./settings-tab.tsx')
const pageSource = read('../page.tsx')
const appShellSource = read('../app-shell.tsx')

/** The panel component each tab renders, and the file it lives in. */
const PANEL_FILES: Record<string, string> = {
  GeneralSettings: '../settings/general-settings.tsx',
  RecordingSettings: '../settings/recording-settings.tsx',
  PermissionsSettings: '../settings/permissions-settings.tsx',
  ShortcutsSettings: '../settings/shortcuts-settings.tsx',
  RemoteSettings: '../settings/remote-settings.tsx',
  AboutSettings: '../settings/about-settings.tsx'
}
const panelSources = Object.fromEntries(
  Object.entries(PANEL_FILES).map(([component, path]) => [component, read(path)])
)

/** Sections rendered by a component that carries its own title prop. */
const SECTION_COMPONENTS: Record<string, string> = {
  CohostSettingsSection: 'Orcle (alpha)',
  PhoneRemoteSection: 'Phone remote',
  AboutAndUpdates: 'About & updates'
}

/** One exported component's body, without the helpers declared after it. */
function exportedBody(source: string, component: string): string {
  const start = source.indexOf(`export function ${component}`)
  const next = source.indexOf('\nfunction ', start)
  return source.slice(start, next === -1 ? undefined : next)
}

/** Section titles a chunk of JSX renders, in render order. */
function sectionTitles(jsx: string): string[] {
  const titles: string[] = []
  const tags = Object.keys({ ...SECTION_COMPONENTS, ...panelSources }).join('|')
  for (const match of jsx.matchAll(new RegExp(`title="([^"]+)"|<(${tags})\\b`, 'g'))) {
    if (match[1]) {
      titles.push(match[1])
    } else if (match[2] && match[2] in SECTION_COMPONENTS) {
      titles.push(SECTION_COMPONENTS[match[2]] as string)
    } else if (match[2]) {
      titles.push(...sectionTitles(exportedBody(panelSources[match[2]] as string, match[2])))
    }
  }
  return titles
}

/** Each `<TabsContent … value="…">` block of the shell, in source order. */
function tabPanels(): { value: string; jsx: string }[] {
  return [
    ...shellSource.matchAll(/<TabsContent\b[^>]*\bvalue="([^"]+)"[^>]*>([\s\S]*?)<\/TabsContent>/g)
  ].map((match) => ({ value: match[1] as string, jsx: match[2] as string }))
}

describe('Settings layout', () => {
  it('splits the config grid into flush columns with a hairline between them', () => {
    // Plan 050, D4: sections are flush, so the columns stretch (the hairline
    // runs the full height) and no gap separates them.
    const configGrid = pageSource.slice(
      pageSource.indexOf('export function ConfigGrid'),
      pageSource.indexOf('export function Gallery')
    )
    expect(configGrid).toContain("'grid lg:grid-cols-2 lg:[&>*:nth-child(odd)]:border-r'")
    expect(configGrid).not.toMatch(/\bgap-\d/)
  })

  it('builds the tab strip from SETTINGS_TABS, so the strip and the tab model cannot drift', () => {
    expect(shellSource).toContain('{SETTINGS_TABS.map(({ id, label }) => (')
    expect(shellSource).toContain(
      '<TabsTrigger key={id} data-videorc-settings-tab={id} value={id}>'
    )
    expect(shellSource.match(/<TabsTrigger\b/g)).toHaveLength(1)
  })

  it('gives every tab exactly one panel, in strip order', () => {
    expect(tabPanels().map((panel) => panel.value)).toEqual(SETTINGS_TABS.map((tab) => tab.id))
  })

  it('puts each section on its tab, in order', () => {
    expect(
      Object.fromEntries(tabPanels().map((panel) => [panel.value, sectionTitles(panel.jsx)]))
    ).toEqual({
      general: ['Appearance & behavior', 'Import'],
      recording: ['Recording & storage'],
      permissions: ['System access'],
      shortcuts: ['Global shortcuts', 'App shortcuts'],
      remote: ['Remote control', 'Phone remote'],
      orcle: ['Orcle (alpha)'],
      about: ['About & updates', 'Support']
    })
  })

  it('gives every section and control exactly one home', () => {
    const titles = tabPanels().flatMap((panel) => sectionTitles(panel.jsx))
    expect(new Set(titles).size).toBe(titles.length)

    // Plan 064: a studio behavior, not a storage setting.
    expect(panelSources.GeneralSettings).toContain('id="animate-scene-changes"')
    expect(panelSources.RecordingSettings).not.toContain('animate-scene-changes')
    for (const source of Object.values(panelSources)) {
      expect(source.match(/id="animate-scene-changes"/g)?.length ?? 0).toBeLessThanOrEqual(1)
    }

    // The recorders are the only home of a global binding; the in-app list
    // beside them does not repeat them.
    expect(panelSources.ShortcutsSettings).not.toContain('Global ·')
  })

  it('pairs two-section tabs side by side and stacks single-section tabs', () => {
    // At `lg` the pair fills the visible height with one stretched row, so the
    // column hairline runs the full height; stacked, rows keep content height.
    expect(shellSource).toContain(
      "const SECTION_PAIR = 'flex-1 content-start lg:content-stretch lg:[&>*]:border-b-0'"
    )
    expect(shellSource.match(/<TabsContent className="flex flex-col" value="/g)).toHaveLength(
      SETTINGS_TABS.length
    )
    for (const panel of tabPanels()) {
      const wrapper =
        sectionTitles(panel.jsx).length === 2
          ? '<ConfigGrid className={SECTION_PAIR}>'
          : '<PageStack>'
      expect(panel.jsx.trim().startsWith(wrapper), `${panel.value} opens with ${wrapper}`).toBe(
        true
      )
    }
  })

  it('pins the strip: Settings owns its scroll and only the region under the strip scrolls', () => {
    expect(appShellSource).toContain(
      "<PaneBody scroll={active !== 'library' && active !== 'settings'}>"
    )
    const strip = shellSource.indexOf('<TabsList')
    const scroll = shellSource.indexOf('data-slot="settings-scroll"')
    expect(strip).toBeGreaterThan(-1)
    expect(scroll).toBeGreaterThan(strip)
    const scrollRegion = shellSource.slice(shellSource.lastIndexOf('<div', scroll), scroll)
    expect(scrollRegion).toContain('key={tab}')
    expect(scrollRegion).toContain('overflow-y-auto')
    expect(tabPanels().every((panel) => shellSource.indexOf(panel.jsx) > scroll)).toBe(true)
  })

  it('never pins a Settings card to a fixed height', () => {
    expect(shellSource).not.toMatch(/\b(?:min-)?h-\[/)
    // `min-h-0` is the flex scroll idiom (it lets the region shrink), not a pin.
    expect(shellSource).not.toMatch(/className="[^"]*(?<![\w-])h-\d/)
    expect(shellSource).not.toMatch(/className="[^"]*\bmin-h-[1-9]/)
    for (const source of Object.values(panelSources)) {
      expect(source).not.toMatch(/\b(?:min-)?h-\[/)
    }
  })

  it('gives Remote control a one-line body when it is off, so it is never header-only', () => {
    expect(REMOTE_CONTROL_OFF_HINT).toBe(
      'Off. Turn on to pair a Stream Deck or the Videorc remote.'
    )

    const remoteSource = panelSources.RemoteSettings as string
    const remoteCard = remoteSource.slice(remoteSource.indexOf('title="Remote control"'))
    const enabledBranch = remoteCard.indexOf('{remoteStatus?.enabled ? (')
    const offBody = remoteCard.indexOf('{REMOTE_CONTROL_OFF_HINT}')

    expect(enabledBranch).toBeGreaterThan(-1)
    expect(offBody).toBeGreaterThan(enabledBranch)
    expect(remoteCard.slice(enabledBranch, offBody)).not.toContain(') : null}')
  })
})
