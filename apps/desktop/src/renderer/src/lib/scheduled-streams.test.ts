import { describe, expect, it, vi } from 'vitest'
import { runScheduledOperation, selectScheduledStreamForTarget } from './scheduled-streams'
import {
  defaultCaptureConfig,
  normalizeStreamingSettings,
  patchStreamTargetForEdit
} from './capture'
import type { StreamTargetSettings, ScheduledStreamEvent } from './backend'

describe('scheduled stream ownership', () => {
  const eventId = '11111111-1111-4111-8111-111111111111'
  const target = {
    id: 'youtube',
    platform: 'youtube',
    label: 'Channel',
    authMode: 'oauth',
    enabled: true,
    accountId: 'channel',
    scheduledEventId: eventId,
    scheduledAttemptId: eventId,
    scheduledEventTitle: 'Saved title',
    streamKey: '',
    streamKeyPresent: true,
    streamKeySecretRef: 'event-secret-ref',
    serverUrl: 'rtmp://example/live',
    platformBroadcastId: 'event',
    platformStreamId: 'ingest',
    createdAt: '',
    updatedAt: ''
  } satisfies StreamTargetSettings
  it('preserves the selected event across normalization and clears it on channel/auth changes', () => {
    const normalized = normalizeStreamingSettings({ targets: [target] }).targets.find(
      (item) => item.id === 'youtube'
    )!
    expect(normalized.scheduledEventId).toBe(eventId)
    expect(
      patchStreamTargetForEdit(target, { accountId: 'other' }).scheduledEventId
    ).toBeUndefined()
    expect(
      patchStreamTargetForEdit(target, { authMode: 'manual-rtmp' }).scheduledEventId
    ).toBeUndefined()
  })
  it('rejects malformed persisted selection fields before rendering', () => {
    const normalized = normalizeStreamingSettings({
      targets: [
        {
          ...target,
          scheduledEventTitle: {},
          scheduledStartUtc: {},
          scheduledPrivacy: {},
          scheduledAttemptId: 'not-a-uuid'
        }
      ]
    }).targets.find((item) => item.id === target.id)!
    expect(normalized.scheduledEventTitle).toBeUndefined()
    expect(normalized.scheduledStartUtc).toBeUndefined()
    expect(normalized.scheduledPrivacy).toBeUndefined()
    expect(normalized.scheduledAttemptId).toBeUndefined()
    const malformed = normalizeStreamingSettings({
      targets: [{ ...target, scheduledEventId: '-'.repeat(36) }]
    }).targets.find((item) => item.id === target.id)!
    expect(malformed.scheduledEventId).toBeUndefined()
    expect(malformed.scheduledEventTitle).toBeUndefined()
  })
  it('explicit instant selection removes every previous event credential', () => {
    const cleared = patchStreamTargetForEdit(target, { scheduledEventId: undefined })
    expect(cleared.scheduledAttemptId).toBeUndefined()
    expect(cleared.platformBroadcastId).toBeUndefined()
    expect(cleared.platformStreamId).toBeUndefined()
    expect(cleared.streamKeySecretRef).toBeUndefined()
    expect(cleared.streamKeyPresent).toBe(false)
  })
  it('selecting a saved event enables streaming atomically without changing recording or other targets', () => {
    const other = { ...target, id: 'other', enabled: false }
    const config = {
      ...defaultCaptureConfig,
      recordEnabled: true,
      streamEnabled: false,
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: false,
        targets: [{ ...target, enabled: false }, other],
        enabledTargetIds: []
      }
    }
    const event = {
      id: eventId,
      accountId: 'channel',
      startUtc: '2035-01-01T12:00:00Z',
      requested: { title: 'Saved event', privacy: 'private' }
    } as ScheduledStreamEvent
    const result = selectScheduledStreamForTarget(config, target.id, event)
    expect(result.recordEnabled).toBe(true)
    expect(result.streamEnabled).toBe(true)
    expect(result.streaming.enabled).toBe(true)
    expect(result.streaming.enabledTargetIds).toEqual([target.id])
    expect(result.streaming.targets[0]).toMatchObject({
      enabled: true,
      authMode: 'oauth',
      scheduledEventId: eventId,
      streamKeyPresent: false
    })
    expect(result.streaming.targets[0].streamKeySecretRef).toBeUndefined()
    expect(result.streaming.targets[0].scheduledAttemptId).toBeUndefined()
    expect(result.streaming.targets[1]).toBe(other)
    expect(() =>
      selectScheduledStreamForTarget(config, target.id, { ...event, accountId: 'different' })
    ).toThrow('channel')
  })
  it('binds an X broadcast only to an X OAuth destination of the same account', () => {
    const xTarget = {
      ...target,
      id: 'x',
      platform: 'x',
      accountId: '123',
      scheduledEventId: undefined
    } satisfies StreamTargetSettings
    const config = {
      ...defaultCaptureConfig,
      streaming: {
        ...defaultCaptureConfig.streaming,
        targets: [{ ...target, enabled: false }, xTarget],
        enabledTargetIds: []
      }
    }
    const event = {
      id: eventId,
      provider: 'x',
      accountId: '123',
      startUtc: '2035-01-01T12:00:00Z',
      requested: { title: 'X launch', privacy: 'private' }
    } as ScheduledStreamEvent
    const result = selectScheduledStreamForTarget(config, 'x', event)
    expect(result.streaming.targets[1]).toMatchObject({
      platform: 'x',
      enabled: true,
      scheduledEventId: eventId,
      streamKeyPresent: false
    })
    expect(result.streaming.enabledTargetIds).toEqual(['x'])
    expect(() => selectScheduledStreamForTarget(config, target.id, event)).toThrow('X destination')
  })
  it('deduplicates a supplied intent UUID and surfaces reconciliation rather than replaying', async () => {
    const request = vi.fn().mockResolvedValue({
      id: eventId,
      eventId,
      state: 'needs-reconciliation',
      error: { message: 'Recover unknown creation.' },
      result: null
    })
    await expect(
      runScheduledOperation({ request }, 'schedule', {
        operationId: eventId,
        eventId,
        expectedRevision: 1
      })
    ).rejects.toThrow('Recover unknown')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'scheduledStreams.schedule',
      expect.objectContaining({ operationId: eventId })
    )
  })
})
