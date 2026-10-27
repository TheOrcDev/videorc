import { useState, type ReactElement, type ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { MediaAccessSnapshot, SystemPermissionPane } from '@/lib/backend'
import {
  mediaAccessStatusForPane,
  systemAccessAction,
  type SystemAccessRow
} from '@/lib/system-access'
import {
  systemAccessActionLabel,
  systemAccessStatus,
  systemAccessTag,
  systemAccessVisibleDetail
} from '@/lib/system-access-view'

/**
 * The system access rows (plan 174 S3.17, I-10/A-16): one list for first-run
 * setup and Settings → Permissions, so both say the same thing. Each row
 * names the permission with its status chip, says why Videorc wants it, and
 * shows the detail in full while something is left to do, with the one
 * action that fixes it.
 *
 * The `setup` variant (plan 203 S5, D3 and D6) adds what the first launch
 * needs and Settings does not: the "Needed to record" or "Optional" tag, and
 * under a granted Microphone the live level (`microphoneProof`), so the
 * streamer sees the grant work before leaving.
 */
export function SystemAccessList({
  rows,
  platform,
  mediaAccess,
  onAction,
  variant = 'plain',
  microphoneProof
}: {
  rows: readonly SystemAccessRow[]
  platform: string | undefined
  mediaAccess: MediaAccessSnapshot | null | undefined
  /** Runs the row's action: the OS prompt, its settings page, or Reopen Videorc. */
  onAction: (pane: SystemPermissionPane) => Promise<void>
  variant?: 'plain' | 'setup'
  /** Shown under the Microphone row once it is granted (the setup variant only). */
  microphoneProof?: ReactNode
}): ReactElement {
  const [pending, setPending] = useState<SystemPermissionPane | null>(null)

  const run = async (pane: SystemPermissionPane): Promise<void> => {
    setPending(pane)
    try {
      await onAction(pane)
    } finally {
      setPending(null)
    }
  }

  return (
    <GroupedList aria-label="System access">
      {rows.map((row) => {
        const status = systemAccessStatus(row.state)
        const detail = systemAccessVisibleDetail(row)
        const tag = variant === 'setup' ? systemAccessTag(row) : null
        const actionLabel = systemAccessActionLabel(
          systemAccessAction({
            pane: row.id,
            checking: row.checking,
            state: row.state,
            platform,
            mediaAccessStatus: mediaAccessStatusForPane(mediaAccess, row.id)
          }),
          platform
        )
        const pane = row.id === 'system-audio' ? null : row.id
        const proof =
          variant === 'setup' &&
          row.id === 'microphone' &&
          row.state === 'granted' &&
          !row.checking &&
          microphoneProof
        return (
          <div
            key={row.id}
            className="flex items-start gap-3 px-3 py-2.5"
            data-slot="system-access-row"
            data-state={row.state}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{row.label}</span>
                {/* A grant that lands while the streamer is in System Settings
                    or the OS prompt is announced when they come back. */}
                <span aria-live="polite" className="inline-flex items-center gap-2">
                  <StatusBadge tone={status.tone} value={status.label} />
                  {row.checking || row.state === 'waiting' ? (
                    <Spinner aria-label="Checking permission…" />
                  ) : null}
                </span>
                {tag ? <Badge variant="outline">{tag}</Badge> : null}
              </div>
              <p className="text-meta text-muted-foreground">{row.purpose}</p>
              {detail ? <p className="text-meta text-muted-foreground">{detail}</p> : null}
              {proof ? <div className="pt-1.5">{proof}</div> : null}
            </div>
            {actionLabel && pane ? (
              <Button
                aria-label={`${row.label}: ${actionLabel}`}
                disabled={pending !== null}
                variant="outline"
                onClick={() => void run(pane)}
              >
                {pending === row.id ? <Spinner aria-hidden data-icon="inline-start" /> : null}
                {actionLabel}
              </Button>
            ) : null}
          </div>
        )
      })}
    </GroupedList>
  )
}
