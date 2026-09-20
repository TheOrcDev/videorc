import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { CommandItem, CommandShortcut } from '@/components/ui/command'
import type { CohostFlag } from '@/lib/backend'
import {
  cohostAgeLabel,
  cohostFlagActionLabel,
  cohostFlagChipLabel,
  cohostFlagDetail,
  cohostFlagRowKey
} from '@/lib/cohost-view'
import { cn } from '@/lib/utils'

/**
 * One flagged message. The co-host NEVER acts on it — this row exists so the
 * streamer can jump to the message and decide. Only `high` severity earns the
 * destructive accent; medium/low stay in the monochrome text tiers.
 */
export function CohostFlagRow({
  flag,
  selected,
  nowMs,
  onSelect,
  onJump
}: {
  flag: CohostFlag
  selected: boolean
  nowMs: number
  onSelect: (key: string) => void
  onJump: (flag: CohostFlag) => void
}): ReactElement {
  const key = cohostFlagRowKey(flag.messageId)
  const detail = cohostFlagDetail(flag)
  const action = cohostFlagActionLabel(flag)

  return (
    <CommandItem
      className="min-h-11"
      data-cohost-row="flag"
      data-cohost-row-key={key}
      data-cohost-selected={selected ? 'true' : 'false'}
      value={key}
      onSelect={() => {
        onSelect(key)
        onJump(flag)
      }}
      onPointerDown={() => onSelect(key)}
    >
      <Badge
        className={cn(
          'max-w-[55%] shrink-0',
          flag.severity === 'high' ? 'text-destructive' : 'text-subtle'
        )}
        variant="outline"
      >
        <span className="truncate">{cohostFlagChipLabel(flag)}</span>
      </Badge>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
        {flag.reason}
      </span>
      {action ? (
        // A suggestion label, not a control: the co-host never moderates.
        <span className="shrink-0 text-[11px] text-subtle" data-slot="cohost-flag-action">
          {action}
        </span>
      ) : null}
      <CommandShortcut className="tabular-nums">{cohostAgeLabel(flag.at, nowMs)}</CommandShortcut>
    </CommandItem>
  )
}
