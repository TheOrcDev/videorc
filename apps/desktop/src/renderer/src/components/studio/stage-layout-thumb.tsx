import type { ReactElement } from 'react'

import type { DrawnStageLayout } from '@/lib/talk-show-layout'

/**
 * A small diagram of a room layout (plan 252), as the Scenes gallery draws
 * its presets (`LayoutThumb`): the arrangement, never a live picture. People
 * are the stronger boxes and a shared screen the lighter one, so "Screen +
 * people" reads at a glance. A new room layout adds its diagram here.
 */
export function StageLayoutThumb({ layout }: { layout: DrawnStageLayout }): ReactElement {
  return (
    <div
      aria-hidden
      className="relative aspect-video w-full overflow-hidden rounded-chip border bg-gradient-to-br from-muted/40 to-muted/70"
      data-slot="stage-layout-thumb"
      data-stage-layout={layout}
    >
      {layout === 'solo' ? <div className={`${PERSON} inset-1`} /> : null}
      {layout === 'side-by-side' ? (
        <>
          <div className={`${PERSON} top-[26%] bottom-[26%] left-1 w-[46%]`} />
          <div className={`${PERSON} top-[26%] right-1 bottom-[26%] w-[46%]`} />
        </>
      ) : null}
      {layout === 'screen-people' ? (
        <>
          <div className={`${SCREEN} top-1 bottom-1 left-1 w-[68%]`} />
          <div className={`${PERSON} top-1 right-1 h-[28%] w-[24%]`} />
          <div className={`${PERSON} top-[36%] right-1 h-[28%] w-[24%]`} />
        </>
      ) : null}
      {layout === 'two-screens' ? (
        <>
          {/* Plan 251: two screens across the top, everyone in a row under them. */}
          <div className={`${SCREEN} top-1 left-1 h-[50%] w-[47%]`} />
          <div className={`${SCREEN} top-1 right-1 h-[50%] w-[47%]`} />
          <div className={`${PERSON} bottom-1 left-[23%] h-[30%] w-[25%]`} />
          <div className={`${PERSON} right-[23%] bottom-1 h-[30%] w-[25%]`} />
        </>
      ) : null}
      {layout === 'spotlight' ? (
        <>
          {/* The spotlit person above, the others in a strip along the bottom. */}
          <div className={`${PERSON} top-1 left-[16%] h-[62%] w-[68%]`} />
          <div className={`${OTHER} bottom-1 left-[26%] h-[20%] w-[22%]`} />
          <div className={`${OTHER} right-[26%] bottom-1 h-[20%] w-[22%]`} />
        </>
      ) : null}
    </div>
  )
}

const BOX = 'absolute rounded-[2px]'
/** A person's tile. */
const PERSON = `${BOX} bg-foreground/30`
/** A shared screen: lighter, as the Scenes diagrams draw a screen. */
const SCREEN = `${BOX} bg-foreground/10`
/** The people a spotlight sets aside. */
const OTHER = `${BOX} bg-foreground/15`
