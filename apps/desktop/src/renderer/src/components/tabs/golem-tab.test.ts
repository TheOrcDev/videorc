// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostSettings, CohostState } from '@/lib/backend'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES, GOLEM_LIVE_POWERS } from '@/lib/golem-tab-view'
import type { GolemTabId } from '@/lib/golem-tabs'

import { GolemTab } from './golem-tab'

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
vi.mock('@/hooks/use-golem-report', () => ({
  useGolemReport: (sessionId: string | null) => {
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
// My Golems (plan 170) has its own tests; here a marker shows where it sits,
// and the tab's tests stay fast under a loaded suite.
vi.mock('@/components/golem-library-section', async () => {
  const { createElement } = await import('react')
  return {
    GolemLibrarySection: () => createElement('section', { 'data-testid': 'golem-library' })
  }
})
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
  setGolemLive: vi.fn(async (_on: boolean) => undefined),
  answerGolemConsent: vi.fn(async (_accepted: boolean) => undefined),
  setAiConsent: vi.fn((_consent: boolean) => undefined),
  patchCohostSettings: vi.fn(async () => undefined),
  openCommentsWindow: vi.fn(async () => undefined),
  signIn: vi.fn(),
  openOAuthUrl: vi.fn(async (_url: string) => undefined),
  onTabChange: vi.fn((_tab: GolemTabId) => undefined)
}

const premium = { allowed: true }
const basic = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
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
    wakeWordRequired: false,
    removeConfirm: 'confirm',
    persona: {
      id: 'default',
      name: 'Golem',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    },
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
  tab = undefined as GolemTabId | undefined,
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
    golemConsentRequested: consentRequested,
    setGolemLive: calls.setGolemLive,
    answerGolemConsent: calls.answerGolemConsent,
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
      createElement(GolemTab, {
        ...(reportSessionId === undefined ? {} : { reportSessionId }),
        ...(cleanCutRequest === undefined ? {} : { cleanCutRequest }),
        ...(tab === undefined ? {} : { tab, onTabChange: calls.onTabChange })
      })
    )
  )
  // The review is lazy.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Plan 164 S-D6: the switch moved to Stream Manager; the tab points there. */
function livePointer(): HTMLElement {
  const pointer = document.querySelector('[data-testid="golem-live-pointer"]') as HTMLElement | null
  expect(pointer).toBeTruthy()
  expect(document.getElementById('golem-live-switch')).toBeNull()
  return pointer!
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(match, label).toBeTruthy()
  return match as HTMLButtonElement
}

function statusLine(): HTMLElement {
  return document.querySelector('[data-slot="golem-live-status"]') as HTMLElement
}

function stripTabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-videorc-golem-tab]')]
}

function selectedTab(): string | null {
  return (
    document
      .querySelector('[data-videorc-golem-tab][data-state="active"]')
      ?.getAttribute('data-videorc-golem-tab') ?? null
  )
}

/** Radix activates a tab on mousedown with the primary button. */
async function pressTab(id: GolemTabId): Promise<void> {
  const trigger = document.querySelector(`[data-videorc-golem-tab="${id}"]`) as HTMLElement
  expect(trigger).toBeTruthy()
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
}

describe('Golem tab strip (plan 150)', () => {
  it('lists five tabs like Settings and opens on Live', async () => {
    await render()
    expect(stripTabs().map((tab) => tab.textContent)).toEqual([
      'Golem',
      'Chat',
      'Voice',
      'Reports',
      'Clean cut'
    ])
    expect(selectedTab()).toBe('live')
    expect(document.querySelector('[data-slot="page-header"]')).toBeNull()
    expect(document.querySelector('[data-slot="golem-customize"]')).toBeNull()
  })

  it('shows the tab the shell names and asks the shell to change it', async () => {
    await render({ tab: 'voice' })
    expect(selectedTab()).toBe('voice')
    expect(document.querySelector('[data-slot="golem-voice-commands"]')).toBeTruthy()
    expect(document.getElementById('golem-live-switch')).toBeNull()
    await pressTab('reports')
    expect(calls.onTabChange).toHaveBeenLastCalledWith('reports')
  })

  it('switches its own tab when rendered without the shell', async () => {
    await render()
    await pressTab('chat')
    expect(selectedTab()).toBe('chat')
    expect(document.getElementById('cohost-tone')).toBeTruthy()
  })

  it("lands on Reports for the Library's report ask, and Clean cut for a cut ask", async () => {
    await render({ reportSessionId: 'stream-7' })
    expect(selectedTab()).toBe('reports')
    await render({ cleanCutRequest: { sessionId: 'rec-1', nonce: 1 } })
    expect(selectedTab()).toBe('clean-cut')
  })
})

