// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VideoPreset } from '@/lib/backend'

import { StreamQualityControl } from './stream-quality-control'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(value: VideoPreset, onChange: (value: VideoPreset | 'default') => void) {
  await act(async () =>
    root.render(
      createElement(StreamQualityControl, { value, disabled: false, youtube: false, onChange })
    )
  )
}

function option(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent?.includes(label)
  )
  if (!found) throw new Error(`no option ${label}`)
  return found
}

// Go Live steps an untouched default down on a CPU compositor (retest 153),
// so choosing the 1080p30 the control already shows must make it a pick.
describe('StreamQualityControl', () => {
  it('turns the untouched default into a pick when 1080p30 is chosen again', async () => {
    const onChange = vi.fn()
    await render('tutorial-1080p30', onChange)
    expect(option('1080p · 30 fps').getAttribute('aria-checked')).toBe('true')

    await act(async () => option('1080p · 30 fps').click())

    expect(onChange).toHaveBeenCalledWith('stream-safe-1080p30')
  })

  it('does nothing when a picked quality is chosen again', async () => {
    const onChange = vi.fn()
    await render('stream-safe-1080p30', onChange)

    await act(async () => option('1080p · 30 fps').click())

    expect(onChange).not.toHaveBeenCalled()
  })
})
