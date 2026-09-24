// The Stream Manager window body is a CSS container (`@container/stream-manager`):
// its layout follows its own width, never JS resize state (plan 053, D1).
//   Wide    ≥ 1040px: the stats strip, then Chat beside a right pane
//                     (Activity · Orcle).
//   Medium  640–1039px: a compact strip, then one pane with a segmented
//                     control (Chat · Activity · Orcle).
//   Narrow  < 640px (320 minimum): a one-line summary above the same segments.
// The viewer count is never hidden while live (owner, plan 047).
// Class strings stay literal so Tailwind's scanner generates them.

export const STREAM_MANAGER_CONTAINER = '@container/stream-manager'

/** Shown in the Wide tier only. */
export const WIDE_ONLY = 'hidden @min-[1040px]/stream-manager:flex'
/** Hidden in the Wide tier. */
export const BELOW_WIDE = '@min-[1040px]/stream-manager:hidden'
/** Shown in the Narrow tier only. */
export const NARROW_ONLY = 'hidden @max-[639px]/stream-manager:flex'
/** Hidden in the Narrow tier. */
export const ABOVE_NARROW = '@max-[639px]/stream-manager:hidden'

/** A control's text label that leaves the eye (not the screen reader) below
 * 800 px, where the status bar keeps icons and tooltips only. */
export const COMPACT_LABEL = '@max-[799px]/stream-manager:sr-only'

/** The body grid: one column below Wide, chat plus a right pane at Wide. */
export const PANES_GRID =
  'grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @min-[1040px]/stream-manager:grid-cols-[minmax(0,1fr)_clamp(340px,34%,440px)]'

export type StreamManagerPane = 'chat' | 'activity' | 'orcle'
export type StreamManagerRightPane = Exclude<StreamManagerPane, 'chat'>

/**
 * A pane's visibility classes. Below Wide the segmented control picks one of
 * the three panes; at Wide Chat is always shown and the right pane shows the
 * one picked there. Each pane renders once; only its placement changes.
 */
export function paneClasses(
  pane: StreamManagerPane,
  narrowPane: StreamManagerPane,
  rightPane: StreamManagerRightPane
): string {
  const belowWide = narrowPane === pane ? 'flex' : 'hidden'
  if (pane === 'chat') {
    return `${belowWide} row-start-2 @min-[1040px]/stream-manager:flex @min-[1040px]/stream-manager:col-start-1 @min-[1040px]/stream-manager:row-span-2 @min-[1040px]/stream-manager:row-start-1`
  }
  const wide =
    rightPane === pane ? '@min-[1040px]/stream-manager:flex' : '@min-[1040px]/stream-manager:hidden'
  return `${belowWide} ${wide} row-start-2 @min-[1040px]/stream-manager:col-start-2 @min-[1040px]/stream-manager:border-l @min-[1040px]/stream-manager:border-border`
}
