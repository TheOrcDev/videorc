import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

// Plan 064: every way into Settings that knows where the fix lives opens that
// tab; a plain "Settings" (⌘,, the sidebar, the account menu) opens the tab
// used last.
describe('Settings entry points', () => {
  it('opens a named tab from the workspace navigation event, else the last one', () => {
    const appShell = read('../app-shell.tsx')
    expect(appShell).toContain(
      'openSettings(isSettingsTabId(detail?.settingsTab) ? detail.settingsTab : undefined)'
    )
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
    const ffmpeg = studio.slice(studio.indexOf("title: 'FFmpeg unavailable'"))
    expect(ffmpeg.slice(0, ffmpeg.indexOf('}'))).toContain("settingsTab: 'recording'")

    const sessionPanel = read('../studio/session-panel.tsx')
    expect(sessionPanel).toContain(
      "blockedJump.to === 'settings'\n                  ? openSettings(blockedJump.settingsTab)"
    )
  })
})
