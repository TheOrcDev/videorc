// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'
import { FIRST_RUN_SETUP_OPEN_EVENT } from '@/lib/workspace-navigation'

import { CommandPalette } from './command-palette'

// Plan 174 S0.1 (B-1): the palette's session stop goes through the
// provider's decision, never straight to stopSession: a livestream asks
// first, a recording stops at once. Plan 174 S2.2 (D3): it speaks the
// transport's words, and offers both of its starts. Plan 174 S3.21 (A-9,
// A-13): Session → Pages → Windows → Scenes → Buddy → Settings → Appearance,
// one verb for pages, synonyms, and a footer naming the selected action.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  banners: {} as Record<string, unknown>,
  soundboard: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>,
  replay: {
    state: { state: 'off', seconds: 30, bufferedSeconds: 0 },
    armed: false,
    setArmed: vi.fn(),
    save: vi.fn(async () => undefined)
  } as Record<string, unknown>,
  theme: 'dark' as string | undefined,
  setTheme: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioBanners: () => mocked.banners,
  useStudioRecordingState: () => ({ recording: mocked.recording }),
  useStudioReplay: () => mocked.replay
}))
vi.mock('@/hooks/use-soundboard', () => ({ useSoundboard: () => mocked.soundboard }))
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: mocked.theme, setTheme: mocked.setTheme })
}))

let root: Root
let container: HTMLDivElement
const noop = (): void => {}
const nav = {
  setActive: vi.fn(),
  openStudioPanel: vi.fn(),
  openSettings: vi.fn(),
  openBuddy: vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.recording = { state: 'idle' }
  mocked.banners = {
    banners: [],
    showBanner: vi.fn(async () => true),
    hideBanner: vi.fn(async () => true)
  }
  mocked.soundboard = {
    sounds: [],
    voices: [],
    play: vi.fn(async () => true),
    stopAll: vi.fn(async () => true)
  }
  mocked.core = {
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled: false, captionsWindowEnabled: false },
    savedScenes: [],
    applySavedScene: vi.fn(async () => true),
    captureConfig: { audio: { microphoneMuted: false } },
    setCaptureConfig: vi.fn(),
    settings: {},
    markClip: vi.fn(async () => null),
    startSession: vi.fn(async () => true),
    startRecording: vi.fn(),
    startLivestream: vi.fn(),
    stopSession: vi.fn(async () => true),
    requestStopSession: vi.fn(async () => false),
    previewWindow: { open: false },
    togglePreviewWindow: vi.fn(async () => undefined),
    notesWindow: { open: false },
    openNotesWindow: vi.fn(async () => undefined),
    closeNotesWindow: vi.fn(async () => undefined),
    commentsWindow: { open: false },
    toggleCommentsWindow: vi.fn(async () => undefined),
    captionsWindow: { open: false },
    toggleCaptionsWindow: vi.fn(async () => undefined)
  }
  for (const fn of Object.values(nav)) fn.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        WorkspaceNavContext.Provider,
        {
          value: {
            active: 'library',
            activeStudioPanel: null,
            closeStudioPanel: noop,
            ...nav
          }
        },
        createElement(CommandPalette, { open: true, onOpenChange: noop })
      )
    )
  )
}

