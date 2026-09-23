import { patchPreparedStreamTarget, type CaptureConfig } from '@/lib/capture'
import type { BackendClient } from '@/backendClient'
import type {
  ScheduledStreamCapabilities,
  ScheduledStreamEvent,
  ScheduledStreamOperation,
  ScheduledStreamProvider,
  StreamPlatform,
  StreamTargetSettings,
  StreamingSettings
} from '@/lib/backend'

export function scheduledProviderLabel(provider: ScheduledStreamProvider | StreamPlatform): string {
  return provider === 'x' ? 'X' : 'YouTube'
}

/** Where the provider's own event page lives, for copy such as "Open on YouTube". */
export function scheduledProviderSite(provider: ScheduledStreamProvider): string {
  return provider === 'x' ? 'X' : 'YouTube Studio'
}

/** What the provider calls a scheduled stream: YouTube "events", X "broadcasts". */
export function scheduledProviderNoun(provider: ScheduledStreamProvider): string {
  return provider === 'x' ? 'broadcast' : 'event'
}

/** Upcoming shows one section per platform, always in this order. */
export const SCHEDULED_PROVIDERS: readonly ScheduledStreamProvider[] = ['youtube', 'x']

const HISTORY_LIFECYCLES: readonly ScheduledStreamEvent['lifecycle'][] = ['completed', 'canceled']

export interface ScheduledProviderSection {
  provider: ScheduledStreamProvider
  available: boolean
  reason: string | null
  events: ScheduledStreamEvent[]
}

/**
 * Upcoming (or History) split by platform. Every platform keeps its section,
 * even when empty, so each one carries its own Schedule action and its own
 * availability.
 */
export function scheduledProviderSections(
  events: readonly ScheduledStreamEvent[],
  capabilities: ScheduledStreamCapabilities | null | undefined,
  history: boolean
): ScheduledProviderSection[] {
  return SCHEDULED_PROVIDERS.map((provider) => {
    const capability = capabilities?.providers?.find((item) => item.provider === provider)
    return {
      provider,
      available: capability?.available ?? capabilities?.available ?? false,
      reason: capability ? capability.reason : (capabilities?.reason ?? null),
      events: events.filter(
        (event) =>
          (event.provider ?? 'youtube') === provider &&
          HISTORY_LIFECYCLES.includes(event.lifecycle) === history
      )
    }
  })
}

export type ScheduledLifecycleChip =
  | { kind: 'tag'; label: string }
  | { kind: 'live'; label: string }
  | { kind: 'status'; label: string; tone: 'good' | 'warn' | 'neutral' }

/** The event's state in words, with the glass chip that carries it. */
export function scheduledLifecycleChip(event: ScheduledStreamEvent): ScheduledLifecycleChip {
  if (event.createUncertain || event.operationState === 'needs-reconciliation') {
    return { kind: 'status', label: 'Needs review', tone: 'warn' }
  }
  switch (event.lifecycle) {
    case 'draft':
      return { kind: 'tag', label: 'Draft' }
    case 'scheduled':
      return { kind: 'status', label: 'Scheduled', tone: 'good' }
    case 'preparing':
      return { kind: 'status', label: 'Preparing', tone: 'neutral' }
    case 'live':
      return { kind: 'live', label: 'Live' }
    case 'completed':
      return { kind: 'status', label: 'Ended', tone: 'neutral' }
    case 'canceled':
      return { kind: 'status', label: 'Canceled', tone: 'neutral' }
    case 'missing':
      return {
        kind: 'status',
        label: `Deleted on ${scheduledProviderLabel(event.provider ?? 'youtube')}`,
        tone: 'warn'
      }
    default:
      return { kind: 'status', label: 'Needs review', tone: 'warn' }
  }
}

const PRIVACY_LABEL: Record<ScheduledStreamEvent['requested']['privacy'], string> = {
  private: 'Private',
  unlisted: 'Unlisted',
  public: 'Public'
}

/** YouTube's visibility, as the tag the row shows. X broadcasts have none. */
export function scheduledPrivacyLabel(event: ScheduledStreamEvent): string | null {
  return event.provider === 'x' ? null : PRIVACY_LABEL[event.requested.privacy]
}

/**
 * When the stream airs, in its own time zone ("Tue, Jan 1, 2035, 12:00 PM CET").
 * An X broadcast shows its planned end as a range ("12:00 – 1:30 PM CET"). The
 * planned end is a wall time in the start's zone, so the difference of the two
 * wall times is the length (off by an hour only across a DST change).
 */
export function scheduledWhenLabel(event: ScheduledStreamEvent, locale?: string): string {
  const { timeZone, plannedEndLocal, localStart } = event.requested
  const start = new Date(event.startUtc)
  if (Number.isNaN(start.getTime())) return localStart.replace('T', ' ')
  const format = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short'
  })
  const length =
    event.provider === 'x' && plannedEndLocal
      ? Date.parse(`${plannedEndLocal}Z`) - Date.parse(`${localStart}Z`)
      : Number.NaN
  return length > 0
    ? format.formatRange(start, new Date(start.getTime() + length))
    : format.format(start)
}

