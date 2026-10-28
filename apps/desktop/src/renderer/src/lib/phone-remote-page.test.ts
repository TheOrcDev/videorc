import { readFileSync } from 'node:fs'
import { Window, type HTMLButtonElement, type Node } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type State = {
  sessionState: string
  sessionActive: boolean
  streamEnabled: boolean
  recordEnabled: boolean
  micMuted: boolean
  systemAudioAvailable: boolean
  systemAudioOn: boolean
  savedScenes?: Array<{ id: string; name: string }>
  activeSavedSceneId?: string | null
  layoutPreset: string
}
type FakeClient = {
  status: string
  intent: ReturnType<typeof vi.fn>
  reconnectNow: ReturnType<typeof vi.fn>
  emit: (event: string, payload: unknown) => void
  setStatus: (status: string) => void
}

const remote = vi.hoisted(() => ({
  client: null as FakeClient | null,
  state: {} as State,
  banners: [] as Array<{ id: string; name: string; shown: boolean }>,
  sounds: [] as Array<{ id: string; name: string; playing: boolean }>,
  describeCalls: 0
}))

// Load the shipping app module unchanged, replacing only its transport. Fragment
// parsing remains real; no renderer, socket, backend session or media is started.
vi.mock(
  '../../../../../../crates/videorc-backend/remote_web/remote-client.js',
  async (original) => {
    const protocol = await original<Record<string, unknown>>()
    return {
      ...protocol,
      RemoteClient: class {
        status = 'connected'
        listeners = new Map<string, Set<(payload: unknown) => void>>()
        intent = vi.fn(async () => ({ ok: true }))
        reconnectNow = vi.fn()
        close = vi.fn(() => this.setStatus('idle'))

        constructor() {
          remote.client = this
        }

        on(event: string, listener: (payload: unknown) => void): void {
          if (!this.listeners.has(event)) this.listeners.set(event, new Set())
          this.listeners.get(event)!.add(listener)
        }

        emit(event: string, payload: unknown): void {
          for (const listener of this.listeners.get(event) ?? []) listener(payload)
        }

        setStatus(status: string): void {
          this.status = status
          this.emit('status', { status })
        }

        async connect(): Promise<void> {
          this.setStatus('connected')
        }

        async describe(): Promise<unknown> {
          remote.describeCalls += 1
          return {
            describe: {
              layoutPresets: ['screen-only', 'vertical-split'],
              layoutLabels: { 'screen-only': 'Screen only', 'vertical-split': 'Vertical split' },
              takeovers: [],
              banners: remote.banners,
              sounds: remote.sounds
            },
            state: remote.state
          }
        }

        async chatSnapshot(): Promise<void> {}
      }
    }
  }
)

const html = readFileSync(
  new URL('../../../../../../crates/videorc-backend/remote_web/index.html', import.meta.url),
  'utf8'
)
let page: Window

function client(): FakeClient {
  expect(remote.client).not.toBeNull()
  return remote.client!
}

function sessionButton(): HTMLButtonElement {
  const button = page.document.querySelector<HTMLButtonElement>('#deck-main button')!
  expect(button.querySelector('.name')!.textContent).toMatch(/Stop recording|End livestream/)
  return button
}

function pointer(button: HTMLButtonElement, type: string, pointerId = 1): void {
  button.dispatchEvent(new page.PointerEvent(type, { bubbles: true, pointerId }))
}

function stateUpdate(patch: Partial<State>): void {
  remote.state = { ...remote.state, ...patch }
  client().emit('state', remote.state)
}

function highlightUpdate(): void {
  client().emit('highlight', {
    phase: 'live',
    messageId: 'comment',
    expiresAt: new Date(Date.now() + 10_000).toISOString()
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  remote.client = null
  remote.banners = []
  remote.sounds = []
  remote.describeCalls = 0
  remote.state = {
    sessionState: 'recording',
    sessionActive: true,
    streamEnabled: false,
    recordEnabled: true,
    micMuted: false,
    systemAudioAvailable: true,
    systemAudioOn: false,
    layoutPreset: 'screen-only'
  }
  page = new Window({
    url: `http://127.0.0.1:7420/#d=test-device.${'A'.repeat(43)}`,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true
    }
  })
  page.document.write(html)
  for (const name of ['window', 'document', 'navigator', 'location', 'localStorage', 'history']) {
    vi.stubGlobal(name, name === 'window' ? page : page[name as keyof Window])
  }
  // The standalone phone page is plain JS and intentionally outside the TS project.
  // @ts-expect-error No declaration file for the shipping browser module.
  await import('../../../../../../crates/videorc-backend/remote_web/app.js')
  page.document.querySelector<HTMLButtonElement>('[data-view="deck"]')!.click()
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  await page.happyDOM.abort()
  vi.unstubAllGlobals()
})

