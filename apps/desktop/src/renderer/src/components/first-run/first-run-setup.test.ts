import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    handleSystemPermission: vi.fn(async () => undefined)
  },
  rows: [] as SystemAccessRow[]
}))

vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => studio.core }))
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

beforeEach(() => {
  studio.core.wsStatus = 'connected'
  studio.core.deviceList = { devices: [{ id: 'mic', kind: 'microphone', status: 'available' }] }
  studio.core.mediaAccess = { camera: 'granted', microphone: 'granted', screen: 'granted' }
  studio.core.runtimeInfo = { platform: 'darwin', hardwareAccelerationDisabled: true }
  studio.rows = allGranted()
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
      /<button[^>]*class="[^"]*bg-primary[^"]*"[^>]*data-first-run-primary=""[^>]*>Continue</
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

  it('starts the Linux replay at the goal: Linux has nothing to grant', () => {
    studio.core.runtimeInfo = { platform: 'linux', hardwareAccelerationDisabled: true }
    studio.rows = []
    const markup = render({ kind: 'replay', returnTo: 'settings' })
    expect(markup).toContain('data-first-run-mode="replay"')
    expect(markup).toContain('data-first-run-step="goal"')
    expect(markup).toMatch(/<h1[^>]*>What are you making\?<\/h1>/)
    expect(markup).not.toContain('data-slot="system-access-row"')
    expect(markup).not.toContain('data-first-run-back=""')
  })

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
})
