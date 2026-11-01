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
import { defaultCaptureConfig, type CaptureConfig } from '@/lib/capture'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'
import type { GoLivePhase } from '@/lib/go-live-dialog-view'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { GO_LIVE_EXCLUDED_NOTE, GoLiveConfirmationDialog } from './go-live-dialog'

// Plan 174 S3.4: the rebuilt Go Live dialog. First focus is the title (or the
// primary), ⌘↵ goes live, the pending primary names its phase, and "Go live
// without …" leaves a destination out of this livestream only.

const mocked = vi.hoisted(() => ({
  captureConfig: undefined as unknown,
  banners: [] as unknown[],
  sharedVideo: null as unknown
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioBanners: () => ({ banners: mocked.banners }),
  useStudioCore: () => ({
    captureConfig: mocked.captureConfig,
    performanceCheck: undefined,
    streamOutputTopologyPreflight: { state: 'idle' },
    streamSharedEncodeFallbackVideo: mocked.sharedVideo,
    overlayLayout: DEFAULT_OVERLAY_LAYOUT
  })
}))

const CAPTIONS_OFF: GoLiveCaptionsReadiness = {
  kind: 'disabled',
  blocksStart: false,
  title: '',
  description: '',
  transport: null
}

function withTargets(patch: (target: StreamTargetSettings) => StreamTargetSettings): CaptureConfig {
  const streaming = defaultCaptureConfig.streaming
  const targets = streaming.targets.map(patch)
  return {
    ...defaultCaptureConfig,
    streaming: {
      ...streaming,
      targets,
      enabled: targets.some((target) => target.enabled),
      enabledTargetIds: targets.filter((target) => target.enabled).map((target) => target.id)
    }
  }
}

/** Twitch on, streaming the instant draft. */
const twitchOn = (): CaptureConfig =>
  withTargets((target) => (target.platform === 'twitch' ? { ...target, enabled: true } : target))

function twitchTarget(config: CaptureConfig): StreamTargetSettings {
  return config.streaming.targets.find((target) => target.platform === 'twitch')!
}

function destination(
  overrides: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  return {
    targetId: twitchTarget(twitchOn()).id,
    platform: 'twitch',
    label: 'Twitch',
    authMode: 'oauth',
    ready: true,
    title: 'Friday build',
    description: '',
    message: 'Ready for Go Live confirmation.',
    chatRead: 'ready',
    chatWrite: 'ready',
    chatMessage: '',
    accountLabel: 'orcdev',
    ...overrides
  }
}

const draft = (title: string): StreamMetadataDraft => ({
  title,
  description: '',
  defaultPrivacy: 'private',
  targetOverrides: [],
  updatedAt: '2026-10-11T00:00:00Z'
})

const READY: GoLivePreflight = { valid: true, issues: [], destinations: [destination()] }

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.captureConfig = twitchOn()
  mocked.banners = []
  mocked.sharedVideo = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

type DialogProps = Parameters<typeof GoLiveConfirmationDialog>[0]

function render(props: Partial<DialogProps> = {}): DialogProps {
  const full: DialogProps = {
    open: true,
    pending: false,
    partialSetup: null,
    preflight: READY,
    entitlementGate: { allowed: true },
    draft: draft('Friday build'),
    captionsReadiness: CAPTIONS_OFF,
    platform: 'darwin',
    onPatchDraft: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    onContinuePartial: vi.fn(),
    onContinueWithoutCaptions: vi.fn(),
    onResolveBlocker: vi.fn(),
    onReconnect: vi.fn(),
    onRecheck: vi.fn(),
    ...props
  }
  act(() =>
    root.render(createElement(TooltipProvider, null, createElement(GoLiveConfirmationDialog, full)))
  )
  return full
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role=dialog]')!
const primary = (): HTMLButtonElement =>
  dialog().querySelector<HTMLButtonElement>('[data-testid=go-live-confirm]')!
const button = (label: string): HTMLButtonElement =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )!

function pressCommandEnter(target: Element = dialog()): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    )
  })
}

