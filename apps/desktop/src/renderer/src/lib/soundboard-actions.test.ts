import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Sound, SoundboardState } from './backend'
import { createSoundboardStore } from './soundboard-store'
import { SOUND_COUNT_LIMIT_REASON } from './sounds'

// Plan 189: the page actions. A refusal is a warning with the backend's
// sentence, an action that works says nothing, and Remove waits for its Undo.

const toasts = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('./toast', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const {
  SOUND_REMOVE_UNDO_MS,
  changeSoundboardSettings,
  importSounds,
  moveSound,
  removeSoundWithUndo,
  runSoundboardAction,
  updateSound
} = await import('./soundboard-actions')

const sound = (id: string): Sound => ({
  id,
  name: id === 'a' ? 'Airhorn' : id,
  file: `${id}.wav`,
  durationMs: 1000,
  loudnessLufs: -18,
  levelDb: 0,
  volumeDb: 0,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z'
})
const board: SoundboardState = {
  sounds: [sound('a'), sound('b')],
  volumeDb: 0,
  monitor: true,
  startersSeeded: true
}

function setup() {
  const store = createSoundboardStore()
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'sounds.list') return new Promise(() => undefined)
    if (method === 'sounds.settings') return { ...board, ...(params as object) }
    return {}
  })
  store.connect({ request } as never)
  store.acceptBoard(board)
  return { store, request }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  for (const spy of Object.values(toasts)) spy.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('soundboard actions (plan 189)', () => {
  it('plays quietly, and a refusal is a warning with its sentence', async () => {
    const { store, request } = setup()
    expect(await runSoundboardAction(store, { action: 'play', id: 'a' })).toBe(true)
    expect(request).toHaveBeenCalledWith('sounds.play', { id: 'a' })
    expect(toasts.warning).not.toHaveBeenCalled()
    request.mockRejectedValueOnce(new Error("That sound isn't available anymore."))
    expect(await runSoundboardAction(store, { action: 'press', id: 'a' })).toBe(false)
    expect(toasts.warning).toHaveBeenCalledWith("Couldn't play the sound", {
      id: 'sound-action',
      description: "That sound isn't available anymore."
    })
  })

  it('says Videorc is reconnecting when there is no connection', async () => {
    const store = createSoundboardStore()
    expect(await runSoundboardAction(store, { action: 'stopAll' })).toBe(false)
    expect(toasts.warning).toHaveBeenCalledWith(
      "Couldn't stop the sounds",
      expect.objectContaining({ description: 'Videorc is reconnecting. Try again in a moment.' })
    )
  })

  it('changes, moves and sets the board through their RPCs', async () => {
    const { store, request } = setup()
    await updateSound(store, 'a', { hotkey: '' })
    expect(request).toHaveBeenCalledWith('sounds.update', { id: 'a', hotkey: '' })
    expect(await moveSound(store, 'b', 0)).toBe(true)
    expect(request).toHaveBeenCalledWith('sounds.reorder', { ids: ['b', 'a'] })
    expect(await moveSound(store, 'a', 0)).toBe(false)
    expect(await changeSoundboardSettings(store, { monitor: false })).toBe(true)
    expect(store.getSnapshot().board?.monitor).toBe(false)
  })

  it('removes after the Undo toast closes, and Undo keeps the sound', () => {
    const { store, request } = setup()
    removeSoundWithUndo(store, sound('a'))
    expect(store.getSnapshot().hidden.has('a')).toBe(true)
    const [title, options] = toasts.message.mock.calls[0]
    expect(title).toBe('Removed Airhorn')
    expect(options).toMatchObject({ id: 'sound-remove-a', duration: SOUND_REMOVE_UNDO_MS })
    expect(options.action.label).toBe('Undo')
    expect(request).not.toHaveBeenCalledWith('sounds.delete', expect.anything())
    options.onAutoClose()
    expect(request).toHaveBeenCalledWith('sounds.delete', { id: 'a' })

    removeSoundWithUndo(store, sound('b'))
    const [, undoOptions] = toasts.message.mock.calls[1]
    undoOptions.action.onClick()
    undoOptions.onDismiss()
    expect(store.getSnapshot().hidden.has('b')).toBe(false)
    expect(request).not.toHaveBeenCalledWith('sounds.delete', { id: 'b' })
  })

  it('imports each picked file, and a limit refusal ends the batch', async () => {
    const { store, request } = setup()
    const selection = (name: string) => ({
      capabilityId: `cap-${name}`,
      kind: 'input-file' as const,
      displayName: name
    })
    vi.stubGlobal('window', {
      videorc: {
        pickSoundFiles: vi.fn(async () => [
          selection('one.wav'),
          selection('two.mp3'),
          selection('three.ogg')
        ])
      }
    })
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method !== 'sounds.import') return new Promise(() => undefined)
      if ((params as { sourceCapability: string }).sourceCapability === 'cap-two.mp3') {
        throw new Error(SOUND_COUNT_LIMIT_REASON)
      }
      return sound('new')
    })
    const phases: string[] = []
    await importSounds(store, (phase) => phases.push(phase))
    expect(phases).toEqual(['choosing', 'importing', 'idle'])
    expect(
      request.mock.calls.filter(([method]) => method === 'sounds.import').map(([, p]) => p)
    ).toEqual([{ sourceCapability: 'cap-one.wav' }, { sourceCapability: 'cap-two.mp3' }])
    expect(toasts.warning).toHaveBeenCalledWith("Couldn't import “two.mp3”", {
      id: 'sound-import',
      description: SOUND_COUNT_LIMIT_REASON
    })
  })
})
