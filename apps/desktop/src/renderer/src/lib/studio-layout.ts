// The Studio page is a CSS container (`@container/studio`): its layout follows
// the width of its own pane, never the window's viewport (plan 174 S3.3,
// B-10). The `lg` viewport breakpoint (1,024 px) sat above the main window's
// 960 px minimum, so a narrow window stacked the inspector under the preview
// and Stop fell below the fold.
//   Wide    ≥ 720 px of content: the preview column, and beside it the
//           transport (status, clock, Record / Go Live… / Stop) on top of the
//           inspector. The 960 px window leaves about 750 px, so it is Wide.
//   Narrow  < 720 px (a zoomed-in window): one column, with the transport row
//           above the preview, pinned while the page scrolls.
// Class strings stay literal so Tailwind's scanner generates them.

export const STUDIO_CONTAINER = '@container/studio'

/** Content width from which the inspector sits beside the preview. */
export const STUDIO_WIDE_MIN_PX = 720

/** The page grid: one column when narrow; preview | transport over inspector when wide. */
export const STUDIO_GRID =
  'grid min-h-full grid-cols-1 content-start @min-[720px]/studio:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] @min-[720px]/studio:grid-rows-[auto_minmax(0,1fr)]'

/** The preview and the scenes: second row when narrow, the left column when wide. */
export const STUDIO_PREVIEW_COLUMN =
  'min-w-0 @min-[720px]/studio:col-start-1 @min-[720px]/studio:row-span-2 @min-[720px]/studio:row-start-1 @min-[720px]/studio:border-r'

/** Session, Microphone, Sources, Captions and Takeover: last when narrow, under the transport when wide. */
export const STUDIO_INSPECTOR =
  'min-w-0 border-t @min-[720px]/studio:col-start-2 @min-[720px]/studio:row-start-2 @min-[720px]/studio:border-t-0'

/**
 * The transport row. Narrow, it leads the page and stays pinned (on the solid
 * tone, so what scrolls under it never shows through) unless the preview is
 * docked: the docked preview is a native surface glued over its slot, which
 * would draw over a pinned row as the slot scrolls under it. Wide, it is the
 * top of the inspector and scrolls with nothing.
 */
export function studioTransportRowClass(previewDocked: boolean): string {
  return previewDocked
    ? 'min-w-0 row-start-1 @min-[720px]/studio:col-start-2 @min-[720px]/studio:row-start-1'
    : 'sticky top-0 z-10 min-w-0 row-start-1 bg-glass-solid @min-[720px]/studio:static @min-[720px]/studio:col-start-2 @min-[720px]/studio:row-start-1 @min-[720px]/studio:bg-transparent'
}
