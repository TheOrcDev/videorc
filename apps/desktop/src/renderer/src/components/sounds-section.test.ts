// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Sound } from '@/lib/backend'
import { soundboard } from '@/lib/soundboard-store'
import { SOUND_COUNT_LIMIT_REASON } from '@/lib/sounds'

import { SOUNDS_RETRY_MS } from './sounds-load-state'
import { SoundsSection } from './sounds-section'

// Plan 189 S7: Assets → Sounds imports, renames, orders and removes the
// soundboard's sounds, and sets each one's mode, volume and key.

const mocked = vi.hoisted(() => ({
  board: {} as Record<string, unknown>,
  starters: null as Array<{ slug: string; name: string }> | null
}))
vi.mock('@/hooks/use-soundboard', () => ({
  useSoundboard: () => mocked.board,
  useStarterSounds: () => mocked.starters
}))

const sound = (id: string, overrides: Partial<Sound> = {}): Sound => ({
  id,
  name: id === 'airhorn' ? 'Airhorn' : id === 'gong' ? 'Gong' : id,
  file: `${id}.wav`,
  durationMs: 1610,
  loudnessLufs: -15,
  levelDb: -3,
  volumeDb: -3,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z',
  ...overrides
})
const airhorn = sound('airhorn', { hotkey: '1', starter: 'airhorn' })
const gong = sound('gong', { mode: 'toggle', durationMs: 2850 })

let root: Root
let container: HTMLDivElement

function setBoard(overrides: Record<string, unknown> = {}): void {
  mocked.board = {
    sounds: [airhorn, gong],
    loaded: true,
    offline: false,
    voices: [],
    voiceBySound: new Map(),
    monitor: true,
    volumeDb: 0,
    play: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    importPhase: 'idle',
    importSounds: vi.fn(async () => undefined),
    updateSound: vi.fn(async () => null),
    moveSound: vi.fn(async () => true),
    removeSound: vi.fn(),
    changeSettings: vi.fn(async () => true),
    restoring: false,
    restoreStarters: vi.fn(async () => undefined),
    ...overrides
  }
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(createElement(TooltipProvider, null, createElement(SoundsSection)))
  )
}

const board = () =>
  mocked.board as {
    play: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    importSounds: ReturnType<typeof vi.fn>
    restoreStarters: ReturnType<typeof vi.fn>
  }
