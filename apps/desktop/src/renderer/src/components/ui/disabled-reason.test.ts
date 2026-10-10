// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Button } from './button'
import { DisabledReason } from './disabled-reason'
import { TooltipProvider } from './tooltip'

// Plan 174 S1.1 (J1-2): a disabled control's reason shows on hover and on
// keyboard focus, and stays its description for assistive tech.

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
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(props: Partial<Parameters<typeof DisabledReason>[0]>): Promise<void> {
  await act(async () =>
    root.render(
      createElement(TooltipProvider, {
        delayDuration: 0,
        children: createElement(DisabledReason, {
          reason: null,
          children: createElement(Button, { disabled: true }, 'Save changes'),
          ...props
        })
      })
    )
  )
}

const wrapper = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="disabled-reason"]')

describe('DisabledReason', () => {
  it('makes the disabled control focusable through a wrapper the reason describes', async () => {
    await render({ reason: 'You can save when this cut finishes.' })
    const trigger = wrapper()
    expect(trigger?.tabIndex).toBe(0)
    expect(trigger?.querySelector('button')?.disabled).toBe(true)
    const description = document.getElementById(trigger?.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('You can save when this cut finishes.')
    // Out of the reading order, but still the description.
    expect(description?.hidden).toBe(true)
  })

  it('shows the reason as a tooltip on keyboard focus', async () => {
    await render({ reason: 'Stop the recording or stream before switching orientation.' })
    await act(async () => wrapper()?.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Stop the recording or stream before switching orientation.'
    )
  })

  it('renders the control as it is when there is no reason', async () => {
    await render({ reason: null })
    expect(wrapper()).toBeNull()
    expect(container.querySelector('[data-slot="disabled-reason-text"]')).toBeNull()
    expect(container.firstElementChild?.tagName).toBe('BUTTON')
    await render({ reason: '' })
    expect(wrapper()).toBeNull()
  })

  it('keeps a caller id and names the wrapper when asked', async () => {
    await render({
      reason: 'Videorc is reconnecting. Try again in a moment.',
      id: 'noise-cleanup-session-1-description',
      label: 'Clean up noise in Launch demo'
    })
    expect(wrapper()?.getAttribute('aria-describedby')).toBe('noise-cleanup-session-1-description')
    expect(wrapper()?.getAttribute('aria-label')).toBe('Clean up noise in Launch demo')
    expect(document.getElementById('noise-cleanup-session-1-description')?.textContent).toBe(
      'Videorc is reconnecting. Try again in a moment.'
    )
  })

  it('describes a Radix item in place, with no wrapper, when it is not focusable', async () => {
    await render({
      reason: '4K exceeds the recording limit.',
      focusable: false,
      children: createElement('div', { 'data-disabled': '', role: 'option' }, '4K')
    })
    expect(wrapper()).toBeNull()
    const option = container.querySelector<HTMLElement>('[role="option"]')
    expect(option?.className).toContain('data-disabled:pointer-events-auto')
    expect(
      document.getElementById(option?.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('4K exceeds the recording limit.')
  })
})
