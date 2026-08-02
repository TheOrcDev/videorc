import { describe, expect, it } from 'vitest'

import type { StreamHealth } from '@/lib/backend'

import { durationMsLabel, formatBytes, mergeStreamHealth } from './format'

describe('format', () => {
  it('spells out recording durations once they pass an hour', () => {
    expect(durationMsLabel(72 * 60 * 1000)).toBe('1 hour and 12 minutes')
    expect(durationMsLabel(60 * 60 * 1000)).toBe('1 hour')
    expect(durationMsLabel(121 * 60 * 1000)).toBe('2 hours and 1 minute')
  })

  it('keeps sub-hour recording durations compact', () => {
    expect(durationMsLabel(12 * 60 * 1000 + 34 * 1000)).toBe('12:34')
    expect(durationMsLabel(undefined)).toBe('--:--')
  })
})

describe('formatBytes', () => {
  it('scales through the units with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(742 * 1024 * 1024)).toBe('742 MB')
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB')
    expect(formatBytes(175 * 1024 ** 3)).toBe('175 GB')
  })

  it('answers a calm dash for the unknowable', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(-5)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('mergeStreamHealth', () => {
  const health = (
    overrides: Partial<StreamHealth> & Pick<StreamHealth, 'sessionId'>
  ): StreamHealth => {
    const { sessionId, ...rest } = overrides
    return {
      sessionId,
      createdAt: '2026-07-29T10:00:00.000Z',
      ...rest
    }
  }

  it('preserves sparse progress values within one stream session', () => {
    const current = health({
      sessionId: 'session-a',
      fps: 59.8,
      droppedFrames: 2,
      speed: 0.99,
      bitrateKbps: 11_900,
      totalBytes: 2_000_000,
      duplicatedFrames: 3
    })

    expect(
      mergeStreamHealth(
        current,
        health({
          sessionId: 'session-a',
          fps: 60,
          createdAt: '2026-07-29T10:00:01.000Z'
        })
      )
    ).toEqual({
      ...current,
      fps: 60,
      createdAt: '2026-07-29T10:00:01.000Z'
    })
  })

  it('accepts explicit zero values instead of treating them as sparse', () => {
    const merged = mergeStreamHealth(
      health({
        sessionId: 'session-a',
        bitrateKbps: 12_000,
        totalBytes: 2_000_000,
        duplicatedFrames: 3
      }),
      health({
        sessionId: 'session-a',
        bitrateKbps: 0,
        totalBytes: 0,
        duplicatedFrames: 0
      })
    )

    expect(merged).toMatchObject({
      bitrateKbps: 0,
      totalBytes: 0,
      duplicatedFrames: 0
    })
  })

  it('resets sparse values instead of leaking them into a new session', () => {
    const update = health({
      sessionId: 'session-b',
      fps: 30,
      createdAt: '2026-07-29T10:05:00.000Z'
    })

    expect(
      mergeStreamHealth(
        health({
          sessionId: 'session-a',
          bitrateKbps: 12_000,
          totalBytes: 2_000_000,
          duplicatedFrames: 3
        }),
        update
      )
    ).toBe(update)
    expect(update).not.toHaveProperty('bitrateKbps')
    expect(update).not.toHaveProperty('totalBytes')
    expect(update).not.toHaveProperty('duplicatedFrames')
  })
})

describe('latestArtifactAnyStatus', () => {
  it('returns pending/failed stubs that the ready-only lookup hides', async () => {
    const { latestArtifact, latestArtifactAnyStatus } = await import('./format')
    const artifact = (kind: string, status: string, id: string) =>
      ({ id, sessionId: 's1', kind, status, content: {}, createdAt: '2026-07-06' }) as never
    const session = {
      aiArtifacts: [
        artifact('transcript', 'pending-consent', 'a1'),
        artifact('chapters', 'failed', 'a2')
      ]
    } as never

    // Regression (2026-07-06): a finished consent-off run looked like "Not
    // run" because the cards only consulted ready artifacts.
    expect(latestArtifact(session, 'transcript')).toBeUndefined()
    expect(latestArtifactAnyStatus(session, 'transcript')).toMatchObject({
      status: 'pending-consent'
    })
    expect(latestArtifactAnyStatus(session, 'chapters')).toMatchObject({ status: 'failed' })
    expect(latestArtifactAnyStatus(session, 'summary')).toBeUndefined()
  })
})
