import { useState, type ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { CloseIcon, WarningIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  chatCommandReplyFailedLine,
  type ChatCommandReplyFailed
} from '../../../../shared/chat-commands'

const failureKey = (failure: ChatCommandReplyFailed): string =>
  `${failure.sessionId}\n${failure.destinationId}\n${failure.reason}`

/**
 * Chat command replies that couldn't go out (plan 226 D12), over the Stream
 * Manager's chat like the sign-in rows: one row per chat and reason this
 * live session ("!go couldn't answer on YouTube: reconnect YouTube to allow
 * chat posts."), each dismissible. Nothing when every reply went out.
 */
export function ChatCommandFailureRows({
  failures
}: {
  /** This live chat session's failures, one per chat and reason. */
  failures: readonly ChatCommandReplyFailed[]
}): ReactElement | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const shown = failures.filter((failure) => !dismissed.has(failureKey(failure)))
  if (shown.length === 0) return null
  return (
    <ul
      aria-label="Chat command replies that couldn't go out"
      className="flex shrink-0 flex-col divide-y divide-border border-b border-border"
      data-slot="chat-command-failures"
    >
      {shown.map((failure) => {
        const key = failureKey(failure)
        const line = chatCommandReplyFailedLine(failure, CHAT_PLATFORM_LABELS[failure.platform])
        return (
          <li
            key={key}
            className="flex items-center gap-2 px-3 py-1.5"
            data-platform={failure.platform}
            data-testid="chat-command-failure"
          >
            <ChatPlatformIcon decorative platform={failure.platform} />
            <WarningIcon aria-hidden className="size-3.5 shrink-0 text-warning" weight="fill" />
            <span className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
              {line}
            </span>
            <Button
              aria-label={`Dismiss: ${line}`}
              className="shrink-0"
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={() => setDismissed((current) => new Set(current).add(key))}
            >
              <CloseIcon />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