const button = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!
const row = (id: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-videorc-sound-row="${id}"]`)!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.starters = [
    { slug: 'airhorn', name: 'Airhorn' },
    { slug: 'applause', name: 'Applause' }
  ]
  setBoard()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Assets → Sounds (plan 189 S7)', () => {
  it('lists every sound with its play button, length, mode, volume, key and actions', async () => {
    await render()
    const section = container.querySelector('[data-videorc-sounds-section]')!
    expect(section.querySelector('h2')?.textContent).toBe('Sounds')
    expect(section.textContent).toContain(
      '2 sounds · up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
    )
    expect(row('airhorn').textContent).toContain('Airhorn')
    expect(row('airhorn').textContent).toContain('1.6 s')
    expect(row('gong').textContent).toContain('2.9 s')
    expect(
      row('airhorn').querySelector('[aria-label="How Airhorn plays"] [data-slot="select-value"]')
        ?.textContent
    ).toBe('Play once')
    expect(
      row('gong').querySelector('[aria-label="How Gong plays"] [data-slot="select-value"]')
        ?.textContent
    ).toBe('Play/stop')
    expect(row('airhorn').querySelector('[aria-label="Airhorn volume"]')).not.toBeNull()
    expect(row('airhorn').textContent).toContain('−3.0 dB')
    expect(
      row('airhorn').querySelector('[aria-label="Airhorn key"] [data-slot="select-value"]')
        ?.textContent
    ).toBe('1')
    expect(
      row('gong').querySelector('[aria-label="Gong key"] [data-slot="select-value"]')?.textContent
    ).toBe('None')
    expect(row('airhorn').querySelector('[aria-label="Actions for Airhorn"]')).not.toBeNull()
  })

  it('plays a sound to audition it, and stops it while it plays', async () => {
    setBoard({ voices: [{ soundId: 'gong' }] })
    await render()
    await act(async () => {
      row('airhorn').querySelector<HTMLButtonElement>('[aria-label="Play Airhorn"]')!.click()
      row('gong').querySelector<HTMLButtonElement>('[aria-label="Stop Gong"]')!.click()
    })
    expect(board().play).toHaveBeenCalledWith('airhorn')
    expect(board().stop).toHaveBeenCalledWith('gong')
  })

  it('imports from the header', async () => {
    await render()
    await act(async () => button('Import sounds…').click())
    expect(board().importSounds).toHaveBeenCalled()
  })

  // A full board renders 24 rows, each with its mode Select, volume Fader, key
  // Select and menu: about 3 s in happy-dom on an idle laptop, so it timed out
  // at the default 5 s under load (release test 147, plan 0007). It has its own
  // test, mounted once, with a budget that says why.
  it('says why not at 24 sounds', { timeout: 20_000 }, async () => {
    setBoard({ sounds: Array.from({ length: 24 }, (_, index) => sound(`s${index}`)) })
    await render()
    const importButton = button('Import sounds…')
    expect(importButton.disabled).toBe(true)
    const wrapper = importButton.closest('[data-slot="disabled-reason"]')!
    expect(document.getElementById(wrapper.getAttribute('aria-describedby')!)?.textContent).toBe(
      SOUND_COUNT_LIMIT_REASON
    )
  })

  it('offers Restore starter sounds only while a starter is missing', async () => {
    await render()
    await act(async () => button('Restore starter sounds').click())
    expect(board().restoreStarters).toHaveBeenCalled()
    mocked.starters = [{ slug: 'airhorn', name: 'Airhorn' }]
    await render()
    expect(button('Restore starter sounds')).toBeUndefined()
  })

  it('never says No sounds yet before the board loads, and leads with the alert offline', async () => {
    setBoard({ sounds: [], loaded: false })
    await render()
    expect(container.textContent).toContain('Loading sounds…')
    expect(container.textContent).not.toContain('No sounds yet')
    expect(container.textContent).toContain(
      'Sounds up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
    )
    setBoard({ sounds: [] })
    await render()
    expect(container.textContent).toContain('No sounds yet')
    setBoard({ offline: true })
    await render()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('reconnecting')
    expect(
      row('airhorn').querySelector<HTMLButtonElement>('[aria-label="Play Airhorn"]')!.disabled
    ).toBe(true)
  })

  describe('a failed first read (QA F7)', () => {
    const emptyBoard = { sounds: [], volumeDb: 0, monitor: true, startersSeeded: true }
    const loading = (): Element | null => container.querySelector('[data-videorc-sounds-loading]')
    const failed = (): Element | null => container.querySelector('[data-videorc-sounds-failed]')
    const wait = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    it('reads again on a short ladder, then offers Retry, which reads at once', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const request = vi.fn().mockRejectedValue(new Error('request timed out'))
      const client = { request } as unknown as Parameters<typeof soundboard.connect>[0]
      soundboard.connect(client)
      try {
        setBoard({ sounds: [], loaded: false })
        await render()
        expect(request).toHaveBeenCalledTimes(1)
        expect(loading()?.textContent).toBe('Loading sounds…')
        await wait(SOUNDS_RETRY_MS[0])
        await wait(SOUNDS_RETRY_MS[1])
        expect(request).toHaveBeenCalledTimes(3)
        expect(loading()).not.toBeNull()
        await wait(SOUNDS_RETRY_MS[2])
        expect(request).toHaveBeenCalledTimes(4)
        expect(loading()).toBeNull()
        expect(failed()?.textContent).toContain("Couldn't load sounds")
        await wait(120_000)
        expect(request).toHaveBeenCalledTimes(4)

        request.mockResolvedValue(emptyBoard)
        await act(async () => button('Retry').click())
        await wait(0)
        expect(request).toHaveBeenCalledTimes(5)
        expect(soundboard.getSnapshot().board).toEqual(emptyBoard)
      } finally {
        soundboard.disconnect(client)
      }
    })

    it('never lets a late read overwrite a newer board', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let answer: (board: typeof emptyBoard) => void = () => undefined
      const request = vi
        .fn()
        .mockRejectedValueOnce(new Error('request timed out'))
        .mockImplementation(() => new Promise((done) => (answer = done)))
      const client = { request } as unknown as Parameters<typeof soundboard.connect>[0]
      soundboard.connect(client)
      try {
        setBoard({ sounds: [], loaded: false })
        await render()
        await wait(SOUNDS_RETRY_MS[0])
        expect(request).toHaveBeenCalledTimes(2)
        const newer = { ...emptyBoard, volumeDb: -6 }
        soundboard.acceptBoard(newer)
        answer(emptyBoard)
        await wait(0)
        expect(soundboard.getSnapshot().board).toEqual(newer)
      } finally {
        soundboard.disconnect(client)
      }
    })
  })
})
