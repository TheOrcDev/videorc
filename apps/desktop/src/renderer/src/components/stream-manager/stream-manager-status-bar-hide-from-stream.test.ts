// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { StreamManagerHideMethod } from '@/lib/backend'
import { CAPTURE_PROTECTION_UNSUPPORTED_REASON } from '../../../../shared/capture-protection'
import {
  HIDDEN_FROM_STREAM_FOOTER,
  HIDE_FROM_STREAM_LABEL,
  StreamManagerStatusBar,
  hiddenFromStreamFooter,
  hideFromStreamAction
} from './stream-manager-status-bar'

// Plan 215 D6: Hide from stream sits next to Keep on top, in the status bar
// and the ⋯ menu, with the platform's own promise in its hint. macOS leaves
// the window out of Videorc's capture and nothing else; Windows hides it
// from every capture app and screenshot too, and says so; Linux can't, so
// the switch is disabled with the reason. While it holds, the footer says
// "Hidden from your stream", as Notes does.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.platform = 'darwin'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.platform
  vi.unstubAllGlobals()
})

async function renderBar(
  hiddenFromStream: boolean,
  hideFromStreamMethod: StreamManagerHideMethod,
  /** null: no relay to main. */
  onToggleHiddenFromStream: (() => void) | null = vi.fn()
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(TooltipProvider, {
        delay: 0,
        children: createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onToggleAlwaysOnTop: vi.fn(),
          hiddenFromStream,
          hideFromStreamMethod,
          onToggleHiddenFromStream: onToggleHiddenFromStream ?? undefined
        })
      })
    )
  )
}

const inline = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(
    '[data-slot="stream-manager-actions"] [data-testid="hide-from-stream-button"]'
  )

const footer = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-testid="stream-manager-capture-hidden"]')

async function openMore(): Promise<HTMLElement> {
  const more = container.querySelector<HTMLButtonElement>(
    '[aria-label="More Stream Manager actions"]'
  )!
  await act(async () => {
    more.click()
  })
  return document.querySelector<HTMLElement>('[role=menu]')!
}

function menuItem(menu: HTMLElement): HTMLElement {
  return [...menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')].find((row) =>
    row.textContent?.startsWith(HIDE_FROM_STREAM_LABEL)
  )!
}

describe('Stream Manager: Hide from stream (plan 215 D6)', () => {
  it('sits next to Keep on top, off by default, with the macOS promise in its hint', async () => {
    const onToggle = vi.fn()
    await renderBar(false, 'capture-filter', onToggle)
    const action = inline()!
    expect(action.getAttribute('aria-label')).toBe(HIDE_FROM_STREAM_LABEL)
    expect(action.getAttribute('aria-pressed')).toBe('false')
    expect(action.disabled).toBe(false)
    expect(action.getAttribute('aria-description')).toBe(
      'Keep this window out of your recordings and streams. Your own screenshots and other apps still see it.'
    )
    expect(action.hasAttribute('title')).toBe(false)
    const pin = container.querySelector<HTMLElement>('[data-testid="pin-window-button"]')!
    expect(pin.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(footer()).toBeNull()
    await act(async () => action.click())
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('reads on while hidden, and the footer says Hidden from your stream', async () => {
    await renderBar(true, 'capture-filter')
    expect(inline()!.getAttribute('aria-pressed')).toBe('true')
    expect(footer()!.textContent).toBe(HIDDEN_FROM_STREAM_FOOTER)
    expect(footer()!.textContent).toBe('Hidden from your stream')
  })

  it('says on Windows that other capture apps and screenshots lose the window too', async () => {
    await renderBar(true, 'content-protection')
    expect(inline()!.getAttribute('aria-description')).toBe(
      'Keep this window out of your recordings and streams. Other capture apps and screenshots lose it too.'
    )
    expect(footer()!.textContent).toBe(HIDDEN_FROM_STREAM_FOOTER)
  })

  it('is disabled on Linux with the reason, inline and in ⋯, and the footer stays quiet', async () => {
    const onToggle = vi.fn()
    await renderBar(false, 'unsupported', onToggle)
    const action = inline()!
    expect(action.disabled).toBe(true)
    const wrapper = action.closest<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe(CAPTURE_PROTECTION_UNSUPPORTED_REASON)
    expect(footer()).toBeNull()
    const menu = await openMore()
    const item = menuItem(menu)
    expect(item.hasAttribute('data-disabled')).toBe(true)
    expect(document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      CAPTURE_PROTECTION_UNSUPPORTED_REASON
    )
    expect(onToggle).not.toHaveBeenCalled()
    // A remembered value that cannot hold here never claims it does.
    await renderBar(true, 'unsupported', onToggle)
    expect(footer()).toBeNull()
  })

  it('folds into ⋯ as a check after Keep on top', async () => {
    const onToggle = vi.fn()
    await renderBar(true, 'capture-filter', onToggle)
    const menu = await openMore()
    const checks = [...menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')].map(
      (row) => row.textContent
    )
    expect(checks.indexOf(HIDE_FROM_STREAM_LABEL)).toBe(checks.indexOf('Keep on top') + 1)
    const item = menuItem(menu)
    expect(item.getAttribute('aria-checked')).toBe('true')
    await act(async () => item.click())
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('stays away with no relay', async () => {
    await renderBar(true, 'capture-filter', null)
    expect(inline()).toBeNull()
    const menu = await openMore()
    expect(
      [...menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')].some((row) =>
        row.textContent?.startsWith(HIDE_FROM_STREAM_LABEL)
      )
    ).toBe(false)
  })

  it('keeps the words in one place for the status bar and ⌘K', () => {
    expect(hideFromStreamAction(false, 'capture-filter', undefined)).toBeNull()
    expect(hideFromStreamAction(false, 'unsupported', vi.fn())?.disabledReason).toBe(
      CAPTURE_PROTECTION_UNSUPPORTED_REASON
    )
    expect(hideFromStreamAction(false, 'content-protection', vi.fn())?.disabledReason).toBeNull()
    expect(hiddenFromStreamFooter(true, 'capture-filter')).toBe(HIDDEN_FROM_STREAM_FOOTER)
    expect(hiddenFromStreamFooter(true, 'content-protection')).toBe(HIDDEN_FROM_STREAM_FOOTER)
    expect(hiddenFromStreamFooter(true, 'unsupported')).toBeNull()
    expect(hiddenFromStreamFooter(false, 'capture-filter')).toBeNull()
  })
})
