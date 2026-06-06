import { ArrowsClockwise, MagnifyingGlass } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { WORKSPACE_GROUPS, WORKSPACE_TABS, type WorkspaceTab } from '@/components/workspace-nav'
import { cn } from '@/lib/utils'

export function Sidebar({
  active,
  onSelect,
  statusTone,
  statusLabel,
  live,
  onRefresh,
  onOpenCommand
}: {
  active: WorkspaceTab
  onSelect: (tab: WorkspaceTab) => void
  statusTone: StatusDotTone
  statusLabel: string
  live: boolean
  onRefresh: () => void
  onOpenCommand: () => void
}): ReactElement {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <img alt="Videorc" className="size-8 rounded-lg object-contain" src={logoUrl} />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Videorc</span>
          <span className="text-[11px] text-muted-foreground">Recording studio</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2">
        <button
          type="button"
          onClick={onOpenCommand}
          className="flex items-center gap-2 rounded-lg border bg-background/40 px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <MagnifyingGlass className="size-4 shrink-0" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border px-1.5 py-px font-mono text-[10px] font-medium">⌘K</kbd>
        </button>
        {WORKSPACE_GROUPS.map((group) => {
          const items = WORKSPACE_TABS.filter((tab) => tab.group === group.id)
          if (!items.length) return null
          return (
            <div key={group.id} className="flex flex-col gap-0.5">
              {group.label ? (
                <span className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </span>
              ) : null}
              {items.map((tab) => {
                const isActive = active === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    data-videorc-tab-trigger={tab.id}
                    onClick={() => onSelect(tab.id)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                    )}
                  >
                    <tab.icon
                      weight={isActive ? 'fill' : 'regular'}
                      className={cn('size-4 shrink-0', isActive && 'text-primary')}
                    />
                    {tab.label}
                  </button>
                )
              })}
            </div>
          )
        })}
      </nav>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2.5">
        <StatusDot tone={statusTone} label={statusLabel} pulse={live} />
        <div className="flex items-center gap-0.5">
          <Button
            aria-label="Refresh backend"
            size="icon"
            variant="ghost"
            className="size-8"
            title="Refresh backend"
            onClick={onRefresh}
          >
            <ArrowsClockwise className="size-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  )
}
