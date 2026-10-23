// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Sound } from '@/lib/backend'
import { SOUND_COUNT_LIMIT_REASON } from '@/lib/sounds'

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
    expect(row('airhorn').querySelector('[aria-label="How Airhorn plays"]')?.textContent).toBe(
      'Play once'
    )
    expect(row('gong').querySelector('[aria-label="How Gong plays"]')?.textContent).toBe(
      'Play/stop'
    )
    expect(row('airhorn').querySelector('[aria-label="Airhorn volume"]')).not.toBeNull()
    expect(row('airhorn').textContent).toContain('−3.0 dB')
    expect(row('airhorn').querySelector('[aria-label="Airhorn key"]')?.textContent).toBe('1')
    expect(row('gong').querySelector('[aria-label="Gong key"]')?.textContent).toBe('None')
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

  it('imports from the header, and says why not at 24 sounds', async () => {
    await render()
    await act(async () => button('Import sounds…').click())
    expect(board().importSounds).toHaveBeenCalled()
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
})
