// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostSettings, CohostState } from '@/lib/backend'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES, ORCLE_LIVE_POWERS } from '@/lib/orcle-tab-view'

import { OrcleTab } from './orcle-tab'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  chat: { cohostState: null } as Record<string, unknown>,
  recording: { recording: { state: 'idle' } } as Record<string, unknown>,
  shell: {} as Record<string, unknown>,
  account: {} as Record<string, unknown>,
  reportAsks: [] as Array<string | null>
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioChat: () => mocked.chat,
  useStudioRecordingState: () => mocked.recording,
  useStudioShell: () => mocked.shell
}))
vi.mock('@/hooks/use-account', () => ({ useVideorcAccount: () => mocked.account }))
vi.mock('@/hooks/use-orcle-report', () => ({
  useOrcleReport: (sessionId: string | null) => {
    mocked.reportAsks.push(sessionId)
    return { payload: null, loading: false, error: null, reload: () => undefined }
  }
}))
vi.mock('@/hooks/use-clean-cut', () => ({
  useCleanCut: () => ({
    connected: true,
    jobs: [],
    jobsLoaded: true,
    capabilities: null,
    start: async () => undefined,
    cancel: async () => undefined,
    render: async () => undefined,
    get: async () => ({ sessionId: '', jobs: [] }),
    updateEdl: async () => undefined,
    transcript: async () => undefined,
    subscribe: () => () => undefined
  })
}))
vi.mock('@/components/clean-cut/clean-cut-review', async () => {
  const { createElement } = await import('react')
  return {
    CleanCutReview: ({
      target,
      onClose
    }: {
      target: { sessionId: string; mode: string; jobId: string | null }
      onClose: () => void
    }) =>
      createElement(
        'div',
        { 'data-slot': 'review-stub', 'data-target': JSON.stringify(target) },
        createElement('button', { type: 'button', onClick: onClose }, 'Close review')
      )
  }
})

let root: Root
let container: HTMLDivElement
const calls = {
  setOrcleLive: vi.fn(async (_on: boolean) => undefined),
  answerOrcleConsent: vi.fn(async (_accepted: boolean) => undefined),
  setAiConsent: vi.fn((_consent: boolean) => undefined),
  patchCohostSettings: vi.fn(async () => undefined),
  openCommentsWindow: vi.fn(async () => undefined),
  signIn: vi.fn(),
  openOAuthUrl: vi.fn(async (_url: string) => undefined)
}

const premium = { allowed: true }
const basic = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Orcle requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}

