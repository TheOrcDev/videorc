// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VirtualCameraStatus } from '@/lib/backend'
import type { VirtualCameraControls } from '@/hooks/use-virtual-camera'

// Plan 214 E1: Output → Camera for other apps. One row with the switch,
// the state's line and its one action; nothing where the camera is hidden.

const mocked = vi.hoisted(() => ({ camera: null as unknown as VirtualCameraControls }))
vi.mock('@/hooks/use-virtual-camera', () => ({ useVirtualCamera: () => mocked.camera }))

import { VideorcCameraSection } from './videorc-camera-section'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function camera(
  status: VirtualCameraStatus | null,
  overrides: Partial<VirtualCameraControls> = {}
): VirtualCameraControls {
  return {
    status,
    connected: true,
    platform: 'darwin',
    osRelease: '25.5.0',
    setOn: vi.fn(async () => ({ ok: true })),
    runAction: vi.fn(async () => ({ ok: true })),
    readFramePipeline: vi.fn(async () => null),
    ...overrides
  }
}

async function render(controls: VirtualCameraControls): Promise<void> {
  mocked.camera = controls
  await act(async () => root.render(createElement(VideorcCameraSection)))
}

const row = () => container.querySelector('[data-testid="output-videorc-camera"]')
const toggle = () => container.querySelector<HTMLElement>('[role="switch"]')!
const statusLine = () =>
  container.querySelector('[data-testid="output-videorc-camera-status"]')?.textContent ?? null
const action = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="output-videorc-camera-action"]')

describe('Output → Camera for other apps (plan 214 E1)', () => {
  it('is a labelled switch with the description, under its own section title', async () => {
    await render(camera({ on: false, available: true, state: 'off' }))
    expect(container.querySelector('h2')?.textContent).toBe('Camera for other apps')
    const label = [...container.querySelectorAll('label')].find(
      (entry) => entry.textContent === 'Videorc Camera'
    )!
    expect(label).toBeTruthy()
    expect(toggle().getAttribute('aria-labelledby')).toBe(label.id)
    expect(row()?.textContent).toContain(
      'Shows your program as a camera in Meet, Zoom, Teams and Discord. No sound. Meet shows you a mirror image; everyone else sees it right.'
    )
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(statusLine()).toBeNull()
    expect(action()).toBeNull()
  })

  it('turns on and off through the switch, with no toast and no extra words', async () => {
    const controls = camera({ on: false, available: true, state: 'off' })
    await render(controls)
    await act(async () => toggle().click())
    expect(controls.setOn).toHaveBeenCalledWith(true)
    await render(camera({ on: true, available: true, state: 'ready', viewers: 0 }))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(statusLine()).toBe('Ready · choose Videorc Camera in the other app')
  })

  it('needs approval: the path and Open System Settings, through the action channel', async () => {
    const controls = camera({
      on: true,
      available: true,
      state: 'needs-approval',
      platformStep: 'needs-approval'
    })
    await render(controls)
    expect(statusLine()).toBe(
      'Allow Videorc Camera in System Settings → General → Login Items & Extensions → Camera Extensions.'
    )
    expect(action()?.textContent).toBe('Open System Settings')
    await act(async () => action()!.click())
    expect(controls.runAction).toHaveBeenCalledWith('open-approval-settings')
  })

  it("says why an action didn't run, under the row", async () => {
    await render(
      camera(
        { on: false, available: true, state: 'needs-setup', platformStep: 'needs-setup' },
        {
          platform: 'win32',
          runAction: vi.fn(async () => ({ ok: false, message: 'Not available on this computer.' }))
        }
      )
    )
    expect(action()?.textContent).toBe('Set up Videorc Camera')
    await act(async () => action()!.click())
    expect(row()?.textContent).toContain('Not available on this computer.')
  })

  it("locks the switch off with one reason when the camera can't run", async () => {
    await render(
      camera({
        on: true,
        available: false,
        state: 'unavailable',
        platformStep: 'failed',
        message: 'Move Videorc to the Applications folder.'
      })
    )
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(toggle().hasAttribute('data-disabled')).toBe(true)
    expect(statusLine()).toBe('Move Videorc to the Applications folder.')
  })

  it('Linux: the install command to copy and Load module', async () => {
    await render(
      camera(
        {
          on: true,
          available: true,
          state: 'needs-setup',
          platformStep: 'needs-setup',
          message: 'sudo pacman -S v4l2loopback-dkms'
        },
        { platform: 'linux' }
      )
    )
    expect(statusLine()).toBe('Install v4l2loopback, then load it.')
    expect(
      container.querySelector('[data-testid="output-videorc-camera-command"]')?.textContent
    ).toBe('sudo pacman -S v4l2loopback-dkms')
    expect([...container.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual(
      expect.arrayContaining(['Copy', 'Load module'])
    )
  })

  it('waits while Videorc reconnects', async () => {
    await render(camera({ on: false, available: true, state: 'off' }, { connected: false }))
    expect(toggle().hasAttribute('data-disabled')).toBe(true)
    expect(statusLine()).toBe('Videorc is reconnecting. These controls come back in a moment.')
  })

  it('is not there where the camera is hidden, or before the status arrives', async () => {
    for (const platform of ['win32', 'linux']) {
      await render(
        camera(
          { on: false, available: false, state: 'unavailable', platformStep: 'unsupported' },
          { platform }
        )
      )
      expect(container.innerHTML, platform).toBe('')
    }
    await render(camera(null))
    expect(container.innerHTML).toBe('')
  })
})
