import type { MouseEvent } from 'react'

// The Library's table look, shared by its Local and Cloud tabs: the header
// row, the body rows and the poster frame are one style in both, so a cloud
// recording reads like a local one.

/** The header row under the tab's strip: tertiary labels on a hairline. */
export const LIBRARY_HEADER_CLASS =
  'border-b border-border py-2 text-meta font-medium text-muted-foreground'

/** A body row: a full-row highlight on hover, selection and keyboard focus. */
export const LIBRARY_ROW_CLASS =
  'border-b border-border py-2 outline-hidden last:border-b-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-selected:bg-accent data-revealed:bg-accent'

/** The 72 × 40 frame a row's poster (or its placeholder icon) sits in. */
export const LIBRARY_POSTER_CLASS =
  'grid h-10 w-[4.5rem] shrink-0 place-items-center overflow-hidden rounded-row border bg-muted/30'

/** A click that lands on one of the row's own controls is that control's, not the row's. */
export function fromRowControl(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target instanceof Element ? event.target : null
  const control = target?.closest(
    'button, a, input, [role="checkbox"], [data-slot="disabled-reason"]'
  )
  return Boolean(control && event.currentTarget.contains(control))
}