const updates = [
  ['no update', () => {}],
  ['microphone state', () => stateUpdate({ micMuted: true })],
  ['system audio state', () => stateUpdate({ systemAudioOn: true })],
  ['system audio removal', () => stateUpdate({ systemAudioAvailable: false })],
  ['highlight', highlightUpdate]
] as const

describe('shipping phone remote stop gestures', () => {
  it.each(updates)('cancels an early release after %s', (_name, update) => {
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(100)
    update()
    pointer(sessionButton(), 'pointerup')
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
    expect(sessionButton().dataset.holding).toBe('false')
  })

  it('keeps a valid hold attached through frequent state and highlight updates', () => {
    const stop = sessionButton()
    const removals: Node[] = []
    const observer = new page.MutationObserver((records) => {
      for (const record of records) removals.push(...record.removedNodes)
    })
    observer.observe(page.document.getElementById('deck-main')!, { childList: true })
    pointer(stop, 'pointerdown')
    for (let tick = 0; tick < 6; tick += 1) {
      vi.advanceTimersByTime(100)
      stateUpdate({ micMuted: tick % 2 === 0, systemAudioOn: tick % 2 === 1 })
      highlightUpdate()
      expect(sessionButton()).toBe(stop)
      expect(stop.isConnected).toBe(true)
    }
    vi.advanceTimersByTime(99)
    for (const record of observer.takeRecords()) {
      removals.push(...record.removedNodes)
    }
    observer.disconnect()
    expect(removals).not.toContain(stop)
    expect(client().intent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(client().intent).toHaveBeenCalledExactlyOnceWith({ kind: 'recordStop' })
    // An ack never optimistically retires the backend-confirmed Stop control.
    expect(sessionButton()).toBe(stop)
    vi.advanceTimersByTime(1000)
    expect(client().intent).toHaveBeenCalledTimes(1)
    pointer(stop, 'pointerup')
  })

  it('preserves the held button when system audio becomes available', () => {
    stateUpdate({ systemAudioAvailable: false })
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    stateUpdate({ systemAudioAvailable: true })
    expect(sessionButton()).toBe(stop)
    pointer(stop, 'pointerup')
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it.each(['pointercancel', 'pointerleave'])('cancels %s after a state update', (event) => {
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(100)
    stateUpdate({ micMuted: true })
    pointer(sessionButton(), event)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('does not leave a second timer after repeated pointerdown and an early release', () => {
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    pointer(stop, 'pointerup')
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('fires once per held pointer despite repeated pointerdown', () => {
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(600)
    expect(client().intent).toHaveBeenCalledExactlyOnceWith({ kind: 'recordStop' })
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(1000)
    expect(client().intent).toHaveBeenCalledTimes(1)
    pointer(stop, 'pointerup')
  })

  it('retires an old recording hold when the action changes to End livestream', () => {
    const oldStop = sessionButton()
    pointer(oldStop, 'pointerdown')
    vi.advanceTimersByTime(100)
    stateUpdate({ streamEnabled: true, sessionState: 'streaming' })
    expect(sessionButton()).not.toBe(oldStop)
    expect(oldStop.isConnected).toBe(false)
    expect(oldStop.dataset.holding).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(700)
    expect(client().intent).toHaveBeenCalledExactlyOnceWith({ kind: 'streamStop' })
  })

  it('cannot send a retired hold into a later recording session', () => {
    const oldStop = sessionButton()
    pointer(oldStop, 'pointerdown')
    vi.advanceTimersByTime(100)
    stateUpdate({ sessionActive: false, sessionState: 'idle' })
    expect(oldStop.dataset.holding).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    stateUpdate({ sessionActive: true, sessionState: 'recording' })
    expect(sessionButton()).not.toBe(oldStop)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('retires a hold when the confirmed session lifecycle changes', () => {
    const oldStop = sessionButton()
    pointer(oldStop, 'pointerdown')
    vi.advanceTimersByTime(100)
    stateUpdate({ sessionState: 'stopping' })
    expect(sessionButton()).not.toBe(oldStop)
    expect(oldStop.dataset.holding).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('cannot re-arm a disposed button even if it is later reattached', () => {
    const retired = sessionButton()
    stateUpdate({ sessionActive: false, sessionState: 'idle' })
    page.document.getElementById('deck-main')!.append(retired)
    pointer(retired, 'pointerdown')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it.each(['reconnecting', 'unpaired', 'idle'])('cancels a hold on %s', (status) => {
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    client().setStatus(status)
    expect(stop.dataset.holding).toBe('false')
    // The one timer left while reconnecting is the 10 s "Can't reach" clock.
    expect(vi.getTimerCount()).toBe(status === 'reconnecting' ? 1 : 0)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('cannot resume an old hold after reconnecting', async () => {
    const oldStop = sessionButton()
    pointer(oldStop, 'pointerdown')
    vi.advanceTimersByTime(100)
    client().setStatus('reconnecting')
    client().setStatus('connected')
    await Promise.resolve()
    expect(sessionButton()).not.toBe(oldStop)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(700)
    expect(client().intent).toHaveBeenCalledExactlyOnceWith({ kind: 'recordStop' })
  })

  it('cancels when the phone page is hidden, even if made visible before the deadline', () => {
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    Object.defineProperty(page.document, 'visibilityState', { configurable: true, value: 'hidden' })
    page.document.dispatchEvent(new page.Event('visibilitychange'))
    expect(stop.dataset.holding).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    Object.defineProperty(page.document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    page.document.dispatchEvent(new page.Event('visibilitychange'))
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
    expect(stop.dataset.holding).toBe('false')
  })

  it('cancels on pagehide', () => {
    const stop = sessionButton()
    pointer(stop, 'pointerdown')
    vi.advanceTimersByTime(100)
    page.dispatchEvent(new page.Event('pagehide'))
    expect(stop.dataset.holding).toBe('false')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('cancels when the deck view is retired', () => {
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(100)
    page.document.querySelector<HTMLButtonElement>('[data-view="comments"]')!.click()
    vi.advanceTimersByTime(1000)
    expect(client().intent).not.toHaveBeenCalled()
  })

  it('keeps the existing early-release and refusal snacks', async () => {
    pointer(sessionButton(), 'pointerdown')
    vi.advanceTimersByTime(100)
    pointer(sessionButton(), 'pointerup')
    expect(page.document.getElementById('snack')!.textContent).toBe('Hold to stop.')
    client().intent.mockResolvedValueOnce({ ok: false, message: 'Session already stopping.' })
    pointer(sessionButton(), 'pointerdown')
    await vi.advanceTimersByTimeAsync(700)
    expect(page.document.getElementById('snack')!.textContent).toBe('Session already stopping.')
    expect(sessionButton().querySelector('.name')!.textContent).toBe('Stop recording')
  })
})

describe('shipping phone remote words (plan 174 I-14)', () => {
  it('says what the desktop says: Chat, Controls, ON AIR, Take off stream, real layout names', () => {
    const tabs = [...page.document.querySelectorAll('#tabs button')].map((tab) =>
      tab.textContent?.trim()
    )
    expect(tabs).toEqual(['Chat', 'Controls'])
    expect(page.document.getElementById('live')!.textContent).toBe('ON AIR')
    expect(page.document.getElementById('comments-empty')!.textContent).toBe(
      'Chat appears here when you go live.'
    )
    const keys = [...page.document.querySelectorAll('#deck-main .name')].map(
      (name) => name.textContent
    )
    expect(keys).toContain('Take off stream')
    expect(keys).not.toContain('Clear comment')
    const scenes = [...page.document.querySelectorAll('#deck-scenes .name')].map(
      (name) => name.textContent
    )
    expect(scenes).toEqual(['Screen only', 'Vertical split'])
    stateUpdate({ streamEnabled: true, sessionState: 'streaming' })
    expect(sessionButton().querySelector('.name')!.textContent).toBe('End livestream')
  })
})

describe('shipping phone remote states and semantics (plan 174 S3.20)', () => {
  const $ = (id: string) => page.document.getElementById(id) as unknown as HTMLElement
  const deckKeys = () => [...page.document.querySelectorAll<HTMLButtonElement>('#view-deck .key')]
  const keyNamed = (name: string) =>
    deckKeys().find((key) => key.querySelector('.name')!.textContent === name)!

  it('names the microphone state and never lights the key when muted (I-13)', () => {
    expect(keyNamed('Mic on').querySelector('.hint')!.textContent).toBe('Tap to mute')
    stateUpdate({ micMuted: true })
    const mic = keyNamed('Mic muted')
    expect(mic.dataset.on).toBe('false')
    expect(mic.dataset.accent).toBeUndefined()
    expect(mic.dataset.lit).toBeUndefined()
    expect(mic.querySelector('.hint')!.textContent).toBe('Tap to unmute')
  })

  it('wears the desktop chrome: Record an LED, Go Live the primary, stop the lit LED (plan 208 D8)', () => {
    const lit = (key: HTMLButtonElement) => key.dataset.lit !== undefined
    expect(sessionButton().dataset.accent).toBe('record')
    expect(lit(sessionButton())).toBe(true)
    stateUpdate({ sessionActive: false, sessionState: 'idle' })
    expect(keyNamed('Record').dataset.accent).toBe('record')
    expect(lit(keyNamed('Record'))).toBe(false)
    stateUpdate({ streamEnabled: true })
    expect(keyNamed('Go Live').dataset.accent).toBe('primary')
    expect(lit(keyNamed('Go Live'))).toBe(false)
    stateUpdate({ sessionActive: true, sessionState: 'streaming' })
    expect(sessionButton().dataset.accent).toBe('record')
    expect(lit(sessionButton())).toBe(true)
    // Nothing else is ever an LED: a scene that is on wears the plate.
    expect(keyNamed('Screen only').dataset.accent).toBeUndefined()
    expect(lit(keyNamed('Screen only'))).toBe(false)
  })

  it('marks keys that stay on with aria-pressed (I-12)', () => {
    expect(keyNamed('Screen only').getAttribute('aria-pressed')).toBe('true')
    expect(keyNamed('Vertical split').getAttribute('aria-pressed')).toBe('false')
    expect(keyNamed('System audio').getAttribute('aria-pressed')).toBe('false')
  })

  it('puts chat in a real list of buttons that say whether they are on stream (I-12)', () => {
    client().emit('chat.reset', [
      { id: 'comment', platform: 'twitch', authorName: 'Ada', messageText: 'hi' }
    ])
    highlightUpdate()
    const list = $('comments')
    expect(list.tagName).toBe('UL')
    const row = list.querySelector('li > button.comment')!
    expect(row.getAttribute('role')).toBeNull()
    expect(row.getAttribute('aria-pressed')).toBe('true')
    const viewport = page.document.querySelector('meta[name="viewport"]')!.getAttribute('content')
    expect(viewport).not.toContain('user-scalable=no')
  })

  it('disables every control while offline and says so after 10 s (I-11)', () => {
    client().emit('chat.reset', [
      { id: 'm1', platform: 'twitch', authorName: 'Ada', messageText: 'hi' }
    ])
    client().setStatus('reconnecting')
    expect(deckKeys().every((key) => key.disabled)).toBe(true)
    expect(page.document.querySelector<HTMLButtonElement>('.comment')!.disabled).toBe(true)
    expect($('status').textContent).toBe('Reconnecting…')
    expect($('offline').hidden).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect($('status').textContent).toBe('Can’t reach Videorc…')
    expect($('offline').hidden).toBe(false)
    page.document.querySelector<HTMLButtonElement>('#offline [data-action="retry"]')!.click()
    expect(client().reconnectNow).toHaveBeenCalledOnce()
    expect($('status').textContent).toBe('Reconnecting…')
    client().setStatus('connected')
    expect(keyNamed('Mic on').disabled).toBe(false)
    expect(sessionButton().disabled).toBe(false)
    expect($('offline').hidden).toBe(true)
  })

  it('shows REC while recording and ON AIR while live (I-34)', () => {
    expect($('rec').hidden).toBe(false)
    expect($('live').hidden).toBe(true)
    stateUpdate({ streamEnabled: true, sessionState: 'streaming' })
    expect($('rec').hidden).toBe(true)
    expect($('live').hidden).toBe(false)
  })

  it('forgets this computer only after the streamer confirms (I-34)', () => {
    const confirm = vi.fn(() => false)
    Object.assign(page, { confirm })
    const forget = page.document.querySelector<HTMLButtonElement>(
      '.deck-footer [data-action="forget"]'
    )!
    expect(forget.textContent).toBe('Forget this computer…')
    forget.click()
    expect(confirm).toHaveBeenCalledOnce()
    expect($('view-gate').hidden).toBe(true)
    confirm.mockReturnValue(true)
    forget.click()
    expect($('view-gate').hidden).toBe(false)
    expect($('gate-title').textContent).toBe('Pair this phone')
    expect(page.location.hash).toBe('')
  })
})

describe('shipping phone remote banners (plan 186 S7)', () => {
  const bannerKeys = () =>
    [...page.document.querySelectorAll<HTMLButtonElement>('#deck-banners .key')].map((key) => ({
      name: key.querySelector('.name')!.textContent,
      hint: key.querySelector('.hint')?.textContent ?? null,
      pressed: key.getAttribute('aria-pressed')
    }))
  // Let the describe re-read that follows a state event land.
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  }

  it('lists banners by name, shows or hides each by id, and follows describe after state', async () => {
    expect((page.document.getElementById('banners-label') as unknown as HTMLElement).hidden).toBe(
      true
    )
    remote.banners = [
      { id: 'sponsor', name: 'Sponsor', shown: true },
      { id: 'follow', name: 'Follow me', shown: false }
    ]
    // A banner change on the desktop arrives as remote.state; the page re-reads describe.
    const before = remote.describeCalls
    stateUpdate({})
    await settle()
    expect(remote.describeCalls).toBeGreaterThan(before)
    expect((page.document.getElementById('banners-label') as unknown as HTMLElement).hidden).toBe(
      false
    )
    expect(bannerKeys()).toEqual([
      { name: 'Sponsor', hint: 'Showing. Tap to hide', pressed: 'true' },
      { name: 'Follow me', hint: null, pressed: 'false' }
    ])
    const keys = page.document.querySelectorAll<HTMLButtonElement>('#deck-banners .key')
    keys[0].click()
    keys[1].click()
    expect(client().intent.mock.calls.map(([intent]) => intent)).toEqual([
      { kind: 'bannerHide', bannerId: 'sponsor' },
      { kind: 'bannerShow', bannerId: 'follow' }
    ])
    // Names only: no image or path ever reaches the page.
    expect(page.document.querySelector('#deck-banners img')).toBeNull()
  })
})

describe('shipping phone remote sounds (plan 189 S10)', () => {
  const soundKeys = () =>
    [...page.document.querySelectorAll<HTMLButtonElement>('#deck-sounds .key')].map((key) => ({
      name: key.querySelector('.name')!.textContent,
      hint: key.querySelector('.hint')?.textContent ?? null,
      disabled: key.disabled
    }))
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  }

  it('lists sounds by name, presses each by id, and stops them all', async () => {
    expect((page.document.getElementById('sounds-label') as unknown as HTMLElement).hidden).toBe(
      true
    )
    remote.sounds = [
      { id: 'airhorn', name: 'Airhorn', playing: false },
      { id: 'applause', name: 'Applause', playing: true }
    ]
    stateUpdate({})
    await settle()
    expect((page.document.getElementById('sounds-label') as unknown as HTMLElement).hidden).toBe(
      false
    )
    expect(soundKeys()).toEqual([
      { name: 'Airhorn', hint: null, disabled: false },
      { name: 'Applause', hint: 'Playing', disabled: false },
      { name: 'Stop all sounds', hint: null, disabled: false }
    ])
    const keys = page.document.querySelectorAll<HTMLButtonElement>('#deck-sounds .key')
    keys[0].click()
    keys[2].click()
    expect(client().intent.mock.calls.map(([intent]) => intent)).toEqual([
      { kind: 'soundPlay', soundId: 'airhorn' },
      { kind: 'soundStop' }
    ])
    // Names only: no file or path ever reaches the page.
    expect(page.document.querySelector('#deck-sounds')?.innerHTML).not.toMatch(/\.wav|src=|href=/)

    // Nothing plays: Stop all sounds waits.
    remote.sounds = [{ id: 'airhorn', name: 'Airhorn', playing: false }]
    stateUpdate({})
    await settle()
    expect(soundKeys().at(-1)).toEqual({ name: 'Stop all sounds', hint: null, disabled: true })
  })
})

it('shows saved scenes above layouts and sends their ids, marking confirmed state', () => {
  stateUpdate({
    savedScenes: [{ id: 'figma', name: 'Figma <script>' }],
    activeSavedSceneId: 'figma'
  })
  const keys = [...page.document.querySelectorAll<HTMLButtonElement>('#deck-scenes .key')]
  expect(keys[0].querySelector('.name')!.textContent).toBe('Figma <script>')
  expect(keys[0].getAttribute('aria-pressed')).toBe('true')
  expect(keys[1].getAttribute('aria-pressed')).toBe('false')
  keys[0].click()
  expect(client().intent).toHaveBeenCalledWith({ kind: 'sceneApply', sceneId: 'figma' })
})
