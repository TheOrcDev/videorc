// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppErrorBoundary } from './app-error-boundary'
import { errorDetails } from './error-boundary'
import { PageErrorBoundary } from './page-error-boundary'

// Plan 174 S3.21 (A-7): a page crash stays inside the page and can be
// reloaded in place; the root panel keeps a drag band and offers the support
// bundle when the provider survived. The panels load lazily, so each render
// is flushed twice.

let root: Root
let container: HTMLDivElement
let crash = true

function Page(): ReactElement {
  if (crash) throw new Error('boom')
  return createElement('p', { 'data-testid': 'page-ok' }, 'Studio')
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  crash = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element))
  // The lazy panel (and the modules it imports) load on later ticks: under
  // vitest their first transform takes a moment, so wait for the panel.
  for (let tick = 0; tick < 200 && !container.querySelector('[role="alert"]'); tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label
  )
  expect(found, label).toBeTruthy()
  return found!
}

describe('PageErrorBoundary', () => {
  it('keeps the crash inside the page and reloads the page in place', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement('nav', { 'data-testid': 'sidebar' }, 'Sidebar'),
        createElement(PageErrorBoundary, { children: createElement(Page) })
      )
    )
    const panel = container.querySelector('[data-testid="page-error"]')
    expect(panel?.getAttribute('role')).toBe('alert')
    expect(panel?.textContent).toContain('This page hit a problem')
    expect(panel?.textContent).toContain('Other pages still work.')
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull()
    expect(button('Copy details')).toBeTruthy()

    crash = false
    await act(async () => button('Reload page').click())
    expect(container.querySelector('[data-testid="page-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="page-ok"]')?.textContent).toBe('Studio')
  })
})

describe('AppErrorBoundary', () => {
  it('shows a recoverable panel with a drag band, and the support bundle when given', async () => {
    await render(
      createElement(AppErrorBoundary, {
        supportBundle: createElement('button', { type: 'button' }, 'Export support bundle'),
        children: createElement(Page)
      })
    )
    expect(container.querySelector('[data-testid="app-error"]')?.getAttribute('role')).toBe('alert')
    expect(container.querySelector('[data-testid="app-error-drag"]')?.className).toContain(
      '[-webkit-app-region:drag]'
    )
    expect(container.textContent).toContain('Videorc hit a problem')
    expect(button('Export support bundle')).toBeTruthy()
    expect(button('Reload Videorc')).toBeTruthy()

    crash = false
    await act(async () => button('Try again').click())
    expect(container.querySelector('[data-testid="app-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="page-ok"]')).not.toBeNull()
  })

  it('offers no support bundle at the root, where no provider serves it', async () => {
    await render(createElement(AppErrorBoundary, { children: createElement(Page) }))
    expect(
      [...container.querySelectorAll('button')].map((entry) => entry.textContent?.trim())
    ).toEqual(['Try again', 'Reload Videorc', 'Copy details'])
  })
})

describe('errorDetails', () => {
  it('copies the stack and where it rendered', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at render'
    expect(errorDetails(error, '\n    at Page\n    at AppShell')).toBe(
      'Error: boom\n    at render\nRendered by:\nat Page\n    at AppShell'
    )
    expect(errorDetails(error)).toBe('Error: boom\n    at render')
  })
})
