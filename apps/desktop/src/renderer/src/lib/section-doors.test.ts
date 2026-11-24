// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readWorkspaceNavigation } from '@/components/workspace-nav'
import {
  openDestinations,
  openDestinationsCloud,
  openDestinationsDiscord,
  openLibraryRecording,
  openOutputClips,
  openOutputRecordings,
  openOutputVideorcCamera,
  openSourcesMicrophone,
  openSourcesSystemAudio,
  openStudioAudio
} from '@/lib/section-doors'
import { takeSectionFocus, type SectionFocusId } from '@/lib/section-focus'
import { WORKSPACE_NAVIGATE_EVENT, type WorkspaceNavigation } from '@/lib/workspace-navigation'

describe('doors (plan 250 S4)', () => {
  let opened: (WorkspaceNavigation | null)[] = []
  const onNavigate = (event: Event): void => {
    opened.push(readWorkspaceNavigation((event as CustomEvent<unknown>).detail))
  }

  beforeEach(() => {
    opened = []
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
  })
  afterEach(() => window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate))

  const doors: [string, () => void, WorkspaceNavigation, SectionFocusId][] = [
    ['Open Audio', openStudioAudio, { tab: 'studio' }, 'studio-audio'],
    ['Open Sources (microphone)', openSourcesMicrophone, { tab: 'sources' }, 'sources-microphone'],
    [
      'Open Sources (system audio)',
      openSourcesSystemAudio,
      { tab: 'sources' },
      'sources-system-audio'
    ],
    ['Open Output (folder)', openOutputRecordings, { tab: 'recording' }, 'output-recordings'],
    ['Open Output (Clips)', openOutputClips, { tab: 'recording' }, 'output-clips'],
    [
      'Open Output (Videorc Camera)',
      openOutputVideorcCamera,
      { tab: 'recording' },
      'output-videorc-camera'
    ],
    [
      'Open Destinations (Videorc Cloud)',
      openDestinationsCloud,
      { tab: 'live', livestreamView: 'setup' },
      'destinations-cloud'
    ]
  ]
  it.each(doors)('%s opens its page and asks its section once', (_name, open, page, section) => {
    open()
    expect(opened).toEqual([page])
    expect(takeSectionFocus(section)).toBe(true)
    expect(takeSectionFocus(section)).toBe(false)
  })

  it('Open Destinations opens Setup, on the named destination card', () => {
    openDestinations()
    openDestinations('tw-1')
    expect(opened).toEqual([
      { tab: 'live', livestreamView: 'setup' },
      { tab: 'live', livestreamView: 'setup', destinationId: 'tw-1' }
    ])
    // A card lives in Setup: a destination never opens Upcoming.
    expect(
      readWorkspaceNavigation({ tab: 'live', livestreamView: 'upcoming', destinationId: 'tw-1' })
    ).toEqual({ tab: 'live', livestreamView: 'setup', destinationId: 'tw-1' })
    expect(readWorkspaceNavigation({ tab: 'live', destinationId: 7 })).toEqual({ tab: 'live' })
  })

  it('Open Discord settings opens Destinations on its Discord tab (plan 187)', () => {
    openDestinationsDiscord()
    expect(opened).toEqual([{ tab: 'live', livestreamView: 'discord' }])
    expect(readWorkspaceNavigation({ tab: 'live', livestreamView: 'discord' })).toEqual({
      tab: 'live',
      livestreamView: 'discord'
    })
  })

  it('Open in Library keeps the recording', () => {
    openLibraryRecording('session-9')
    expect(opened).toEqual([{ tab: 'library', sessionId: 'session-9' }])
  })

  // The shell is not mounted in a unit test: pin the two lines that carry a
  // door's target into the page, which `setActive` alone dropped.
  it('the shell hands the recording and the destination to their pages', () => {
    const shell = readFileSync(join(__dirname, '../components/app-shell.tsx'), 'utf8')
    expect(shell).toMatch(
      /navigation\.tab === 'library' && navigation\.sessionId\) \{\s+openLibrarySession\(navigation\.sessionId\)/
    )
    expect(shell).toMatch(
      /if \(navigation\.destinationId\) setDestinationToOpen\(navigation\.destinationId\)/
    )
  })
})
