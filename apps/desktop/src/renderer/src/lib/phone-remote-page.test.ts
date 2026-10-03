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
  layoutPreset: string
}
type FakeClient = {
  status: string
  intent: ReturnType<typeof vi.fn>
  reconnectNow: ReturnType<typeof vi.fn>
  emit: (event: string, payload: unknown) => void
  setStatus: (status: string) => void
}

const remote = vi.hoisted(() => ({ client: null as FakeClient | null, state: {} as State }))

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
          return { describe: { layoutPresets: [], takeovers: [] }, state: remote.state }
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
  expect(button.querySelector('.name')!.textContent).toMatch(/Stop recording|End stream/)
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

  it('retires an old recording hold when the action changes to End stream', () => {
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
    expect(vi.getTimerCount()).toBe(0)
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
