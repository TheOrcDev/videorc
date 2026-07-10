import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import { Badge } from '@/components/ui/badge'
import type {
  LiveChatProviderConnectionState,
  LiveChatProviderState,
  StreamPlatform
} from '@/lib/backend'
import type { ChatSendFailure } from '@/lib/chat-send'

function joinLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? ''
  if (labels.length === 2) return labels.join(' + ')
  return `${labels.slice(0, -1).join(', ')} + ${labels.at(-1)}`
}

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
): 'success' | 'warning' | 'destructive' | 'outline' {
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
      return 'outline'
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

export function commentsDestinationSummary({
  providers,
  sendTargets,
  failures = []
}: {
  providers: LiveChatProviderState[]
  sendTargets: StreamPlatform[]
  failures?: ChatSendFailure[]
}): string {
  const uniqueSendTargets = [...new Set(sendTargets)]
  const sendLabels = uniqueSendTargets.map((platform) => CHAT_PLATFORM_LABELS[platform])
  const parts = [
    sendLabels.length > 0 ? `Sends to ${joinLabels(sendLabels)}` : 'No writable destinations'
  ]
  const failedPlatforms = new Set(failures.map((failure) => failure.platform))
  const describedPlatforms = new Set<StreamPlatform>()

  for (const provider of providers) {
    if (describedPlatforms.has(provider.platform)) continue
    describedPlatforms.add(provider.platform)
    if (failedPlatforms.has(provider.platform)) {
      parts.push(`${CHAT_PLATFORM_LABELS[provider.platform]} failed`)
      continue
    }
    if (uniqueSendTargets.includes(provider.platform)) {
      continue
    }
    if (provider.write === 'missing-scope') {
      parts.push(`${CHAT_PLATFORM_LABELS[provider.platform]} reconnect to send`)
      continue
    }
    if (provider.write === 'failed') {
      parts.push(`${CHAT_PLATFORM_LABELS[provider.platform]} send failed`)
      continue
    }
    if (provider.write === 'read-only' || provider.state === 'connected') {
      parts.push(`${CHAT_PLATFORM_LABELS[provider.platform]} receive-only`)
      continue
    }
    if (provider.state === 'failed') {
      parts.push(`${CHAT_PLATFORM_LABELS[provider.platform]} failed`)
      continue
    }
    if (provider.state === 'connecting' || provider.state === 'reconnecting') {
      parts.push(
        `${CHAT_PLATFORM_LABELS[provider.platform]} ${providerStateLabel(provider.state).toLowerCase()}`
      )
    }
  }

  return parts.join(' · ')
}

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
    const summary = commentsDestinationSummary({ providers, sendTargets, failures })
    return (
      <div className="flex min-w-0 flex-col gap-1.5" data-slot="comments-destination-status">
        <p className="text-[11px] leading-tight text-muted-foreground" title={summary}>
          {summary}
        </p>
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
      aria-label="Comments destination status"
      className="flex flex-wrap items-center gap-1"
      data-slot="comments-destination-status"
    >
      {providers.map((provider) => (
        <Badge
          key={provider.id}
          title={provider.message}
          variant={providerBadgeVariant(provider.state)}
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
          <ChatPlatformIcon decorative platform={provider.platform} />
          {CHAT_PLATFORM_LABELS[provider.platform]}
          <span aria-hidden>·</span>
          {providerStatusLabel(provider)}
        </Badge>
      ))}
    </div>
  )
}
