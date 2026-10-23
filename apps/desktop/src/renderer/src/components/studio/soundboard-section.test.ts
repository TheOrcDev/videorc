// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'
import type { Sound, SoundVoice } from '@/lib/backend'

import { SoundboardSection } from './soundboard-section'

// Plan 189 S6: Studio → Soundboard. Pads play on their own mode, keys 1 to 9
// press them while Studio is up, and the line says where a press goes.

const mocked = vi.hoisted(() => ({
  board: {} as Record<string, unknown>,
  shell: { wsStatus: 'connected' } as Record<string, unknown>,
  recording: { state: 'idle' } as Record<string, unknown>
}))
vi.mock('@/hooks/use-soundboard', () => ({ useSoundboard: () => mocked.board }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioShell: () => mocked.shell,
  useStudioRecordingState: () => ({ recording: mocked.recording })
}))

const sound = (id: string, overrides: Partial<Sound> = {}): Sound => ({
  id,
  name: id === 'airhorn' ? 'Airhorn' : id === 'applause' ? 'Applause' : 'Drumroll',
  file: `${id}.wav`,
  durationMs: 1610,
  loudnessLufs: -15,
  levelDb: -3,
  volumeDb: 0,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z',
  ...overrides
})
const airhorn = sound('airhorn', { hotkey: '1' })
const applause = sound('applause', { hotkey: '2', mode: 'toggle' })
const drumroll = sound('drumroll', { hotkey: '3', mode: 'hold' })
const playingApplause: SoundVoice = {
  voiceId: 'v-1',
  soundId: 'applause',
  startedAtMs: Date.now(),
  durationMs: 5000,
  loop: false,
  onAir: false
}

let root: Root
let container: HTMLDivElement
const nav = {
  active: 'studio' as const,
  setActive: vi.fn(),
  activeStudioPanel: null,
  openStudioPanel: vi.fn(),
  closeStudioPanel: vi.fn(),
  openSettings: vi.fn(),
  openBuddy: vi.fn()
}

const actions = () => ({
  play: vi.fn(async () => true),
  stop: vi.fn(async () => true),
  press: vi.fn(async () => true),
  stopAll: vi.fn(async () => true)
})

function setBoard(overrides: Record<string, unknown> = {}): void {
  const voices = (overrides.voices as SoundVoice[] | undefined) ?? []
  mocked.board = {
    sounds: [airhorn, applause, drumroll],
    loaded: true,
    offline: false,
    voices,
    voiceBySound: new Map(voices.map((voice) => [voice.soundId, voice])),
    monitor: true,
    volumeDb: 0,
    ...actions(),
    ...overrides
  }
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(WorkspaceNavContext.Provider, { value: nav }, createElement(SoundboardSection))
    )
  )
}

