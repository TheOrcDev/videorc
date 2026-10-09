// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanCutClient } from '@/hooks/use-clean-cut'
import type { CleanCutJob, SessionSummary } from '@/lib/backend'
import { CLEAN_CUT_AUTO_STORAGE_KEY } from '@/lib/clean-cut-auto'
import {
  CLEAN_CUT_DESCRIPTION,
  CLEAN_CUT_NO_RECORDINGS,
  CONDENSED_TOO_SHORT,
  type CleanCutCapabilities
} from '@/lib/clean-cut-view'
import { DEFAULT_BASIC_ENTITLEMENTS } from '@/lib/entitlements'
import { CLOUD_AI_USES } from '@/lib/golem-tab-view'

import { CleanCutCard, type CleanCutFocus } from './clean-cut-card'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  recording: { recording: { state: 'idle' } } as Record<string, unknown>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioRecordingState: () => mocked.recording
}))
const signIn = vi.fn()
vi.mock('@/hooks/use-account', () => ({ useVideorcAccount: () => ({ signIn }) }))

const MIN = 60_000
const PREMIUM = {
  ...DEFAULT_BASIC_ENTITLEMENTS,
  tier: 'premium' as const,
  capabilities: DEFAULT_BASIC_ENTITLEMENTS.capabilities.map((capability) => ({
    ...capability,
    state: 'enabled' as const,
    reason: undefined
  }))
}

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'rec-1',
    title: 'Building a Rust CLI',
    startedAt: '2026-10-03T14:02:00Z',
    durationMs: 42 * MIN + 10_000,
    status: 'completed',
    mode: 'record',
    mp4Path: '/videos/rust-cli.mp4',
    finalizationState: 'finalized',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const SESSIONS = [
  session({}),
  session({
    id: 'rec-2',
    title: 'Friday stream',
    mode: 'record+stream',
    startedAt: '2026-10-02T18:00:00Z',
    durationMs: 123 * MIN
  }),
  session({
    id: 'rec-short',
    title: 'Short one',
    startedAt: '2026-10-01T10:00:00Z',
    durationMs: 5 * MIN
  })
]

const SUMMARY = {
  durationMs: 42 * MIN + 10_000,
  keptMs: 31 * MIN + 5_000,
  removalCount: 63,
  byKind: []
}

function job(overrides: Partial<CleanCutJob> = {}): CleanCutJob {
  return {
    id: 'job-1',
    sourceSessionId: 'rec-1',
    mode: 'clean',
    state: 'completed',
    progress: 1,
    edlRevision: 0,
    edlSummary: SUMMARY,
    outputSessionId: 'out-1',
    createdAt: '2026-10-03T15:00:00Z',
    updatedAt: '2026-10-03T15:10:00Z',
    ...overrides
  }
}

const AVAILABLE: CleanCutCapabilities = {
  supported: true,
  available: true,
  reasonCode: null,
  monthlySecondsLimit: 72_000,
  remainingSeconds: 64_000
}

let root: Root
let container: HTMLDivElement
const onReview = vi.fn()
const onOpenLibrarySession = vi.fn()
const setAiConsent = vi.fn()
const revealSession = vi.fn(async (_sessionId: string) => undefined)

function client(overrides: Partial<CleanCutClient> = {}): CleanCutClient {
  return {
    connected: true,
    jobs: [],
    jobsLoaded: true,
    capabilities: AVAILABLE,
    start: vi.fn(async () => job({ state: 'queued' })),
    cancel: vi.fn(async () => job({ state: 'cancelled' })),
    render: vi.fn(async () => job({ state: 'queued', step: 'render' })),
    get: vi.fn(),
    updateEdl: vi.fn(),
    transcript: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    ...overrides
  }
}

let current: CleanCutClient

async function render({
  cut = client(),
  consented = true,
  signedIn = true,
  entitlements = PREMIUM as unknown,
  sessions = SESSIONS,
  live = false,
  focus = null as CleanCutFocus | null
} = {}): Promise<void> {
  current = cut
  mocked.core = {
    sessions,
    account: signedIn ? { status: 'signed-in' } : { status: 'signed-out' },
    entitlements,
    aiConsent: consented,
    setAiConsent
  }
  mocked.recording = {
    recording: live ? { state: 'recording', streamUrl: 'rtmp://live' } : { state: 'idle' }
  }
  await act(async () =>
    root.render(createElement(CleanCutCard, { client: cut, focus, onReview, onOpenLibrarySession }))
  )
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(match, label).toBeTruthy()
  return match as HTMLButtonElement
}

function statusRow(): HTMLElement {
  return document.querySelector('[data-testid="clean-cut-status"]') as HTMLElement
}

function autoSwitch(): HTMLButtonElement {
  return document.getElementById('clean-cut-auto-switch') as HTMLButtonElement
}

