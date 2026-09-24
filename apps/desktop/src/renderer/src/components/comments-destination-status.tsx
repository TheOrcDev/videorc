import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Badge } from '@/components/ui/badge'
import type {
  LiveChatProviderConnectionState,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import type { ChatSendFailure } from '@/lib/chat-send'
import type { CohostState } from '@/lib/backend'
import { cohostChipView } from '@/lib/cohost-view'

function providerStateLabel(state: LiveChatProviderConnectionState): string {
  switch (state) {
    case 'disabled':
      return 'Idle'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'reconnecting':
      return 'Reconnecting'
    case 'waiting':
      return 'Waiting'
    case 'failed':
      return 'Failed'
    case 'unsupported':
      return 'Unavailable'
    case 'ended':
      return 'Ended'
  }
}

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

function providerStatusLabel(provider: LiveChatProviderState): string {
  if (provider.write === 'read-only') {
    return 'Receive-only'
  }
  if (provider.write === 'missing-scope') return 'Reconnect to send'
  if (provider.write === 'failed') return 'Send failed'
  if (provider.write === 'unavailable' && provider.state === 'connected') return 'Receive-only'
  return providerStateLabel(provider.state)
}

// Chat binds to the linked account's channel, not to wherever the stream key
// points. On a manual-RTMP stream of a different channel that reads the wrong
// chat with a green "Connected" badge — name the bound account so the
// mismatch is at least visible.
export function providerBadgeTitle(provider: LiveChatProviderState): string {
  const identity = provider.accountLabel ? `Reading chat as ${provider.accountLabel}.` : ''
  if (provider.message && identity) {
    return `${provider.message} · ${identity}`
  }
  return provider.message || identity
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
      parts.push(`${label} receive-only`)
    } else if (provider.state === 'failed') {
      parts.push(`${label} failed`)
    } else if (provider.state === 'connecting' || provider.state === 'reconnecting') {
      parts.push(`${label} ${providerStateLabel(provider.state).toLowerCase()}`)
    }
  }

  return parts.join(' · ')
}

/** Co-host status, in the destination strip's own vocabulary. Monochrome by
 * rule — only `listening` earns the live accent, exactly like a connected
 * destination. */
export function CohostStatusChip({ state }: { state: CohostState | null }): ReactElement | null {
  const chip = cohostChipView(state)
  if (!chip) return null
  return (
    <Badge data-slot="cohost-status-chip" variant={chip.tone === 'live' ? 'success' : 'neutral'}>
      {chip.label}
    </Badge>
  )
}

export function CommentsDestinationStatus({
  providers,
  mode = 'providers',
  sendTargets = [],
  failures = [],
  cohostState = null
}: {
  providers: LiveChatProviderState[]
  mode?: 'providers' | 'composer'
  sendTargets?: StreamPlatform[]
  failures?: ChatSendFailure[]
  /** Latest `cohost.state`; null hides the chip entirely. */
  cohostState?: CohostState | null
}): ReactElement | null {
  if (providers.length === 0 && mode === 'providers' && !cohostState) {
    return null
  }

  if (mode === 'composer') {
    const notes = commentsDestinationNotes({ providers, sendTargets })
    const chip = cohostChipView(cohostState)
    if (!notes && !chip && failures.length === 0) return null
    return (
      <div className="flex min-w-0 flex-col gap-1.5" data-slot="comments-destination-status">
        {notes || chip ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground"
              title={notes}
            >
              {notes}
            </p>
            <CohostStatusChip state={cohostState} />
          </div>
        ) : null}
        {failures.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {failures.map((failure) => (
              <Badge
                key={`${failure.destinationId}:${failure.reason}`}
                className="h-auto max-w-full justify-start whitespace-normal text-left"
                title={failure.reason}
                variant="destructive"
              >
                <ChatPlatformIcon decorative platform={failure.platform} />
                {CHAT_PLATFORM_LABELS[failure.platform]}: {failure.reason}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      aria-label="Chat destination status"
      className="flex flex-wrap items-center gap-1"
      data-slot="comments-destination-status"
    >
      {providers.map((provider) => (
        <Badge
          key={provider.id}
          title={providerBadgeTitle(provider)}
          variant={providerBadgeVariant(provider.state)}
        >
          <ChatPlatformIcon decorative platform={provider.platform} />
          {CHAT_PLATFORM_LABELS[provider.platform]}
          <span aria-hidden>·</span>
          {providerStatusLabel(provider)}
        </Badge>
      ))}
      <CohostStatusChip state={cohostState} />
    </div>
  )
}
