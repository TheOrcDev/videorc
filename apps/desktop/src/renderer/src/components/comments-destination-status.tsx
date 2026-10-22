import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Badge } from '@/components/ui/badge'
import type {
  LiveChatProviderConnectionState,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import type { ChatSendFailure } from '@/lib/chat-send'
import { chatStateLabel } from '@/lib/state-labels'
import { waitingProviderMessage } from '@/lib/youtube-quota-copy'

function providerBadgeVariant(
  state: LiveChatProviderConnectionState
): 'success' | 'warning' | 'destructive' | 'neutral' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
    case 'reconnecting':
    case 'waiting':
      return 'warning'
    case 'failed':
      return 'destructive'
    default:
      return 'neutral'
  }
}

// Chat binds to the linked account's channel, not to wherever the stream key
// points. On a manual-RTMP stream of a different channel that reads the wrong
// chat with a green "Connected" badge — name the bound account so the
// mismatch is at least visible.
export function providerBadgeTitle(provider: LiveChatProviderState): string {
  const identity = provider.accountLabel ? `Reading chat as ${provider.accountLabel}.` : ''
  // Plan 094: a parked connector (the YouTube quota pause) names its resume time.
  const message = waitingProviderMessage(provider)
  if (message && identity) {
    return `${message} · ${identity}`
  }
  return message || identity
}

/**
 * What the composer says about its destinations: only the exceptions (plan
 * 057, D3). A destination that receives the send needs no words, since the
 * "To:" picker already names where a message goes, and a failed send shows
 * its own reason as a badge. Empty when everything can send.
 */
export function commentsDestinationNotes({
  providers,
  sendTargets
}: {
  providers: LiveChatProviderState[]
  sendTargets: StreamPlatform[]
}): string {
  const uniqueSendTargets = [...new Set(sendTargets)]
  const parts = uniqueSendTargets.length > 0 ? [] : ['No writable destinations']
  const describedPlatforms = new Set<StreamPlatform>()

  for (const provider of providers) {
    if (describedPlatforms.has(provider.platform)) continue
    describedPlatforms.add(provider.platform)
    if (uniqueSendTargets.includes(provider.platform)) continue
    const label = CHAT_PLATFORM_LABELS[provider.platform]
    if (provider.write === 'missing-scope') {
      parts.push(`${label} reconnect to send`)
    } else if (provider.write === 'failed') {
      parts.push(`${label} send failed`)
    } else if (provider.write === 'read-only' || provider.state === 'connected') {
      // X sends now (closed-beta chat API, 2026-08-19) — read-only here only
      // means THIS stream lacks send context (e.g. a manual-RTMP X target).
      parts.push(`${label} read-only`)
    } else if (provider.state === 'failed') {
      parts.push(`${label} failed`)
    } else if (provider.state === 'connecting' || provider.state === 'reconnecting') {
      parts.push(`${label} ${chatStateLabel(provider).toLowerCase()}`)
    }
  }

  return parts.join(' · ')
}

// Buddy's own status lives in the Buddy pane's header (plan 174 S3.14a): the
// strip names chat destinations only.
export function CommentsDestinationStatus({
  providers,
  mode = 'providers',
  sendTargets = [],
  failures = []
}: {
  providers: LiveChatProviderState[]
  mode?: 'providers' | 'composer'
  sendTargets?: StreamPlatform[]
  failures?: ChatSendFailure[]
}): ReactElement | null {
  if (providers.length === 0 && mode === 'providers') {
    return null
  }

  if (mode === 'composer') {
    const notes = commentsDestinationNotes({ providers, sendTargets })
    if (!notes && failures.length === 0) return null
    return (
      <div className="flex min-w-0 flex-col gap-1.5" data-slot="comments-destination-status">
        {notes ? (
          <p
            className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground"
            title={notes}
          >
            {notes}
          </p>
        ) : null}
        {failures.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {failures.map((failure) => (
              <Badge
                key={`${failure.destinationId}:${failure.reason}`}
                className="h-auto max-w-full justify-start whitespace-normal text-left"
                variant="destructive"
              >
                {/* A Badge forces its icons to 12 px: YouTube's mark may not
                    shrink (plan 165), so its chip names it in words only. */}
                {failure.platform === 'youtube' ? null : (
                  <ChatPlatformIcon decorative platform={failure.platform} />
                )}
                {CHAT_PLATFORM_LABELS[failure.platform]}: {failure.reason}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  // What each badge cannot say (a paused chat's resume time, the account
  // chat reads as) is visible text under the badges, never hover text (plan
  // 174 S1.10, H-16).
  const details = providers
    .map((provider) => ({ provider, detail: providerBadgeTitle(provider) }))
    .filter((entry) => entry.detail)
  return (
    <div
      aria-label="Chat destination status"
      className="flex flex-col items-center gap-1.5"
      data-slot="comments-destination-status"
    >
      <div className="flex flex-wrap items-center justify-center gap-1">
        {providers.map((provider) => (
          <Badge key={provider.id} variant={providerBadgeVariant(provider.state)}>
            {provider.platform === 'youtube' ? null : (
              <ChatPlatformIcon decorative platform={provider.platform} />
            )}
            {CHAT_PLATFORM_LABELS[provider.platform]}
            <span aria-hidden>·</span>
            {chatStateLabel(provider)}
          </Badge>
        ))}
      </div>
      {details.map(({ provider, detail }) => (
        <p
          key={provider.id}
          className="max-w-full text-center text-xs text-muted-foreground"
          data-slot="comments-destination-detail"
        >
          {CHAT_PLATFORM_LABELS[provider.platform]}: {detail}
        </p>
      ))}
    </div>
  )
}
