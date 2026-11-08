import { cva } from 'class-variance-authority'

/**
 * The glass segmented look, shared by `Tabs` and `SegmentedControl`. Its own
 * module with no Base UI import: `SegmentedControl` reads it from eager
 * chunks, and importing `tabs.tsx` there would pull Base UI Tabs into the
 * initial bundle.
 */
const tabsListVariants = cva(
  'group/tabs-list rounded-row text-muted-foreground group-data-horizontal/tabs:h-control inline-flex w-fit items-center justify-center p-0.5 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:p-1',
  {
    defaultVariants: {
      variant: 'default'
    },
    variants: {
      variant: {
        // A glass segmented control: a recessed track, the selected segment
        // a chrome plate.
        default: 'bg-foreground/5 ring-border ring-1 ring-inset',
        // A strip of words over a pane, the selected one underlined. For
        // switching a view where a track would be one box too many.
        line: 'gap-1 bg-transparent'
      }
    }
  }
)

/** One segment's shape and type, before its selected state. */
const tabsTriggerBaseClassName =
  "rounded-chip text-muted-foreground hover:text-foreground focus-visible:outline-ring relative inline-flex h-full flex-1 items-center justify-center gap-1.5 border border-transparent px-3 text-[13px] font-medium whitespace-nowrap group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export { tabsListVariants, tabsTriggerBaseClassName }
