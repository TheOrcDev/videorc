import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { CommandItem, CommandShortcut } from '@/components/ui/command'
import type { CohostFlag } from '@/lib/backend'
import { cohostAgeLabel, cohostFlagRowKey, COHOST_FLAG_KIND_LABELS } from '@/lib/cohost-view'
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
        className={cn('shrink-0', flag.severity === 'high' ? 'text-destructive' : 'text-subtle')}
        variant="outline"
      >
        {COHOST_FLAG_KIND_LABELS[flag.kind]}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={flag.reason}>
        {flag.reason}
      </span>
      <CommandShortcut className="tabular-nums">{cohostAgeLabel(flag.at, nowMs)}</CommandShortcut>
    </CommandItem>
  )
}
