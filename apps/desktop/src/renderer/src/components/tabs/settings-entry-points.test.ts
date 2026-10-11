import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { readWorkspaceNavigation } from '@/components/workspace-nav'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

// Plan 064: every way into Settings that knows where the fix lives opens that
// tab; a plain "Settings" (⌘,, the sidebar, the account menu) opens the tab
// used last.
describe('Settings entry points', () => {
  it('opens a named tab from the workspace navigation event, else the last one', () => {
    const appShell = read('../app-shell.tsx')
    // Plan 174 (I-PAT-12): the event is read through the typed reader, which
    // keeps a real tab and drops one that does not exist.
    expect(appShell).toContain(
      'const navigation = readWorkspaceNavigation((event as CustomEvent<unknown>).detail)'
    )
    expect(appShell).toContain(
      "if (navigation.tab === 'settings') openSettings(navigation.settingsTab)"
    )
    expect(readWorkspaceNavigation({ tab: 'settings', settingsTab: 'about' })).toEqual({
      tab: 'settings',
      settingsTab: 'about'
    })
    expect(readWorkspaceNavigation({ tab: 'settings', settingsTab: 'nope' })).toEqual({
      tab: 'settings'
    })
    expect(appShell).toContain('onOpenSettings={openSettings}')
  })

  it('sends the sidebar update chip to About, where the update story lives', () => {
    expect(read('../sidebar.tsx')).toContain(
      "<SidebarUpdateChip captureActive={live} onOpenSettings={() => onOpenSettings('about')} />"
    )
  })

  it('lists every Settings tab in the command palette', () => {
    const palette = read('../command-palette.tsx')
    expect(palette).toContain('<CommandGroup heading="Settings">')
    expect(palette).toContain('{SETTINGS_TABS.map((tab) => (')
    expect(palette).toContain('onSelect={() => run(() => openSettings(tab.id))}')
  })

  it('sends the FFmpeg blocker to Recording, where FFmpeg status lives', () => {
    const studio = read('./studio-tab.tsx')
    const ffmpeg = studio.slice(studio.indexOf('title: "Videorc\'s recorder isn\'t available"'))
    expect(ffmpeg.slice(0, ffmpeg.indexOf('}'))).toContain("settingsTab: 'recording'")

    // The reason line under the transport (plan 174 S3.2) still opens the
    // Settings tab the jump names, never a page by that name.
    const sessionPanel = read('../studio/session-panel.tsx')
    expect(sessionPanel).toContain(
      "jump.to === 'settings' ? nav.openSettings(jump.settingsTab) : nav.setActive(jump.to)"
    )
  })
})
