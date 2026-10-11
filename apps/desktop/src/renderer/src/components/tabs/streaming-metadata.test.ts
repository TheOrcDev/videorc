import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamTargetSettings
} from '@/lib/backend'

import { isSixteenByNine } from '@/components/streaming/thumbnail-field'

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

    expect(markup).toContain('Shared title · Just Chatting')
    expect(markup).toContain('id="kick-category"')
    // One combobox shows the picked category; typed text is only a search (D-30).
    expect(markup).toMatch(/<button(?=[^>]*role="combobox")(?=[^>]*id="kick-category")[^>]*>/)
    expect(markup).toContain('>Just Chatting<')
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
    expect(markup).toContain('Shared title · Unlisted')
    expect(markup).not.toContain('Custom RTMP')
    // Closed rows draw no inputs: the page is one form, not four.
    expect(markup).not.toContain('id="youtube-metadata-title"')
    expect(markup).not.toContain('id="twitch-category"')
    expect(markup).not.toContain('Custom title and description')
  })

  it('shows no per-destination rows for a Custom RTMP-only setup', () => {
    const markup = render(draft(), [target('custom', 'Custom RTMP')])

    expect(markup).not.toContain('data-slot="accordion"')
    expect(markup).toContain(
      'Turn on YouTube, Twitch, Kick or X in Destinations to set details for each.'
    )
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
    expect(markup).toContain('Uses the title, description and privacy above.')
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

    expect(markup).toContain('Own title · Public')
    expect(markup).toContain('id="youtube-metadata-title"')
    expect(markup).toContain('value="Testing Videorc"')
    expect(markup).toContain('id="youtube-metadata-description"')
    expect(markup).toContain('Replaces the title, description and privacy above for Orc TV.')
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

  it('draws the thumbnail field only with a YouTube destination', () => {
    expect(render(draft(), [target('twitch', 'Twitch main')])).not.toContain('Thumbnail')

    const oauth = { ...target('youtube', 'Orc TV'), authMode: 'oauth' } as StreamTargetSettings
    const markup = render(draft(), [oauth])
    expect(markup).toContain('Thumbnail')
    expect(markup).toContain('Choose thumbnail')
    expect(markup).toContain('Shown on YouTube. JPEG or PNG, 16:9, 1280 × 720 or larger.')
  })

  it('says a stream-key-only YouTube setup cannot receive a thumbnail', () => {
    const markup = render(draft(), [target('youtube', 'Orc TV')])
    expect(markup).toContain('Stream key destinations can&#x27;t receive a thumbnail.')
  })

  it('previews a saved thumbnail with Replace and Remove', () => {
    const id = 'c'.repeat(64)
    const oauth = { ...target('youtube', 'Orc TV'), authMode: 'oauth' } as StreamTargetSettings
    const markup = render(draft({ thumbnailAssetId: id }), [oauth])
    expect(markup).toContain(`src="videorc-asset://scheduled-thumbnail/${id}"`)
    expect(markup).toContain('Replace thumbnail')
    expect(markup).toContain('Remove thumbnail')
  })
})

describe('Stream details (plan 174 S3.5b)', () => {
  it('draws rows only for destinations that are on (D-18)', () => {
    const off = { ...target('twitch', 'Twitch main'), enabled: false } as StreamTargetSettings
    const markup = render(draft(), [target('youtube', 'Orc TV'), off])
    expect(markup).toContain('Orc TV')
    expect(markup).not.toContain('Twitch main')
  })

  it('shows no title error before the title is touched, even when the check found one (V-3)', () => {
    const validation: StreamMetadataValidation = {
      valid: false,
      issues: [{ field: 'title', message: 'Global title is required before going live.' }]
    }
    const markup = render(draft({ title: '' }), [target('youtube', 'Orc TV')], validation)
    expect(markup).not.toContain('Global title')
    expect(markup).not.toContain('Add a title before you go live.')
    expect(markup).not.toContain('aria-invalid="true"')
  })

  it('names the state: checked, or how many details need attention (D-5)', () => {
    expect(render(draft(), [target('youtube', 'Orc TV')], { valid: true, issues: [] })).toContain(
      '>Checked<'
    )
    const twoIssues: StreamMetadataValidation = {
      valid: false,
      issues: [
        { field: 'title', message: 'x', platform: 'youtube' },
        { field: 'title', message: 'y', platform: 'x' }
      ]
    }
    const markup = render(draft(), [target('youtube', 'Orc TV')], twoIssues)
    expect(markup).toContain('2 details need attention')
    expect(markup).not.toContain('Metadata ready')
    expect(markup.replace(/<[^>]*>/g, ' ')).not.toMatch(/metadata/i)
    expect(render(draft(), [target('youtube', 'Orc TV')])).not.toContain(
      'data-testid="stream-details-status"'
    )
  })

  it('keeps the thumbnail picker off, with its reason, when only a stream key reaches YouTube', () => {
    const markup = render(draft(), [target('youtube', 'Orc TV')])
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Choose thumbnail</)
    expect(markup).toContain('Stream key destinations can&#x27;t receive a thumbnail.')
  })

  it('offers privacy as one segmented control only while YouTube is on', () => {
    expect(render(draft(), [target('youtube', 'Orc TV')])).toContain('id="stream-privacy"')
    expect(render(draft(), [target('twitch', 'Twitch main')])).not.toContain('id="stream-privacy"')
  })
})

describe('isSixteenByNine', () => {
  it('accepts 16:9 within 1% and flags other shapes', () => {
    expect(isSixteenByNine(1280, 720)).toBe(true)
    expect(isSixteenByNine(1920, 1080)).toBe(true)
    expect(isSixteenByNine(1280, 726)).toBe(true)
    expect(isSixteenByNine(1080, 1080)).toBe(false)
    expect(isSixteenByNine(1080, 1920)).toBe(false)
    expect(isSixteenByNine(1600, 1200)).toBe(false)
  })
})
