import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Button } from '@/components/ui/button'
import type { ScopeReconnectPlatform } from '@/lib/backend'
import { removeMessagesReconnectCopy } from '../../../../shared/platform-scopes'

/** The toast once the browser opened for a Stream Manager reconnect. */
export function removeMessagesReconnectStarted(platform: ScopeReconnectPlatform): {
  title: string
  description: string
} {
  const name = CHAT_PLATFORM_LABELS[platform]
  return {
    title: `Approve the ${name} permission in your browser`,
    description: `Golem can remove messages once ${name} confirms.`
  }
}

/**
 * "Reconnect Twitch to let Golem remove messages" in the Stream Manager's
 * Golem pane (plan 140, S5): one quiet row per platform whose chat can't
 * remove messages until its account is reconnected, from the backend's
 * per-destination `moderate` state. Nothing at all when every platform can.
 */
export function RemoveMessagesReconnectRows({
  platforms,
  onReconnect
}: {
  platforms: readonly ScopeReconnectPlatform[]
  onReconnect: (platform: ScopeReconnectPlatform) => void
}): ReactElement | null {
  if (platforms.length === 0) return null
  return (
    <ul
      aria-label="Permissions Golem needs"
      className="flex shrink-0 flex-col divide-y divide-border border-b border-border"
      data-slot="remove-messages-reconnect"
    >
      {platforms.map((platform) => (
        <li key={platform} className="flex items-center gap-2 px-3 py-1.5" data-platform={platform}>
          <ChatPlatformIcon decorative platform={platform} />
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {removeMessagesReconnectCopy(platform)}
          </span>
          <Button
            className="shrink-0"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => onReconnect(platform)}
          >
            Reconnect
          </Button>
        </li>
      ))}
    </ul>
  )
}
