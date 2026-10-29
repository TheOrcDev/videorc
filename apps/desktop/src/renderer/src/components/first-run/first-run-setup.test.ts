import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CaptureConfig } from '@/lib/capture'
import type { FirstRunGoal, FirstRunSetupMode, FirstRunStep } from '@/lib/first-run'
import type { SystemAccessRow } from '@/lib/system-access'

// Plan 203 S5: the Welcome screen is the whole window, with the Permissions
// step in one card on the dialog tier. Rendered without a browser, so the
// hooks behind the rows and the meter are stubbed to the values they report.

const studio = vi.hoisted(() => ({
  core: {
    wsStatus: 'connected' as string,
    deviceList: { devices: [{ id: 'mic', kind: 'microphone', status: 'available' }] as unknown[] },
    mediaAccess: { camera: 'granted', microphone: 'granted', screen: 'granted' } as {
      camera: string
      microphone: string
      screen?: string
    },
    runtimeInfo: { platform: 'darwin', hardwareAccelerationDisabled: true } as {
      platform: string
      hardwareAccelerationDisabled: boolean
    },
    refreshBackend: vi.fn(async () => undefined),
    handleSystemPermission: vi.fn(async () => undefined),
    // Sound check (plan 207 S6) reads the same fields as the Studio's Audio section.
    captureConfig: {
      audio: {
        microphoneGainDb: 0,
        microphoneMuted: false,
        systemAudioEnabled: false,
        systemAudioGainDb: -6
      },
      sources: { microphoneId: 'mic', microphoneName: 'MacBook Pro Microphone' },
      streaming: {
        targets: ['youtube', 'twitch', 'kick', 'x'].map((id) => ({
          id,
          platform: id,
          enabled: false,
          authMode: 'manual-rtmp'
        })),
        enabledTargetIds: [] as string[]
      }
    } as unknown as CaptureConfig,
    setCaptureConfig: vi.fn(),
    selectedMicrophone: undefined,
    switchSourceDeviceLive: vi.fn(async () => undefined),
    sourceSwitchReason: () => null,
    isSessionActive: false,
    audioBusActive: false,
    systemAudioConfirmed: null,
    systemAudioJoining: false,
    systemAudioIssue: null,
    // Where you stream (plan 207 S7).
    entitlements: null,
    platformAccounts: [] as unknown[],
    oauthProviderCredentials: [] as unknown[],
    connectPlatformAccount: vi.fn(async () => null),
    patchStreamingTarget: vi.fn(),
    xNativeCapability: null,
    refreshXNativeCapability: vi.fn(async () => undefined),
    authorizeXLive: vi.fn(async () => undefined),
    // Your look (plan 207 S5): the committed scene and the look hold.
    scene: null as unknown,
    firstRunLookHold: null,
    applyFirstRunLook: vi.fn()
  },
  rows: [] as SystemAccessRow[],
  registry: null as unknown
}))

vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => studio.core }))
vi.mock('@/hooks/use-background-assets', () => ({
  useBackgroundAssets: () => ({ registry: studio.registry })
}))
vi.mock('@/hooks/use-system-access-rows', () => ({ useSystemAccessRows: () => studio.rows }))
vi.mock('@/hooks/use-studio-mic-sources', () => ({
  useMicrophoneMeter: () => ({ meter: { kind: 'value', peakDb: -20 } })
}))
vi.mock('@/hooks/use-studio-mic-visual', () => ({
  StudioMicVisualProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/components/studio/mic-level-meter', () => ({
  MicLevelMeter: (props: { 'aria-label': string }) =>
    createElement('div', { 'data-mic-level-meter': '', 'aria-label': props['aria-label'] })
}))

import { createDefaultRegistry } from '@/lib/background-assets'
import { defaultCaptureConfig } from '@/lib/capture'

import { FirstRunSetup } from './first-run-setup'

const row = (
  id: SystemAccessRow['id'],
  state: SystemAccessRow['state'],
  required = id === 'screen-recording' || id === 'microphone'
): SystemAccessRow => ({
  id,
  label: id,
  purpose: `Why ${id}.`,
  state,
  detail: '',
  required
})

