import { BuddyIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'

/**
 * The off-but-useful row. It appears for exactly one audience — live right now,
 * entitled, already consented, and simply has co-host off — and it says what
 * the feature would do rather than that it exists. Dismissal is persisted, so
 * "no thanks" is answered once and never asked again. Turn on is Buddy Live's
 * one switch (plan 119): Buddy reads chat and hears you, so the copy says both.
 */
export function CohostNudge({
  onTurnOn,
  onDismiss
}: {
  onTurnOn: () => void
  onDismiss: () => void
}): ReactElement {
  return (
    <div
      className="mt-1.5 flex items-center gap-2 rounded-row border border-border/60 bg-card/30 px-2.5 py-1.5 text-[11px] text-muted-foreground"
      data-slot="cohost-nudge"
    >
      <BuddyIcon aria-hidden className="size-4 shrink-0" weight="duotone" />
      <span className="min-w-0 flex-1">
        Buddy is off. It can group your chat&apos;s questions, draft replies and hear you answer.
      </span>
      <Button className="shrink-0" size="xs" type="button" variant="ghost" onClick={onTurnOn}>
        Turn on
      </Button>
      <Button className="shrink-0" size="xs" type="button" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}
