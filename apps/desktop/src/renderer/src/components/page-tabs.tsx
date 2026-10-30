import type { ReactElement, ReactNode } from 'react'

import { PANE_OWNS_SCROLL, PaneStrip } from '@/components/pane'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

// A page with tabs: one segmented TabsList pinned in a strip under the
// toolbar, and only the region under it scrolls. The page owns its scroll,
// so the shell's PaneBody stops scrolling for it (PANE_OWNS_SCROLL). The
// selected tab is the caller's: the shell keeps it, remembers it on this
// device and opens a named tab from a link.

interface PageTab<Id extends string> {
  readonly id: Id
  readonly label: ReactNode
}

interface PageTabsProps<Id extends string> {
  tabs: readonly PageTab<Id>[]
  value: Id
  onValueChange: (tab: Id) => void
  /** The strip's accessible name ("Settings sections"). */
  label: string
  /** A data attribute each trigger carries with its tab id (tests and probes find tabs by it). */
  triggerAttribute?: `data-${string}`
  testId?: string
  /** The TabsContent panels, inside the region that scrolls. */
  children: ReactNode
}

function PageTabs<Id extends string>({
  tabs,
  value,
  onValueChange,
  label,
  triggerAttribute,
  testId,
  children
}: PageTabsProps<Id>): ReactElement {
  return (
    <Tabs
      {...PANE_OWNS_SCROLL}
      // The strip and the region under it meet at the strip's hairline, so
      // the page drops the gap Tabs puts between its list and its panels.
      // oxlint-disable-next-line shadcn/no-restyle -- see above.
      className="min-h-0 flex-1 gap-0"
      data-testid={testId}
      onValueChange={(next) => {
        const tab = tabs.find(({ id }) => id === next)
        if (tab) {
          onValueChange(tab.id)
        }
      }}
      value={value}
    >
      {/* The toolbar carries only the title. */}
      <PaneStrip>
        <TabsList aria-label={label}>
          {tabs.map(({ id, label: tabLabel }) => (
            <TabsTrigger
              key={id}
              value={id}
              {...(triggerAttribute ? { [triggerAttribute]: id } : {})}
            >
              {tabLabel}
            </TabsTrigger>
          ))}
        </TabsList>
      </PaneStrip>
      {/* The only region that scrolls. Keyed by tab, so every tab change (a
          click, the arrow keys, or a link that opens a named tab) starts the
          new tab at the top; a flex column, so a panel can fill the height. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        data-slot="page-tabs-scroll"
        key={value}
      >
        {children}
      </div>
    </Tabs>
  )
}

export { PageTabs, type PageTab, type PageTabsProps }
