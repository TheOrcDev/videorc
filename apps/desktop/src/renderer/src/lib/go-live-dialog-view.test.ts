import { describe, expect, it } from 'vitest'

import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  StreamTargetSettings,
  StreamingSettings
} from './backend'
import {
  VERTICAL_LEG_UNSUPPORTED_PROBLEM,
  goLiveConfirmGate,
  goLiveDialogView,
  goLivePendingLabel,
  isTitleIssue,
  verticalLegUnsupported
} from './go-live-dialog-view'

function destination(
  targetId: string,
  overrides: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  return {
    targetId,
    platform: targetId === 'youtube' ? 'youtube' : 'twitch',
    label: targetId === 'youtube' ? 'YouTube' : 'Twitch',
    authMode: 'oauth',
    ready: true,
    title: 'Live',
    description: '',
    message: 'Ready for Go Live confirmation.',
    chatRead: 'ready',
    chatWrite: 'ready',
    chatMessage: '',
    ...overrides
  }
}

const titleOnly: GoLivePreflight = {
  valid: false,
  destinations: [
    destination('youtube', {
      ready: false,
      message: 'Destination title is required before going live.'
    }),
    destination('twitch')
  ],
  issues: [
    { severity: 'error', message: 'Global title is required before going live.' },
    {
      severity: 'error',
      targetId: 'youtube',
      platform: 'youtube',
      message: 'Destination title is required before going live.'
    }
  ]
}

describe('Go Live dialog view (plan 174 S3.4)', () => {
  it('labels the pending primary by phase (B-14)', () => {
    expect(goLivePendingLabel(null)).toBe('Checking…')
    expect(goLivePendingLabel({ kind: 'checking' })).toBe('Checking…')
    expect(goLivePendingLabel({ kind: 'preparing', platform: 'youtube' })).toBe(
      'Preparing YouTube…'
    )
    expect(goLivePendingLabel({ kind: 'starting' })).toBe('Starting…')
  })

  it('lets the Title field own title problems: typed, they no longer block', () => {
    expect(isTitleIssue({ message: 'Global title is required before going live.' })).toBe(true)
    const typed = goLiveDialogView(titleOnly, { titleField: true, titleMissing: false })
    expect(typed.generalErrors).toEqual([])
    expect(typed.destinations.every((view) => view.ready)).toBe(true)
    expect(typed.destinationsReady).toBe(true)
    expect(typed.summary).toBe('2 of 2 ready')

    const empty = goLiveDialogView(titleOnly, { titleField: true, titleMissing: true })
    expect(empty.generalErrors).toEqual([])
    expect(empty.destinations[0]).toMatchObject({ ready: false, problem: 'Needs a title.' })
    expect(empty.summary).toBe('1 of 2 ready')
    expect(empty.destinationsReady).toBe(false)
  })

  it('keeps title problems when the dialog has no Title field (every destination scheduled)', () => {
    const view = goLiveDialogView(titleOnly, { titleField: false, titleMissing: false })
    expect(view.generalErrors).toEqual(['Global title is required before going live.'])
    expect(view.destinations[0]?.ready).toBe(false)
  })

  it('puts a destination problem in its row, never again in an Alert', () => {
    const view = goLiveDialogView(
      {
        valid: false,
        destinations: [
          destination('youtube', {
            ready: false,
            message: 'Connected account needs reconnect before going live.'
          })
        ],
        issues: [
          {
            severity: 'error',
            targetId: 'youtube',
            platform: 'youtube',
            message: 'Connected account needs reconnect before going live.'
          },
          { severity: 'warning', platform: 'twitch', message: 'Chat is read-only.' }
        ]
      },
      { titleField: true, titleMissing: false }
    )
    expect(view.destinations[0]).toMatchObject({
      ready: false,
      problem: 'Connected account needs reconnect before going live.'
    })
    expect(view.generalErrors).toEqual([])
    expect(view.warnings).toEqual(['Twitch: Chat is read-only.'])
    expect(view.destinationsReady).toBe(false)
  })

  it('is not ready with no destination at all', () => {
    const view = goLiveDialogView(
      {
        valid: false,
        destinations: [],
        issues: [
          { severity: 'error', message: 'At least one livestream destination must be enabled.' }
        ]
      },
      { titleField: false, titleMissing: false }
    )
    expect(view.summary).toBeNull()
    expect(view.generalErrors).toHaveLength(1)
    expect(view.destinationsReady).toBe(false)
    expect(
      goLiveDialogView(null, { titleField: false, titleMissing: false }).destinationsReady
    ).toBe(false)
  })
})

describe('a vertical destination on the raw encoder path (#691)', () => {
  it('is refused only for a vertical leg on the raw path, once the output check answered', () => {
    expect(verticalLegUnsupported(true, 'raw-yuv420p')).toBe(true)
    expect(verticalLegUnsupported(true, 'videotoolbox-h264-mpegts')).toBe(false)
    expect(verticalLegUnsupported(true, 'windows-media-foundation-h264-mpegts')).toBe(false)
    expect(verticalLegUnsupported(false, 'raw-yuv420p')).toBe(false)
    expect(verticalLegUnsupported(true, null)).toBe(false)
  })

  it('holds the primary with the vertical row needing attention, not "2 of 2 ready"', () => {
    const target = (id: string, overrides: Partial<StreamTargetSettings> = {}) =>
      ({ id, platform: 'twitch', label: id, enabled: true, ...overrides }) as StreamTargetSettings
    const sentStreaming = {
      enabled: true,
      mode: 'multi',
      targets: [target('twitch'), target('tiktok', { outputOrientation: 'vertical' })],
      enabledTargetIds: ['twitch', 'tiktok']
    } as unknown as StreamingSettings
    const input: Parameters<typeof goLiveConfirmGate>[0] = {
      preflight: {
        valid: true,
        issues: [],
        destinations: [destination('twitch'), destination('tiktok')]
      },
      draft: {
        title: 'Live',
        description: '',
        defaultPrivacy: 'private',
        targetOverrides: [],
        updatedAt: '2026-11-01T00:00:00Z'
      },
      sentStreaming,
      captionsReadiness: { blocksStart: false },
      entitlementGate: { allowed: true }
    }

    expect(goLiveConfirmGate(input).blocked).toBe(false)
    const gate = goLiveConfirmGate({ ...input, verticalLegUnsupported: true })
    expect(gate.blocked).toBe(true)
    expect(gate.view.summary).toBe('1 of 2 ready')
    expect(gate.view.destinations).toMatchObject([
      { ready: true, problem: null },
      { ready: false, problem: VERTICAL_LEG_UNSUPPORTED_PROBLEM }
    ])
  })
})
