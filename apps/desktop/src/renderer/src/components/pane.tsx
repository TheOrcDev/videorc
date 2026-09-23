import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

// Desktop structure (plan 050, D4). A pane is a flush column: a 40 px toolbar
// that never scrolls, then a body that does. Panes are split by hairlines and
// nothing inside a window floats.

type ToolbarSlot = { node: HTMLElement | null; setNode: (node: HTMLElement | null) => void }

const ToolbarSlotContext = createContext<ToolbarSlot | null>(null)

/** Owns the toolbar's actions slot, so page content can fill the toolbar it sits under. */
export function ToolbarSlotProvider({ children }: { children: ReactNode }): ReactElement {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ node, setNode }), [node])
  return <ToolbarSlotContext.Provider value={value}>{children}</ToolbarSlotContext.Provider>
}

/**
 * The pane toolbar: title on the left (14 px / 600), actions on the right.
 * It is the window's drag region; its controls opt out.
 */
export function Toolbar({
  title,
  leading,
  children,
  className
}: {
  title?: ReactNode
  /** Before the title (e.g. a back button). */
  leading?: ReactNode
  /** Actions that always show; pages add theirs with <ToolbarActions>. */
  children?: ReactNode
  className?: string
}): ReactElement {
  const slot = useContext(ToolbarSlotContext)
  return (
    <header
      className={cn(
        'flex h-toolbar shrink-0 items-center gap-2 border-b border-border px-gutter select-none [-webkit-app-region:drag]',
        className
      )}
      data-slot="toolbar"
    >
      {leading ? (
        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          {leading}
        </div>
      ) : null}
      {title ? (
        <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h1>
      ) : null}
      <span className="min-w-4 flex-1" />
      <div
        ref={slot?.setNode}
        className="flex min-w-0 items-center gap-1.5 [-webkit-app-region:no-drag]"
        data-slot="toolbar-actions"
      />
      {children ? (
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          {children}
        </div>
      ) : null}
    </header>
  )
}

/**
 * Renders page actions into the toolbar above the page. Outside a toolbar
 * (no provider) the actions render in place.
 */
export function ToolbarActions({ children }: { children: ReactNode }): ReactElement | null {
  const slot = useContext(ToolbarSlotContext)
  if (!slot) return <>{children}</>
  return slot.node ? createPortal(children, slot.node) : null
}

/** A flush pane: toolbar + body, filling its parent. */
export function Pane({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)} data-slot="pane">
      {children}
    </div>
  )
}

/**
 * The pane's scroll container: the only thing that scrolls. Pass
 * `scroll={false}` for a body that owns its scroll (Library's table).
 */
export function PaneBody({
  children,
  className,
  scroll = true
}: {
  children: ReactNode
  className?: string
  scroll?: boolean
}): ReactElement {
  return (
    <div
      className={cn(
        'min-h-0 flex-1',
        scroll ? 'overflow-y-auto overscroll-contain' : 'flex flex-col',
        className
      )}
      data-slot="pane-body"
    >
      {children}
    </div>
  )
}
