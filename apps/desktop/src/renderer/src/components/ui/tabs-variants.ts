import { cva } from 'class-variance-authority'

/**
 * The glass segmented look, shared by `Tabs` and `SegmentedControl`. Its own
 * module with no Base UI import: `SegmentedControl` reads it from eager
 * chunks, and importing `tabs.tsx` there would pull Base UI Tabs into the
 * initial bundle.
 *
 * Two layers. `segmentedTrackClassName` and `segmentedItemClassName` are the
 * bare look; `tabsListVariants` and `tabsTriggerBaseClassName` add the rules a
 * TabsList and a TabsTrigger take from their own Tabs root
 * (`group-data-horizontal/tabs:h-control` and the like). `SegmentedControl`
 * wears only the bare layer: those rules match ANY Tabs ancestor, so on a page
 * inside `PageTabs` (Destinations, Settings) they pinned its track to one
 * 28 px row and a wrapped option spilled out over the text under it.
 */
const segmentedTrackClassName =
  'group/tabs-list rounded-row text-muted-foreground inline-flex w-fit items-center justify-center p-0.5'

/** The recessed glass track: a TabsList's `default` variant and every SegmentedControl. */
const segmentedTrackVariantClassName = 'bg-foreground/5 ring-border ring-1 ring-inset'

const tabsListVariants = cva(
  `${segmentedTrackClassName} group-data-horizontal/tabs:h-control group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:p-1`,
  {
    defaultVariants: {
      variant: 'default'
    },
    variants: {
      variant: {
        // A glass segmented control: a recessed track, the selected segment
        // a chrome plate.
        default: segmentedTrackVariantClassName,
        // A strip of words over a pane, the selected one underlined. For
        // switching a view where a track would be one box too many.
        line: 'gap-1 bg-transparent'
      }
    }
  }
)

/** One segment's shape and type, before its selected state. */
const segmentedItemClassName =
  "rounded-chip text-muted-foreground hover:text-foreground focus-visible:outline-ring relative inline-flex h-full flex-1 items-center justify-center gap-1.5 border border-transparent px-3 text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/** A TabsTrigger's shape: the segment plus its vertical-Tabs rules. */
const tabsTriggerBaseClassName = `${segmentedItemClassName} group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:px-3 group-data-vertical/tabs:py-1`

export {
  segmentedItemClassName,
  segmentedTrackClassName,
  segmentedTrackVariantClassName,
  tabsListVariants,
  tabsTriggerBaseClassName
}
