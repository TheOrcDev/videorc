// @vitest-environment happy-dom
// QA F14: the People list mounted with the real TanStack virtualizer and the
// real ScrollArea (community-tab.test.ts mocks the virtualizer, which hid that
// the list watched ScrollArea's root instead of the viewport that scrolls).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommunityPersonRow } from '@/lib/backend'

const client = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/use-community', () => ({
  useCommunityClient: () => ({
    call: client.call,
    summary: null,
    revision: 0,
    ready: true,
    offline: false,
    bump: () => undefined
  })
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    cohostGate: { allowed: true },
    cohostSettings: null,
    patchCohostSettings: vi.fn(async () => undefined)
  })
}))
vi.mock('@/components/community/community-preview', () => ({
  CommunityPreview: () => null
}))

const { default: CommunityTab } = await import('@/components/community/community-tab')

const VIEWPORT = { width: 400, height: 384 }

function person(index: number): CommunityPersonRow {
  return {
    id: `p-${index}`,
    name: `Person ${index}`,
    platforms: ['twitch'],
    streams: 3,
    regular: true,
    status: 'normal'
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // happy-dom lays nothing out: give the scrolling viewport (only it) the
  // h-96 box the app draws, so the virtualizer has a window to fill.
  const sized = (element: HTMLElement): boolean =>
    element.dataset.slot === 'scroll-area-viewport' &&
    element.closest('[data-testid="community-people-list"]') !== null
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return sized(this) ? VIEWPORT.height : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return sized(this) ? VIEWPORT.width : 0
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client.call.mockImplementation(async (method: string, params: { cursor?: string }) => {
    if (method === 'cohost.community.list') {
      return params.cursor
        ? { people: Array.from({ length: 20 }, (_, n) => person(100 + n)) }
        : { people: Array.from({ length: 100 }, (_, n) => person(n)), nextCursor: 'page-2' }
    }
    if (method === 'cohost.community.suggestions') return { suggestions: [] }
    throw new Error(`unexpected ${method}`)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(): Promise<HTMLElement> {
  await act(async () => {
    root.render(createElement(CommunityTab))
  })
  // The list asks after its 150 ms debounce.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  const viewport = container.querySelector<HTMLElement>(
    '[data-testid="community-people-list"] [data-slot="scroll-area-viewport"]'
  )
  expect(viewport).not.toBeNull()
  return viewport!
}

async function scrollTo(viewport: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    viewport.scrollTop = top
    viewport.dispatchEvent(new Event('scroll'))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const renderedNames = (): string[] =>
  Array.from(container.querySelectorAll('[data-testid="community-person-row"]')).map(
    (row) => row.textContent ?? ''
  )

describe('Sidekick → Community People list scrolling (QA F14)', () => {
  it('draws the people at the scrolled offset of the viewport that scrolls', async () => {
    const viewport = await mount()
    expect(renderedNames().some((name) => name.includes('Person 0'))).toBe(true)
    expect(renderedNames().some((name) => name.includes('Person 50'))).toBe(false)

    // 32 px rows: 1,600 px down is row 50.
    await scrollTo(viewport, 1600)

    expect(renderedNames().some((name) => name.includes('Person 50'))).toBe(true)
  })

  it('asks for the next page once the scroll nears the end of the loaded rows', async () => {
    const viewport = await mount()
    const pageCalls = (): unknown[] =>
      client.call.mock.calls.filter(
        ([method, params]) =>
          method === 'cohost.community.list' && (params as { cursor?: string }).cursor
      )
    expect(pageCalls()).toHaveLength(0)

    // Row 85 at the top: the last drawn row passes 100 - 10.
    await scrollTo(viewport, 85 * 32)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(pageCalls()).toHaveLength(1)
    expect(pageCalls()[0]).toEqual([
      'cohost.community.list',
      expect.objectContaining({ cursor: 'page-2' })
    ])
  })
})