async function chooseTab(label: string): Promise<void> {
  const tab = [...document.querySelectorAll('[role="tab"]')].find(
    (candidate) => candidate.textContent === label
  ) as HTMLElement
  expect(tab, label).toBeTruthy()
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const spy of [onReview, onOpenLibrarySession, setAiConsent, revealSession, signIn]) {
    spy.mockClear()
  }
  localStorage.clear()
  Object.assign(window, { videorc: { revealSession } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Clean cut card (plan 119 S14)', () => {
  it('sells Clean cut, with the minutes left this month and the switch off', async () => {
    await render()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Clean cut')
    expect(text).toContain(CLEAN_CUT_DESCRIPTION)
    expect(text).toContain('Make a clean cut of every recording')
    expect(document.querySelector('[data-testid="clean-cut-minutes"]')?.textContent).toBe(
      '1,066 min left this month'
    )
    expect(autoSwitch().getAttribute('data-state')).toBe('unchecked')
    expect(
      document.querySelector('[data-slot="clean-cut-auto-status"]')?.getAttribute('data-status')
    ).toBe('off')
  })

  it('turns "every recording" on and off, remembering it in this window', async () => {
    await render()
    await act(async () => autoSwitch().click())
    expect(localStorage.getItem(CLEAN_CUT_AUTO_STORAGE_KEY)).toBe('1')
    expect(autoSwitch().getAttribute('data-state')).toBe('checked')
    expect(document.querySelector('[data-slot="clean-cut-auto-status"]')?.textContent).toContain(
      'On, cuts every recording when you stop'
    )
    await act(async () => autoSwitch().click())
    expect(localStorage.getItem(CLEAN_CUT_AUTO_STORAGE_KEY)).toBe('0')
  })

  it('asks for Cloud AI consent first, naming the audio upload, and changes nothing on Not now', async () => {
    await render({ consented: false })
    await act(async () => autoSwitch().click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Turn on Clean cut?')
    expect(dialog?.textContent).toContain(
      "Clean cut uploads your recording's audio, never the video"
    )
    for (const use of CLOUD_AI_USES) expect(dialog?.textContent).toContain(use)
    await act(async () => button('Not now').click())
    expect(setAiConsent).not.toHaveBeenCalled()
    expect(localStorage.getItem(CLEAN_CUT_AUTO_STORAGE_KEY)).toBeNull()

    await act(async () => autoSwitch().click())
    await act(async () => button('Allow and turn on').click())
    expect(setAiConsent).toHaveBeenCalledWith(true)
    expect(localStorage.getItem(CLEAN_CUT_AUTO_STORAGE_KEY)).toBe('1')
  })

  it('asks a signed-out streamer to sign in and offers nothing to start', async () => {
    await render({ signedIn: false, entitlements: null, cut: client({ capabilities: null }) })
    expect(document.querySelector('[data-testid="clean-cut-unlock"]')?.textContent).toContain(
      'Sign in to use Clean cut, part of Videorc Premium.'
    )
    expect(autoSwitch().disabled).toBe(true)
    expect(button('Make a clean cut').disabled).toBe(true)
    await act(async () => button('Sign in').click())
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('says why the server cannot cut, and still lets a finished cut be reviewed', async () => {
    await render({
      cut: client({
        jobs: [job()],
        capabilities: {
          ...AVAILABLE,
          available: false,
          reasonCode: 'quota-exhausted',
          remainingSeconds: 0
        }
      })
    })
    expect(document.querySelector('[data-testid="clean-cut-unlock"]')?.textContent).toContain(
      "This month's Clean cut minutes are used up."
    )
    expect(document.querySelector('[data-testid="clean-cut-minutes"]')?.textContent).toBe(
      'No minutes left this month'
    )
    expect(button('Review').disabled).toBe(false)
  })

  it('makes a clean cut of the newest recording', async () => {
    await render()
    expect(statusRow().getAttribute('data-status')).toBe('none')
    expect(statusRow().textContent).toContain('Not cut yet')
    await act(async () => button('Make a clean cut').click())
    expect(current.start).toHaveBeenCalledWith({
      sessionId: 'rec-1',
      mode: 'clean',
      consentToUploadAudio: true
    })
  })

  it('asks for consent before the first cut, then makes it', async () => {
    await render({ consented: false })
    await act(async () => button('Make a clean cut').click())
    expect(current.start).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Make a clean cut?')
    await act(async () => button('Allow and make it').click())
    expect(setAiConsent).toHaveBeenCalledWith(true)
    expect(current.start).toHaveBeenCalledWith({
      sessionId: 'rec-1',
      mode: 'clean',
      consentToUploadAudio: true
    })
  })

  it('shows the work in progress, and cancels it', async () => {
    await render({
      cut: client({ jobs: [job({ state: 'transcribing', progress: 0.4, edlSummary: undefined })] })
    })
    expect(statusRow().textContent).toContain('Transcribing 40%')
    await act(async () => button('Cancel').click())
    expect(current.cancel).toHaveBeenCalledWith('job-1')
  })

  it('waits for the stream to end', async () => {
    await render({
      live: true,
      cut: client({ jobs: [job({ state: 'queued', progress: 0, edlSummary: undefined })] })
    })
    expect(statusRow().textContent).toContain('Waiting until you stop streaming')
  })

  it('opens a finished cut: review, the file, and its Library row', async () => {
    await render({ cut: client({ jobs: [job()] }) })
    expect(statusRow().getAttribute('data-status')).toBe('ready')
    expect(statusRow().textContent).toContain('Ready')
    expect(statusRow().textContent).toContain('42:10 → 31:05 · 11:05 shorter')
    await act(async () => button('Review').click())
    expect(onReview).toHaveBeenCalledWith({ sessionId: 'rec-1', mode: 'clean', jobId: 'job-1' })
    const reveal = [...document.querySelectorAll('button')].find((candidate) =>
      /^Show in/.test(candidate.textContent?.trim() ?? '')
    ) as HTMLButtonElement
    await act(async () => reveal.click())
    expect(revealSession).toHaveBeenCalledWith('out-1')
    await act(async () => button('Open in Library').click())
    expect(onOpenLibrarySession).toHaveBeenCalledWith('out-1')
  })

  it('retries a failed render by cutting again, and an earlier failure by starting over', async () => {
    await render({
      cut: client({
        jobs: [job({ state: 'failed', errorCode: 'render-invalid', errorMessage: 'Bad output.' })]
      })
    })
    expect(statusRow().getAttribute('data-status')).toBe('failed')
    expect(statusRow().textContent).toContain(
      "The cut didn't pass its checks, so it wasn't saved. Retry to cut again."
    )
    await act(async () => button('Retry').click())
    expect(current.render).toHaveBeenCalledWith('job-1')

    await render({
      cut: client({
        jobs: [
          job({
            state: 'failed',
            edlSummary: undefined,
            errorCode: 'network',
            errorMessage: 'offline'
          })
        ]
      })
    })
    await act(async () => button('Retry').click())
    expect(current.start).toHaveBeenCalledWith({
      sessionId: 'rec-1',
      mode: 'clean',
      consentToUploadAudio: true
    })
  })

  it('makes a Condensed cut at the chosen length (S19)', async () => {
    await render({ focus: { sessionId: 'rec-2', nonce: 1 } })
    expect(document.querySelector('[aria-label="Recording"]')?.textContent).toContain(
      'Friday stream'
    )
    await chooseTab('Condensed')
    const lengths = [...document.querySelectorAll('[data-slot="clean-cut-target"] button')].map(
      (item) => item.textContent
    )
    expect(lengths).toEqual(['10 min', '15 min', '20 min', '30 min'])
    expect(
      document.querySelector('[data-slot="clean-cut-target"] [data-state="on"]')?.textContent
    ).toBe('15 min')
    await act(async () => button('20 min').click())
    await act(async () => button('Make a condensed cut').click())
    expect(current.start).toHaveBeenCalledWith({
      sessionId: 'rec-2',
      mode: 'condensed',
      consentToUploadAudio: true,
      targetDurationSeconds: 1_200
    })
  })

  it('scrolls to the card once per ask, not on every update', async () => {
    const scrolled = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrolled
    })
    await render({ focus: { sessionId: 'rec-2', nonce: 1 } })
    await render({ focus: { sessionId: 'rec-2', nonce: 1 }, cut: client({ jobs: [job()] }) })
    expect(scrolled).toHaveBeenCalledTimes(1)
    await render({ focus: { sessionId: 'rec-1', nonce: 2 } })
    expect(scrolled).toHaveBeenCalledTimes(2)
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })

  it('keeps Condensed for recordings of 25 minutes or more', async () => {
    await render({ focus: { sessionId: 'rec-short', nonce: 1 } })
    await chooseTab('Condensed')
    expect(statusRow().getAttribute('data-status')).toBe('unavailable')
    expect(statusRow().textContent).toContain(CONDENSED_TOO_SHORT)
    expect(document.querySelector('[data-slot="clean-cut-target"]')).toBeNull()
  })

  it('says where cuts appear when there is no recording yet', async () => {
    await render({ sessions: [session({ id: 'stream', mode: 'stream', mp4Path: undefined })] })
    expect(document.querySelector('[data-slot="clean-cut-empty"]')?.textContent).toBe(
      CLEAN_CUT_NO_RECORDINGS
    )
  })
})

describe('Clean cut tab layout (plan 150 S7)', () => {
  it('sets the settings beside the recordings, in two titled columns', async () => {
    await render()
    const titles = [...document.querySelectorAll('[data-slot="panel-section"] h3')].map(
      (heading) => heading.textContent
    )
    expect(titles).toEqual(['Clean cut', 'Recordings'])
    const [settings, recordings] = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="panel-section"]')
    ]
    expect(settings.querySelector('#clean-cut-auto-switch')).toBeTruthy()
    expect(recordings.querySelector('[data-slot="clean-cut"]')).toBeTruthy()
  })

  it('locks the switch and the cut, never a live-looking control, while Videorc cannot cut', async () => {
    await render({
      cut: client({
        capabilities: { ...AVAILABLE, available: false, reasonCode: 'provider-unconfigured' }
      })
    })
    expect(document.querySelector('[data-testid="clean-cut-unlock"]')?.textContent).toContain(
      "Clean cut isn't set up on Videorc's side yet."
    )
    expect(autoSwitch().disabled).toBe(true)
    expect(button('Make a clean cut').disabled).toBe(true)
  })
})