export async function runScheduledOperation<T = unknown>(
  client: Pick<BackendClient, 'request'>,
  action: string,
  params: Record<string, unknown>
): Promise<T> {
  const operationId =
    typeof params.operationId === 'string' ? params.operationId : crypto.randomUUID()
  let operation = await client.request<ScheduledStreamOperation>(`scheduledStreams.${action}`, {
    ...params,
    operationId
  })
  const deadline = Date.now() + 180_000
  while (operation.state === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    operation = await client.request<ScheduledStreamOperation>('scheduledStreams.operation', {
      operationId
    })
  }
  if (operation.state !== 'complete') {
    throw new Error(
      operation.error?.message ?? 'Operation is still running. Check Upcoming before retrying.'
    )
  }
  return operation.result as T
}

export async function scheduledTargetOperation<T>(
  client: Pick<BackendClient, 'request'>,
  action: string,
  eventId: string,
  fields: Record<string, unknown>
): Promise<T> {
  const event = await client.request<ScheduledStreamEvent>('scheduledStreams.get', { eventId })
  return runScheduledOperation<T>(client, action, {
    eventId,
    expectedRevision: event.revision,
    ...fields
  })
}

export function scheduledThumbnailUrl(id: string): string {
  return `videorc-asset://scheduled-thumbnail/${id}`
}

export function eventCanEdit(event: ScheduledStreamEvent): boolean {
  return (
    event.schemaVersion === 1 &&
    !event.preparation &&
    event.operationState !== 'pending' &&
    ['draft', 'scheduled', 'unknown'].includes(event.lifecycle)
  )
}

export function selectScheduledStreamForTarget(
  config: CaptureConfig,
  targetId: string,
  event: ScheduledStreamEvent
): CaptureConfig {
  const selected = config.streaming.targets.find((target) => target.id === targetId)
  const provider = event.provider ?? 'youtube'
  if (
    !selected ||
    selected.platform !== provider ||
    selected.authMode !== 'oauth' ||
    selected.accountId !== event.accountId
  ) {
    throw new Error(
      provider === 'x'
        ? 'Choose an X destination connected to this broadcast’s account.'
        : 'Choose a YouTube destination connected to this event’s channel.'
    )
  }
  const targets = config.streaming.targets.map((target) =>
    target.id === targetId
      ? {
          ...target,
          enabled: true,
          scheduledEventId: event.id,
          scheduledEventTitle: event.requested.title,
          scheduledStartUtc: event.startUtc,
          scheduledPrivacy: event.requested.privacy,
          scheduledAttemptId: undefined,
          platformBroadcastId: undefined,
          platformStreamId: undefined,
          streamKey: '',
          streamKeySecretRef: undefined,
          streamKeyPresent: false,
          updatedAt: new Date().toISOString()
        }
      : target
  )
  const enabledTargetIds = targets.filter((target) => target.enabled).map((target) => target.id)
  return {
    ...config,
    streamEnabled: true,
    streaming: {
      ...config.streaming,
      enabled: true,
      targets,
      enabledTargetIds,
      mode: enabledTargetIds.length > 1 ? 'multi' : 'single'
    }
  }
}

function holdsScheduledXPreparation(target: StreamTargetSettings): boolean {
  return (
    target.platform === 'x' &&
    target.authMode === 'oauth' &&
    Boolean(target.scheduledEventId) &&
    Boolean(target.scheduledAttemptId) &&
    target.status?.state !== 'live' &&
    !(target.status?.state === 'warning' && Boolean(target.status.redactedUrl))
  )
}

/**
 * A saved X broadcast keeps its schedule when Go Live never reached publish,
 * and records completion once END is confirmed. Either way its preparation
 * attempt is released exactly once. It lives with the scheduler so the studio
 * provider loads it only after a session that used a saved X broadcast.
 */
export async function releaseScheduledXPreparations(
  client: Pick<BackendClient, 'request'>,
  streaming: StreamingSettings,
  sessionId: string | undefined
): Promise<{ streaming: StreamingSettings; complete: boolean }> {
  let next = streaming
  let complete = true
  for (const target of streaming.targets.filter(holdsScheduledXPreparation)) {
    try {
      const released = await scheduledTargetOperation<{
        lifecycleStatus: string
        message: string
      }>(client, 'releasePreparation', target.scheduledEventId!, {
        attemptId: target.scheduledAttemptId,
        sessionId
      })
      next = patchPreparedStreamTarget(next, target.id, {
        scheduledAttemptId: undefined,
        status: {
          state: 'stopped',
          message:
            released.lifecycleStatus === 'ready'
              ? 'Upcoming broadcast preserved.'
              : released.message
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      next = patchPreparedStreamTarget(next, target.id, {
        status: {
          state: 'warning',
          message: `X scheduled cleanup needs review: ${message}`
        }
      })
      complete = false
    }
  }
  return { streaming: next, complete }
}

/** Carries each saved X destination's settled attempt and status onto `current`. */
export function settleScheduledXTargets(
  current: StreamingSettings,
  settled: StreamingSettings
): StreamingSettings {
  return {
    ...current,
    targets: current.targets.map((target) => {
      const match = settled.targets.find((item) => item.id === target.id)
      return match && target.platform === 'x' && target.scheduledEventId
        ? { ...target, scheduledAttemptId: match.scheduledAttemptId, status: match.status }
        : target
    })
  }
}
