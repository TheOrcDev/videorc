// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamOutputTopologyPreflight } from '@/hooks/use-studio'
import type {
  DiagnosticStats,
  PlatformAccount,
  StreamPlatform,
  StreamTargetSettings,
  VideoSettings
} from '@/lib/backend'
import { videoPresets, type ProviderStreamOutputPlan } from '@/lib/capture'

import {
  encoderLabel,
  formatQuality,
  qualitySummary,
  ReadyToGoLive,
  TECHNICAL_DETAILS_STORAGE_KEY,
  TechnicalDetails
} from './go-live-panel'

// Plan 080 S7: the right column is a plain-words checklist, and the encoder
// paths and frame counters sit in Technical details, closed by default.

const stream1080 = videoPresets['stream-safe-1080p30']

function target(
  platform: StreamPlatform,
  label: string,
  patch: Partial<StreamTargetSettings> = {}
): StreamTargetSettings {
  return {
    id: label.toLowerCase().replace(/\s+/g, '-'),
    platform,
    label,
    enabled: true,
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    authMode: 'oauth',
    ...patch
  } as StreamTargetSettings
}

function account(platform: StreamPlatform): PlatformAccount {
  return {
    id: `${platform}-account`,
    platform,
    accountId: 'orcdev',
    accountLabel: 'OrcDev',
    scopes: [],
    accessTokenPresent: true,
    refreshTokenPresent: true,
    streamKeyPresent: false,
    connectedAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
    status: 'connected'
  }
}

function plan(
  outputs: Array<{ target?: StreamTargetSettings; video: VideoSettings }>
): ProviderStreamOutputPlan {
  return {
    targets: outputs.map(({ target, video }) => ({ target, video })),
    streamVideo: stream1080,
    separateEncodedOutputRole: false
  } as ProviderStreamOutputPlan
}

const readyPreflight = {
  state: 'ready',
  requestKey: 'k',
  result: {
    outputRoles: ['stream'],
    requestedBridgeOutput: 'videotoolbox-h264-mpegts',
    effectiveBridgeOutput: 'videotoolbox-h264-mpegts',
    effectiveEncodeBackend: 'hardware-videotoolbox',
    probeState: 'passed'
  }
} as unknown as StreamOutputTopologyPreflight

function readiness(props: {
  targets: StreamTargetSettings[]
  accounts?: PlatformAccount[]
  preflight?: StreamOutputTopologyPreflight
  providerPlan?: ProviderStreamOutputPlan
  onOpenDestination?: (targetId: string) => void
}) {
  return createElement(ReadyToGoLive, {
    targets: props.targets,
    accountByPlatform: new Map((props.accounts ?? []).map((item) => [item.platform, item])),
    ffmpegReady: true,
    profileCompatible: true,
    providerPlan:
      props.providerPlan ??
      plan(props.targets.map((item) => ({ target: item, video: stream1080 }))),
    recordEnabled: false,
    recordingVideo: stream1080,
    preflight: props.preflight ?? readyPreflight,
    liveOutputActive: false,
    diagnosticStats: {} as DiagnosticStats,
    streamHealth: null,
    streamTargets: [],
    onOpenDestination: props.onOpenDestination ?? vi.fn(),
    onRetry: vi.fn(async () => undefined)
  })
}

