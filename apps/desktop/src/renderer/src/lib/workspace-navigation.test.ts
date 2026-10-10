import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  readWorkspaceNavigation,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { openBuddyTab } from '@/lib/buddy-tabs'
import { openSettingsTab } from '@/lib/settings-tabs'
import { WORKSPACE_NAVIGATE_EVENT, openWorkspaceTab } from './workspace-navigation'

// Plan 174 (I-NEW, I-PAT-12): pages opened from outside React go through one
// typed call, and the shell reads back exactly the page that was asked for.

function capture(open: () => void): unknown[] {
  const target = new EventTarget()
  const sent: unknown[] = []
  target.addEventListener(WORKSPACE_NAVIGATE_EVENT, (event) =>
    sent.push((event as CustomEvent).detail)
  )
  vi.stubGlobal('window', target)
  open()
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const EVERY_PAGE: WorkspaceTab[] = [
  ...WORKSPACE_TABS.map((tab) => tab.id),
  ...STUDIO_PANELS.map((panel) => panel.id)
]

describe('openWorkspaceTab', () => {
  it.each(EVERY_PAGE)('opens %s, and the shell reads back the same page', (tab) => {
    // The overloads take every id; this loop calls the general form.
    const sent = capture(() => (openWorkspaceTab as (tab: WorkspaceTab) => void)(tab))
    expect(sent).toEqual([{ tab }])
    expect(readWorkspaceNavigation(sent[0])).toEqual({ tab })
  })

  it('covers all eleven pages, Livestream as `live`', () => {
    expect([...EVERY_PAGE].sort()).toEqual(
      [
        'ai',
        'assets',
        'captions',
        'diagnostics',
        'layouts',
        'library',
        'live',
        'recording',
        'settings',
        'sources',
        'studio'
      ].sort()
    )
  })

  it('carries a Settings or Buddy tab, and the session a Library action is about', () => {
    const sent = capture(() => {
      openWorkspaceTab('settings', 'permissions')
      openWorkspaceTab('ai', 'clean-cut')
      openWorkspaceTab('library', 'session-1')
      openWorkspaceTab('live')
    })
    expect(sent).toEqual([
      { tab: 'settings', settingsTab: 'permissions' },
      { tab: 'ai', buddyTab: 'clean-cut' },
      { tab: 'library', sessionId: 'session-1' },
      { tab: 'live' }
    ])
    expect(sent.map(readWorkspaceNavigation)).toEqual(sent)
  })

  it('is how openSettingsTab and openBuddyTab open their pages', () => {
    const sent = capture(() => {
      openSettingsTab('shortcuts')
      openBuddyTab('voice')
    })
    expect(sent).toEqual([
      { tab: 'settings', settingsTab: 'shortcuts' },
      { tab: 'ai', buddyTab: 'voice' }
    ])
  })

  it('refuses a page that does not exist, at compile time and in the shell', () => {
    // The old chat-setup toast sent `streaming`; Livestream's id is `live`.
    // @ts-expect-error `streaming` is not a page id
    capture(() => openWorkspaceTab('streaming'))
    expect(readWorkspaceNavigation({ tab: 'streaming' })).toBeNull()
    expect(readWorkspaceNavigation({ tab: 'missing' })).toBeNull()
    expect(readWorkspaceNavigation(null)).toBeNull()
    expect(readWorkspaceNavigation('live')).toBeNull()
  })

  it('opens a page on its remembered tab when the sub-tab does not exist', () => {
    expect(readWorkspaceNavigation({ tab: 'settings', settingsTab: 'nope' })).toEqual({
      tab: 'settings'
    })
    expect(readWorkspaceNavigation({ tab: 'ai', buddyTab: 7 })).toEqual({ tab: 'ai' })
    expect(readWorkspaceNavigation({ tab: 'library', sessionId: null })).toEqual({
      tab: 'library'
    })
  })
})
