// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COHOST_ROW_OPENS, CohostSessionRow } from './session-panel'

// Plan 213 B2: the live Session row labelled Buddy opens the Stream Manager,
// and its hint and accessible name say so. Buddy's presence dot stays. The
// Chat row (B1) is chat's door; this one stays Buddy's.

const mocked = vi.hoisted(() => ({
  openCommentsWindow: vi.fn(async () => undefined)
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioChat: () => ({ cohostState: null }),
  useStudioShell: () => ({ openCommentsWindow: mocked.openCommentsWindow })
}))
// The row's tooltip opens on hover; render its hint inline to read it.
vi.mock('@/components/navigable-row', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/navigable-row')>()),
  NavigableRow: ({
    label,
    value,
    hint,
    onNavigate
  }: {
    label: string
    value: ReactNode
    hint?: ReactNode
    onNavigate?: () => void
  }) =>
    createElement(
      'div',
      null,
      createElement('button', { type: 'button', onClick: onNavigate }, label, ' ', value),
      createElement('div', { 'data-testid': 'hint' }, hint)
    )
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(CohostSessionRow)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the live Buddy row (plan 213 B2)', () => {
  it('says it opens the Stream Manager, in its hint and its name', () => {
    expect(COHOST_ROW_OPENS).toBe('Open Stream Manager')
    const hintLines = [
      ...container.querySelectorAll('[data-testid="hint"] [data-slot="navigable-row-hint"] > span')
    ].map((line) => line.textContent)
    expect(hintLines.at(-1)).toBe('Open Stream Manager')
    const name = container.querySelector('button')?.textContent ?? ''
    expect(name.startsWith('Buddy ')).toBe(true)
    expect(name.endsWith('. Open Stream Manager')).toBe(true)
  })

  it('keeps Buddy presence dot, and a click opens the Stream Manager', () => {
    expect(container.querySelector('button [data-slot="cohost-presence-dot"]')).not.toBeNull()
    act(() => container.querySelector('button')?.click())
    expect(mocked.openCommentsWindow).toHaveBeenCalledTimes(1)
  })
})
