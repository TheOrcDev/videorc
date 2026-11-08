import { useRef, type ReactElement } from 'react'

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

/**
 * The line under the highlights when the update also brought releases the
 * streamer never saw (plan 174 S3.21, A-19): the dialog shows the newest and
 * names the rest. Here, not in lib/whats-new.ts, which is in the eager bundle.
 */
export function skippedReleasesLine(versions: readonly string[]): string | null {
  if (versions.length === 0) return null
  const names = versions.map(formatChangelogVersion)
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Also includes ${list}.`
}

// Post-update changelog highlights. Chrome stays monochrome per the design
// language — the glass Dialog primitive carries the styling.
export function WhatsNewDialog({
  entry,
  skippedVersions = [],
  open,
  onClose
}: {
  entry: ChangelogEntry | null
  /** Releases between the last seen one and `entry`, newest first (plan 174 A-19). */
  skippedVersions?: readonly string[]
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const continueRef = useRef<HTMLButtonElement>(null)
  if (!entry) {
    return null
  }
  const skipped = skippedReleasesLine(skippedVersions)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      {/* Continue takes the focus (plan 174 S3.21, A-19): Return closes the
          dialog instead of sending the first button's link to the browser. */}
      <DialogContent initialFocus={continueRef}>
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
        {skipped ? (
          <p className="text-xs text-muted-foreground" data-testid="whats-new-skipped">
            {skipped}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => openVideorcWebLink(releaseNotesUrl(entry.version))}
          >
            Full release notes
          </Button>
          <Button ref={continueRef} onClick={onClose}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
