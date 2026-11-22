// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readWorkspaceNavigation } from '@/components/workspace-nav'
import type { WatchdogAlert } from '@/lib/backend'
import { SECTION_FOCUS_EVENT, takeSectionFocus } from '@/lib/section-focus'
import { runWatchdogFix } from '@/lib/watchdog-surface'
import { WORKSPACE_NAVIGATE_EVENT, type WorkspaceNavigation } from '@/lib/workspace-navigation'

const silentMic: WatchdogAlert = {
  id: 'alert-mic-silent',
  check: 'mic-silent',
  severity: 'critical',
  state: 'open',
  since: '2026-11-22T12:00:00Z',
  title: 'Your microphone is silent in the recording',
  detail:
    "Shure MV7+ is sending only silence. Check its own mute button or switch, and its cable. If it's still silent, choose it again.",
  source: 'desktop',
  fixes: [{ kind: 'open-audio', label: 'Open Audio' }]
}

const deps = {
  client: null,
  live: () => false,
  source: () => null,
  openStudioPanel: vi.fn()
}

// Silent-mic report 2026-11-22: Open Audio on the Session panel's card did
// nothing. The card sits on the Studio page, and the fix only opened the
// Studio tab: a page already open, so nothing moved. The fix is the door now.
describe('the watchdog card: Open Audio', () => {
  let opened: (WorkspaceNavigation | null)[] = []
  let asked: unknown[] = []
  const onNavigate = (event: Event): void => {
    opened.push(readWorkspaceNavigation((event as CustomEvent<unknown>).detail))
  }
  const onFocus = (event: Event): void => {
    asked.push((event as CustomEvent<unknown>).detail)
  }

  beforeEach(() => {
    opened = []
    asked = []
    takeSectionFocus('studio-audio')
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
    window.addEventListener(SECTION_FOCUS_EVENT, onFocus)
  })
  afterEach(() => {
    window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
    window.removeEventListener(SECTION_FOCUS_EVENT, onFocus)
  })

  it('opens the Studio and asks its Audio group to land on the microphone, on a page already open too', async () => {
    await runWatchdogFix(silentMic, silentMic.fixes![0]!, deps)
    expect(opened).toEqual([{ tab: 'studio' }])
    // The event is what a Studio page already on screen answers.
    expect(asked).toEqual(['studio-audio'])
    // The request is what a Studio that opens now takes as it mounts.
    expect(takeSectionFocus('studio-audio')).toBe(true)
  })

  it('works every time it is pressed', async () => {
    await runWatchdogFix(silentMic, silentMic.fixes![0]!, deps)
    takeSectionFocus('studio-audio')
    await runWatchdogFix(silentMic, silentMic.fixes![0]!, deps)
    expect(asked).toEqual(['studio-audio', 'studio-audio'])
    expect(takeSectionFocus('studio-audio')).toBe(true)
    expect(deps.openStudioPanel).not.toHaveBeenCalled()
  })
})
