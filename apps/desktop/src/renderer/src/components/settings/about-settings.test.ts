// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '@/lib/backend'
import { WORKSPACE_NAVIGATE_EVENT, type WorkspaceNavigation } from '@/lib/workspace-navigation'

import { AboutSettings } from './about-settings'

// Plan 174 S3.17 (I-20, I-21): About's update states and links.

const mocked = vi.hoisted(() => ({
  status: { phase: 'idle' } as UpdateStatus,
  recordingState: 'idle',
  check: vi.fn(),
  install: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    runtimeInfo: { version: '0.9.140', platform: 'darwin', isPackaged: true },
    exportSupportBundle: vi.fn(),
    supportBundleExportPending: false
  }),
  useStudioRecordingState: () => ({ recording: { state: mocked.recordingState } })
}))
vi.mock('@/hooks/use-updater', () => ({
  useUpdater: () => ({
    status: mocked.status,
    check: mocked.check,
    download: vi.fn(),
    install: mocked.install
  })
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.status = { phase: 'idle' }
  mocked.recordingState = 'idle'
  mocked.check.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = async (): Promise<void> =>
  act(async () => root.render(createElement(AboutSettings, { onShowWhatsNew: () => undefined })))
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)

describe('AboutSettings', () => {
  it('turns an update failure into an Alert with Try again, never the raw text', async () => {
    mocked.status = { phase: 'error', message: 'HttpError: 503 https://example.test/latest.yml' }
    await render()
    const alert = container.querySelector('[data-testid="update-error"]')
    expect(alert?.textContent).toContain("Couldn't check for updates")
    expect(container.textContent).not.toContain('HttpError')
    await act(async () => button('Try again')!.click())
    expect(mocked.check).toHaveBeenCalledOnce()
  })

  it('keeps install off while recording or live, and says why', async () => {
    mocked.status = { phase: 'downloaded', version: '0.9.141' }
    mocked.recordingState = 'streaming'
    await render()
    const install = button('Restart & install 0.9.141')!
    expect(install.disabled).toBe(true)
    const reasonId = install
      .closest('[data-slot="disabled-reason"]')
      ?.getAttribute('aria-describedby')
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      'Finish your recording or stream first. Installing restarts Videorc.'
    )
    expect(container.textContent).toContain('installs the next time you quit Videorc')
  })

  // Plan 174 S3.18 (I-1, D9): the support bundle lives on Health; About
  // links to it instead of keeping a second export button.
  it('sends the support bundle to its one home on Health', async () => {
    const opened: WorkspaceNavigation[] = []
    const listener = (event: Event): void => {
      opened.push((event as CustomEvent<WorkspaceNavigation>).detail)
    }
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, listener)
    try {
      await render()
      expect(container.querySelector('[data-testid="support-bundle-button"]')).toBeNull()
      await act(async () => button('Open Health')!.click())
      expect(opened).toEqual([{ tab: 'diagnostics' }])
    } finally {
      window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, listener)
    }
  })

  it('links the website, the policies and the source', async () => {
    await render()
    for (const title of [
      'Website',
      'Privacy policy',
      'Terms of service',
      'Source code and licenses'
    ]) {
      expect(
        [...container.querySelectorAll('[data-slot="list-row-title"]')].some(
          (entry) => entry.textContent === title
        ),
        title
      ).toBe(true)
    }
  })
})
