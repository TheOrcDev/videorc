import { describe, expect, it, vi } from 'vitest'
import {
  releaseScheduledXPreparations,
  runScheduledOperation,
  scheduledLifecycleChip,
  scheduledPrivacyLabel,
  scheduledProviderSections,
  scheduledWhenLabel,
  selectScheduledStreamForTarget,
  settleScheduledXTargets
} from './scheduled-streams'
import {
  defaultCaptureConfig,
  normalizeStreamingSettings,
  patchStreamTargetForEdit
} from './capture'
import type {
  ScheduledStreamCapabilities,
  ScheduledStreamEvent,
  StreamTargetSettings,
  StreamingSettings
} from './backend'

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

function scheduledEvent(overrides: Partial<ScheduledStreamEvent> = {}): ScheduledStreamEvent {
  return {
    id: 'event',
    schemaVersion: 1,
    revision: 1,
    provider: 'youtube',
    accountId: 'channel',
    accountLabel: 'Channel',
    requested: {
      title: 'Launch',
      description: '',
      privacy: 'unlisted',
      madeForKids: false,
      localStart: '2035-01-01T12:00',
      timeZone: 'Europe/Madrid',
      offsetChoice: null,
      thumbnailAssetId: null,
      plannedEndLocal: null,
      availableForReplay: null
    },
    startUtc: '2035-01-01T11:00:00Z',
    providerEventId: 'broadcast',
    watchUrl: null,
    lifecycle: 'scheduled',
    operationState: 'idle',
    thumbnailState: 'none',
    error: null,
    lastSyncedAt: null,
    preparation: null,
    createUncertain: false,
    ...overrides
  } as ScheduledStreamEvent
}

describe('Upcoming, split by platform', () => {
  const capabilities = {
    available: true,
    reason: null,
    accounts: [],
    audienceEditable: false,
    providers: [
      {
        provider: 'youtube',
        available: false,
        reason: 'YouTube approval is pending.',
        accounts: [],
        fields: [],
        audienceEditable: false
      },
      {
        provider: 'x',
        available: true,
        reason: null,
        accounts: [],
        fields: [],
        audienceEditable: false
      }
    ]
  } as ScheduledStreamCapabilities

  it('keeps a section for every platform, YouTube first, each with its own availability', () => {
    const events = [
      scheduledEvent({ id: 'x-1', provider: 'x' }),
      scheduledEvent({ id: 'yt-1' }),
      scheduledEvent({ id: 'yt-done', lifecycle: 'completed' })
    ]
    const upcoming = scheduledProviderSections(events, capabilities, false)
    expect(upcoming.map((section) => section.provider)).toEqual(['youtube', 'x'])
    expect(upcoming[0]).toMatchObject({ available: false, reason: 'YouTube approval is pending.' })
    expect(upcoming[0].events.map((event) => event.id)).toEqual(['yt-1'])
    expect(upcoming[1]).toMatchObject({ available: true, reason: null })
    expect(upcoming[1].events.map((event) => event.id)).toEqual(['x-1'])

    const history = scheduledProviderSections(events, capabilities, true)
    expect(history[0].events.map((event) => event.id)).toEqual(['yt-done'])
    expect(history[1].events).toEqual([])
  })

  it('falls back to the legacy capability for a platform the backend does not list', () => {
    const legacy = {
      available: true,
      reason: null,
      accounts: [],
      audienceEditable: false
    } as unknown as ScheduledStreamCapabilities
    expect(scheduledProviderSections([], legacy, false)[1]).toMatchObject({
      provider: 'x',
      available: true,
      events: []
    })
    expect(scheduledProviderSections([], null, false)[0].available).toBe(false)
  })

  it('names each state with the chip that carries it', () => {
    expect(scheduledLifecycleChip(scheduledEvent({ lifecycle: 'draft' }))).toEqual({
      kind: 'tag',
      label: 'Draft'
    })
    expect(scheduledLifecycleChip(scheduledEvent())).toEqual({
      kind: 'status',
      label: 'Scheduled',
      tone: 'good'
    })
    expect(scheduledLifecycleChip(scheduledEvent({ lifecycle: 'live' }))).toEqual({
      kind: 'live',
      label: 'Live'
    })
    expect(scheduledLifecycleChip(scheduledEvent({ lifecycle: 'completed' }))).toMatchObject({
      label: 'Ended',
      tone: 'neutral'
    })
    expect(
      scheduledLifecycleChip(scheduledEvent({ provider: 'x', lifecycle: 'missing' }))
    ).toMatchObject({ label: 'Deleted on X', tone: 'warn' })
    expect(scheduledLifecycleChip(scheduledEvent({ createUncertain: true }))).toMatchObject({
      label: 'Needs review',
      tone: 'warn'
    })
  })

  it('shows visibility for YouTube only', () => {
    expect(scheduledPrivacyLabel(scheduledEvent())).toBe('Unlisted')
    expect(scheduledPrivacyLabel(scheduledEvent({ provider: 'x' }))).toBeNull()
  })

  it('says when, in the event time zone, with an X broadcast planned end', () => {
    const youtube = scheduledWhenLabel(scheduledEvent(), 'en-GB')
    expect(youtube).toContain('2035')
    expect(youtube).toContain('12:00')
    const x = scheduledEvent({
      provider: 'x',
      requested: { ...scheduledEvent().requested, plannedEndLocal: '2035-01-01T13:30' }
    })
    expect(scheduledWhenLabel(x, 'en-GB')).toMatch(/12:00\s?–\s?13:30 CET$/)
    expect(scheduledWhenLabel(x, 'en-US')).toMatch(/12:00\s?–\s?1:30\s?PM/)
    const overnight = scheduledEvent({
      provider: 'x',
      requested: { ...scheduledEvent().requested, plannedEndLocal: '2035-01-02T01:00' }
    })
    expect(scheduledWhenLabel(overnight, 'en-GB')).toMatch(/12:00.*–.*2 Jan 2035, 01:00/)
  })
})

