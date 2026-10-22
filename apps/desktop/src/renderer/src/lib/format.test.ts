import { describe, expect, it } from 'vitest'

import type { StreamHealth } from '@/lib/backend'

import {
  NO_VALUE,
  durationMsLabel,
  formatBytes,
  formatDroppedFrames,
  formatMetric,
  mergeStreamHealth,
  missingValue,
  plural
} from './format'

describe('format (plan 174 S1.4, E-20)', () => {
  it('writes recording durations as the one timecode, past an hour too', () => {
    expect(durationMsLabel(72 * 60 * 1000)).toBe('1:12:00')
    expect(durationMsLabel(60 * 60 * 1000)).toBe('1:00:00')
    expect(durationMsLabel(121 * 60 * 1000 + 5_000)).toBe('2:01:05')
  })

  it('keeps sub-hour recording durations compact, and an unknown one a placeholder', () => {
    expect(durationMsLabel(12 * 60 * 1000 + 34 * 1000)).toBe('12:34')
    expect(durationMsLabel(65 * 1000)).toBe('1:05')
    expect(durationMsLabel(undefined)).toBe(NO_VALUE)
    expect(durationMsLabel(Number.NaN)).toBe('–')
  })

  it('says a missing metric with the one placeholder, never "--"', () => {
    expect(formatMetric(29.94, 'fps')).toBe('29.9 fps')
    expect(formatMetric(undefined, 'fps')).toBe('–')
    expect(formatDroppedFrames(1)).toBe('1 drop')
    expect(formatDroppedFrames(12)).toBe('12 drops')
    expect(formatDroppedFrames(0)).toBe('0 drops')
    expect(formatDroppedFrames(undefined)).toBe('–')
  })
})

describe('plural', () => {
  it('agrees the noun with the count', () => {
    expect(plural(1, 'drop')).toBe('1 drop')
    expect(plural(12, 'drop')).toBe('12 drops')
    expect(plural(0, 'viewer')).toBe('0 viewers')
    expect(plural(1, 'person', 'people')).toBe('1 person')
    expect(plural(3, 'person', 'people')).toBe('3 people')
    expect(plural(1204, 'viewer')).toBe(`${(1204).toLocaleString()} viewers`)
  })
})

describe('missingValue', () => {
  it('pairs the one placeholder with its reason', () => {
    expect(missingValue('Not measured yet')).toEqual({ value: '–', reason: 'Not measured yet' })
    expect(NO_VALUE).toBe('–')
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
    expect(formatBytes(undefined)).toBe('-')
    expect(formatBytes(null)).toBe('-')
    expect(formatBytes(-5)).toBe('-')
    expect(formatBytes(Number.NaN)).toBe('-')
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
