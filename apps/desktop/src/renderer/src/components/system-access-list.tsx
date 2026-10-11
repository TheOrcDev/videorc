import { useState, type ReactElement } from 'react'

import { GroupedList } from '@/components/list-row'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { MediaAccessSnapshot } from '@/lib/backend'
import { systemAccessAction, type SystemAccessRow } from '@/lib/system-access'
import {
  systemAccessActionLabel,
  systemAccessStatus,
  systemAccessVisibleDetail
} from '@/lib/system-access-view'

/**
 * The system access rows (plan 174 S3.17, I-10/A-16): one list for the
 * first-run dialog and Settings → Permissions, so both say the same thing.
 * Each row names the permission with its status chip, says why Videorc
 * wants it, and shows the detail in full while something is left to do,
 * with the one action that fixes it.
 */
export function SystemAccessList({
  rows,
  platform,
  mediaAccess,
  onAction
}: {
  rows: readonly SystemAccessRow[]
  platform: string | undefined
  mediaAccess: MediaAccessSnapshot | null | undefined
  /** Runs the row's action: the OS prompt, or its settings page. */
  onAction: (pane: SystemAccessRow['id']) => Promise<void>
}): ReactElement {
  const [pending, setPending] = useState<SystemAccessRow['id'] | null>(null)

  const run = async (pane: SystemAccessRow['id']): Promise<void> => {
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
        const actionLabel = systemAccessActionLabel(
          systemAccessAction({
            pane: row.id,
            state: row.state,
            platform,
            mediaAccessStatus:
              row.id === 'camera' || row.id === 'microphone' ? mediaAccess?.[row.id] : undefined
          }),
          platform
        )
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
                <StatusBadge tone={status.tone} value={status.label} />
              </div>
              <p className="text-meta text-muted-foreground">{row.purpose}</p>
              {detail ? <p className="text-meta text-muted-foreground">{detail}</p> : null}
            </div>
            {actionLabel ? (
              <Button
                aria-label={`${row.label}: ${actionLabel}`}
                disabled={pending !== null}
                size="sm"
                variant="outline"
                onClick={() => void run(row.id)}
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