/** An item by the words the footer shows for it (its cmdk value). */
function item(value: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[cmdk-item][data-value="${value}"]`)
  expect(found, value).toBeTruthy()
  return found!
}

function values(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map(
    (entry) => entry.dataset.value ?? ''
  )
}

function headings(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[cmdk-group-heading]')].map(
    (entry) => entry.textContent?.trim() ?? ''
  )
}

/** The items under one group heading. */
function groupValues(heading: string): string[] {
  const head = [...document.querySelectorAll<HTMLElement>('[cmdk-group-heading]')].find(
    (entry) => entry.textContent?.trim() === heading
  )
  expect(head, heading).toBeTruthy()
  return [...head!.parentElement!.querySelectorAll<HTMLElement>('[cmdk-item]')].map(
    (entry) => entry.dataset.value ?? ''
  )
}

async function search(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CommandPalette session actions (plan 174 S0.1, S2.2)', () => {
  it('ends a livestream through requestStopSession, never stopSession', async () => {
    mocked.recording = { state: 'recording', sessionId: 'live', streamUrl: 'rtmp://x/***' }
    await render()
    expect(values()).not.toContain('Stop recording')
    await act(async () => item('End livestream').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('stops a plain recording the same way (the provider stops it at once)', async () => {
    mocked.recording = { state: 'recording', sessionId: 'rec' }
    await render()
    expect(values()).not.toContain('End livestream')
    await act(async () => item('Stop recording').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('offers Start recording and Go live… when idle, each running its own start', async () => {
    await render()
    expect(values()).not.toContain('Stop recording')
    expect(values()).not.toContain('End livestream')
    expect(values().some((value) => /session/i.test(value))).toBe(false)

    await act(async () => item('Start recording').click())
    expect(mocked.core.startRecording).toHaveBeenCalledOnce()
    expect(mocked.core.startLivestream).not.toHaveBeenCalled()

    await render()
    await act(async () => item('Go live…').click())
    expect(mocked.core.startLivestream).toHaveBeenCalledOnce()
    expect(mocked.core.startRecording).toHaveBeenCalledOnce()
    expect(mocked.core.startSession).not.toHaveBeenCalled()
    expect(mocked.core.requestStopSession).not.toHaveBeenCalled()
  })

  it('disables both starts while a session is starting', async () => {
    mocked.recording = { state: 'starting' }
    await render()
    expect(item('Start recording').getAttribute('aria-disabled')).toBe('true')
    expect(item('Go live…').getAttribute('aria-disabled')).toBe('true')
  })

  // Plan 174 A-9: the Session group mirrors the transport, mute included.
  it('mutes and unmutes the microphone through the capture config', async () => {
    await render()
    expect(values()).not.toContain('Unmute microphone')
    await act(async () => item('Mute microphone').click())
    const update = (mocked.core.setCaptureConfig as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(update({ audio: { microphoneMuted: false, gain: 1 } })).toEqual({
      audio: { microphoneMuted: true, gain: 1 }
    })

    mocked.core.captureConfig = { audio: { microphoneMuted: true } }
    await render()
    expect(values()).toContain('Unmute microphone')
    expect(values()).not.toContain('Mute microphone')
  })

  it('offers both clip lengths while recording or live (plan 181 R4, plan 199)', async () => {
    await render()
    expect(values()).not.toContain('Save a 30-second clip')
    expect(values()).not.toContain('Save a 1-minute clip')
    mocked.recording = { state: 'recording', sessionId: 'rec' }
    await render()
    expect(values()).toContain('Save a 1-minute clip')
    await act(async () => item('Save a 30-second clip').click())
    // No length is today's 30-second clip.
    expect(mocked.core.markClip).toHaveBeenCalledExactlyOnceWith()
  })

  it('offers both clip lengths while the ring holds frames with nothing recording (plan 181, plan 199)', async () => {
    await render()
    expect(values()).not.toContain('Save a 30-second clip')
    expect(values()).not.toContain('Save replay')
    mocked.replay = {
      ...mocked.replay,
      state: { state: 'on', seconds: 60, bufferedSeconds: 12, sessionId: 'ring' }
    }
    await render()
    expect(values()).toContain('Save a 30-second clip')
    await act(async () => item('Save a 1-minute clip').click())
    expect(mocked.core.markClip).toHaveBeenCalledExactlyOnceWith(60)
    expect(values()).not.toContain('Save replay')
    mocked.replay = { ...mocked.replay, state: { state: 'off', seconds: 60, bufferedSeconds: 0 } }
  })
})

describe('CommandPalette order and verbs (plan 174 A-9, A-13)', () => {
  it('runs Session → Pages → Windows → Scenes → Buddy → Settings → Appearance', async () => {
    await render()
    expect(headings()).toEqual(['Session', 'Pages', 'Windows', 'Buddy', 'Settings', 'Appearance'])
    mocked.core.savedScenes = [{ id: 's1', name: 'Talking head' }]
    await render()
    expect(headings()).toEqual([
      'Session',
      'Pages',
      'Windows',
      'Scenes',
      'Buddy',
      'Settings',
      'Appearance'
    ])
    expect(groupValues('Scenes')).toEqual(['Switch to Talking head'])
  })

  it('opens every page with one verb, in sidebar order, Health last', async () => {
    await render()
    expect(groupValues('Pages')).toEqual([
      'Open Studio',
      'Open Buddy',
      'Open Sources',
      'Open Scene',
      'Open Assets',
      'Open Livestream',
      'Open Captions',
      'Open Output',
      'Open Library',
      'Open Settings',
      'Open Health',
      'Open Upcoming events'
    ])
    await act(async () => item('Open Scene').click())
    expect(nav.openStudioPanel).toHaveBeenCalledExactlyOnceWith('layouts')
    await render()
    await act(async () => item('Open Settings').click())
    expect(nav.openSettings).toHaveBeenCalledExactlyOnceWith()
    await render()
    await act(async () => item('Open Health').click())
    expect(nav.setActive).toHaveBeenCalledExactlyOnceWith('diagnostics')
  })

  it('finds pages by what people call them', async () => {
    await render()
    await search('layout')
    expect(values()).toContain('Open Scene')
    await search('destinations')
    expect(values()).toContain('Open Livestream')
    await search('keyboard')
    expect(values()).toContain('Open Settings → Shortcuts')
    await search('support bundle')
    expect(values()).toContain('Open Health')
    expect(values()).not.toContain('Open Library')
  })

  it('names the selected action in the footer, with the Return chip', async () => {
    await render()
    const footer = document.querySelector<HTMLElement>('[data-slot="command-footer"]')
    expect(footer?.textContent).toContain('Start recording')
    expect(footer?.querySelector('[data-accelerator="Enter"]')).not.toBeNull()
    expect(footer?.getAttribute('aria-hidden')).toBe('true')
  })

  it('checks the look in use', async () => {
    await render()
    expect(groupValues('Appearance')).toEqual(['Light theme', 'Dark theme', 'System theme'])
    expect(item('Dark theme').dataset.checked).toBe('true')
    expect(item('Light theme').dataset.checked).toBe('false')
    await act(async () => item('Light theme').click())
    expect(mocked.setTheme).toHaveBeenCalledWith('light')
  })
})

describe('CommandPalette windows (plan 174 S2.3a, A-11)', () => {
  it('lists every window by its one name, in the Window menu order', async () => {
    mocked.core.runtimeInfo = {
      platform: 'darwin',
      commentsWindowEnabled: true,
      notesWindowEnabled: true
    }
    mocked.core.captionsWindow = { open: false, enabled: true }
    mocked.core.notesWindow = { open: true }
    await render()
    expect(groupValues('Windows')).toEqual([
      'Open Preview',
      'Close Notes',
      'Open Stream Manager',
      'Open Captions reader'
    ])
    await act(async () => item('Close Notes').click())
    expect(mocked.core.closeNotesWindow).toHaveBeenCalledOnce()
    expect(mocked.core.openNotesWindow).not.toHaveBeenCalled()
  })
})

describe('CommandPalette Health door (plan 174 D9)', () => {
  it('finds Health by what people look for there', async () => {
    await render()
    await search('support bundle')
    expect(values()).toContain('Open Health')
    expect(values()).not.toContain('Open Library')
  })
})

describe('CommandPalette banners (plan 186 S7)', () => {
  it('names each banner by what selecting it does, then Hide all banners while any shows', async () => {
    mocked.banners.banners = [
      { id: 'sponsor', name: 'Sponsor', shown: false },
      { id: 'logo', name: 'Logo', shown: true }
    ]
    mocked.core.savedScenes = [{ id: 's1', name: 'Talking head' }]
    await render()
    expect(headings()).toEqual([
      'Session',
      'Pages',
      'Windows',
      'Scenes',
      'Banners',
      'Buddy',
      'Settings',
      'Appearance'
    ])
    expect(groupValues('Banners')).toEqual([
      'Show banner: Sponsor',
      'Hide banner: Logo',
      'Hide all banners'
    ])
    await act(async () => item('Show banner: Sponsor').click())
    expect(mocked.banners.showBanner).toHaveBeenCalledExactlyOnceWith('sponsor')
    await render()
    await act(async () => item('Hide banner: Logo').click())
    expect(mocked.banners.hideBanner).toHaveBeenCalledExactlyOnceWith('logo')
    await render()
    await act(async () => item('Hide all banners').click())
    expect(mocked.banners.hideBanner).toHaveBeenLastCalledWith()
  })

  it('finds banners by the word, and leaves the group out with none, or none showing', async () => {
    mocked.banners.banners = [{ id: 'sponsor', name: 'Sponsor', shown: false }]
    await render()
    expect(groupValues('Banners')).toEqual(['Show banner: Sponsor'])
    await search('banner')
    expect(values()).toContain('Show banner: Sponsor')
    mocked.banners.banners = []
    await render()
    expect(headings()).not.toContain('Banners')
  })
})

describe('CommandPalette sounds (plan 189 S10)', () => {
  it('plays each sound by name with its Studio key, then Stop all sounds while any plays', async () => {
    mocked.soundboard.sounds = [
      { id: 'airhorn', name: 'Airhorn', hotkey: '1' },
      { id: 'gong', name: 'Gong' }
    ]
    mocked.soundboard.voices = [{ soundId: 'gong' }]
    await render()
    expect(headings()).toContain('Sounds')
    expect(groupValues('Sounds')).toEqual([
      'Play sound: Airhorn',
      'Play sound: Gong',
      'Stop all sounds'
    ])
    expect(item('Play sound: Airhorn').querySelector('kbd')?.textContent).toBe('1')
    await act(async () => item('Play sound: Airhorn').click())
    expect(mocked.soundboard.play).toHaveBeenCalledExactlyOnceWith('airhorn')
    await render()
    await act(async () => item('Stop all sounds').click())
    expect(mocked.soundboard.stopAll).toHaveBeenCalledOnce()
  })

  it('finds sounds by the word, and leaves Stop all out while nothing plays', async () => {
    mocked.soundboard.sounds = [{ id: 'airhorn', name: 'Airhorn' }]
    await render()
    expect(groupValues('Sounds')).toEqual(['Play sound: Airhorn'])
    await search('soundboard')
    expect(values()).toContain('Play sound: Airhorn')
    mocked.soundboard.sounds = []
    await render()
    expect(headings()).not.toContain('Sounds')
  })

  it('runs setup again and comes back to the page it was opened from (plan 203 S6)', async () => {
    await render()
    const requests: unknown[] = []
    const listen = (event: Event): void => void requests.push((event as CustomEvent).detail)
    window.addEventListener(FIRST_RUN_SETUP_OPEN_EVENT, listen)
    await act(async () => item('Run setup again…').click())
    window.removeEventListener(FIRST_RUN_SETUP_OPEN_EVENT, listen)
    expect(requests).toEqual([{ returnTo: 'library' }])
  })

  it('hides Run setup again… while a recording or livestream runs, not for the Clips ring', async () => {
    for (const state of ['starting', 'recording', 'streaming', 'stopping']) {
      mocked.recording = { state }
      await render()
      expect(values(), state).not.toContain('Run setup again…')
    }
    mocked.recording = { state: 'recording', replayOnly: true }
    await render()
    expect(values()).toContain('Run setup again…')
  })
})
