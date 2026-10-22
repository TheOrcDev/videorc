// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  core: { goLiveConfirmationOpen: false, goLiveConfirmationPending: false }
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/components/go-live-dialog-host', async () => {
  const react = await import('react')
  return {
    GoLiveDialogHost: () => react.createElement('div', { 'data-testid': 'go-live-dialog-host' })
  }
})

import { GoLiveDialogGate } from './go-live-dialog-gate'

// Plan 174 S0.6 (B-5, A-3): the Go Live confirmation used to mount only on
// the Studio page, so a start from any other page showed nothing.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

let root: Root
let container: HTMLDivElement

async function render(core: typeof mocked.core): Promise<void> {
  mocked.core = core
  await act(async () => root.render(createElement(GoLiveDialogGate)))
  // The host is a lazy chunk: let it resolve and commit.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const host = (): Element | null => container.querySelector('[data-testid="go-live-dialog-host"]')

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

describe('GoLiveDialogGate', () => {
  it('loads no dialog until Go Live is asked for', async () => {
    await render({ goLiveConfirmationOpen: false, goLiveConfirmationPending: false })
    expect(host()).toBeNull()
  })

  it('mounts the dialog while the preflight runs and keeps it after it closes', async () => {
    await render({ goLiveConfirmationOpen: false, goLiveConfirmationPending: false })
    await render({ goLiveConfirmationOpen: false, goLiveConfirmationPending: true })
    expect(host()).not.toBeNull()

    await render({ goLiveConfirmationOpen: true, goLiveConfirmationPending: false })
    expect(host()).not.toBeNull()

    // Closed: still mounted, so the dialog animates out and reopens at once.
    await render({ goLiveConfirmationOpen: false, goLiveConfirmationPending: false })
    expect(host()).not.toBeNull()
  })

  it('is hosted by the shell, outside the page switch, so it opens over every page', () => {
    const appShell = read('./app-shell.tsx')
    const gateAt = appShell.indexOf('<GoLiveDialogGate />')
    // Pages render inside PaneBody, each behind its own `active === …` check:
    // the gate sits after the pane, beside the palette and onboarding.
    expect(gateAt).toBeGreaterThan(appShell.indexOf('</main>'))
    expect(appShell.indexOf('</main>')).toBeGreaterThan(appShell.indexOf('</PaneBody>'))
    expect(appShell).not.toMatch(/\{active === '[a-z]+' \? <GoLiveDialogGate/)

    // One host only: Studio no longer mounts its own copy.
    expect(read('./tabs/studio-tab.tsx')).not.toContain('GoLiveConfirmationDialog')
  })

  it('keeps the dialog out of the shell entry chunk', () => {
    const gate = read('./go-live-dialog-gate.tsx')
    expect(gate).toContain("await import('@/components/go-live-dialog-host')")
    expect(gate).not.toMatch(/from '@\/components\/go-live-dialog(-host)?'/)
    expect(read('./app-shell.tsx')).not.toMatch(/from '@\/components\/go-live-dialog(-host)?'/)
  })
})
