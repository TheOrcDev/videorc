import { useEffect, useState, type ReactElement } from 'react'

import { OrcleIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { CohostUtterance } from '@/lib/backend'
import { GOLEM_UTTERANCE_TRIGGER_LABELS } from '@/lib/golem-auto-chat-view'
import { cn } from '@/lib/utils'

/** Recent lines shown under the cards. */
const RECENT_MAX = 4

/**
 * The Golem's proposed cards (plan 164 S-D2, Suggest mode): what it wants to
 * post as you, with Send and Dismiss, then the last few lines it said. The
 * newest proposed card takes ↵ (send) and ⌫ (dismiss) while nothing else has
 * the keyboard; every card keeps its buttons.
 */
export function GolemUtteranceCards({
  utterances,
  pending = false,
  onApprove,
  onDismiss
}: {
  utterances: readonly CohostUtterance[]
  pending?: boolean
  onApprove: (utterance: CohostUtterance) => void
  onDismiss: (utterance: CohostUtterance) => void
}): ReactElement | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const proposed = utterances.filter(
    (utterance) =>
      utterance.status === 'proposed' &&
      (!utterance.expiresAt || Date.parse(utterance.expiresAt) > nowMs)
  )
  const recent = utterances
    .filter((utterance) => utterance.status !== 'proposed' && utterance.status !== 'dismissed')
    .slice(-RECENT_MAX)
    .reverse()
  const newest = proposed.at(-1) ?? null

  useEffect(() => {
    if (proposed.length === 0) return
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [proposed.length])

  useEffect(() => {
    if (!newest || pending) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as Element | null
      if (target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return
      if (event.key === 'Enter') {
        event.preventDefault()
        onApprove(newest)
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        onDismiss(newest)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [newest, onApprove, onDismiss, pending])

  if (proposed.length === 0 && recent.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border" data-slot="golem-utterances">
      {proposed.length > 0 ? (
        <div className="flex flex-col gap-2 p-2">
          {proposed.map((utterance) => (
            <Alert
              key={utterance.id}
              aria-label="The Golem wants to post"
              data-slot="golem-utterance-card"
              data-utterance-id={utterance.id}
              role="group"
            >
              <OrcleIcon aria-hidden weight="duotone" />
              <AlertTitle className="flex min-w-0 items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {GOLEM_UTTERANCE_TRIGGER_LABELS[utterance.trigger.kind]} · posts as you
                </span>
                {utterance.expiresAt ? (
                  <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
                    {secondsLeft(utterance.expiresAt, nowMs)}
                  </span>
                ) : null}
              </AlertTitle>
              <AlertDescription className="text-xs" data-slot="golem-utterance-text">
                {utterance.text}
              </AlertDescription>
              <div className="col-start-2 mt-1.5 flex flex-wrap gap-1">
                <Button
                  disabled={pending}
                  size="xs"
                  type="button"
                  variant="secondary"
                  onClick={() => onApprove(utterance)}
                >
                  Send
                  {utterance === newest ? <Kbd>↵</Kbd> : null}
                </Button>
                <Button
                  disabled={pending}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={() => onDismiss(utterance)}
                >
                  Dismiss
                  {utterance === newest ? <Kbd>⌫</Kbd> : null}
                </Button>
              </div>
            </Alert>
          ))}
        </div>
      ) : null}
      {recent.length > 0 ? (
        <ul className="flex flex-col px-3 py-1" data-slot="golem-utterance-recent">
          {recent.map((utterance) => (
            <li
              key={utterance.id}
              className="flex h-6 min-w-0 items-center gap-1.5 text-[11px]"
              data-status={utterance.status}
              title={utterance.text}
            >
              <Badge className="shrink-0" variant="outline">
                {GOLEM_UTTERANCE_TRIGGER_LABELS[utterance.trigger.kind]}
              </Badge>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  utterance.status === 'failed'
                    ? 'text-subtle line-through'
                    : 'text-muted-foreground'
                )}
              >
                {utterance.text}
              </span>
              <span className="shrink-0 text-subtle">{statusLabel(utterance)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function statusLabel(utterance: CohostUtterance): string {
  switch (utterance.status) {
    case 'sent':
      return 'Posted'
    case 'failed':
      return 'Not sent'
    case 'bubble-only':
      return 'On stream'
    default:
      return ''
  }
}

function secondsLeft(expiresAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000))
  return `${seconds}s`
}
