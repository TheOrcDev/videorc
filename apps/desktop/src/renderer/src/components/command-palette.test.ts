// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'

import { CommandPalette } from './command-palette'

// Plan 174 S0.1 (B-1): the palette's session stop goes through the
// provider's decision, never straight to stopSession: a livestream asks
// first, a recording stops at once. Plan 174 S2.2 (D3): it speaks the
// transport's words, and offers both of its starts.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => ({ recording: mocked.recording })
}))

let root: Root
let container: HTMLDivElement
const noop = (): void => {}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled: false, captionsWindowEnabled: false },
    savedScenes: [],
    applySavedScene: vi.fn(async () => true),
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
            setActive: noop,
            activeStudioPanel: null,
            openStudioPanel: noop,
            closeStudioPanel: noop,
            openSettings: noop,
            openBuddy: noop
          }
        },
        createElement(CommandPalette, { open: true, onOpenChange: noop })
      )
    )
  )
}

function item(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
    (entry) => entry.textContent?.trim() === label
  )
  expect(found, label).toBeTruthy()
  return found!
}

function labels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map(
    (entry) => entry.textContent?.trim() ?? ''
  )
}

describe('CommandPalette session actions (plan 174 S0.1, S2.2)', () => {
  it('ends a livestream through requestStopSession, never stopSession', async () => {
    mocked.recording = { state: 'recording', sessionId: 'live', streamUrl: 'rtmp://x/***' }
    await render()
    expect(labels()).not.toContain('Stop recording')
    await act(async () => item('End livestream').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('stops a plain recording the same way (the provider stops it at once)', async () => {
    mocked.recording = { state: 'recording', sessionId: 'rec' }
    await render()
    expect(labels()).not.toContain('End livestream')
    await act(async () => item('Stop recording').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('offers Start recording and Go live… when idle, each running its own start', async () => {
    mocked.recording = { state: 'idle' }
    await render()
    expect(labels()).not.toContain('Stop recording')
    expect(labels()).not.toContain('End livestream')
    expect(labels().some((label) => /session/i.test(label))).toBe(false)

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
})

describe('CommandPalette windows (plan 174 S2.3a, A-11)', () => {
  it('lists every window by its one name, in the Window menu order', async () => {
    mocked.recording = { state: 'idle' }
    mocked.core.runtimeInfo = {
      platform: 'darwin',
      commentsWindowEnabled: true,
      notesWindowEnabled: true
    }
    mocked.core.captionsWindow = { open: false, enabled: true }
    mocked.core.notesWindow = { open: true }
    await render()
    const windows = labels().filter((label) => /^(Open|Close) /.test(label))
    expect(windows.map((label) => label.replace(/[⌘⇧].*$/, '').trim())).toEqual([
      'Open Preview',
      'Close Notes',
      'Open Stream Manager',
      'Open Captions reader'
    ])
    await act(async () => item(windows[1]).click())
    expect(mocked.core.closeNotesWindow).toHaveBeenCalledOnce()
    expect(mocked.core.openNotesWindow).not.toHaveBeenCalled()
  })
})