describe('Golem tab (plan 119 S2)', () => {
  it('leads with the creation screen, then its status and its powers', async () => {
    await render()
    const text = document.body.textContent ?? ''
    // Plan 170 D16: My Golems leads the first tab, the creation screen under it.
    const library = document.querySelector('[data-testid="golem-library"]')
    const header = document.querySelector('[data-slot="golem-header"]')
    expect(library).toBeTruthy()
    expect(header).toBeTruthy()
    expect(
      library!.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(document.getElementById('golem-name')).toBeTruthy()
    expect(text).toContain('Joins my streams')
    expect(text).toContain('Alpha')
    expect(text).toContain('Golem joins my streams')
    for (const power of GOLEM_LIVE_POWERS) {
      expect(text).toContain(power.title)
      expect(text).toContain(power.description)
    }
    expect(livePointer().textContent).toContain('Turn it on in Stream Manager')
    expect(statusLine().getAttribute('data-status')).toBe('off')
    // Plan 164 S-D6: the Stream Manager is where the Golem is turned on, so
    // the way there is always offered.
    expect(text).toContain('Open Stream Manager')
  })

  it('has no switch of its own any more: the Stream Manager mode turns Golem on', async () => {
    await render()
    livePointer()
    expect(calls.setGolemLive).not.toHaveBeenCalled()
    await render({ cohost: settings({ enabled: true, listen: true }) })
    expect(statusLine().textContent).toContain('On, joins your next stream')
    expect(calls.patchCohostSettings).not.toHaveBeenCalled()
  })

  it('asks for consent in a dialog that names every cloud use, and answers it', async () => {
    await render({ consented: false, consentRequested: true })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Turn on Golem Live?')
    // Plan 149: Golem's emblem leads the dialog, at its large size.
    const emblem = dialog?.querySelector('[data-slot="golem-emblem"]')
    expect(emblem?.getAttribute('src')).toContain('golem-emblem-112')
    expect(emblem?.getAttribute('alt')).toBe('')
    for (const use of CLOUD_AI_USES) expect(dialog?.textContent).toContain(use)
    expect(dialog?.textContent).toContain(CLOUD_AI_KEEPS)

    await act(async () => button('Allow and turn on').click())
    expect(calls.answerGolemConsent).toHaveBeenLastCalledWith(true)

    await act(async () => button('Not now').click())
    expect(calls.answerGolemConsent).toHaveBeenLastCalledWith(false)
    expect(calls.setAiConsent).not.toHaveBeenCalled()
  })

  it('shows no consent dialog until Golem Live asks for one', async () => {
    await render({ consented: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('asks a signed-out streamer to sign in', async () => {
    await render({ signedIn: false, gate: basic })
    const unlock = document.querySelector('[data-testid="golem-live-unlock"]')
    expect(unlock?.textContent).toContain('Sign in to use Golem Live, part of Videorc Premium.')
    livePointer()
    await act(async () => button('Sign in').click())
    expect(calls.signIn).toHaveBeenCalledTimes(1)
  })

  it('offers Premium to a Basic account', async () => {
    await render({ gate: basic })
    expect(document.querySelector('[data-testid="golem-live-unlock"]')?.textContent).toContain(
      'Golem requires Videorc Premium.'
    )
    livePointer()
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

  it('names what needs attention when cloud AI was revoked with Golem on', async () => {
    await render({ cohost: settings({ enabled: true }), consented: false })
    expect(statusLine().getAttribute('data-status')).toBe('attention')
    expect(statusLine().textContent).toContain('Needs attention')
    expect(statusLine().textContent).toContain("Cloud AI is off, so Golem can't read chat")
  })
})

describe('Live and Chat tabs (plan 150 S3, S4)', () => {
  it('leads Live with the emblem beside the status, and listening under it', async () => {
    await render()
    const block = document.querySelector('[data-slot="golem-live-status-block"]') as HTMLElement
    expect(block.querySelector('[data-slot="golem-emblem"]')?.getAttribute('src')).toContain(
      'golem-emblem-112'
    )
    expect(block.querySelector('#golem-live-switch')).toBeNull()
    expect(block.querySelector('[data-testid="golem-live-pointer"]')).toBeTruthy()
    expect(document.getElementById('cohost-listen')).toBeTruthy()
    // The three-column pitch is gone; Live lists what Golem does as rows.
    expect(document.querySelector('ul[aria-label="What Golem Live does"]')).toBeNull()
    expect(document.querySelectorAll('[data-power-tab]')).toHaveLength(GOLEM_LIVE_POWERS.length)
  })

  it('opens the tab that holds a power when its row is pressed', async () => {
    await render({ tab: 'live' })
    const voice = document.querySelector('[data-power-tab="voice"] button') as HTMLButtonElement
    await act(async () => voice.click())
    expect(calls.onTabChange).toHaveBeenLastCalledWith('voice')
    const chat = document.querySelector('[data-power-tab="chat"] button') as HTMLButtonElement
    await act(async () => chat.click())
    expect(calls.onTabChange).toHaveBeenLastCalledWith('chat')
  })

  it('splits Chat into Greetings, Replies and Moderation, and leads with one reason when locked', async () => {
    await render({ tab: 'chat' })
    const titles = [...document.querySelectorAll('[data-slot="panel-section"] h3')].map(
      (heading) => heading.textContent
    )
    // Plan 164 S-D5: Greetings lead the Chat tab, above Replies.
    expect(titles).toEqual(['Greetings', 'Replies', 'Moderation'])
    expect(document.querySelector('[data-testid="golem-tab-unlock"]')).toBeNull()

    await render({ tab: 'chat', gate: basic })
    expect(document.querySelector('[data-testid="golem-tab-unlock"]')?.textContent).toContain(
      'Golem requires Videorc Premium.'
    )
    expect((document.getElementById('cohost-notes') as HTMLTextAreaElement).disabled).toBe(true)
    // Greetings are free (plan 164 D6): editable under the same lock.
    expect((document.getElementById('golem-greetings-enabled') as HTMLButtonElement).disabled).toBe(
      false
    )
    expect((document.getElementById('cohost-answers') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Locked means disabled, with one reason, on every tab (plan 150, D7)', () => {
  it('gives a signed-out streamer the same sign-in reason on Live, Chat and Voice', async () => {
    await render({ signedIn: false })
    expect(document.querySelector('[data-testid="golem-live-unlock"]')?.textContent).toContain(
      'Sign in to use Golem Live'
    )
    expect((document.getElementById('cohost-listen') as HTMLButtonElement).disabled).toBe(true)

    await render({ signedIn: false, tab: 'chat' })
    expect(document.querySelector('[data-testid="golem-tab-unlock"]')?.textContent).toContain(
      'Sign in to use Golem Live'
    )
    expect((document.getElementById('cohost-notes') as HTMLTextAreaElement).disabled).toBe(true)

    await render({ signedIn: false, tab: 'voice' })
    expect(document.querySelector('[data-testid="golem-tab-unlock"]')?.textContent).toContain(
      'Sign in to use Golem Live'
    )
    expect(document.querySelector('[data-testid="golem-voice-commands-off"]')).toBeNull()
    expect((document.getElementById('golem-wake-word') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Reports (plan 119 S3, plan 150)', () => {
  it('is its own tab and follows the last stream', async () => {
    await render({ tab: 'reports' })
    expect(document.querySelector('[data-slot="golem-report"]')).toBeTruthy()
    expect(document.getElementById('golem-live-switch')).toBeNull()
    expect(mocked.reportAsks.at(-1)).toBeNull()
    expect(document.body.textContent).toContain(
      'The report appears here after your first stream with Golem.'
    )
  })

  it("opens on the session Library's Golem report asked for", async () => {
    await render({ reportSessionId: 'stream-7' })
    expect(mocked.reportAsks.at(-1)).toBe('stream-7')
  })
})

describe('Cloud AI and the settings tabs (plan 119 S2, plan 150)', () => {
  it('keeps cloud-AI consent on Live, its single home: it revokes and grants', async () => {
    await render({ cohost: settings({ enabled: true, listen: true }) })
    const cloudAi = document.getElementById('golem-cloud-ai') as HTMLButtonElement
    expect(cloudAi.getAttribute('data-state')).toBe('checked')
    for (const use of CLOUD_AI_USES) expect(document.body.textContent).toContain(use)
    await act(async () => cloudAi.click())
    expect(calls.setAiConsent).toHaveBeenLastCalledWith(false)

    await render({ cohost: settings({ enabled: true, listen: true }), consented: false })
    const revoked = document.getElementById('golem-cloud-ai') as HTMLButtonElement
    expect(revoked.getAttribute('data-state')).toBe('unchecked')
    await act(async () => revoked.click())
    expect(calls.setAiConsent).toHaveBeenLastCalledWith(true)
    // Consent alone never turns Golem on or off.
    expect(calls.setGolemLive).not.toHaveBeenCalled()
  })

  it("holds Golem's settings without a second Enable switch", async () => {
    await render({ cohost: settings({ enabled: true }), tab: 'chat' })
    expect(document.getElementById('cohost-tone')).toBeTruthy()
    expect(document.getElementById('cohost-enabled')).toBeNull()
    expect(document.body.textContent).not.toContain('Enable Golem')
  })
})

describe('Clean cut in the Golem tab (plan 119 S14)', () => {
  it('is its own tab', async () => {
    await render({ tab: 'clean-cut' })
    expect(document.querySelector('[data-slot="clean-cut"]')).toBeTruthy()
    expect(document.querySelector('[data-slot="golem-report"]')).toBeNull()
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
    // The review opens inside Clean cut: the strip stays.
    expect(selectedTab()).toBe('clean-cut')
    expect(document.querySelector('[data-slot="clean-cut"]')).toBeNull()
    await act(async () => button('Close review').click())
    expect(document.querySelector('[data-slot="clean-cut"]')).toBeTruthy()
  })
})

describe('Golem tab: Voice commands (plan 140, S6 part A)', () => {
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
    const element = document.querySelector<HTMLElement>('[data-slot="golem-voice-commands"]')
    expect(element).toBeTruthy()
    return element!
  }

  it('is the Voice tab: what you can say, and the promise', async () => {
    await render({ cohost: settings({ enabled: true }), tab: 'voice' })
    const voice = section()
    expect(document.getElementById('golem-live-switch')).toBeNull()
    const text = voice.textContent ?? ''
    expect(text).toContain('Voice commands')
    expect(text).toContain('What you can say')
    for (const title of ['Highlight', 'Clear', 'Remove', 'Answer']) expect(text).toContain(title)
    expect(text).toContain('“Golem, highlight the comment from coders X”')
    expect(text).toContain('“This one is toxic. Remove it from our chat.”')
    expect(text).toContain(
      'The Golem posts only in the modes you turn on. Everything is off by default. It removes a comment only when you tell it to.'
    )
    expect(text).toContain('20 seconds')
    expect(text).toContain('At most 10 removals a minute.')
    expect(voice.querySelector('[data-testid="golem-voice-commands-off"]')).toBeNull()
  })

  it('says to turn on Golem Live first while it is off, with a way to Live', async () => {
    await render({ tab: 'voice' })
    const off = section().querySelector('[data-testid="golem-voice-commands-off"]') as HTMLElement
    expect(off.textContent).toContain('Turn on Golem Live to use voice commands.')
    await act(async () => off.querySelector('button')!.click())
    expect(calls.onTabChange).toHaveBeenLastCalledWith('live')
  })

  it('leads with one reason when Golem is locked, and disables the settings (plan 150)', async () => {
    await render({ tab: 'voice', gate: basic })
    expect(section().querySelector('[data-testid="golem-tab-unlock"]')?.textContent).toContain(
      'Golem requires Videorc Premium.'
    )
    expect(section().querySelector('[data-testid="golem-voice-commands-off"]')).toBeNull()
    expect((document.getElementById('golem-wake-word') as HTMLButtonElement).disabled).toBe(true)
  })

  it('puts each phrase over what it does, in two columns (plan 150)', async () => {
    await render({ cohost: settings({ enabled: true }), tab: 'voice' })
    const titles = [...section().querySelectorAll('[data-slot="panel-section"] h3')].map(
      (heading) => heading.textContent
    )
    expect(titles).toEqual(['Commands', 'Remove messages'])
    const highlight = section().querySelector('[data-command="highlight"]') as HTMLElement
    expect(highlight.children).toHaveLength(2)
    expect(highlight.lastElementChild?.textContent).toBe('Puts it on stream.')
    expect(section().querySelector('[data-slot="golem-voice-commands-premium"]')).toBeTruthy()
  })

  it('lists Remove messages per account, with the one fix for each', async () => {
    connectPlatformAccount.mockClear()
    authorizeXLive.mockClear()
    await render({
      tab: 'voice',
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
    expect(rows[0].querySelector('button')).toBeNull()
    // One line per row: the short status shows, the whole fix is the button's
    // name and tooltip.
    expect(rows[1].textContent).toContain('Needs access')
    expect(rows[1].textContent).not.toContain('to let Golem remove messages')
    const reconnect = rows[1].querySelector('button')!
    expect(reconnect.textContent).toBe('Reconnect')
    expect(reconnect.getAttribute('aria-label')).toBe(
      'Reconnect Twitch to let Golem remove messages.'
    )
    expect(reconnect.title).toBe('Reconnect Twitch to let Golem remove messages.')
    const authorize = rows[2].querySelector('button')!
    expect(rows[2].textContent).toContain('Needs access')
    expect(authorize.textContent).toBe('Authorize X Live')
    expect(authorize.getAttribute('aria-label')).toBe(
      'Authorize X Live to let Golem remove messages.'
    )
    expect(authorize.title).toBe('Authorize X Live to let Golem remove messages.')

    await act(async () => rows[1].querySelector('button')!.click())
    // A permission reconnect asks for every optional Twitch permission.
    expect(connectPlatformAccount).toHaveBeenCalledWith('twitch', {
      optionalScopes: [
        'moderator:read:followers',
        'channel:read:subscriptions',
        'moderator:manage:chat_messages',
        'bits:read',
        'channel:read:redemptions'
      ]
    })
    await act(async () => rows[2].querySelector('button')!.click())
    expect(authorizeXLive).toHaveBeenCalledTimes(1)
  })

  it('saves the wake word and the confirmation mode (part B)', async () => {
    calls.patchCohostSettings.mockClear()
    await render({
      cohost: settings({ enabled: true, wakeWordRequired: false, removeConfirm: 'confirm' }),
      tab: 'voice'
    })
    const voice = section()
    expect(voice.textContent).toContain('Commands need “Golem” first')
    expect(voice.textContent).toContain('YouTube always asks you to confirm.')
    expect(voice.textContent).toContain('A removal waits 20 seconds for your answer')
    const wake = document.getElementById('golem-wake-word') as HTMLButtonElement
    await act(async () => wake.click())
    expect(calls.patchCohostSettings).toHaveBeenLastCalledWith({ wakeWordRequired: true })
    const countdown = [...voice.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '5-second countdown'
    )
    expect(voice.textContent).toContain('Confirm first')
    await act(async () => countdown!.click())
    expect(calls.patchCohostSettings).toHaveBeenLastCalledWith({ removeConfirm: 'countdown' })
  })

  it('names the countdown in the numbers line when it is on', async () => {
    await render({ cohost: settings({ enabled: true, removeConfirm: 'countdown' }), tab: 'voice' })
    const notes = section().querySelector('[data-slot="golem-voice-commands-notes"]')
    expect(notes?.textContent).toContain('runs after 5 seconds unless you cancel')
  })

  it('says when Videorc paused voice commands or removing', async () => {
    await render({
      tab: 'voice',
      state: {
        sessionId: null,
        status: 'off',
        reason: null,
        questions: [],
        flags: [],
        mood: null,
        lastTickAt: null,
        tickSeq: 0,
        partial: false,
        commandAvailability: { voiceCommands: 'paused', remove: 'paused' }
      }
    })
    const lines = [...section().querySelectorAll('[data-slot="golem-voice-commands-paused"]')].map(
      (line) => line.textContent
    )
    expect(lines).toEqual([
      'Voice commands are paused by Videorc.',
      'Removing messages is paused by Videorc.'
    ])
    await render({ tab: 'voice' })
    expect(section().querySelector('[data-slot="golem-voice-commands-paused"]')).toBeNull()
  })

  it('says where to connect when no platform is connected', async () => {
    await render({ core: { platformAccounts: [] }, tab: 'voice' })
    expect(section().querySelector('[data-slot="remove-messages-empty"]')?.textContent).toBe(
      'Connect YouTube, Twitch, Kick or X under Livestream to remove their chat messages.'
    )
  })
})