describe('Ready to go live', () => {
  it('counts signed-in destinations as ready without a stored key', () => {
    // The old "Destinations ready 1/4" used the stored-key check for every
    // destination, so a signed-in YouTube or Twitch never counted.
    const markup = renderToStaticMarkup(
      readiness({
        targets: [target('youtube', 'YouTube'), target('twitch', 'Twitch')],
        accounts: [account('youtube'), account('twitch')]
      })
    )
    expect(markup).toContain('2 of 2 ready')
    expect(markup).not.toContain('data-slot="destinations-not-ready"')
    expect(markup).not.toContain('Multistream readiness')
  })

  it('names what each destination still needs', () => {
    const markup = renderToStaticMarkup(
      readiness({
        targets: [
          target('youtube', 'YouTube'),
          target('twitch', 'Twitch'),
          target('tiktok', 'TikTok', { authMode: 'manual-rtmp' })
        ],
        accounts: [account('youtube')]
      })
    )
    expect(markup).toContain('1 of 3 ready')
    expect(markup).toContain('Twitch · sign in or add a stream key')
    expect(markup).toContain('TikTok · add a stream key')
  })

  it('keeps the Go Live blocker visible outside Technical details', () => {
    const markup = renderToStaticMarkup(
      readiness({
        targets: [target('youtube', 'YouTube')],
        accounts: [account('youtube')],
        preflight: {
          state: 'failed',
          requestKey: 'k',
          message: 'ffmpeg probe exited 1'
        }
      })
    )
    expect(markup).toContain('Couldn&#x27;t check')
    expect(markup).toContain('Go Live stays off until this passes.')
    expect(markup).toContain('Retry')
    // The raw probe message is one hover away, not inline.
    expect(markup).toContain('title="ffmpeg probe exited 1"')
  })

  it('says the quality once when every destination streams the same thing', () => {
    const markup = renderToStaticMarkup(
      readiness({
        targets: [target('youtube', 'YouTube'), target('twitch', 'Twitch')],
        accounts: [account('youtube'), account('twitch')]
      })
    )
    expect(markup).toContain('1080p · 30 fps · 6 Mbps')
    expect(markup).not.toContain('YouTube 1920×1080')
    expect(markup).not.toContain('FFmpeg')
  })
})

describe('qualitySummary', () => {
  it('labels every destination by its own name when outputs differ', () => {
    const vertical = { ...stream1080, width: 1080, height: 1920 }
    const summary = qualitySummary([
      { target: target('youtube', 'YouTube'), video: stream1080 },
      { target: target('tiktok', 'TikTok'), video: vertical },
      { target: target('instagram', 'Instagram'), video: vertical }
    ])
    expect(summary.text).toBe('Varies by destination')
    expect(summary.title).toContain('TikTok: 1080×1920 · 30 fps · 6 Mbps')
    expect(summary.title).toContain('Instagram: 1080×1920')
    expect(summary.title).not.toContain('Custom')
  })

  it('formats landscape as NNNp and keeps portrait dimensions', () => {
    expect(formatQuality(stream1080)).toBe('1080p · 30 fps · 6 Mbps')
    expect(formatQuality({ ...stream1080, width: 1080, height: 1920, bitrateKbps: 4500 })).toBe(
      '1080×1920 · 30 fps · 4.5 Mbps'
    )
  })
})

describe('encoderLabel', () => {
  it('reads encoder backends in words', () => {
    expect(encoderLabel('hardware-videotoolbox')).toBe('VideoToolbox · hardware')
    expect(encoderLabel('software-x264')).toBe('x264 · software')
    expect(encoderLabel('something-new')).toBe('something-new')
    expect(encoderLabel(undefined)).toBeUndefined()
  })
})

describe('Technical details', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  function details(liveOutputActive = false) {
    return createElement(TechnicalDetails, {
      diagnosticStats: {} as DiagnosticStats,
      liveOutputActive,
      preflight: readyPreflight,
      providerPlan: plan([
        { target: target('youtube', 'YouTube'), video: stream1080 },
        { target: target('tiktok', 'TikTok'), video: stream1080 }
      ]),
      streamHealth: null,
      streamTargets: []
    })
  }

  it('is closed by default and remembers being opened', async () => {
    await act(async () => root.render(details()))
    expect(container.textContent).toContain('Technical details')
    expect(container.textContent).not.toContain('Keyframe interval')

    const trigger = container.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
    await act(async () => trigger.click())
    expect(container.textContent).toContain('Keyframe interval')
    expect(localStorage.getItem(TECHNICAL_DETAILS_STORAGE_KEY)).toBe('open')
  })

  it('shows no dash-filled stats while idle, and one row per destination', async () => {
    localStorage.setItem(TECHNICAL_DETAILS_STORAGE_KEY, 'open')
    await act(async () => root.render(details()))
    const text = container.textContent ?? ''
    expect(text).toContain('Stats appear when you go live.')
    expect(text).not.toContain('Frame rate')
    expect(text).not.toContain('Classified stage')
    expect(text).not.toContain('The backend verified')
    expect(text).toContain('VideoToolbox · hardware')
    expect(text).toContain('TikTok')
    expect(text).not.toContain(' / ')
  })

  it('renders the closed default when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      clear: () => undefined
    })
    await act(async () => root.render(details()))
    expect(container.textContent).not.toContain('Keyframe interval')
  })
})
