// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { SrtInputContext, type SrtInputControls } from '@/hooks/use-srt-input'
import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  SrtInputState,
  StreamMetadataDraft,
  StreamTargetSettings
} from '@/lib/backend'
import { defaultCaptureConfig, type CaptureConfig } from '@/lib/capture'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'
import type { GoLivePhase } from '@/lib/go-live-dialog-view'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { streamingWithoutTargets } from '@/lib/go-live-exclusions'
import { SRT_CAMERA_ID } from '@/lib/srt-input-view'

import { GO_LIVE_EXCLUDED_NOTE, GoLiveConfirmationDialog } from './go-live-dialog'

// Plan 174 S3.4: the rebuilt Go Live dialog. First focus is the title (or the
// primary), ⌘↵ goes live, the pending primary names its phase, and "Go live
// without …" leaves a destination out of this livestream only.

const mocked = vi.hoisted(() => ({
  srt: null as unknown,
  sceneOnStream: null as unknown,
  captureConfig: undefined as unknown,
  banners: [] as unknown[],
  sharedVideo: null as unknown,
  topology: { state: 'idle' } as unknown
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioBanners: () => ({ banners: mocked.banners }),
  useStudioCore: () => ({
    captureConfig: mocked.captureConfig,
    sceneOnStream: mocked.sceneOnStream,
    performanceCheck: undefined,
    streamOutputTopologyPreflight: mocked.topology,
    streamSharedEncodeFallbackVideo: mocked.sharedVideo,
    overlayLayout: DEFAULT_OVERLAY_LAYOUT
  })
}))

// Plan 231 D4: the vertical leg is the scene on stream's 9:16 layout.
const VERTICAL_CAMERA_SCENE = {
  layouts: {
    vertical: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-bottom' as const }
  }
}

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
  mocked.srt = null
  mocked.sceneOnStream = null
  mocked.banners = []
  mocked.sharedVideo = null
  mocked.topology = { state: 'idle' }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

type DialogProps = Parameters<typeof GoLiveConfirmationDialog>[0]

let lastProps: DialogProps | null = null

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
  lastProps = full
  const srt = mocked.srt as SrtInputState | null
  const controls: SrtInputControls = {
    state: srt,
    stateRef: { current: srt },
    connected: true,
    set: async () => ({ ok: true }),
    renewPassphrase: async () => ({ ok: true })
  }
  act(() =>
    root.render(
      createElement(
        SrtInputContext.Provider,
        { value: controls },
        createElement(TooltipProvider, null, createElement(GoLiveConfirmationDialog, full))
      )
    )
  )
  return full
}

/** The same open dialog, with the SRT Camera's signal now `signal`. */
function setSrt(
  signal: SrtInputState['status']['signal'],
  patch: Partial<SrtInputState> = {},
  status: Partial<SrtInputState['status']> = {}
): void {
  mocked.srt = srtState(signal, patch, status)
  render(lastProps ?? {})
}

