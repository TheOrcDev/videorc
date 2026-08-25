import { AppIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type StatusTone = 'good' | 'warn' | 'error' | 'neutral'

const toneToVariant: Record<StatusTone, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  good: 'success',
  warn: 'warning',
  error: 'destructive',
  neutral: 'secondary'
}

export function StatusBadge({
  label,
  value,
  tone = 'neutral',
  icon: LeadingIcon
}: {
  label?: string
  value: string
  tone?: StatusTone
  icon?: AppIcon
}): ReactElement {
  return (
    <Badge variant={toneToVariant[tone]} className="h-6 gap-1.5 rounded-chip px-2.5">
      {LeadingIcon ? (
        <LeadingIcon data-icon="inline-start" weight="fill" />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-current" />
      )}
      {label ? <span className="font-normal opacity-70">{label}</span> : null}
      <span className={cn('max-w-40 truncate font-semibold capitalize')}>{value}</span>
    </Badge>
  )
}