const pad = (id: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-videorc-sound-pad="${id}"]`)!
const board = () => mocked.board as ReturnType<typeof actions>
const stopAll = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-videorc-stop-all-sounds]')!
const stopAllButton = (): HTMLButtonElement => stopAll().querySelector('button')!
const stopAllShown = (): boolean => stopAll().hasAttribute('data-playing')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  nav.setActive.mockClear()
  mocked.shell = { wsStatus: 'connected' }
  mocked.recording = { state: 'idle' }
  setBoard()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Studio → Soundboard (plan 189 S6)', () => {
  it('shows one pad per sound with its name, key and DOM contract', async () => {
    await render()
    const section = container.querySelector('[data-videorc-soundboard]')!
    expect(section.querySelector('h2')?.textContent).toBe('Soundboard')
    expect(section.textContent).toContain('Only you hear sounds until you record or go live.')
    expect(pad('airhorn').getAttribute('aria-label')).toBe('Play Airhorn')
    expect(pad('airhorn').textContent).toContain('Airhorn')
    expect(pad('airhorn').querySelector('kbd')?.textContent).toBe('1')
    expect(pad('airhorn').className).toContain('rounded-row')
    expect(pad('airhorn').hasAttribute('data-playing')).toBe(false)
  })

  it('marks a playing pad, names its stop, and lets Stop all stop everything', async () => {
    setBoard({ voices: [playingApplause] })
    await render()
    expect(pad('applause').hasAttribute('data-playing')).toBe(true)
    expect(pad('applause').getAttribute('aria-label')).toBe('Stop Applause')
    expect(pad('applause').querySelector('[data-slot="sound-pad-progress"]')).not.toBeNull()
    expect(stopAllShown()).toBe(true)
    expect(stopAllButton().disabled).toBe(false)
    await act(async () => stopAllButton().click())
    expect(board().stopAll).toHaveBeenCalled()
  })

  it('hides Stop all while nothing plays, keeping its place out of reach', async () => {
    await render()
    expect(stopAllShown()).toBe(false)
    const slot = stopAll()
    expect(slot.className).toContain('invisible')
    expect(slot.getAttribute('aria-hidden')).toBe('true')
    expect(slot.inert).toBe(true)
    expect(stopAllButton().disabled).toBe(true)
    // No reason tooltip on a control nobody can see.
    expect(slot.querySelector('[data-slot="disabled-reason"]')).toBeNull()
  })

  it('shows Stop all for a sound in any mode, and hides it when the last one ends', async () => {
    for (const mode of ['oneShot', 'toggle', 'loop', 'hold'] as const) {
      setBoard({
        sounds: [sound('applause', { mode })],
        voices: [{ ...playingApplause, loop: mode === 'loop' }]
      })
      await render()
      expect(stopAllShown()).toBe(true)
    }
    // Two play; one ends and Stop all stays; the last ends and it goes.
    setBoard({
      voices: [playingApplause, { ...playingApplause, voiceId: 'v-2', soundId: 'airhorn' }]
    })
    await render()
    expect(stopAllShown()).toBe(true)
    setBoard({ voices: [playingApplause] })
    await render()
    expect(stopAllShown()).toBe(true)
    setBoard({ voices: [] })
    await render()
    expect(stopAllShown()).toBe(false)
  })

  it('hides Stop all again once pressing it has stopped the sounds', async () => {
    setBoard({ voices: [playingApplause] })
    await render()
    await act(async () => stopAllButton().click())
    expect(board().stopAll).toHaveBeenCalledTimes(1)
    // The board comes back with no voices.
    setBoard({ voices: [] })
    await render()
    expect(stopAllShown()).toBe(false)
  })

  it('keeps Stop all shown but off while Videorc reconnects, with its reason', async () => {
    mocked.shell = { wsStatus: 'closed' }
    setBoard({ voices: [playingApplause] })
    await render()
    expect(stopAllShown()).toBe(true)
    expect(stopAllButton().disabled).toBe(true)
    const wrapper = stopAllButton().closest('[data-slot="disabled-reason"]')!
    const description = document.getElementById(wrapper.getAttribute('aria-describedby')!)
    expect(description?.textContent).toBeTruthy()
  })

  it('keeps the keys working whether Stop all shows or not', async () => {
    await render()
    expect(stopAllShown()).toBe(false)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })))
    expect(board().press).toHaveBeenCalledWith('airhorn')
  })

  it('says sounds reach the recording while one runs, and when the streamer hears them', async () => {
    // A buffer-only Clips session (plan 181) is not a recording.
    mocked.recording = { state: 'recording', replayOnly: true }
    await render()
    expect(container.textContent).toContain('Only you hear sounds until you record or go live.')
    mocked.recording = { state: 'recording' }
    await render()
    expect(container.textContent).toContain('Sounds play in your recording and stream.')
    setBoard({ monitor: false })
    await render()
    expect(container.textContent).toContain(
      "Sounds play in your recording and stream. You don't hear them yourself."
    )
  })

  it('presses a sound by its key, stops a While held one on release, and yields to fields', async () => {
    await render()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: '1' }))
    })
    expect(board().press).toHaveBeenCalledWith('airhorn')
    expect(board().stop).not.toHaveBeenCalled()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', repeat: true }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: '3' }))
    })
    expect(board().press).toHaveBeenCalledTimes(2)
    expect(board().stop).toHaveBeenCalledWith('drumroll')
    // Typing in a field, a modifier, or a key no sound has: nothing plays.
    const input = document.createElement('input')
    document.body.append(input)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '9' }))
    })
    expect(board().press).toHaveBeenCalledTimes(2)
  })

  it('reads the number row by its physical key, so AZERTY presses and releases (release test 147)', async () => {
    await render()
    // French AZERTY: the unshifted number row types "&" and "'" on Digit1 and Digit3.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '&', code: 'Digit1' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: '&', code: 'Digit1' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: "'", code: 'Digit3' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: "'", code: 'Digit3' }))
    })
    expect(board().press).toHaveBeenCalledWith('airhorn')
    expect(board().press).toHaveBeenCalledWith('drumroll')
    expect(board().stop).toHaveBeenCalledWith('drumroll')
    // The numpad presses too; Shift on the number row still yields.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Numpad2' }))
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', code: 'Digit1', shiftKey: true })
      )
    })
    expect(board().press).toHaveBeenCalledWith('applause')
    expect(board().press).toHaveBeenCalledTimes(3)
  })

  it('plays nothing while Videorc reconnects, and says so', async () => {
    mocked.shell = { wsStatus: 'closed' }
    await render()
    expect(pad('airhorn').disabled).toBe(true)
    expect(container.textContent).toContain('Sounds play once Videorc is connected.')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })))
    expect(board().press).not.toHaveBeenCalled()
  })

  it('sends the streamer to Assets when the board is empty, never before it loads', async () => {
    setBoard({ sounds: [], loaded: false })
    await render()
    expect(container.textContent).toContain('Loading sounds…')
    expect(container.textContent).not.toContain('No sounds yet.')
    setBoard({ sounds: [] })
    await render()
    expect(container.textContent).toContain('No sounds yet.')
    const add = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add in Assets'
    )!
    await act(async () => add.click())
    expect(nav.setActive).toHaveBeenCalledWith('assets')
  })
})
