// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamScreen } from '@/lib/backend'

import { TakeoverScreensSection } from './takeover-screens-section'

// Plan 174 S0.3 (C-1): deleting a takeover removes its image file, so it asks.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

const screen: StreamScreen = {
  id: 'screen-1',
  name: 'Intro card',
  imagePath: '/screens/intro.png',
  sortOrder: 0,
  status: 'ready' as never,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z'
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    activeScreen: null,
    deleteScreen: vi.fn(async () => undefined),
    importScreenImage: vi.fn(async () => undefined),
    isSessionActive: false,
    reorderScreen: vi.fn(async () => undefined),
    renameScreen: vi.fn(async () => undefined),
    screenImportPending: false,
    screens: [screen],
    wsStatus: 'connected'
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('TakeoverScreensSection delete', () => {
  it('asks before deleting, keeps the takeover on Cancel, and deletes on confirm', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Delete takeover"]')
    expect(trigger).not.toBeNull()
    await act(async () => trigger!.click())
    const dialog = byTestId('takeover-delete-dialog')
    expect(dialog?.textContent).toContain('Delete Intro card?')
    expect(dialog?.textContent).toContain('Its image file is deleted from this computer.')
    expect(byTestId('takeover-delete-confirm')?.textContent).toBe('Delete takeover')
    await act(async () => byTestId('takeover-delete-cancel')!.click())
    expect(mocked.core.deleteScreen).not.toHaveBeenCalled()
    expect(byTestId('takeover-delete-dialog')).toBeNull()

    await act(async () => trigger!.click())
    await act(async () => byTestId('takeover-delete-confirm')!.click())
    expect(mocked.core.deleteScreen).toHaveBeenCalledExactlyOnceWith('screen-1')
    expect(byTestId('takeover-delete-dialog')).toBeNull()
  })
})