function settings(overrides: Partial<CohostSettings> = {}): CohostSettings {
  return {
    enabled: false,
    tone: 'friendly',
    notes: '',
    autoHighlight: false,
    voiceHighlight: false,
    rules: [],
    listen: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const spy of Object.values(calls)) spy.mockClear()
  mocked.reportAsks = []
  Object.assign(window, { videorc: { openOAuthUrl: calls.openOAuthUrl } })
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

async function render({
  cohost = settings(),
  gate = premium as Record<string, unknown>,
  signedIn = true,
  consented = true,
  consentRequested = false,
  live = false,
  state = null as CohostState | null,
  reportSessionId = undefined as string | null | undefined,
  cleanCutRequest = undefined as CleanCutTabRequest | undefined,
  core = {} as Record<string, unknown>
} = {}): Promise<void> {
  mocked.core = {
    sessions: [],
    entitlements: null,
    account: signedIn ? { status: 'signed-in' } : { status: 'signed-out' },
    aiConsent: consented,
    cohostGate: gate,
    cohostSettings: cohost,
    runtimeInfo: { platform: 'darwin', commentsWindowEnabled: true },
    orcleConsentRequested: consentRequested,
    setOrcleLive: calls.setOrcleLive,
    answerOrcleConsent: calls.answerOrcleConsent,
    setAiConsent: calls.setAiConsent,
    patchCohostSettings: calls.patchCohostSettings,
    ...core
  }
  mocked.chat = { cohostState: state }
  mocked.recording = {
    recording: live
      ? { state: 'recording', streamUrl: 'rtmp://live.example/app' }
      : { state: 'idle' }
  }
  mocked.shell = { openCommentsWindow: calls.openCommentsWindow }
  mocked.account = { signIn: calls.signIn }
  await act(async () =>
    root.render(
      createElement(OrcleTab, {
        ...(reportSessionId === undefined ? {} : { reportSessionId }),
        ...(cleanCutRequest === undefined ? {} : { cleanCutRequest })
      })
    )
  )
  // The review is lazy.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function liveSwitch(): HTMLButtonElement {
  const control = document.getElementById('orcle-live-switch') as HTMLButtonElement | null
  expect(control).toBeTruthy()
  return control!
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(match, label).toBeTruthy()
  return match as HTMLButtonElement
}

function statusLine(): HTMLElement {
  return document.querySelector('[data-slot="orcle-live-status"]') as HTMLElement
}

describe('Orcle tab (plan 119 S2)', () => {
  it('introduces Orcle Live with its switch, its status and its three powers', async () => {
    await render()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Live with you. Edits after.')
    expect(text).toContain('Orcle Live')
    expect(text).toContain('Alpha')
    expect(text).toContain('Orcle joins my streams')
    for (const power of ORCLE_LIVE_POWERS) {
      expect(text).toContain(power.title)
      expect(text).toContain(power.description)
    }
    expect(liveSwitch().getAttribute('data-state')).toBe('unchecked')
    expect(statusLine().getAttribute('data-status')).toBe('off')
    // The Stream Manager waits for a stream.
    expect(text).not.toContain('Open Stream Manager')
  })

  it('turns Orcle Live on and off through the one switch', async () => {
    await render()
    await act(async () => liveSwitch().click())
    expect(calls.setOrcleLive).toHaveBeenLastCalledWith(true)

    await render({ cohost: settings({ enabled: true, listen: true }) })
    expect(statusLine().textContent).toContain('On, joins your next stream')
    await act(async () => liveSwitch().click())
    expect(calls.setOrcleLive).toHaveBeenLastCalledWith(false)
    expect(calls.patchCohostSettings).not.toHaveBeenCalled()
  })

  it('asks for consent in a dialog that names every cloud use, and answers it', async () => {
    await render({ consented: false, consentRequested: true })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Turn on Orcle Live?')
    for (const use of CLOUD_AI_USES) expect(dialog?.textContent).toContain(use)
    expect(dialog?.textContent).toContain(CLOUD_AI_KEEPS)

    await act(async () => button('Allow and turn on').click())
    expect(calls.answerOrcleConsent).toHaveBeenLastCalledWith(true)

    await act(async () => button('Not now').click())
    expect(calls.answerOrcleConsent).toHaveBeenLastCalledWith(false)
    expect(calls.setAiConsent).not.toHaveBeenCalled()
  })

  it('shows no consent dialog until Orcle Live asks for one', async () => {
    await render({ consented: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('asks a signed-out streamer to sign in and keeps the switch off', async () => {
    await render({ signedIn: false, gate: basic })
    const unlock = document.querySelector('[data-slot="orcle-live-unlock"]')
    expect(unlock?.textContent).toContain('Sign in to use Orcle Live, part of Videorc Premium.')
    expect(liveSwitch().disabled).toBe(true)
    await act(async () => button('Sign in').click())
    expect(calls.signIn).toHaveBeenCalledTimes(1)
  })

  it('offers Premium to a Basic account', async () => {
    await render({ gate: basic })
    expect(document.querySelector('[data-slot="orcle-live-unlock"]')?.textContent).toContain(
      'Orcle requires Videorc Premium.'
    )
    expect(liveSwitch().disabled).toBe(true)
    await act(async () => button('View Premium').click())
    expect(calls.openOAuthUrl).toHaveBeenCalledWith('https://www.videorc.com/premium')
  })

  it('is live on air, with the Stream Manager one click away', async () => {
    await render({
      cohost: settings({ enabled: true, listen: true }),
      live: true,
      state: {
        sessionId: 'live-1',
        status: 'listening',
        reason: null,
        questions: [],
        flags: [],
        mood: null,
        lastTickAt: null,
        tickSeq: 1,
        partial: false
      }
    })
    expect(statusLine().getAttribute('data-status')).toBe('live')
    expect(statusLine().textContent).toContain('Live now')
    const open = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Open Stream Manager')
    )
    expect(open?.textContent).toContain('⇧⌘J')
    await act(async () => open!.click())
    expect(calls.openCommentsWindow).toHaveBeenCalledTimes(1)
  })

  it('names what needs attention when cloud AI was revoked with Orcle on', async () => {
    await render({ cohost: settings({ enabled: true }), consented: false })
    expect(statusLine().getAttribute('data-status')).toBe('attention')
    expect(statusLine().textContent).toContain('Needs attention')
    expect(statusLine().textContent).toContain("Cloud AI is off, so Orcle can't read chat")
  })
})

describe('Stream report (plan 119 S3)', () => {
  function sectionTitles(): string[] {
    return [...document.querySelectorAll('[data-slot="orcle-tab"] h3')].map(
      (heading) => heading.textContent ?? ''
    )
  }

  it('sits under Orcle Live, before Customize, and follows the last stream', async () => {
    await render()
    expect(sectionTitles()).toEqual(['Orcle Live', 'Last stream', 'Clean cut'])
    const tab = document.querySelector('[data-slot="orcle-tab"]') as HTMLElement
    const report = tab.querySelector('[data-slot="orcle-report"]') as HTMLElement
    const customize = tab.querySelector('[data-slot="orcle-customize"]') as HTMLElement
    expect(
      report.compareDocumentPosition(customize) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(mocked.reportAsks.at(-1)).toBeNull()
    expect(document.body.textContent).toContain(
      'The report appears here after your first stream with Orcle.'
    )
  })

  it("opens on the session Library's Orcle report asked for", async () => {
    await render({ reportSessionId: 'stream-7' })
    expect(mocked.reportAsks.at(-1)).toBe('stream-7')
  })
})

describe('Customize (plan 119 S2)', () => {
  async function openCustomize(): Promise<void> {
    const trigger = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Customize')
    )
    expect(trigger).toBeTruthy()
    await act(async () => trigger!.click())
  }

  it('starts collapsed', async () => {
    await render()
    expect(document.getElementById('orcle-cloud-ai')).toBeNull()
    expect(document.getElementById('cohost-listen')).toBeNull()
  })

  it('is the single home of cloud-AI consent: it revokes and grants', async () => {
    await render({ cohost: settings({ enabled: true, listen: true }) })
    await openCustomize()
    const cloudAi = document.getElementById('orcle-cloud-ai') as HTMLButtonElement
    expect(cloudAi.getAttribute('data-state')).toBe('checked')
    for (const use of CLOUD_AI_USES) expect(document.body.textContent).toContain(use)
    await act(async () => cloudAi.click())
    expect(calls.setAiConsent).toHaveBeenLastCalledWith(false)

    await render({ cohost: settings({ enabled: true, listen: true }), consented: false })
    const revoked = document.getElementById('orcle-cloud-ai') as HTMLButtonElement
    expect(revoked.getAttribute('data-state')).toBe('unchecked')
    await act(async () => revoked.click())
    expect(calls.setAiConsent).toHaveBeenLastCalledWith(true)
    // Consent alone never turns Orcle on or off.
    expect(calls.setOrcleLive).not.toHaveBeenCalled()
  })

  it("holds Orcle's settings without a second Enable switch", async () => {
    await render({ cohost: settings({ enabled: true }) })
    await openCustomize()
    expect(document.getElementById('cohost-listen')).toBeTruthy()
    expect(document.getElementById('cohost-enabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Enable Orcle')
  })
})

describe('Clean cut in the Orcle tab (plan 119 S14)', () => {
  it('sits after the stream report, before Customize', async () => {
    await render()
    const tab = document.querySelector('[data-slot="orcle-tab"]') as HTMLElement
    const report = tab.querySelector('[data-slot="orcle-report"]') as HTMLElement
    const cleanCut = tab.querySelector('[data-slot="clean-cut"]') as HTMLElement
    const customize = tab.querySelector('[data-slot="orcle-customize"]') as HTMLElement
    expect(report.compareDocumentPosition(cleanCut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      cleanCut.compareDocumentPosition(customize) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("opens a cut's review on the ready toast's ask, and goes back to the tab", async () => {
    await render({
      cleanCutRequest: {
        sessionId: 'rec-1',
        jobId: 'job-1',
        mode: 'condensed',
        review: true,
        nonce: 1
      }
    })
    const review = document.querySelector('[data-slot="review-stub"]') as HTMLElement
    expect(JSON.parse(review.dataset.target ?? '{}')).toEqual({
      sessionId: 'rec-1',
      mode: 'condensed',
      jobId: 'job-1'
    })
    expect(document.querySelector('[data-slot="orcle-tab"]')).toBeNull()
    await act(async () => button('Close review').click())
    expect(document.querySelector('[data-slot="orcle-tab"]')).toBeTruthy()
  })
})

describe('Orcle tab: Voice commands (plan 140, S6 part A)', () => {
  const connectPlatformAccount = vi.fn(async () => undefined)
  const authorizeXLive = vi.fn(async () => undefined)
  const accounts = [
    {
      platform: 'twitch',
      scopes: ['user:write:chat'],
      status: 'connected',
      accountLabel: 'orc_streams'
    },
    {
      platform: 'youtube',
      scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      status: 'connected',
      accountLabel: 'Orc Dev'
    },
    { platform: 'x', scopes: [], status: 'connected', accountLabel: '@orcdev' }
  ]

  function section(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="orcle-voice-commands"]')
    expect(element).toBeTruthy()
    return element!
  }

  it('sits inside Orcle Live: what you can say, and the promise', async () => {
    await render({ cohost: settings({ enabled: true }) })
    const voice = section()
    expect(voice.closest('[data-slot="panel-section"]')?.textContent).toContain('Orcle Live')
    const text = voice.textContent ?? ''
    expect(text).toContain('Voice commands')
    expect(text).toContain('What you can say')
    for (const title of ['Highlight', 'Clear', 'Remove', 'Answer']) expect(text).toContain(title)
    expect(text).toContain('“Orcle, highlight the comment from coders X”')
    expect(text).toContain('“This one is toxic. Remove it from our chat.”')
    expect(text).toContain(
      'Orcle never acts on its own. It removes a comment only when you tell it to.'
    )
    expect(text).toContain('20 seconds')
    expect(text).toContain('At most 10 removals a minute.')
    expect(voice.querySelector('[data-slot="orcle-voice-commands-off"]')).toBeNull()
  })

  it('says to turn on Orcle Live first while it is off', async () => {
    await render()
    expect(section().querySelector('[data-slot="orcle-voice-commands-off"]')?.textContent).toBe(
      'Turn on Orcle Live to use voice commands.'
    )
  })

  it('lists Remove messages per account, with the one fix for each', async () => {
    connectPlatformAccount.mockClear()
    authorizeXLive.mockClear()
    await render({
      core: {
        platformAccounts: accounts,
        xNativeCapability: { nativeAvailable: false },
        connectPlatformAccount,
        authorizeXLive
      }
    })
    const rows = [
      ...section().querySelectorAll<HTMLElement>('[data-slot="list-row"][data-platform]')
    ]
    expect(rows.map((row) => row.dataset.platform)).toEqual(['youtube', 'twitch', 'x'])
    expect(rows[0].textContent).toContain('Ready')
    expect(rows[1].textContent).toContain('Reconnect Twitch to let Orcle remove messages.')
    expect(rows[2].textContent).toContain('Authorize X Live to let Orcle remove messages.')

    await act(async () => rows[1].querySelector('button')!.click())
    // A permission reconnect asks for every optional Twitch permission.
    expect(connectPlatformAccount).toHaveBeenCalledWith('twitch', {
      optionalScopes: [
        'moderator:read:followers',
        'channel:read:subscriptions',
        'moderator:manage:chat_messages'
      ]
    })
    await act(async () => rows[2].querySelector('button')!.click())
    expect(authorizeXLive).toHaveBeenCalledTimes(1)
  })

  it('says where to connect when no platform is connected', async () => {
    await render({ core: { platformAccounts: [] } })
    expect(section().querySelector('[data-slot="remove-messages-empty"]')?.textContent).toBe(
      'Connect YouTube, Twitch, Kick or X under Livestream to remove their chat messages.'
    )
  })
})