// Base UI moves a dialog's first focus on the next animation frame.
describe('Go Live dialog focus (B-14)', () => {
  it('starts on the title field when the dialog carries stream details', async () => {
    render()
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('go-live-title'))
  })

  it('starts on the primary when every destination is a scheduled event', async () => {
    mocked.captureConfig = withTargets((target) =>
      target.platform === 'twitch'
        ? { ...target, enabled: true, scheduledEventId: 'event-1', scheduledEventTitle: 'Saved' }
        : target
    )
    render()
    expect(dialog().querySelector('#go-live-title')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(primary()))
  })

  it('never starts on a button that changes a destination', async () => {
    render({
      preflight: {
        valid: false,
        issues: [{ severity: 'error', targetId: destination().targetId, message: 'Reconnect.' }],
        destinations: [destination({ ready: false, message: 'Reconnect.' })]
      }
    })
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('go-live-title'))
  })
})

describe('Go Live dialog keyboard (B-14)', () => {
  it('goes live on ⌘↵ and shows the keys on the primary', () => {
    const props = render()
    expect(primary().querySelector('[data-accelerator="CmdOrCtrl+Enter"]')).not.toBeNull()
    expect(primary().getAttribute('aria-keyshortcuts')).toBe('Meta+Enter')
    pressCommandEnter(dialog().querySelector('#go-live-description')!)
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does nothing on ⌘↵ while something blocks the primary', () => {
    const props = render({ draft: draft('') })
    expect(primary().disabled).toBe(true)
    pressCommandEnter()
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('ignores Enter without the command key', () => {
    const props = render()
    act(() => {
      dialog().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(props.onConfirm).not.toHaveBeenCalled()
  })
})

describe('Go Live dialog stream details (B-19, D-21)', () => {
  it('asks for a title in the field, and a typed title unblocks the backend title issue', () => {
    const titleIssue: GoLivePreflight = {
      valid: false,
      destinations: [destination()],
      issues: [{ severity: 'error', message: 'Global title is required before going live.' }]
    }
    render({ draft: draft(''), preflight: titleIssue })
    expect(dialog().textContent).toContain('Add a title before you go live.')
    expect(dialog().textContent).not.toContain('Global title')
    expect(primary().disabled).toBe(true)

    render({ draft: draft('Friday build'), preflight: titleIssue })
    expect(primary().disabled).toBe(false)
    expect(dialog().querySelector('[data-testid=go-live-blockers]')).toBeNull()
  })

  it('names privacy "Privacy" only where a YouTube destination streams the draft', () => {
    render()
    expect(dialog().textContent).not.toContain('Privacy')
    mocked.captureConfig = withTargets((target) =>
      target.platform === 'youtube' ? { ...target, enabled: true } : target
    )
    render()
    expect(dialog().querySelector('[role=radiogroup]')).not.toBeNull()
    expect(dialog().textContent).toContain('Privacy')
    expect(dialog().textContent).not.toMatch(/Default privacy|Visibility/)
  })
})

describe('Go Live dialog destinations (B-8, B-12, D-7)', () => {
  it('lists destinations as one grouped list with a summary chip, never tinted boxes', () => {
    render()
    const list = dialog().querySelector('[data-testid=go-live-destinations]')
    expect(list?.getAttribute('data-slot')).toBe('grouped-list')
    expect(list?.querySelectorAll('[data-slot=go-live-destination]')).toHaveLength(1)
    expect(dialog().textContent).toContain('1 of 1 ready')
    expect(dialog().querySelector('.bg-warning\\/10.border, .bg-destructive\\/5')).toBeNull()
  })

  it('leaves a destination out of this livestream, and brings it back', () => {
    const blocked: GoLivePreflight = {
      valid: false,
      issues: [{ severity: 'error', targetId: destination().targetId, message: 'Reconnect.' }],
      destinations: [destination({ ready: false, message: 'Reconnect.' })]
    }
    const props = render({ preflight: blocked })
    act(() => button('Go live without Twitch').click())
    expect(props.onResolveBlocker).toHaveBeenCalledWith(destination().targetId, 'exclude')

    const left = render({
      preflight: { valid: false, issues: [], destinations: [] },
      excludedTargets: [twitchTarget(twitchOn())]
    })
    const row = dialog().querySelector('[data-slot=go-live-excluded]')!
    expect(row.textContent).toContain('Left out')
    expect(row.textContent).toContain(GO_LIVE_EXCLUDED_NOTE)
    act(() => button('Add back').click())
    expect(left.onResolveBlocker).toHaveBeenCalledWith(twitchTarget(twitchOn()).id, 'include')
  })

  it('describes the livestream it sends: a left-out vertical destination drops the both-orientations advice', () => {
    const vertical = withTargets((target) =>
      target.id === 'youtube' || target.id === 'youtube-vertical'
        ? { ...target, enabled: true }
        : target
    )
    mocked.captureConfig = { ...vertical, streamEnabled: true }
    render()
    expect(dialog().textContent).toContain('Streaming both orientations')
    render({
      excludedTargets: vertical.streaming.targets.filter(
        (target) => target.id === 'youtube-vertical'
      )
    })
    expect(dialog().textContent).not.toContain('Streaming both orientations')
  })

  it('reminds a Facebook stream-key session to press Go live in Live Producer, in any orientation', () => {
    // Plan 206: a horizontal-only session never shows the both-orientations
    // advice, so the reminder can't live there.
    mocked.captureConfig = {
      ...withTargets((target) =>
        target.platform === 'facebook' ? { ...target, enabled: true } : target
      ),
      streamEnabled: true
    }
    render()
    expect(dialog().textContent).not.toContain('Streaming both orientations')
    const reminder = dialog().querySelector('[data-testid=go-live-producer-reminder]')!
    expect(reminder.textContent).toContain('press “Go live” in Facebook Live Producer')
    expect(reminder.textContent).not.toContain('Instagram')
    // Left out of this livestream: nothing to publish there.
    render({
      excludedTargets: defaultCaptureConfig.streaming.targets.filter(
        (target) => target.platform === 'facebook'
      )
    })
    expect(dialog().querySelector('[data-testid=go-live-producer-reminder]')).toBeNull()
  })

  it('reminds an Instagram session to press Go live in Live Producer without a second orientation', () => {
    mocked.captureConfig = {
      ...withTargets((target) =>
        target.platform === 'instagram' ? { ...target, enabled: true } : target
      ),
      streamEnabled: true
    }
    render()
    expect(
      dialog().querySelector('[data-testid=go-live-producer-reminder]')?.textContent
    ).toContain('press “Go live” in Instagram Live Producer')
  })

  it('offers Reconnect for a signed-in destination, then Check again', () => {
    const props = render({
      preflight: {
        valid: false,
        issues: [{ severity: 'error', targetId: destination().targetId, message: 'Reconnect.' }],
        destinations: [destination({ ready: false, message: 'Reconnect.' })]
      }
    })
    act(() => button('Reconnect Twitch…').click())
    expect(props.onReconnect).toHaveBeenCalledWith('twitch')
    act(() => button('Check again').click())
    expect(props.onRecheck).toHaveBeenCalledTimes(1)
  })
})

describe('Go Live dialog phases (B-14)', () => {
  const phases: [GoLivePhase | null, string][] = [
    [{ kind: 'checking' }, 'Checking…'],
    [{ kind: 'preparing', platform: 'youtube' }, 'Preparing YouTube…'],
    [{ kind: 'starting' }, 'Starting…']
  ]
  it.each(phases)('labels the pending primary by phase (%o)', (phase, label) => {
    render({ pending: true, phase })
    expect(primary().textContent?.trim()).toBe(label)
    expect(primary().disabled).toBe(true)
  })
})

describe('Go Live banner notices (plan 186, D13)', () => {
  // A showing banner whose two switches differ, on the one shared encode.
  const banner = (shown: boolean, showOnStream: boolean, showInRecording: boolean) => ({
    shown,
    showOnStream,
    showInRecording
  })
  const notices = (): string[] =>
    [...dialog().querySelectorAll('[data-videorc-go-live-overlay-notice="banners"]')].map(
      (item) => item.textContent ?? ''
    )

  it('says the banner sentence once with the other notices, however many banners need it', () => {
    mocked.sharedVideo = defaultCaptureConfig.video
    mocked.banners = [
      banner(true, true, false),
      banner(true, false, true),
      banner(false, true, false)
    ]
    render()
    expect(notices()).toStrictEqual([
      'Banners · Both the stream and the recording will include banners: this computer shares one encode for them.'
    ])
    expect(dialog().querySelector('[data-videorc-go-live-overlay-notices]')).not.toBeNull()
  })

  it('stays quiet while no showing banner splits its switches', () => {
    mocked.sharedVideo = defaultCaptureConfig.video
    mocked.banners = [banner(false, true, false), banner(true, true, true)]
    render()
    expect(notices()).toStrictEqual([])
    expect(dialog().querySelector('[data-videorc-go-live-overlay-notices]')).toBeNull()
  })
})
