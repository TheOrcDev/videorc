// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Badge } from './badge'
import { Button } from './button'
import { InfoTooltip } from './info-tooltip'
import { TooltipProvider } from './tooltip'

// Plan 174 S1.10 (J1-6): what a chip means reaches the keyboard and a screen
// reader, never only a native title.

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

async function render(props: Partial<Parameters<typeof InfoTooltip>[0]>): Promise<void> {
  await act(async () =>
    root.render(
      createElement(TooltipProvider, {
        delayDuration: 0,
        children: createElement(InfoTooltip, {
          content: null,
          children: createElement(Badge, { variant: 'destructive' }, 'MP4 failed'),
          ...props
        })
      })
    )
  )
}

const wrapper = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="info-tooltip"]')

describe('InfoTooltip', () => {
  it('makes a chip focusable through a wrapper its explanation describes', async () => {
    await render({ content: 'The disk is full.' })
    const trigger = wrapper()
    expect(trigger?.tabIndex).toBe(0)
    expect(trigger?.textContent).toBe('MP4 failed')
    const description = document.getElementById(trigger?.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe('The disk is full.')
    expect(description?.hidden).toBe(true)
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('shows the explanation as a tooltip on keyboard focus', async () => {
    await render({ content: 'The disk is full.' })
    await act(async () => wrapper()?.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'The disk is full.'
    )
  })

  it('leaves a roving row out of the tab order while still describing the chip', async () => {
    await render({ content: 'The disk is full.', tabIndex: -1 })
    expect(wrapper()?.tabIndex).toBe(-1)
  })

  it('renders the chip exactly as it is when there is nothing to explain', async () => {
    await render({ content: '' })
    expect(wrapper()).toBeNull()
    expect(container.textContent).toBe('MP4 failed')
  })

  it('describes a control that takes focus itself, with no wrapper', async () => {
    await render({
      content: 'Opens x.com to approve live broadcasting for this account.',
      focusable: false,
      children: createElement(Button, null, 'Authorize X Live')
    })
    expect(wrapper()).toBeNull()
    const button = container.querySelector('button') as HTMLButtonElement
    const description = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toBe(
      'Opens x.com to approve live broadcasting for this account.'
    )
    await act(async () => button.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Opens x.com'
    )
  })
})
