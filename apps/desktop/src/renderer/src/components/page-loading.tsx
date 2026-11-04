import type { ReactElement } from 'react'

import { workspaceTabLabel, type WorkspaceTab } from '@/components/workspace-nav'

/**
 * What a page says while its chunk loads (#1084). "Opening Videorc…" is the
 * app opening: the window's first page, before any page is in. Every later
 * page names itself, so an open app never says it is opening.
 */
export function pageLoadingLabel(tab: WorkspaceTab, opening: boolean): string {
  return opening ? 'Opening Videorc…' : `Loading ${workspaceTabLabel(tab)}…`
}

/**
 * The body of a page whose chunk is loading. The toolbar already holds the
 * page's title, so the words wait a beat: a chunk that is in within a few ms
 * leaves the frame quiet instead of flashing a line. Reduced motion keeps the
 * wait and drops the fade.
 */
export function PageLoading({
  tab,
  opening
}: {
  tab: WorkspaceTab
  opening: boolean
}): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 animate-in items-center justify-center text-xs text-muted-foreground delay-300 fill-mode-backwards fade-in"
      data-page-loading={tab}
      role="status"
    >
      {pageLoadingLabel(tab, opening)}
    </div>
  )
}