function srtState(
  signal: SrtInputState['status']['signal'],
  patch: Partial<SrtInputState> = {},
  status: Partial<SrtInputState['status']> = {}
): SrtInputState {
  return {
    supported: true,
    enabled: true,
    port: 45678,
    connection: 'wifi',
    latencyMs: 120,
    passphrase: 'a'.repeat(32),
    cameraId: SRT_CAMERA_ID,
    cameraName: 'SRT Camera (port 45678)',
    status: {
      listening: true,
      senderConnected: signal !== 'waiting',
      senderSession: 1,
      framesDecoded: 10,
      signal,
      detail: 'x',
      ...status
    },
    ...patch
  }
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

  it('says on the vertical row when this computer cannot encode the vertical leg (#691)', () => {
    // Linux (ogre, 2026-11-01): "3 of 3 ready", then the engine refused the
    // start because the raw path has no second encoder for the vertical leg.
    const vertical = withTargets((target) =>
      target.id === 'youtube' || target.id === 'youtube-vertical'
        ? { ...target, enabled: true }
        : target
    )
    mocked.captureConfig = { ...vertical, streamEnabled: true }
    const preflight: GoLivePreflight = {
      valid: true,
      issues: [],
      destinations: [
        destination({ targetId: 'youtube', platform: 'youtube', label: 'YouTube' }),
        destination({
          targetId: 'youtube-vertical',
          platform: 'youtube',
          label: 'YouTube Vertical'
        })
      ]
    }
    const topology = (effectiveBridgeOutput: string): unknown => ({
      state: 'ready',
      requestKey: 'key',
      result: { outputRoles: ['stream'], effectiveBridgeOutput }
    })

    mocked.topology = topology('raw-yuv420p')
    const props = render({ preflight })
    expect(dialog().textContent).toContain('1 of 2 ready')
    const row = dialog().querySelector('[data-target-id=youtube-vertical]')!
    expect(row.getAttribute('data-ready')).toBe('false')
    expect(row.textContent).toContain("can't encode a separate vertical stream")
    expect(dialog().textContent).not.toContain('Streaming both orientations')
    expect(primary().disabled).toBe(true)
    act(() => button('Go live without YouTube Vertical').click())
    expect(props.onResolveBlocker).toHaveBeenCalledWith('youtube-vertical', 'exclude')

    // An encoder with a second leg (VideoToolbox, Media Foundation) streams both.
    mocked.topology = topology('videotoolbox-h264-mpegts')
    render({ preflight })
    expect(dialog().textContent).toContain('2 of 2 ready')
    expect(dialog().textContent).toContain('Streaming both orientations')
    expect(primary().disabled).toBe(false)
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

// Owner report (2026-11-12): live on four platforms with YouTube Unlisted and
// nothing said so. A YouTube destination that isn't Public asks once more,
// naming it and its privacy; Public goes live at once.
describe('Go Live privacy step', () => {
  const youtubeOn = (): CaptureConfig =>
    withTargets((target) =>
      target.id === 'youtube' || target.platform === 'twitch'
        ? { ...target, enabled: true }
        : target
    )
  const youtubeReady: GoLivePreflight = {
    valid: true,
    issues: [],
    destinations: [
      destination({ targetId: 'youtube', platform: 'youtube', label: 'YouTube' }),
      destination()
    ]
  }
  const withPrivacy = (privacy: StreamMetadataDraft['defaultPrivacy']): StreamMetadataDraft => ({
    ...draft('Friday build'),
    defaultPrivacy: privacy
  })
  const step = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid=go-live-privacy-dialog]')
  const stepButton = (suffix: 'cancel' | 'confirm'): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`[data-testid=go-live-privacy-${suffix}]`)!

  beforeEach(() => {
    mocked.captureConfig = youtubeOn()
  })

  it('asks before going live unlisted, and goes live only on its confirm', () => {
    const props = render({ preflight: youtubeReady, draft: withPrivacy('unlisted') })
    act(() => primary().click())
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(step()?.textContent).toContain('Go live unlisted?')
    expect(step()?.textContent).toContain(
      'YouTube is Unlisted. Only people with the link can watch.'
    )
    expect(stepButton('cancel').textContent).toBe('Change privacy')
    expect(stepButton('confirm').textContent).toBe('Go live unlisted')
    act(() => stepButton('confirm').click())
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('goes back to the dialog without going live', async () => {
    const props = render({ preflight: youtubeReady, draft: withPrivacy('private') })
    act(() => primary().click())
    expect(step()?.textContent).toContain('YouTube is Private. Only you can watch.')
    // The safe answer has focus, so Enter goes back rather than live.
    await vi.waitFor(() => expect(document.activeElement).toBe(stepButton('cancel')))
    act(() => stepButton('cancel').click())
    await vi.waitFor(() => expect(step()).toBeNull())
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
  })

  it('never lets ⌘↵ skip the step', () => {
    const props = render({ preflight: youtubeReady, draft: withPrivacy('unlisted') })
    pressCommandEnter(dialog().querySelector('#go-live-description')!)
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(step()).not.toBeNull()
    // Again, from inside the step (it nests in the Go Live dialog's tree).
    pressCommandEnter(step()!)
    pressCommandEnter(stepButton('cancel'))
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(step()).not.toBeNull()
  })

  it('goes live at once when YouTube is Public, and without YouTube', () => {
    const props = render({ preflight: youtubeReady, draft: withPrivacy('public') })
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(step()).toBeNull()

    mocked.captureConfig = twitchOn()
    const twitch = render({ draft: withPrivacy('private') })
    pressCommandEnter()
    expect(twitch.onConfirm).toHaveBeenCalledTimes(1)
    expect(step()).toBeNull()
  })

  it("shows and edits the privacy YouTube actually gets, its override's when customised", () => {
    const customised: StreamMetadataDraft = {
      ...withPrivacy('public'),
      targetOverrides: [
        {
          platform: 'youtube',
          customize: true,
          title: 'YouTube title',
          description: '',
          privacy: 'unlisted',
          updatedAt: '2026-11-12T00:00:00Z'
        }
      ]
    }
    const props = render({ preflight: youtubeReady, draft: customised })
    const checked = dialog().querySelector('#go-live-privacy [aria-checked=true]')
    expect(checked?.textContent).toBe('Unlisted')
    const row = dialog().querySelector('[data-target-id=youtube]')!
    expect(row.textContent).toContain('Unlisted. Only people with the link can watch.')
    expect(
      dialog().querySelector('[data-target-id=twitch] [data-slot=go-live-destination-privacy]')
    ).toBeNull()

    const publicChoice = [
      ...dialog().querySelectorAll<HTMLElement>('#go-live-privacy [role=radio]')
    ].find((option) => option.textContent === 'Public')!
    act(() => publicChoice.click())
    expect(props.onPatchDraft).toHaveBeenCalledWith({
      targetOverrides: [{ ...customised.targetOverrides[0], privacy: 'public' }]
    })
  })

  it('names a scheduled event that is not public, and goes back rather than to a field', () => {
    mocked.captureConfig = withTargets((target) =>
      target.id === 'youtube'
        ? { ...target, enabled: true, scheduledEventId: 'event-1', scheduledEventTitle: 'Launch' }
        : target
    )
    render({
      preflight: {
        valid: true,
        issues: [],
        destinations: [
          destination({
            targetId: 'youtube',
            platform: 'youtube',
            label: 'YouTube',
            scheduled: {
              eventId: 'event-1',
              fingerprint: 'f',
              title: 'Launch',
              privacy: 'unlisted',
              startUtc: '2026-11-12T20:00:00Z'
            }
          })
        ]
      },
      draft: withPrivacy('public')
    })
    act(() => primary().click())
    expect(step()?.textContent).toContain(
      'The scheduled event on YouTube is Unlisted. Only people with the link can watch.'
    )
    expect(stepButton('cancel').textContent).toBe('Go back')
  })
})

// Plan 255 D15: every way the dialog goes on (the primary,
// ⌘↵, the privacy step, "Go live anyway", "Go live on {ready}") asks what is
// still unanswered in this attempt, with the SRT Camera's signal as it is
// now. An answer counts until the dialog closes.
describe('Go Live SRT Camera ask', () => {
  const withSrtCamera = (config: CaptureConfig): CaptureConfig => ({
    ...config,
    sources: { ...config.sources, cameraId: SRT_CAMERA_ID },
    layout: { ...config.layout, layoutPreset: 'screen-camera' }
  })
  const youtubeAndTwitch = (): CaptureConfig =>
    withSrtCamera(
      withTargets((target) =>
        target.id === 'youtube' || target.platform === 'twitch'
          ? { ...target, enabled: true }
          : target
      )
    )
  const youtubeReady: GoLivePreflight = {
    valid: true,
    issues: [],
    destinations: [
      destination({ targetId: 'youtube', platform: 'youtube', label: 'YouTube' }),
      destination()
    ]
  }
  const partialSetup = () => ({
    streaming: (mocked.captureConfig as CaptureConfig).streaming,
    failures: [],
    readyLabels: ['Twitch']
  })
  // An ask that is up; one being answered closes with an animation.
  const srtAsk = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid=go-live-srt-no-signal-dialog][data-open]')
  const answer = (testId: string): void => {
    act(() => document.querySelector<HTMLButtonElement>(`[data-testid=${testId}-confirm]`)!.click())
  }
  const goBack = (testId: string): void => {
    act(() => document.querySelector<HTMLButtonElement>(`[data-testid=${testId}-cancel]`)!.click())
  }
  const readyButton = (): HTMLButtonElement =>
    dialog().querySelector<HTMLButtonElement>('[data-testid=go-live-continue-partial]')!

  beforeEach(() => {
    mocked.captureConfig = withSrtCamera(twitchOn())
  })

  it('asks for the SRT Camera when its signal goes while the privacy step is up', () => {
    mocked.captureConfig = youtubeAndTwitch()
    mocked.srt = srtState('receiving')
    const props = render({
      preflight: youtubeReady,
      draft: { ...draft('Friday build'), defaultPrivacy: 'unlisted' }
    })
    act(() => primary().click())
    expect(document.querySelector('[data-testid=go-live-privacy-dialog]')).not.toBeNull()
    setSrt('waiting')
    answer('go-live-privacy')
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(srtAsk()?.textContent).toContain('The SRT Camera has no signal.')
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).toHaveBeenCalledWith(true)
  })

  it('tells the start no "Go live anyway" was given while the camera has a signal', () => {
    mocked.srt = srtState('receiving')
    const props = render()
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledWith(false)
  })

  it('waits for "Go live anyway" on the way to the ready destinations, button and ⌘↵', () => {
    mocked.srt = srtState('waiting')
    const props = render({ partialSetup: partialSetup() })
    act(() => readyButton().click())
    expect(props.onContinuePartial).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
    goBack('go-live-srt-no-signal')
    pressCommandEnter()
    expect(props.onContinuePartial).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
    answer('go-live-srt-no-signal')
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
    expect(props.onContinuePartial).toHaveBeenCalledWith(true)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('takes an answer on the way in as the answer on the way to the ready destinations', async () => {
    mocked.srt = srtState('waiting')
    const props = render()
    act(() => primary().click())
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    // Platform setup left some destinations behind; the dialog is still open.
    render({ ...props, partialSetup: partialSetup() })
    act(() => readyButton().click())
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
    // The answered ask has gone (its close animates), and none came back.
    await vi.waitFor(() => expect(srtAsk()).toBeNull())
  })

  it('forgets the answers when the dialog closes', () => {
    mocked.srt = srtState('waiting')
    const props = render()
    act(() => primary().click())
    answer('go-live-srt-no-signal')
    render({ ...props, open: false })
    render({ ...props, open: true, partialSetup: partialSetup() })
    act(() => readyButton().click())
    expect(props.onContinuePartial).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
  })

  it('asks nothing more while the SRT Camera has a signal', () => {
    mocked.srt = srtState('receiving')
    const props = render()
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    render({ ...props, partialSetup: partialSetup() })
    pressCommandEnter()
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
    expect(srtAsk()).toBeNull()
  })

  // The SRT Camera's ask wraps the one place the dialog
  // goes on, so it comes after the privacy step (unchanged since 0.24.0)
  // and never lets the start run before its answer.
  it('asks the privacy step, then the SRT Camera, before going live', () => {
    mocked.captureConfig = youtubeAndTwitch()
    mocked.srt = srtState('waiting')
    const unlisted = { ...draft('Friday build'), defaultPrivacy: 'unlisted' as const }
    const props = render({ preflight: youtubeReady, draft: unlisted })
    act(() => primary().click())
    expect(document.querySelector('[data-testid=go-live-privacy-dialog]')).not.toBeNull()
    expect(srtAsk()).toBeNull()
    answer('go-live-privacy')
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('asks at the way on when the signal goes after the privacy answer', () => {
    mocked.captureConfig = youtubeAndTwitch()
    mocked.srt = srtState('receiving')
    const unlisted = { ...draft('Friday build'), defaultPrivacy: 'unlisted' as const }
    const props = render({ preflight: youtubeReady, draft: unlisted })
    act(() => primary().click())
    answer('go-live-privacy')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    // Platform setup left some behind, and the signal went meanwhile.
    render({ ...props, partialSetup: partialSetup() })
    setSrt('waiting')
    act(() => readyButton().click())
    expect(props.onContinuePartial).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
    answer('go-live-srt-no-signal')
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
  })

  it('asks once for the same facts, and again for new ones', () => {
    mocked.srt = srtState('waiting')
    const props = render()
    act(() => primary().click())
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    // The signal comes back and goes again: the same facts, no new ask.
    setSrt('receiving')
    setSrt('waiting')
    act(() => primary().click())
    expect(srtAsk()).toBeNull()
    expect(props.onConfirm).toHaveBeenCalledTimes(2)
    // A codec Videorc can't show is another fact: asked.
    setSrt('unsupportedCodec')
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(2)
    expect(srtAsk()).not.toBeNull()
  })

  // An answer covers the signal, the streamed legs
  // and the port senders dial. A refusal comes and goes on its own (10 s,
  // or the next sender in), so it neither asks again nor clears an answer;
  // the ask shows it as context. Counters and the rate change nothing.
  it('asks again after a port change, never for a refusal or the frame rate', () => {
    mocked.srt = srtState(
      'waiting',
      {},
      { refusal: 'wrongPassphrase', detail: 'Sender refused: wrong passphrase' }
    )
    const props = render()
    act(() => primary().click())
    expect(srtAsk()?.textContent).toContain('Sender refused: wrong passphrase')
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)

    // The refusal clears, the rate and counters move: no new ask.
    setSrt('waiting', {}, { fps: 30, framesDecoded: 99, detail: 'Waiting for SRT stream' })
    act(() => primary().click())
    expect(srtAsk()).toBeNull()
    expect(props.onConfirm).toHaveBeenCalledTimes(2)

    setSrt('waiting', { port: 45679 })
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(2)
    expect(srtAsk()).not.toBeNull()
    expect(srtAsk()?.textContent).not.toContain('refused')
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(3)

    // A refusal appearing on the same port: no new ask.
    setSrt('waiting', { port: 45679 }, { refusal: 'secondSender' })
    act(() => primary().click())
    expect(srtAsk()).toBeNull()
    expect(props.onConfirm).toHaveBeenCalledTimes(4)
  })

  // ⌘↵ on the main path goes through the ask too, and
  // does nothing while the ask is up, even once the signal is back.
  it('asks on ⌘↵ with no signal and goes live only on "Go live anyway"', () => {
    mocked.srt = srtState('waiting')
    const props = render()
    pressCommandEnter()
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(props.onContinuePartial).not.toHaveBeenCalled()
    expect(srtAsk()).not.toBeNull()
    answer('go-live-srt-no-signal')
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  // ⌘↵ never acts while the SRT ask is up, whatever
  // changes under it. Here a partial setup arrives whose ready destinations
  // don't show the camera: unguarded, ⌘↵ would go on to them.
  it('ignores ⌘↵ while the SRT ask is up', () => {
    const config = withSrtCamera(
      withTargets((target) =>
        target.platform === 'twitch' || target.id === 'tiktok'
          ? { ...target, enabled: true }
          : target
      )
    )
    mocked.captureConfig = {
      ...config,
      layout: { ...config.layout, layoutPreset: 'screen-only' }
    }
    mocked.sceneOnStream = VERTICAL_CAMERA_SCENE
    mocked.srt = srtState('waiting')
    const props = render()
    act(() => primary().click())
    expect(srtAsk()).not.toBeNull()
    render({
      ...props,
      partialSetup: {
        streaming: streamingWithoutTargets(config.streaming, ['tiktok']),
        failures: [],
        readyLabels: ['Twitch']
      }
    })
    expect(srtAsk()).not.toBeNull()
    pressCommandEnter(srtAsk()!)
    pressCommandEnter()
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(props.onContinuePartial).not.toHaveBeenCalled()
  })

  // A signal back while the ask is up closes it, back to
  // the dialog; nothing starts until Go live is pressed again.
  it('closes the ask when the signal comes back, and starts nothing on its own', () => {
    for (const signal of ['receiving', 'holding'] as const) {
      mocked.srt = srtState('waiting')
      const props = render({ onConfirm: vi.fn() })
      act(() => primary().click())
      expect(srtAsk()).not.toBeNull()
      setSrt(signal)
      expect(srtAsk()).toBeNull()
      expect(props.onConfirm).not.toHaveBeenCalled()
      act(() => primary().click())
      expect(srtAsk()).toBeNull()
      expect(props.onConfirm).toHaveBeenCalledTimes(1)
    }
  })

  // The way to the ready destinations asks about what they
  // stream. Only the vertical destination showed the SRT Camera, and it
  // failed its setup: the screen-only rest needs no SRT ask.
  it('asks on the way to the ready destinations only about what they stream', () => {
    const config = withSrtCamera(
      withTargets((target) =>
        target.platform === 'twitch' || target.id === 'tiktok'
          ? { ...target, enabled: true }
          : target
      )
    )
    mocked.captureConfig = {
      ...config,
      layout: { ...config.layout, layoutPreset: 'screen-only' }
    }
    mocked.sceneOnStream = VERTICAL_CAMERA_SCENE
    mocked.srt = srtState('waiting')
    const props = render({
      partialSetup: {
        streaming: streamingWithoutTargets(config.streaming, ['tiktok']),
        failures: [],
        readyLabels: ['Twitch']
      }
    })
    act(() => readyButton().click())
    expect(srtAsk()).toBeNull()
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
  })
})

// #1316 as 0.24.0 has it, which the SRT input leaves alone: every press of Go live asks again, a privacy that changed
// while the dialog stayed open is asked for as it is now, and "Go live on
// {ready}" goes on to the prepared broadcasts without the step.
describe('Go Live privacy step on each attempt', () => {
  const youtubeOn = (): CaptureConfig =>
    withTargets((target) =>
      target.id === 'youtube' || target.platform === 'twitch'
        ? { ...target, enabled: true }
        : target
    )
  const youtubeReady: GoLivePreflight = {
    valid: true,
    issues: [],
    destinations: [
      destination({ targetId: 'youtube', platform: 'youtube', label: 'YouTube' }),
      destination()
    ]
  }
  // A step that is up; one being answered closes with an animation.
  const step = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid=go-live-privacy-dialog][data-open]')
  const confirmStep = (): void => {
    act(() =>
      document.querySelector<HTMLButtonElement>('[data-testid=go-live-privacy-confirm]')!.click()
    )
  }

  it('asks again when the confirm kept the dialog open, and for a privacy that changed', () => {
    mocked.captureConfig = youtubeOn()
    const withPrivacy = (privacy: StreamMetadataDraft['defaultPrivacy']): StreamMetadataDraft => ({
      ...draft('Friday build'),
      defaultPrivacy: privacy
    })
    const props = render({ preflight: youtubeReady, draft: withPrivacy('unlisted') })
    act(() => primary().click())
    expect(step()?.textContent).toContain('YouTube is Unlisted.')
    confirmStep()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)

    // The confirm kept the dialog open (the check found the event changed):
    // Go live asks again, for the privacy it is now.
    render({ ...props, draft: withPrivacy('private') })
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(step()?.textContent).toContain('YouTube is Private.')
    confirmStep()
    expect(props.onConfirm).toHaveBeenCalledTimes(2)

    // The same privacy again: still a fresh attempt, still asked.
    act(() => primary().click())
    expect(props.onConfirm).toHaveBeenCalledTimes(2)
    expect(step()?.textContent).toContain('YouTube is Private.')
  })

  // Two Unlisted YouTube destinations confirmed,
  // one fails setup. 0.24.0 goes on to the one left without asking again.
  it('goes on to the ready subset of a confirmed privacy without asking again', () => {
    mocked.captureConfig = withTargets((target) =>
      target.id === 'youtube' || target.id === 'youtube-vertical'
        ? { ...target, enabled: true }
        : target
    )
    const twoYouTube: GoLivePreflight = {
      valid: true,
      issues: [],
      destinations: [
        destination({ targetId: 'youtube', platform: 'youtube', label: 'YouTube' }),
        destination({
          targetId: 'youtube-vertical',
          platform: 'youtube',
          label: 'YouTube Vertical'
        })
      ]
    }
    const unlisted = { ...draft('Friday build'), defaultPrivacy: 'unlisted' as const }
    const props = render({ preflight: twoYouTube, draft: unlisted })
    act(() => primary().click())
    expect(step()?.textContent).toContain('Unlisted')
    confirmStep()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    const streaming = (mocked.captureConfig as CaptureConfig).streaming
    render({
      ...props,
      partialSetup: {
        streaming: streamingWithoutTargets(streaming, ['youtube-vertical']),
        failures: [],
        readyLabels: ['YouTube']
      }
    })
    act(() =>
      dialog().querySelector<HTMLButtonElement>('[data-testid=go-live-continue-partial]')!.click()
    )
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
  })

  // Privacy edited after the setup prepared the
  // broadcast. 0.24.0 goes on to the prepared broadcast without asking.
  it('goes on to the prepared broadcast after Privacy is edited, without asking', () => {
    mocked.captureConfig = youtubeOn()
    const unlisted = { ...draft('Friday build'), defaultPrivacy: 'unlisted' as const }
    const props = render({ preflight: youtubeReady, draft: unlisted })
    act(() => primary().click())
    confirmStep()
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    render({
      ...props,
      draft: { ...unlisted, defaultPrivacy: 'private' },
      partialSetup: {
        streaming: (mocked.captureConfig as CaptureConfig).streaming,
        failures: [],
        readyLabels: ['YouTube']
      }
    })
    act(() =>
      dialog().querySelector<HTMLButtonElement>('[data-testid=go-live-continue-partial]')!.click()
    )
    expect(props.onContinuePartial).toHaveBeenCalledTimes(1)
    expect(step()).toBeNull()
  })
})
