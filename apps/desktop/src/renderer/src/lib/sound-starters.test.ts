import { describe, expect, it, vi } from 'vitest'

import type { Sound, SoundboardState } from './backend'
import { importStarterFiles, restoreStarterSounds, seedStarterSounds } from './sound-starters'
import { SOUND_COUNT_LIMIT_REASON } from './sounds'
import { createSoundboardStore } from './soundboard-store'
import type { StarterSoundFile } from '../../../shared/sound-commands'

// Plan 189 "Starter sounds": seeded once per profile through the same import
// path, a removed starter stays removed, and Restore adds only what is gone.

const starters = [
  { slug: 'airhorn', name: 'Airhorn', hotkey: '1' as const },
  { slug: 'applause', name: 'Applause', hotkey: '2' as const },
  { slug: 'crickets', name: 'Crickets' }
]
const file = (starter: (typeof starters)[number]): StarterSoundFile => ({
  ...starter,
  selection: { capabilityId: `cap-${starter.slug}`, kind: 'input-file', displayName: starter.slug }
})
const sound = (id: string, overrides: Partial<Sound> = {}): Sound => ({
  id,
  name: id,
  file: `${id}.wav`,
  durationMs: 1000,
  loudnessLufs: -18,
  levelDb: 0,
  volumeDb: 0,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z',
  ...overrides
})
const boardWith = (sounds: Sound[], startersSeeded: boolean): SoundboardState => ({
  sounds,
  volumeDb: 0,
  monitor: true,
  startersSeeded
})

function setup(sounds: Sound[], startersSeeded = false) {
  const store = createSoundboardStore()
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sounds.list') return new Promise(() => undefined)
    if (method === 'sounds.settings') return boardWith(sounds, true)
    return { method, params }
  })
  store.connect({ request } as never)
  store.acceptBoard(boardWith(sounds, startersSeeded))
  const api = {
    getStarterSounds: vi.fn(async () => starters),
    getStarterSoundFiles: vi.fn(async (slugs?: string[]) =>
      starters.filter((starter) => !slugs || slugs.includes(starter.slug)).map(file)
    )
  }
  return { store, request, api }
}

const imports = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(([method]) => method === 'sounds.import').map(([, params]) => params)

describe('starter sounds (plan 189)', () => {
  it('imports every starter with its slug, name and key, then marks the board seeded', async () => {
    const { store, request, api } = setup([])
    await seedStarterSounds(store, api)
    expect(imports(request)).toEqual([
      {
        sourceCapability: 'cap-airhorn',
        starter: { slug: 'airhorn', name: 'Airhorn', hotkey: '1' }
      },
      {
        sourceCapability: 'cap-applause',
        starter: { slug: 'applause', name: 'Applause', hotkey: '2' }
      },
      { sourceCapability: 'cap-crickets', starter: { slug: 'crickets', name: 'Crickets' } }
    ])
    expect(request).toHaveBeenLastCalledWith('sounds.settings', { startersSeeded: true })
    expect(store.getSnapshot().board?.startersSeeded).toBe(true)
  })

  it('skips the starters the board has, and leaves a key the streamer took', async () => {
    const { store, request, api } = setup([
      sound('mine', { hotkey: '2' }),
      sound('a', { starter: 'airhorn', hotkey: '1' })
    ])
    await seedStarterSounds(store, api)
    expect(api.getStarterSoundFiles).toHaveBeenCalledWith(['applause', 'crickets'])
    expect(imports(request)).toEqual([
      { sourceCapability: 'cap-applause', starter: { slug: 'applause', name: 'Applause' } },
      { sourceCapability: 'cap-crickets', starter: { slug: 'crickets', name: 'Crickets' } }
    ])
  })

  it('marks nothing without a manifest, or when the connection goes mid-run', async () => {
    const empty = setup([])
    empty.api.getStarterSounds.mockResolvedValueOnce([])
    await seedStarterSounds(empty.store, empty.api)
    expect(empty.request).not.toHaveBeenCalledWith('sounds.settings', expect.anything())

    const cut = setup([])
    cut.request.mockImplementation(async (method: string) => {
      if (method === 'sounds.import') throw new Error("Videorc's engine connection closed.")
      return new Promise(() => undefined)
    })
    await seedStarterSounds(cut.store, cut.api)
    expect(imports(cut.request)).toHaveLength(1)
    expect(cut.request).not.toHaveBeenCalledWith('sounds.settings', expect.anything())
  })

  it('ends a run at a limit refusal and reports it; other failures are counted', async () => {
    const { store, request } = setup([])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method !== 'sounds.import') return new Promise(() => undefined)
      const slug = (params as { starter: { slug: string } }).starter.slug
      if (slug === 'airhorn') throw new Error('This file has no sound Videorc can play.')
      if (slug === 'applause') throw new Error(SOUND_COUNT_LIMIT_REASON)
      return {}
    })
    const outcome = await importStarterFiles(store, starters.map(file))
    expect(outcome).toEqual({
      imported: 0,
      failed: 1,
      refusal: SOUND_COUNT_LIMIT_REASON,
      offline: false
    })
    expect(imports(request)).toHaveLength(2)
  })

  it('restores only the missing starters', async () => {
    const { store, request, api } = setup(
      [sound('a', { starter: 'airhorn' }), sound('c', { starter: 'crickets' })],
      true
    )
    const outcome = await restoreStarterSounds(store, api)
    expect(api.getStarterSoundFiles).toHaveBeenCalledWith(['applause'])
    expect(outcome).toMatchObject({ imported: 1, failed: 0 })
    expect(imports(request)).toHaveLength(1)
  })
})
