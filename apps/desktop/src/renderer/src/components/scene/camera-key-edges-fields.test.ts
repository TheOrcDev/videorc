// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CameraKeyEdges } from '@/lib/backend'

import { CameraKeyEdgesFields } from './camera-key-edges-fields'

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

const NONE: CameraKeyEdges = { leftPct: 0, topPct: 0, rightPct: 0, bottomPct: 0 }

const field = (side: string): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(`[data-videorc-key-edge="${side}"]`)!

async function type(input: HTMLInputElement, value: string, key = 'Enter'): Promise<void> {
  await act(async () => {
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('CameraKeyEdgesFields (plan 227 B)', () => {
  it('labels the four sides and names each field for screen readers', async () => {
    await act(async () =>
      root.render(createElement(CameraKeyEdgesFields, { edges: NONE, onCommit: vi.fn() }))
    )
    expect(container.textContent).toContain('Hide edges')
    for (const [side, label] of [
      ['leftPct', 'left'],
      ['topPct', 'top'],
      ['rightPct', 'right'],
      ['bottomPct', 'bottom']
    ]) {
      expect(field(side).getAttribute('aria-label')).toBe(
        `Hide ${label} edge, percent of the camera`
      )
      expect(field(side).value).toBe('0')
    }
    expect(container.querySelector('[data-videorc-key-edges-reset]')).toBeNull()
  })

  it('commits a typed side as a clamped whole percent and drops Escape', async () => {
    const onCommit = vi.fn()
    await act(async () =>
      root.render(createElement(CameraKeyEdgesFields, { edges: NONE, onCommit }))
    )
    await type(field('leftPct'), '2')
    expect(onCommit).toHaveBeenLastCalledWith({ ...NONE, leftPct: 2 })
    await type(field('bottomPct'), '60%')
    expect(onCommit).toHaveBeenLastCalledWith({ ...NONE, bottomPct: 25 })
    onCommit.mockClear()
    await type(field('topPct'), '9', 'Escape')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('offers Show all edges while a side is set', async () => {
    const onCommit = vi.fn()
    await act(async () =>
      root.render(
        createElement(CameraKeyEdgesFields, { edges: { ...NONE, rightPct: 3 }, onCommit })
      )
    )
    const reset = container.querySelector<HTMLButtonElement>('[data-videorc-key-edges-reset]')!
    expect(reset.textContent).toContain('Show all edges')
    await act(async () => reset.click())
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(NONE)
  })
})
