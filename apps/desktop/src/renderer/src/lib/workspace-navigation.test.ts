import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  readWorkspaceNavigation,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { openBuddyTab } from '@/lib/buddy-tabs'
import { openLivestreamView } from '@/lib/livestream-tabs'
import { openSettingsTab } from '@/lib/settings-tabs'
import { readFirstRunSetupRequest } from '@/components/workspace-nav'
import {
  FIRST_RUN_SETUP_OPEN_EVENT,
  WORKSPACE_NAVIGATE_EVENT,
  openFirstRunSetup,
  openWorkspaceTab
} from './workspace-navigation'

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
      openWorkspaceTab('live', 'upcoming')
    })
    expect(sent).toEqual([
      { tab: 'settings', settingsTab: 'permissions' },
      { tab: 'ai', buddyTab: 'clean-cut' },
      { tab: 'library', sessionId: 'session-1' },
      { tab: 'live' },
      { tab: 'live', livestreamView: 'upcoming' }
    ])
    expect(sent.map(readWorkspaceNavigation)).toEqual(sent)
  })

  it('is how openSettingsTab, openBuddyTab and openLivestreamView open their pages', () => {
    // Plan 174 S1.6b (A-14): ⌘K's Upcoming used sessionStorage and a bare event.
    const sent = capture(() => {
      openSettingsTab('shortcuts')
      openBuddyTab('voice')
      openLivestreamView('upcoming')
    })
    expect(sent).toEqual([
      { tab: 'settings', settingsTab: 'shortcuts' },
      { tab: 'ai', buddyTab: 'voice' },
      { tab: 'live', livestreamView: 'upcoming' }
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
    expect(readWorkspaceNavigation({ tab: 'live', livestreamView: 'drafts' })).toEqual({
      tab: 'live'
    })
    expect(readWorkspaceNavigation({ tab: 'library', sessionId: null })).toEqual({
      tab: 'library'
    })
  })
})

describe('openFirstRunSetup (plan 203 S5)', () => {
  it('asks the shell to replay setup, returning to Settings unless told otherwise', () => {
    const target = new EventTarget()
    const sent: unknown[] = []
    target.addEventListener(FIRST_RUN_SETUP_OPEN_EVENT, (event) =>
      sent.push((event as CustomEvent).detail)
    )
    vi.stubGlobal('window', target)
    openFirstRunSetup()
    openFirstRunSetup({ returnTo: 'studio' })
    expect(sent).toEqual([{ returnTo: 'settings' }, { returnTo: 'studio' }])
    expect(readFirstRunSetupRequest(sent[1])).toEqual({ returnTo: 'studio' })
  })

  it('returns to Settings when the request names no page it knows', () => {
    expect(readFirstRunSetupRequest(null)).toEqual({ returnTo: 'settings' })
    expect(readFirstRunSetupRequest({ returnTo: 'nowhere' })).toEqual({ returnTo: 'settings' })
  })
})
