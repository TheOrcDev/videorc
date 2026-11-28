// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { StreamOutputTopologyPreflight } from '@/hooks/use-studio'
import type {
  DiagnosticStats,
  PlatformAccount,
  StreamPlatform,
  StreamTargetSettings,
  VideoSettings
} from '@/lib/backend'
import { defaultCaptureConfig, videoPresets, type ProviderStreamOutputPlan } from '@/lib/capture'
import { NO_RECENT_DROPS } from '@/lib/stream-health-attribution'

import { goLiveProviderPlan, qualitySummary, ReadyToGoLive } from './go-live-panel'

// Plan 080 S7: the right column is a plain-words checklist. The encoder paths
// and frame counters live in Health only (owner, 2026-11-20).

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
    recentStreamDrops: NO_RECENT_DROPS,
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
    // Each one is a button that opens its destination, not a text link
    // (owner, 11-27).
    expect(markup).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>Twitch · sign in or add a stream key</
    )
    expect(markup).not.toContain('data-variant="link"')
    expect(markup).toMatch(
      /<button[^>]*class="[^"]*text-foreground[^"]*"[^>]*>TikTok · add a stream key</
    )
  })

  it('keeps the Go Live blocker visible in the checklist', () => {
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
    expect(markup).toContain('Go Live checks again when you start.')
    expect(markup).toContain('Retry')
    // The raw probe message is one hover or focus away, not inline, and never
    // a native title (plan 174 S1.10).
    expect(markup).toMatch(/data-slot="info-tooltip-text"[^>]*>ffmpeg probe exited 1</)
    expect(markup).not.toContain('title=')
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
    expect(summary.lines).toContain('TikTok: 1080 × 1920 · 30 fps · 6 Mbps')
    expect(summary.lines?.some((line) => line.startsWith('Instagram: 1080 × 1920'))).toBe(true)
    expect(summary.lines?.join('\n')).not.toContain('Custom')
  })
})

describe('Ready to go live: captions (plan 174 S3.4, D-9)', () => {
  const youtube = [target('youtube', 'YouTube')]

  it('has no Captions row while captions are off', () => {
    expect(renderToStaticMarkup(readiness({ targets: youtube }))).not.toContain('>Captions<')
  })

  it('says the caption rule before Go Live, in short words and a sentence', () => {
    const markup = renderToStaticMarkup(
      createElement(ReadyToGoLive, {
        ...(readiness({ targets: youtube }).props as Parameters<typeof ReadyToGoLive>[0]),
        captions: {
          blocker: {
            rule: 'frame-rate',
            description: 'Captions on a livestream work up to 30 fps.'
          }
        }
      })
    )
    expect(markup).toContain('>Captions<')
    expect(markup).toContain('Need 30 fps or less')
    expect(markup).toContain('data-slot="captions-not-ready"')
    expect(markup).toContain('Captions on a livestream work up to 30 fps.')
  })

  it('reads On when the output fits', () => {
    const markup = renderToStaticMarkup(
      createElement(ReadyToGoLive, {
        ...(readiness({ targets: youtube }).props as Parameters<typeof ReadyToGoLive>[0]),
        captions: { blocker: null }
      })
    )
    expect(markup).toContain('>Captions<')
    expect(markup).not.toContain('captions-not-ready')
  })
})

describe('goLiveProviderPlan (plan 0016)', () => {
  it('describes the stream Go Live will send, even when the saved mode is Record', () => {
    const streaming = {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      defaultOutputPreset: stream1080.preset,
      defaultBitrateKbps: stream1080.bitrateKbps,
      targets: [target('custom', 'Custom RTMP')],
      enabledTargetIds: ['custom-rtmp']
    }
    const recording = videoPresets['tutorial-720p30']
    const config = { ...defaultCaptureConfig, recordEnabled: true, streamEnabled: false, streaming }
    // A host that runs a separate stream encode: the stream keeps its own profile.
    expect(goLiveProviderPlan(config, recording, true).streamVideo).toMatchObject({
      width: 1920,
      height: 1080,
      bitrateKbps: 6000
    })
    // One shared encode: the panel is handed the shared-fallback profile (the
    // recording follows the stream) and shows exactly that.
    expect(goLiveProviderPlan(config, stream1080, false).streamVideo).toMatchObject({
      width: 1920,
      bitrateKbps: 6000
    })
  })
})
