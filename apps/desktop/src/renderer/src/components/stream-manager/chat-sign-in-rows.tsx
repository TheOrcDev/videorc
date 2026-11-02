import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Button } from '@/components/ui/button'
import type { LiveChatProviderState } from '@/lib/backend'

/** A destination whose chat needs Sign in, and the id "Use Sign in" opens. */
export type ChatSignInRow = {
  id: string
  targetId: string
  platform: LiveChatProviderState['platform']
  message: string
}

/**
 * The destinations that stream with a key and whose chat only Sign in
 * brings (plan 213 J1: X), from the backend's `needs-sign-in` read state.
 */
export function chatSignInRows(providers: readonly LiveChatProviderState[]): ChatSignInRow[] {
  return providers.flatMap((provider) =>
    provider.read === 'needs-sign-in' && provider.targetId
      ? [
          {
            id: provider.id,
            targetId: provider.targetId,
            platform: provider.platform,
            message: provider.message
          }
        ]
      : []
  )
}

/**
 * "X chat needs Sign in" over the Stream Manager's chat (plan 213 J1): one
 * quiet row per stream-key destination, never a failure, with "Use Sign in"
 * opening that destination in Livestream → Setup. Nothing when none needs it.
 */
export function ChatSignInRows({
  providers,
  onUseSignIn
}: {
  providers: readonly LiveChatProviderState[]
  onUseSignIn: (targetId: string) => void
}): ReactElement | null {
  const rows = chatSignInRows(providers)
  if (rows.length === 0) return null
  return (
    <ul
      aria-label="Chat that needs Sign in"
      className="flex shrink-0 flex-col divide-y divide-border border-b border-border"
      data-slot="chat-sign-in"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-center gap-2 px-3 py-1.5"
          data-platform={row.platform}
        >
          <ChatPlatformIcon decorative platform={row.platform} />
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{row.message}</span>
          <Button
            aria-label={`${CHAT_PLATFORM_LABELS[row.platform]}: Use Sign in`}
            className="shrink-0"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => onUseSignIn(row.targetId)}
          >
            Use Sign in
          </Button>
        </li>
      ))}
    </ul>
  )
}
