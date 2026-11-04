import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Button } from '@/components/ui/button'
import type { LiveChatProviderState } from '@/lib/backend'

/**
 * A destination whose chat needs a sign-in, and which one: the platform's
 * (plan 213 J1, "Use Sign in" opens the destination) or Videorc's (plan 215
 * A3, "Sign in to Videorc" starts the account sign-in).
 */
export type ChatSignInRow = {
  id: string
  /** The destination "Use Sign in" opens; null for the Videorc sign-in. */
  targetId: string | null
  platform: LiveChatProviderState['platform']
  message: string
  kind: 'platform' | 'videorc'
}

/**
 * The destinations whose chat only a sign-in brings, from the backend's read
 * states: `needs-sign-in` (a stream key, plan 213 J1) and
 * `needs-videorc-sign-in` (the relay waits on the Videorc account, plan 215
 * A1). Neither is a failure.
 */
export function chatSignInRows(providers: readonly LiveChatProviderState[]): ChatSignInRow[] {
  return providers.flatMap((provider): ChatSignInRow[] => {
    if (provider.read === 'needs-videorc-sign-in') {
      return [
        {
          id: provider.id,
          targetId: provider.targetId ?? null,
          platform: provider.platform,
          message: provider.message,
          kind: 'videorc' as const
        }
      ]
    }
    if (provider.read === 'needs-sign-in' && provider.targetId) {
      return [
        {
          id: provider.id,
          targetId: provider.targetId,
          platform: provider.platform,
          message: provider.message,
          kind: 'platform' as const
        }
      ]
    }
    return []
  })
}

/**
 * "X chat needs Sign in" over the Stream Manager's chat (plan 213 J1) and
 * "Sign in to Videorc to read X chat." (plan 215 A3): one quiet row per
 * destination, never a failure, each with the one button that brings chat.
 * "Use Sign in" opens that destination in Livestream → Setup; "Sign in to
 * Videorc" starts the account sign-in in the main window. Nothing when none
 * needs it, and no button for a door this view cannot open.
 */
export function ChatSignInRows({
  providers,
  onUseSignIn,
  onSignInToVideorc
}: {
  providers: readonly LiveChatProviderState[]
  onUseSignIn?: (targetId: string) => void
  onSignInToVideorc?: () => void
}): ReactElement | null {
  const rows = chatSignInRows(providers)
  if (rows.length === 0) return null
  return (
    <ul
      aria-label="Chat that needs a sign-in"
      className="flex shrink-0 flex-col divide-y divide-border border-b border-border"
      data-slot="chat-sign-in"
    >
      {rows.map((row) => {
        const label = CHAT_PLATFORM_LABELS[row.platform]
        const targetId = row.targetId
        return (
          <li
            key={row.id}
            className="flex items-center gap-2 px-3 py-1.5"
            data-kind={row.kind}
            data-platform={row.platform}
          >
            <ChatPlatformIcon decorative platform={row.platform} />
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">{row.message}</span>
            {row.kind === 'videorc' && onSignInToVideorc ? (
              <Button
                aria-label={`${label}: Sign in to Videorc`}
                className="shrink-0"
                size="xs"
                type="button"
                variant="outline"
                onClick={onSignInToVideorc}
              >
                Sign in to Videorc
              </Button>
            ) : null}
            {row.kind === 'platform' && targetId && onUseSignIn ? (
              <Button
                aria-label={`${label}: Use Sign in`}
                className="shrink-0"
                size="xs"
                type="button"
                variant="outline"
                onClick={() => onUseSignIn(targetId)}
              >
                Use Sign in
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