const allGranted = (): SystemAccessRow[] => [
  row('screen-recording', 'granted'),
  row('system-audio', 'granted'),
  row('microphone', 'granted'),
  row('camera', 'granted')
]

const render = (
  mode: FirstRunSetupMode = { kind: 'first-run' },
  progress: { initialStep?: FirstRunStep; initialGoal?: FirstRunGoal | null } = {}
): string =>
  renderToStaticMarkup(
    createElement(FirstRunSetup, { mode, onLeave: () => undefined, ...progress })
  )

const SYSTEM_AUDIO = { id: 'system-audio:default', kind: 'system-audio', status: 'available' }

beforeEach(() => {
  studio.core.wsStatus = 'connected'
  studio.core.deviceList = {
    devices: [{ id: 'mic', kind: 'microphone', status: 'available' }, SYSTEM_AUDIO]
  }
  studio.core.mediaAccess = { camera: 'granted', microphone: 'granted', screen: 'granted' }
  studio.core.runtimeInfo = { platform: 'darwin', hardwareAccelerationDisabled: true }
  studio.rows = allGranted()
  studio.core.platformAccounts = []
  studio.core.oauthProviderCredentials = []
  studio.registry = createDefaultRegistry()
  studio.core.captureConfig = {
    ...defaultCaptureConfig,
    ...studio.core.captureConfig,
    layout: defaultCaptureConfig.layout,
    video: defaultCaptureConfig.video
  }
})

