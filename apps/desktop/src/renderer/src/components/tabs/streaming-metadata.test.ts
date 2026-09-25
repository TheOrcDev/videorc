import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamTargetSettings
} from '@/lib/backend'

import { MetadataEditor } from './streaming-tab'

function draft(patch: Partial<StreamMetadataDraft> = {}): StreamMetadataDraft {
  const row = (platform: StreamMetadataDraft['targetOverrides'][number]['platform']) => ({
    platform,
    customize: false,
    title: '',
    description: '',
    privacy: 'private' as const,
    updatedAt: '2026-09-24T00:00:00Z'
  })
  return {
    title: 'Reviewing projects',
    description: 'Global description',
    defaultPrivacy: 'unlisted',
    targetOverrides: [row('youtube'), row('twitch'), row('kick'), row('x')],
    updatedAt: '2026-09-24T00:00:00Z',
    ...patch
  }
}

function target(platform: StreamTargetSettings['platform'], label: string): StreamTargetSettings {
  return {
    id: `${platform}-${label}`,
    platform,
    label,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'manual-rtmp'
  } as StreamTargetSettings
}

const noop = () => {}
const noopAsync = async () => {}

function render(
  metadata: StreamMetadataDraft,
  targets: StreamTargetSettings[],
  validation: StreamMetadataValidation | null = null
): string {
  return renderToStaticMarkup(
    createElement(MetadataEditor, {
      draft: metadata,
      validation,
      targets,
      disabled: false,
      pending: false,
      twitchCategories: [],
      twitchCategorySearchPending: false,
      onPatchDraft: noop,
      onPatchTarget: noop,
      onSave: noop,
      onSearchTwitchCategories: noopAsync
    })
  )
}

describe('Broadcast info', () => {
  it('draws a Kick row with its category and a category search when open', () => {
    const metadata = draft()
    const kickIndex = metadata.targetOverrides.findIndex((row) => row.platform === 'kick')
    metadata.targetOverrides[kickIndex] = {
      ...metadata.targetOverrides[kickIndex],
      kickCategoryId: 15,
      kickCategoryName: 'Just Chatting'
    }
    const validation: StreamMetadataValidation = {
      valid: false,
      issues: [{ field: 'title', message: 'x', platform: 'kick' }]
    }
    const markup = render(metadata, [target('kick', 'Kick')], validation)

    expect(markup).toContain('Global title · Just Chatting')
    expect(markup).toContain('id="kick-category"')
    expect(markup).toContain('value="Just Chatting"')
    expect(markup).not.toContain('id="twitch-language"')
  })

  it('draws the global fields and one closed row per connected native destination', () => {
    const markup = render(draft(), [
      target('youtube', 'Orc TV'),
      target('custom', 'Custom RTMP'),
      target('twitch', 'Twitch main')
    ])

    expect(markup).toContain('id="stream-title"')
    expect(markup).toContain('id="stream-description"')
    expect(markup).toContain('data-slot="accordion"')
    expect(markup.indexOf('Orc TV')).toBeLessThan(markup.indexOf('Twitch main'))
    expect(markup).toContain('Global title · Unlisted')
    expect(markup).not.toContain('Custom RTMP')
    // Closed rows draw no inputs: the page is one form, not four.
    expect(markup).not.toContain('id="youtube-metadata-title"')
    expect(markup).not.toContain('id="twitch-category"')
    expect(markup).not.toContain('Custom title and description')
  })

  it('shows no per-destination rows for a Custom RTMP-only setup', () => {
    const markup = render(draft(), [target('custom', 'Custom RTMP')])

    expect(markup).not.toContain('data-slot="accordion"')
    expect(markup).toContain('Connect YouTube, Twitch, Kick or X to set per-destination details.')
  })

  it('draws no rows when the draft has no override rows', () => {
    const markup = render(draft({ targetOverrides: [] }), [target('youtube', 'Orc TV')])

    expect(markup).not.toContain('data-slot="accordion"')
  })

  it('keeps a row with a validation issue open and hides custom text while the switch is off', () => {
    const validation: StreamMetadataValidation = {
      valid: false,
      issues: [
        {
          field: 'title',
          message: 'Customized destination title cannot be empty.',
          platform: 'youtube'
        }
      ]
    }
    const markup = render(draft(), [target('youtube', 'Orc TV')], validation)

    expect(markup).toContain('aria-label="Needs attention"')
    expect(markup).toContain('Custom title and description for Orc TV')
    expect(markup).toContain('Uses the global title, description and privacy.')
    expect(markup).toContain('Made for kids')
    expect(markup).not.toContain('id="youtube-metadata-title"')
    expect(markup).not.toContain('id="youtube-metadata-description"')
  })

  it('reveals the custom title, description and privacy only when the switch is on', () => {
    const metadata = draft()
    metadata.targetOverrides[0] = {
      ...metadata.targetOverrides[0],
      customize: true,
      title: 'Testing Videorc',
      privacy: 'public'
    }
    const validation: StreamMetadataValidation = {
      valid: false,
      issues: [{ field: 'title', message: 'x', platform: 'youtube' }]
    }
    const markup = render(metadata, [target('youtube', 'Orc TV')], validation)

    expect(markup).toContain('Custom title · Public')
    expect(markup).toContain('id="youtube-metadata-title"')
    expect(markup).toContain('value="Testing Videorc"')
    expect(markup).toContain('id="youtube-metadata-description"')
    expect(markup).toContain('Replaces the global title, description and privacy for Orc TV.')
  })

  it('Twitch category and language sit outside the custom-text switch', () => {
    const validation: StreamMetadataValidation = {
      valid: false,
      issues: [{ field: 'title', message: 'x', platform: 'twitch' }]
    }
    const markup = render(draft(), [target('twitch', 'Twitch main')], validation)

    expect(markup).toContain('id="twitch-category"')
    expect(markup).toContain('id="twitch-language"')
    expect(markup).not.toContain('id="twitch-metadata-title"')
  })
})
