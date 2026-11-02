// Every page follows the width of its own pane, never the window's viewport
// (plan 213 C3), as the Studio does (`studio-layout.ts`). The shell's pane
// body is a CSS container (`@container/page`). The `lg` viewport breakpoint
// (1,024 px) counted the 208 px sidebar as page, so a 1,024 px window put
// two columns into 816 px of content and squeezed both.
//   Wide    ≥ 940 px of content: two columns. The default 1,180 px window
//           leaves 972 px, so it is Wide.
//   Narrow  < 940 px (the 960 px minimum, a 1,100 px laptop window): one
//           column, the sections stacked in the same order.
// Config grids (`ConfigGrid`, `CONFIG_GRID_PAIR` in `components/page.tsx`,
// synced from @videorc) switch at the same width. Class strings stay literal
// so Tailwind's scanner generates them.

export const PAGE_CONTAINER = '@container/page'

/** Content width from which a page puts its sections in two columns. */
export const PAGE_WIDE_MIN_PX = 940

/** Livestream → Setup: destinations and details | output and health. */
export const LIVESTREAM_SETUP_GRID =
  'grid @min-[940px]/page:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]'

/** Scene: the canvas and its sources | the overlays. */
export const SCENE_GRID = 'grid @min-[940px]/page:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'

/** Captions: the preview | the controls. */
export const CAPTIONS_GRID =
  'grid @min-[940px]/page:grid-cols-[minmax(0,1.2fr)_minmax(380px,0.8fr)]'

/** The left column of a two-column page: the hairline only beside a second column. */
export const PAGE_LEAD_COLUMN = 'flex min-w-0 flex-col @min-[940px]/page:border-r'

/** The right column of a two-column page: a hairline above it while stacked, beside it when wide. */
export const PAGE_TRAIL_COLUMN = 'min-w-0 border-t @min-[940px]/page:border-t-0'

/** The Captions preview stays in view while the controls beside it scroll. */
export const CAPTIONS_PREVIEW_PIN = '@min-[940px]/page:sticky @min-[940px]/page:top-0'

/**
 * Clean cut's review: the player beside its controls over the transcript when
 * narrow; the player and controls as one scrolling pane beside the
 * transcript when wide.
 */
export const CLEAN_CUT_REVIEW_GRID =
  'flex min-h-0 flex-1 flex-col @min-[940px]/page:grid @min-[940px]/page:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]'

/** The review's player pane. */
export const CLEAN_CUT_REVIEW_PLAYER_PANE =
  'flex shrink-0 gap-4 border-b border-border p-gutter @min-[940px]/page:min-h-0 @min-[940px]/page:flex-col @min-[940px]/page:gap-3 @min-[940px]/page:overflow-y-auto @min-[940px]/page:border-r @min-[940px]/page:border-b-0'

/** The player inside it: half the row when narrow, the pane's width when wide. */
export const CLEAN_CUT_REVIEW_PLAYER = 'w-[min(22rem,50%)] shrink-0 @min-[940px]/page:w-full'