describe('FirstRunSetup', () => {
  it('is the whole window: the backdrop, the drag band and the card as the main landmark', () => {
    const markup = render()
    expect(markup).toContain('data-first-run-setup="open"')
    expect(markup).toContain('data-first-run-mode="first-run"')
    expect(markup).toContain('data-first-run-backdrop=')
    expect(markup).toMatch(/data-slot="first-run-title-band"/)
    expect(markup).toMatch(
      /\[-webkit-app-region:drag\][^>]*(pl-3|pl-\[88px\])|(pl-3|pl-\[88px\])[^>]*\[-webkit-app-region:drag\]/
    )
    expect(markup).toMatch(/<main[^>]*aria-labelledby="first-run-title"/)
    expect(markup).toMatch(/<h1[^>]*id="first-run-title"[^>]*>Welcome to Videorc<\/h1>/)
    expect(markup).toMatch(/<main[^>]*class="[^"]*glass-float-dialog[^"]*"/)
    expect(markup).toMatch(/<main[^>]*class="[^"]*rounded-panel[^"]*"/)
    expect(markup).toMatch(/<main[^>]*class="[^"]*sm:max-w-xl[^"]*"/)
    expect(markup).toMatch(/<img[^>]+alt=""[^>]+videorc-logo/)
    expect(markup).toContain('Recordings stay on this Mac. Cloud AI only runs after you opt in.')
  })

  it('is not a dialog: no scrim, no close, and Escape does nothing', () => {
    expect(render()).not.toContain('role="dialog"')
    for (const file of ['./first-run-setup.tsx', './permissions-step.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).not.toMatch(/onKeyDown|onEscapeKeyDown|<Dialog[ >]|DialogContent/)
    }
  })

  it("describes the step in the OS's words", () => {
    expect(render()).toContain('First, let Videorc record your Mac.')
    studio.core.runtimeInfo = { platform: 'win32', hardwareAccelerationDisabled: true }
    const windows = render()
    expect(windows).toContain(
      'First, check that Windows lets Videorc use your camera and microphone.'
    )
    expect(windows).toContain('Recordings stay on this PC.')
  })

  it('shows Skeleton rows, never guesses, until the OS has answered and the devices are listed', () => {
    studio.rows = [row('screen-recording', 'first-use'), row('microphone', 'first-use')]
    studio.core.wsStatus = 'connecting'
    studio.core.deviceList = { devices: [] }
    const markup = render()
    expect(markup).toContain('data-first-run-rows="loading"')
    expect(markup).toContain('data-slot="skeleton"')
    expect(markup).toContain('Checking permissions…')
    expect(markup).not.toContain('data-slot="system-access-row"')
    expect(markup).not.toContain('Not asked yet')
    // The 5 s fallback is the pure rule the step reads.
    const source = readFileSync(new URL('./permissions-step.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useWaitedLong(FIRST_RUN_ROWS_FALLBACK_MS)')
  })

  it('renders the rows in the setup variant: tags, and the meter only under a granted microphone', () => {
    const granted = render()
    expect(granted.match(/data-slot="system-access-row"/g)).toHaveLength(4)
    expect(granted).toContain('Needed to record')
    expect(granted).toContain('Optional')
    expect(granted).toContain('data-mic-level-meter=""')
    expect(granted).toContain('Say something. The bar moves when Videorc hears you.')

    studio.rows = [
      row('screen-recording', 'granted'),
      row('system-audio', 'granted'),
      row('microphone', 'first-use'),
      row('camera', 'granted')
    ]
    const asking = render()
    expect(asking).not.toContain('data-mic-level-meter=""')
    expect(asking).not.toContain('Say something.')
  })

  it('reads Continue with the arrow once every needed grant is in, Skip for now as an outline before', () => {
    const done = render()
    expect(done).toMatch(
      /<button[^>]*class="[^"]*chrome-fill[^"]*"[^>]*data-first-run-primary=""[^>]*>Continue</
    )
    expect(done).toMatch(/Continue<svg[^>]*data-icon="inline-end"/)
    studio.rows = [
      row('screen-recording', 'first-use'),
      row('system-audio', 'first-use'),
      row('microphone', 'granted'),
      row('camera', 'first-use')
    ]
    const skip = render()
    expect(skip).toMatch(
      /<button[^>]*class="[^"]*border-border[^"]*"[^>]*data-first-run-primary=""[^>]*>Skip for now</
    )
    expect(skip).not.toContain('data-icon="inline-end"')
  })

  it.each(['first-run', 'replay'] as const)(
    'starts Linux %s with sharing guidance, without claiming grants',
    (kind) => {
      studio.core.runtimeInfo = { platform: 'linux', hardwareAccelerationDisabled: true }
      studio.core.wsStatus = 'disconnected'
      studio.core.mediaAccess = { camera: 'unknown', microphone: 'unknown', screen: 'unknown' }
      studio.rows = []
      const markup = render(kind === 'replay' ? { kind, returnTo: 'settings' } : { kind })
      expect(markup).toContain(`data-first-run-mode="${kind}"`)
      expect(markup).toContain('data-first-run-step="permissions"')
      expect(markup).toContain('Screen sharing on Linux')
      expect(markup).toContain('your desktop asks what to share')
      expect(markup).toContain(
        'Camera and microphone access depends on your desktop and device permissions.'
      )
      expect(markup).toMatch(/data-first-run-primary=""[^>]*>Continue</)
      expect(markup).not.toContain('data-slot="system-access-row"')
      expect(markup).not.toContain('Checking permissions')
      expect(markup).not.toContain('Nothing to grant')
      expect(markup).not.toContain('Allow…')
      expect(markup).not.toContain('data-first-run-back=""')
    }
  )

  it('frames each step: the count and Skip setup on top, no Back on the first step (plan 207 D3)', () => {
    const markup = render()
    expect(markup).toMatch(/data-first-run-step-position="1\/\d"/)
    expect(markup).toMatch(/>Step 1 of \d</)
    expect(markup).toMatch(/<button[^>]*data-first-run-skip=""[^>]*>Skip setup</)
    expect(markup).not.toContain('data-first-run-back=""')
  })

  it('resumes at the goal step: three choices, Back, nothing picked and no primary (plan 207 D4)', () => {
    const markup = render({ kind: 'first-run' }, { initialStep: 'goal' })
    expect(markup).toContain('data-first-run-step="goal"')
    expect(markup).toMatch(/data-first-run-step-position="2\/\d"/)
    expect(markup).toMatch(/<h1[^>]*id="first-run-title"[^>]*>What are you making\?<\/h1>/)
    expect(markup.match(/data-first-run-goal="/g)).toHaveLength(3)
    for (const title of ['Recordings', 'Livestreams', 'Both']) expect(markup).toContain(title)
    expect(markup).toContain('Tutorials, demos and videos, saved on this Mac.')
    expect(markup).toMatch(/<button[^>]*data-first-run-back=""[^>]*>.*Back</)
    expect(markup).not.toContain('data-first-run-primary')
    expect(markup).not.toContain('data-selected')
  })

  it('marks the saved goal when coming back to it', () => {
    const markup = render(
      { kind: 'replay', returnTo: 'settings' },
      {
        initialStep: 'goal',
        initialGoal: 'stream'
      }
    )
    expect(markup).toMatch(/data-first-run-goal="stream"[^>]*data-selected="true"/)
    expect(markup).toContain('Chosen')
  })

  it('Sound check: the microphone, its level and Gain, the verdict line and Set level for me (plan 207 S6)', () => {
    const markup = render({ kind: 'first-run' }, { initialStep: 'sound', initialGoal: 'both' })
    expect(markup).toContain('data-first-run-step="sound"')
    expect(markup).toMatch(/<h1[^>]*id="first-run-title"[^>]*>Sound check<\/h1>/)
    expect(markup).toContain('data-first-run-sound-row="microphone"')
    expect(markup).toContain('data-mic-level-meter=""')
    expect(markup).toContain('aria-label="Microphone gain"')
    expect(markup).toContain('data-first-run-sound-verdict="none"')
    expect(markup).toContain('Say something. The bar moves when Videorc hears you.')
    // No verdict yet: the level button waits, and says why.
    expect(markup).toMatch(/<button[^>]*data-first-run-sound-level=""[^>]*disabled=""/)
    expect(markup).toContain('Talk for a few seconds first.')
    expect(markup).toContain('data-first-run-primary=""')
  })

  it('Sound check: System audio is a switch, Off by default, with its line', () => {
    const markup = render({ kind: 'first-run' }, { initialStep: 'sound', initialGoal: 'both' })
    expect(markup).toContain('data-first-run-sound-row="system-audio"')
    expect(markup).toMatch(
      /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/
    )
    expect(markup).toContain(
      'The sound your Mac plays: games, music and calls. Its level shows once you record or go live.'
    )
  })

  it('Sound check: System audio waits for Screen Recording on macOS, and says so', () => {
    studio.core.deviceList = {
      devices: [
        { id: 'mic', kind: 'microphone', status: 'available' },
        { ...SYSTEM_AUDIO, status: 'permission-required' }
      ]
    }
    const markup = render({ kind: 'first-run' }, { initialStep: 'sound', initialGoal: 'both' })
    expect(markup).toContain('Comes with Screen Recording. Go back to permissions to allow it.')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/)
  })

  it('Sound check: a microphone Videorc may not use sends you back to permissions', () => {
    studio.core.mediaAccess = { camera: 'granted', microphone: 'denied', screen: 'granted' }
    const markup = render({ kind: 'first-run' }, { initialStep: 'sound', initialGoal: 'both' })
    expect(markup).toContain('data-first-run-sound-blocked=""')
    expect(markup).toMatch(/Videorc can(&#x27;|')t hear your microphone yet\./)
    expect(markup).toContain('Back to permissions')
    expect(markup).not.toContain('data-mic-level-meter=""')
  })

  it('Where you stream: four sign-in rows, the stream-key way out, and Open Studio last (plan 207 S7)', () => {
    const markup = render(
      { kind: 'first-run' },
      { initialStep: 'destinations', initialGoal: 'stream' }
    )
    expect(markup).toContain('data-first-run-step="destinations"')
    expect(markup).toMatch(/<h1[^>]*id="first-run-title"[^>]*>Where you stream<\/h1>/)
    for (const platform of ['youtube', 'twitch', 'kick', 'x']) {
      expect(markup).toContain(`data-first-run-destination="${platform}"`)
    }
    expect(markup.match(/>Sign in…</g)).toHaveLength(4)
    expect(markup).toContain('Using a stream key, TikTok or Instagram? Set it up in Livestream.')
    expect(markup).toContain('>Open Livestream<')
    expect(markup).toMatch(/data-first-run-primary=""[^>]*>Open Studio</)
  })

  it('Where you stream: a connected account shows its name and no button; replay ends on Done', () => {
    studio.core.platformAccounts = [
      {
        platform: 'twitch',
        status: 'connected',
        accountId: 't1',
        accountLabel: 'orcdev',
        updatedAt: 'x',
        scopes: []
      }
    ]
    const markup = render(
      { kind: 'replay', returnTo: 'settings' },
      { initialStep: 'destinations', initialGoal: 'both' }
    )
    expect(markup).toMatch(/data-first-run-destination="twitch"[^>]*data-state="connected"/)
    expect(markup).toContain('orcdev')
    expect(markup.match(/>Sign in…</g)).toHaveLength(3)
    expect(markup).toMatch(/data-first-run-primary=""[^>]*>Done</)
  })

  it('Where you stream: a build without sign-in says so and offers no button', () => {
    studio.core.oauthProviderCredentials = [{ platform: 'kick', ready: false, message: 'missing' }]
    const markup = render(
      { kind: 'first-run' },
      { initialStep: 'destinations', initialGoal: 'stream' }
    )
    expect(markup).toMatch(/Signing in to Kick isn(&#x27;|')t available in this build\./)
    expect(markup.match(/>Sign in…</g)).toHaveLength(3)
  })

  it('skips Where you stream for Recordings: Sound check is the last step', () => {
    const markup = render({ kind: 'first-run' }, { initialStep: 'sound', initialGoal: 'record' })
    expect(markup).toMatch(/data-first-run-primary=""[^>]*>Open Studio</)
  })

  it('Your look: the picture, orientation, layouts, shape and backgrounds at the xl width (plan 207 S5)', () => {
    studio.core.deviceList = {
      devices: [
        { id: 'mic', kind: 'microphone', status: 'available' },
        { id: 'cam', kind: 'camera', status: 'available' },
        { id: 'display', kind: 'screen', status: 'available' },
        SYSTEM_AUDIO
      ]
    }
    studio.core.captureConfig = {
      ...studio.core.captureConfig,
      sources: { ...studio.core.captureConfig.sources, cameraId: 'cam', screenId: 'display' }
    }
    const markup = render({ kind: 'first-run' }, { initialStep: 'look', initialGoal: 'record' })
    expect(markup).toContain('data-first-run-step="look"')
    expect(markup).toMatch(/<main[^>]*class="[^"]*sm:max-w-3xl[^"]*"/)
    expect(markup).toMatch(/<h1[^>]*id="first-run-title"[^>]*>Your look<\/h1>/)
    expect(markup).toContain('data-first-run-look-picture="none"')
    expect(markup).toContain('data-first-run-look-layout="screen-camera"')
    expect(markup).toContain('data-first-run-look-orientation="horizontal"')
    expect(markup.match(/data-first-run-look-option="/g)).toHaveLength(4)
    expect(markup).toContain('aria-label="Camera shape"')
    expect(markup).toContain('Vertical is for Shorts, Reels and TikTok.')
    expect(markup.match(/data-first-run-look-background-option="/g)).toHaveLength(11)
    expect(markup).toContain('Liquid Chrome')
    expect(markup).toMatch(/data-first-run-primary=""[^>]*>Continue</)
  })

  it('Your look: a layout without its screen says why, and the shape hides where it never draws', () => {
    studio.core.mediaAccess = { camera: 'granted', microphone: 'granted', screen: 'denied' }
    studio.core.deviceList = {
      devices: [
        { id: 'mic', kind: 'microphone', status: 'available' },
        { id: 'cam', kind: 'camera', status: 'available' }
      ]
    }
    studio.core.captureConfig = {
      ...studio.core.captureConfig,
      layout: { ...studio.core.captureConfig.layout, layoutPreset: 'camera-only' },
      sources: { ...studio.core.captureConfig.sources, cameraId: 'cam' }
    }
    const markup = render({ kind: 'first-run' }, { initialStep: 'look', initialGoal: 'record' })
    expect(markup).toContain('Allow Screen Recording first.')
    expect(markup).toMatch(/data-first-run-look-option="screen-only"[\s\S]*?disabled=""/)
    expect(markup).not.toContain('aria-label="Camera shape"')
  })
})