describe('saved X broadcasts after a session', () => {
  const eventId = '22222222-2222-4222-8222-222222222222'
  const xTarget = {
    id: 'x',
    platform: 'x',
    label: 'X',
    authMode: 'oauth',
    enabled: true,
    accountId: 'account',
    scheduledEventId: eventId,
    scheduledAttemptId: 'attempt',
    streamKey: '',
    streamKeyPresent: true,
    serverUrl: 'rtmps://example/x',
    status: { state: 'ready', message: 'Saved X broadcast prepared.' },
    createdAt: '',
    updatedAt: ''
  } satisfies StreamTargetSettings
  const youtubeTarget = {
    ...xTarget,
    id: 'youtube',
    platform: 'youtube'
  } satisfies StreamTargetSettings
  const streaming = (targets: StreamTargetSettings[]): StreamingSettings => ({
    ...defaultCaptureConfig.streaming,
    targets
  })

  it('releases a preparation that never went live, once, and keeps the schedule', async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'scheduledStreams.get'
          ? { revision: 3 }
          : { state: 'complete', result: { lifecycleStatus: 'ready', message: '' } }
      )
    const live = { ...xTarget, id: 'x-live', status: { state: 'live' as const } }
    const released = await releaseScheduledXPreparations(
      { request },
      streaming([xTarget, live, youtubeTarget]),
      'session'
    )
    expect(released.complete).toBe(true)
    const [x, stillLive, youtube] = released.streaming.targets
    expect(x).toMatchObject({
      scheduledAttemptId: undefined,
      status: { state: 'stopped', message: 'Upcoming broadcast preserved.' }
    })
    expect(stillLive.scheduledAttemptId).toBe('attempt')
    expect(youtube.scheduledAttemptId).toBe('attempt')
    expect(request).toHaveBeenCalledWith(
      'scheduledStreams.releasePreparation',
      expect.objectContaining({
        eventId,
        expectedRevision: 3,
        attemptId: 'attempt',
        sessionId: 'session'
      })
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('flags a failed release for review instead of dropping it', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    const released = await releaseScheduledXPreparations(
      { request },
      streaming([xTarget]),
      undefined
    )
    expect(released.complete).toBe(false)
    expect(released.streaming.targets[0]).toMatchObject({
      scheduledAttemptId: 'attempt',
      status: { state: 'warning', message: 'X scheduled cleanup needs review: offline' }
    })
  })

  it('carries only the saved X destination settled state onto the live config', () => {
    const settled = streaming([
      { ...xTarget, scheduledAttemptId: undefined, status: { state: 'stopped', message: 'done' } },
      youtubeTarget
    ])
    const current = streaming([xTarget, youtubeTarget])
    const next = settleScheduledXTargets(current, settled)
    expect(next.targets[0]).toMatchObject({
      scheduledAttemptId: undefined,
      status: { state: 'stopped', message: 'done' }
    })
    expect(next.targets[1]).toBe(current.targets[1])
  })
})
