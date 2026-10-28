// @vitest-environment happy-dom
import { act, createElement, Suspense, useEffect, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pageChunk, useRenderPageWhenLoaded, type PageChunk } from './page-chunk'

// Retest 152, plan 0004: on a slow CPU the first Library open stayed on
// "Opening Videorc…" for minutes. The page's retry render (a time-sliced
// Retry lane that never expires) was restarted by every shell update.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.unstubAllGlobals()
  root.unmount()
  container.remove()
})

/** A page whose render costs about `rows` × 2 ms, like a large tab on a slow CPU. */
function SlowPage({ rows }: { rows: number }): ReactElement {
  return createElement(
    'div',
    { 'data-testid': 'page' },
    Array.from({ length: rows }, (_, index) => createElement(SlowRow, { key: index }))
  )
}

function SlowRow(): ReactElement {
  const until = performance.now() + 2
  while (performance.now() < until) {
    // Burn the row's render time.
  }
  return createElement('span', null, 'row')
}

/** Status, levels, diagnostics: a sibling that updates every 10 ms. */
function Ticker(): ReactElement {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 10)
    return () => clearInterval(timer)
  }, [])
  return createElement('output', null, tick)
}

function Shell({ page }: { page: PageChunk<{ rows: number }> }): ReactElement {
  useRenderPageWhenLoaded(page)
  return createElement(
    'main',
    null,
    createElement(Ticker),
    createElement(
      Suspense,
      { fallback: createElement('p', { 'data-testid': 'fallback' }, 'Opening Videorc…') },
      createElement(page.Page, { rows: 40 })
    )
  )
}

function deferredPage(): {
  page: PageChunk<{ rows: number }>
  resolve: () => void
} {
  let resolve = (): void => {}
  const chunk = new Promise<typeof SlowPage>((done) => {
    resolve = () => done(SlowPage)
  })
  return { page: pageChunk(() => chunk), resolve }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<number> {
  const start = performance.now()
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) return -1
    await new Promise((done) => setTimeout(done, 5))
  }
  return performance.now() - start
}

describe('pageChunk', () => {
  it('renders a page that suspended on its first open while the shell keeps updating', async () => {
    const { page, resolve } = deferredPage()
    root.render(createElement(Shell, { page }))
    expect(
      await waitFor(() => container.querySelector('[data-testid=fallback]') !== null, 1000)
    ).toBeGreaterThanOrEqual(0)

    resolve()
    const elapsed = await waitFor(
      () => container.querySelector('[data-testid=page]') !== null,
      2000
    )

    expect(container.querySelector('[data-testid=fallback]')).toBeNull()
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })

  it('renders a preloaded page on its first render, without the fallback', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const { page, resolve } = deferredPage()
    resolve()
    await page.preload()

    act(() =>
      root.render(
        createElement(
          Suspense,
          { fallback: createElement('p', { 'data-testid': 'fallback' }) },
          createElement(page.Page, { rows: 1 })
        )
      )
    )

    expect(container.querySelector('[data-testid=page]')).not.toBeNull()
    expect(page.pendingLoad()).toBeNull()
  })

  it('loads once, and loads again after a failed load', async () => {
    const load = vi
      .fn<() => Promise<typeof SlowPage>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(SlowPage)
    const page = pageChunk(load)

    await expect(page.preload()).rejects.toThrow('chunk failed')
    await Promise.all([page.preload(), page.preload()])

    expect(load).toHaveBeenCalledTimes(2)
  })
})
