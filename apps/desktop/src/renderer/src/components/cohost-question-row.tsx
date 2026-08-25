import { NoteIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Badge } from '@/components/ui/badge'
import { CommandItem, CommandShortcut } from '@/components/ui/command'
import type { CohostQuestion } from '@/lib/backend'
import {
  cohostAgeLabel,
  cohostAskersLabel,
  cohostQuestionRowKey,
  COHOST_PRIORITY_LABELS
} from '@/lib/cohost-view'
import { cn } from '@/lib/utils'

/**
 * One grouped viewer question, as a single dense command row. The pane's footer
 * bar carries the actions with their key chips (Raycast shape), so the row
 * itself stays a scannable line: what was asked, who asked, where from, how old.
 *
 * Monochrome by rule — the priority pill only changes TEXT TIER, never colour;
 * the platform glyphs are the one place saturated colour is allowed.
 */
export function CohostQuestionRow({
  question,
  selected,
  onStream = false,
  nowMs,
  onSelect,
  onReply
}: {
  question: CohostQuestion
  selected: boolean
  /** This question's source comment is currently shown on the stream. */
  onStream?: boolean
  nowMs: number
  onSelect: (key: string) => void
  onReply: (question: CohostQuestion) => void
}): ReactElement {
  const key = cohostQuestionRowKey(question.id)
  const askers = cohostAskersLabel(question.askers)
  const age = cohostAgeLabel(question.updatedAt, nowMs)

  return (
    <CommandItem
      className="min-h-11"
      data-cohost-row="question"
      data-cohost-row-key={key}
      data-cohost-selected={selected ? 'true' : 'false'}
      value={key}
      onSelect={() => {
        onSelect(key)
        onReply(question)
      }}
      onPointerDown={() => onSelect(key)}
    >
      {question.priority !== 'normal' ? (
        <Badge
          className={cn(
            'shrink-0',
            question.priority === 'high' ? 'text-foreground' : 'text-subtle'
          )}
          variant="outline"
        >
          {COHOST_PRIORITY_LABELS[question.priority]}
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-foreground">{question.text}</span>
      {question.fromNotes ? (
        <NoteIcon
          aria-label="Answered from your co-host notes"
          className="size-3.5 shrink-0 text-muted-foreground"
          weight="duotone"
        />
      ) : null}
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {question.platforms.map((platform) => (
          <ChatPlatformIcon key={platform} decorative platform={platform} />
        ))}
      </span>
      {askers ? (
        <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{askers}</span>
      ) : null}
      {onStream ? <Badge variant="success">On stream</Badge> : null}
      <CommandShortcut className="tabular-nums">{age}</CommandShortcut>
    </CommandItem>
  )
}
