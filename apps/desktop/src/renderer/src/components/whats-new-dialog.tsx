import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { openVideorcWebLink, releaseNotesUrl } from '@/lib/videorc-web-links'
import { formatChangelogVersion, type ChangelogEntry } from '@/lib/whats-new'

// Post-update changelog highlights. Chrome stays monochrome per the design
// language — the glass Dialog primitive carries the styling.
export function WhatsNewDialog({
  entry,
  open,
  onClose
}: {
  entry: ChangelogEntry | null
  open: boolean
  onClose: () => void
}): ReactElement | null {
  if (!entry) {
    return null
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            What&apos;s new in Videorc {formatChangelogVersion(entry.version)}
          </DialogTitle>
          <DialogDescription>{entry.summary}</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2.5">
          {entry.highlights.map((highlight) => (
            <li key={highlight} className="flex gap-2.5 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className="mt-2 size-1 shrink-0 rounded-full bg-foreground"
              />
              <span>{highlight}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openVideorcWebLink(releaseNotesUrl(entry.version))}
          >
            Full release notes
          </Button>
          <Button size="sm" onClick={onClose}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
