// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'

import { CommandPalette } from './command-palette'

// Plan 174 S0.1 (B-1): the palette's session stop goes through the
// provider's decision, never straight to stopSession: a livestream asks
// first, a recording stops at once.

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
    stopSession: vi.fn(async () => true),
    requestStopSession: vi.fn(async () => false),
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

describe('CommandPalette session actions (plan 174 S0.1)', () => {
  it('routes Stop session through requestStopSession while live, never stopSession', async () => {
    mocked.recording = { state: 'recording', sessionId: 'live', streamUrl: 'rtmp://x/***' }
    await render()
    await act(async () => item('Stop session').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('routes a plain recording the same way (the provider stops it at once)', async () => {
    mocked.recording = { state: 'recording', sessionId: 'rec' }
    await render()
    await act(async () => item('Stop session').click())
    expect(mocked.core.requestStopSession).toHaveBeenCalledExactlyOnceWith('palette')
    expect(mocked.core.stopSession).not.toHaveBeenCalled()
  })

  it('offers Start session when idle', async () => {
    mocked.recording = { state: 'idle' }
    await render()
    expect(
      [...document.querySelectorAll('[cmdk-item]')].some(
        (entry) => entry.textContent?.trim() === 'Stop session'
      )
    ).toBe(false)
    await act(async () => item('Start session').click())
    expect(mocked.core.startSession).toHaveBeenCalledOnce()
    expect(mocked.core.requestStopSession).not.toHaveBeenCalled()
  })
})
