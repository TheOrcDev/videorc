import { describe, expect, it } from 'vitest'

import type { StreamTargetMetadataDraft, StreamTargetSettings } from '@/lib/backend'

import {
  metadataOverrideSummary,
  streamDetailsStatus,
  visibleMetadataOverrides
} from './stream-metadata-summary'

function override(
  platform: StreamTargetMetadataDraft['platform'],
  patch: Partial<StreamTargetMetadataDraft> = {}
): StreamTargetMetadataDraft {
  return {
    platform,
    customize: false,
    title: '',
    description: '',
    privacy: 'private',
    updatedAt: '2026-09-24T00:00:00Z',
    ...patch
  }
}

function target(
  platform: StreamTargetSettings['platform'],
  label: string,
  id = `${platform}-${label}`
): StreamTargetSettings {
  return {
    id,
    platform,
    label,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'manual-rtmp'
  } as StreamTargetSettings
}

const allOverrides = [override('youtube'), override('twitch'), override('kick'), override('x')]

describe('visibleMetadataOverrides', () => {
  it('draws one row per connected native platform, in Destinations order', () => {
    const visible = visibleMetadataOverrides(
      [
        target('twitch', 'Twitch main'),
        target('custom', 'Custom RTMP'),
        target('youtube', 'Orc TV')
      ],
      allOverrides
    )

    expect(visible.map((item) => item.override.platform)).toEqual(['twitch', 'youtube'])
    expect(visible.map((item) => item.label)).toEqual(['Twitch main', 'Orc TV'])
  })

  it('draws a Kick row once a Kick destination is listed', () => {
    const visible = visibleMetadataOverrides(
      [target('kick', 'Kick'), target('x', 'X')],
      allOverrides
    )

    expect(visible.map((item) => item.override.platform)).toEqual(['kick', 'x'])
  })

  it('draws no row for a destination that is off (plan 174 S3.5b, D-18)', () => {
    const off = { ...target('twitch', 'Twitch main'), enabled: false } as StreamTargetSettings
    expect(visibleMetadataOverrides([off, target('x', 'X')], allOverrides)).toHaveLength(1)
  })

  it('draws nothing for a Custom RTMP-only setup', () => {
    expect(visibleMetadataOverrides([target('custom', 'Custom RTMP')], allOverrides)).toEqual([])
  })

  it('draws nothing when the draft has no rows, even with destinations connected', () => {
    expect(visibleMetadataOverrides([target('youtube', 'Orc TV')], [])).toEqual([])
  })

  it('shows one row per platform when two destinations share it, named after the first', () => {
    const visible = visibleMetadataOverrides(
      [target('youtube', 'Horizontal', 'yt-1'), target('youtube', 'Vertical', 'yt-2')],
      allOverrides
    )

    expect(visible).toHaveLength(1)
    expect(visible[0].label).toBe('Horizontal')
  })

  it('falls back to the platform name when the destination label is blank', () => {
    const visible = visibleMetadataOverrides([target('x', '  ')], allOverrides)

    expect(visible[0].label).toBe('X')
  })
})

describe('metadataOverrideSummary', () => {
  const draft = { defaultPrivacy: 'unlisted' as const }

  it('YouTube inherits: where the title comes from and the default privacy', () => {
    expect(metadataOverrideSummary(draft, override('youtube', { privacy: 'public' }))).toBe(
      'Shared title · Unlisted'
    )
  })

  it('YouTube custom: its own privacy, and made for kids only when true', () => {
    expect(
      metadataOverrideSummary(
        draft,
        override('youtube', { customize: true, privacy: 'public', youtubeMadeForKids: true })
      )
    ).toBe('Own title · Public · Made for kids')
    expect(metadataOverrideSummary(draft, override('youtube', { youtubeMadeForKids: false }))).toBe(
      'Shared title · Unlisted'
    )
  })

  it('Twitch names the category and a non-English language only when set', () => {
    expect(metadataOverrideSummary(draft, override('twitch', { twitchLanguage: 'en' }))).toBe(
      'Shared title'
    )
    expect(
      metadataOverrideSummary(
        draft,
        override('twitch', { twitchCategoryName: ' Just Chatting ', twitchLanguage: 'es' })
      )
    ).toBe('Shared title · Just Chatting · es')
  })

  it('Kick names the category only when set', () => {
    expect(metadataOverrideSummary(draft, override('kick'))).toBe('Shared title')
    expect(
      metadataOverrideSummary(
        draft,
        override('kick', { customize: true, kickCategoryId: 15, kickCategoryName: 'Just Chatting' })
      )
    ).toBe('Own title · Just Chatting')
  })

  it('X says whether the announcement post goes out', () => {
    expect(metadataOverrideSummary(draft, override('x'))).toBe('Shared title · Announces')
    expect(metadataOverrideSummary(draft, override('x', { xAnnounce: false }))).toBe(
      'Shared title · No announcement'
    )
    expect(
      metadataOverrideSummary(draft, override('x', { customize: true, xAnnounce: true }))
    ).toBe('Own title · Announces')
  })
})

describe('streamDetailsStatus (plan 174 S3.5b, D-5)', () => {
  it('says unsaved first, then checked or what needs attention, and nothing before a check', () => {
    expect(streamDetailsStatus({ dirty: true, validation: { valid: true, issues: [] } })).toEqual({
      tone: 'neutral',
      label: 'Unsaved changes'
    })
    expect(streamDetailsStatus({ dirty: false, validation: null })).toBeNull()
    expect(streamDetailsStatus({ dirty: false, validation: { valid: true, issues: [] } })).toEqual({
      tone: 'good',
      label: 'Checked'
    })
    expect(
      streamDetailsStatus({ dirty: false, validation: { valid: false, issues: [{}] } })?.label
    ).toBe('1 detail needs attention')
  })
})
