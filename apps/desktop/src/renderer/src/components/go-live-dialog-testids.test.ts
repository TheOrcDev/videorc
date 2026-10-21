// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  StreamMetadataDraft,
  StreamTargetSettings
} from '@/lib/backend'
import { defaultCaptureConfig, defaultStreamingSettings } from '@/lib/capture'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { GoLiveConfirmationDialog } from './go-live-dialog'

// Plan 178 U6: the live lab clicks this dialog over CDP in packaged builds
// (scripts/live-lab/lib/ui-driver.mjs). These hooks are its contract; a
// rename here breaks every unattended run, so they are pinned.

const streaming = defaultStreamingSettings()
const youtube = streaming.targets.find((target) => target.id === 'youtube') as StreamTargetSettings

vi.mock('@/hooks/use-studio', () => ({
  useStudioBanners: () => ({ banners: [] }),
  useStudioCore: () => ({
    captureConfig: {
      ...defaultCaptureConfig,
      streaming: {
        ...streaming,
        enabled: true,
        targets: streaming.targets.map((target) =>
          target.id === 'youtube' ? { ...target, enabled: true, streamKeyPresent: true } : target
        ),
        enabledTargetIds: ['youtube']
      }
    },
    performanceCheck: undefined,
    streamOutputTopologyPreflight: { state: 'idle' },
    streamSharedEncodeFallbackVideo: null,
    overlayLayout: DEFAULT_OVERLAY_LAYOUT
  })
}))

const noop = (): void => {}
const CAPTIONS_BLOCKED: GoLiveCaptionsReadiness = {
  kind: 'blocked',
  blocksStart: true,
  title: 'Captions unavailable',
  description: 'Captions could not start.',
  transport: null
}
const DRAFT: StreamMetadataDraft = {
  title: 'Automated test: dry',
  description: 'Live lab',
  defaultPrivacy: 'unlisted',
  targetOverrides: [],
  updatedAt: '2026-10-12T06:00:00.000Z'
}

function destination(
  overrides: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  return {
    targetId: 'youtube',
    platform: 'youtube',
    label: 'YouTube',
    authMode: 'manual-rtmp',
    ready: true,
    title: DRAFT.title,
    description: '',
    message: 'Ready to go live.',
    chatRead: 'unavailable',
    chatWrite: 'unavailable',
    chatMessage: '',
    ...overrides
  }
}

describe('Go Live dialog live-lab hooks (plan 178 U6)', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  function render({
    preflight,
    pending = false,
    partialSetup = null,
    excluded = []
  }: {
    preflight: GoLivePreflight
    pending?: boolean
    partialSetup?: { streaming: never; failures: never[]; readyLabels: string[] } | null
    excluded?: StreamTargetSettings[]
  }): void {
    act(() =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(GoLiveConfirmationDialog, {
            open: true,
            pending,
            phase: pending ? { kind: 'starting' } : null,
            partialSetup,
            preflight,
            entitlementGate: { allowed: true },
            draft: DRAFT,
            captionsReadiness: CAPTIONS_BLOCKED,
            excludedTargets: excluded,
            onPatchDraft: noop as never,
            onCancel: noop,
            onConfirm: noop,
            onContinuePartial: noop,
            onContinueWithoutCaptions: noop,
            onResolveBlocker: noop
          })
        )
      )
    )
  }

  const byTestId = (id: string): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)
  ]

  it('renders the dialog, details, privacy, destination, captions, confirm and cancel hooks', () => {
    render({
      preflight: {
        valid: false,
        issues: [],
        destinations: [
          destination(),
          destination({ targetId: 'twitch', platform: 'twitch', label: 'Twitch', ready: false })
        ]
      },
      excluded: [{ ...youtube, id: 'youtube-vertical', label: 'YouTube Vertical' }]
    })
    const dialog = byTestId('go-live-dialog')[0]!
    expect(dialog.getAttribute('data-pending')).toBe('false')
    const details = byTestId('go-live-details')[0]!
    expect(details.querySelector<HTMLInputElement>('#go-live-title')?.value).toBe(DRAFT.title)
    expect(details.querySelector('#go-live-description')).not.toBeNull()
    const privacy = [...details.querySelectorAll('#go-live-privacy [role="radio"]')]
    expect(privacy.map((radio) => radio.textContent?.toLowerCase())).toEqual([
      'private',
      'unlisted',
      'public'
    ])
    expect(
      privacy.find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent
    ).toBe('Unlisted')

    const rows = byTestId('go-live-destination')
    expect(
      rows.map((row) => [row.getAttribute('data-target-id'), row.getAttribute('data-ready')])
    ).toEqual([
      ['youtube', 'true'],
      ['twitch', 'false']
    ])
    expect(rows[0]!.querySelector('[data-testid="go-live-destination-exclude"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-testid="go-live-destination-exclude"]')).not.toBeNull()
    const excluded = byTestId('go-live-excluded')[0]!
    expect(excluded.getAttribute('data-target-id')).toBe('youtube-vertical')
    expect(excluded.querySelector('[data-testid="go-live-include"]')).not.toBeNull()

    expect(byTestId('go-live-captions-skip')).toHaveLength(1)
    expect(byTestId('go-live-confirm')).toHaveLength(1)
    expect(byTestId('go-live-cancel')).toHaveLength(1)
  })

  it('marks a confirmed Go Live as pending with its phase, and names the partial-setup primary', () => {
    render({
      preflight: { valid: true, issues: [], destinations: [destination()] },
      pending: true,
      partialSetup: { streaming: undefined as never, failures: [], readyLabels: ['YouTube'] }
    })
    const dialog = byTestId('go-live-dialog')[0]!
    expect(dialog.getAttribute('data-pending')).toBe('true')
    expect(dialog.getAttribute('data-phase')).toBe('starting')
    expect(byTestId('go-live-partial-setup')).toHaveLength(1)
    expect(byTestId('go-live-continue-partial')).toHaveLength(1)
  })
})
