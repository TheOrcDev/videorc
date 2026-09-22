import type { CaptureConfig } from '@/lib/capture'
import type { BackendClient } from '@/backendClient'
import type { ScheduledStreamEvent, ScheduledStreamOperation } from '@/lib/backend'

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
  if (
    !selected ||
    selected.platform !== 'youtube' ||
    selected.authMode !== 'oauth' ||
    selected.accountId !== event.accountId
  ) {
    throw new Error('Choose a YouTube destination connected to this event’s channel.')
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
