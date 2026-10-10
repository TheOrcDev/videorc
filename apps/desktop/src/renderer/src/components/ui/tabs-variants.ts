import { cva } from 'class-variance-authority'

/**
 * The glass segmented look (plan 050, D9), shared by `Tabs` and
 * `SegmentedControl` (plan 174 S1.7, D13). Its own module with no Radix
 * import: `SegmentedControl` reads it from eager chunks, and importing
 * `tabs.tsx` there would pull Radix Tabs into the initial bundle.
 */
const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-row p-0.5 text-muted-foreground group-data-horizontal/tabs:h-control group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:p-1 data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        // A glass segmented control (plan 050, D9): a recessed track.
        default: 'bg-foreground/[0.05] ring-1 ring-border ring-inset',
        line: 'gap-1 bg-transparent'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

/** One segment's shape and type, before its selected state. */
const tabsTriggerBaseClassName =
  "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-chip border border-transparent px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export { tabsListVariants, tabsTriggerBaseClassName }
