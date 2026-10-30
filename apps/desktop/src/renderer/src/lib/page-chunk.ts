// A workspace page that loads on first navigation (retest 152, plan 0004).
//
// A plain `lazy()` page suspends on its first open, and React renders it again
// on a Retry lane once the chunk is in. Retry lanes are time-sliced and never
// expire, so on a slow CPU the shell's steady updates (status, levels,
// diagnostics) restart that render before it finishes, and the page stayed on
// "Opening Videorc…" until the user changed tabs. Here the shell renders the
// page again itself once the chunk is in, on an ordinary update that React
// finishes in one pass, and a page loaded ahead of time never suspends.

import { lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'

/** The loading half of a page chunk: what the shell needs to wait for it. */
export type PageLoad = {
  /** Loads the chunk once; later calls share the first load (a failed load may retry). */
  preload: () => Promise<unknown>
  /**
   * The load a suspended page is waiting on, or null once the page can no
   * longer be on its fallback (it rendered with the chunk in, or the shell
   * already saw the load finish).
   */
  pendingLoad: () => Promise<unknown> | null
}

export type PageChunk<P extends object> = PageLoad & {
  Page: LazyExoticComponent<ComponentType<P>>
}

type PageModule<P extends object> = { default: ComponentType<P> }

export function pageChunk<P extends object>(load: () => Promise<ComponentType<P>>): PageChunk<P> {
  let loaded: PageModule<P> | null = null
  let settled = false
  let loading: Promise<PageModule<P>> | null = null
  const preload = (): Promise<PageModule<P>> => {
    loading ??= load().then(
      (component) => (loaded = { default: component }),
      (error: unknown) => {
        loading = null
        throw error
      }
    )
    return loading
  }
  // Already in: hand React a thenable that resolves synchronously, so the
  // first render returns the page instead of throwing to the fallback.
  const Page = lazy(() => {
    if (loaded) {
      settled = true
      return resolvedThenable(loaded) as Promise<PageModule<P>>
    }
    // React attaches its own callback to this same promise while rendering,
    // before `useRenderPageWhenLoaded` attaches its one, so the page is
    // resolved by the time the shell renders again.
    return preload()
  })
  const pendingLoad = (): Promise<unknown> | null =>
    settled
      ? null
      : preload().then(() => {
          settled = true
        })
  return { Page, preload, pendingLoad }
}

function resolvedThenable<T>(value: T): PromiseLike<T> {
  return {
    then: (onFulfilled) => {
      onFulfilled?.(value)
      return resolvedThenable(value) as never
    }
  }
}

/**
 * Renders the caller again once the page's chunk is in. Call it above the
 * page's Suspense boundary, with the page on screen.
 */
export function useRenderPageWhenLoaded(page: PageLoad | null): void {
  const [, setLoadedPages] = useState(0)
  useEffect(() => {
    const load = page?.pendingLoad()
    if (!load) return
    let current = true
    load.then(
      () => {
        if (current) setLoadedPages((count) => count + 1)
      },
      // A failed load is the page's own error, shown by its error boundary.
      () => {}
    )
    return () => {
      current = false
    }
  }, [page])
}
