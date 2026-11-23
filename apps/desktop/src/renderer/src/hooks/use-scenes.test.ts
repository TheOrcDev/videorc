// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SCENE_LIBRARY_KEY, WORKING_SCENE_KEY } from '@/lib/scene-presets'
import { SCENES_KEY, type Scene } from '@/lib/scenes'
import { hydrateScenes } from '@/lib/scenes-store'
import { defaultScenes } from '@/lib/scenes-migration'
import { prepareScenes, useScenes } from './use-scenes'

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }))
import { toast } from '@/lib/toast'

/** A profile's localStorage, from the same fixtures the migration tests read. */
function seed(name: string): void {
  // happy-dom's URL is not Node's: resolve the path as a string.
  const storage = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), `../lib/__fixtures__/scenes/${name}.json`),
      'utf8'
    )
  ) as Record<string, unknown>
  for (const [key, value] of Object.entries(storage))
    localStorage.setItem(key, JSON.stringify(value))
}

let unmount: (() => Promise<void>) | null = null

async function mount(strict = false): Promise<{ current: ReturnType<typeof useScenes> }> {
  const result = {} as { current: ReturnType<typeof useScenes> }
  function Probe() {
    result.current = useScenes()
    return null
  }
  // As the Studio does before its first render.
  await prepareScenes()
  const root = createRoot(document.createElement('div'))
  await act(async () =>
    root.render(
      strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe)
    )
  )
  unmount = async () => {
    await act(async () => root.unmount())
    unmount = null
  }
  return result
}

// The profile's storage, as an in-memory stand-in whose calls can be counted
// and made to fail (happy-dom's own is not reachable through Storage.prototype).
let stored = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string): string | null => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string): void => void stored.set(key, value)),
  removeItem: vi.fn((key: string): void => void stored.delete(key)),
  clear: vi.fn((): void => stored.clear())
}

/** Every write from here on. */
function watchWrites() {
  storage.setItem.mockClear()
  return storage.setItem
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stored = new Map()
  for (const mock of Object.values(storage)) mock.mockClear()
  storage.getItem.mockImplementation((key) => stored.get(key) ?? null)
  storage.setItem.mockImplementation((key, value) => void stored.set(key, value))
  vi.stubGlobal('localStorage', storage)
})

afterEach(async () => {
  await unmount?.()
  vi.unstubAllGlobals()
  vi.mocked(toast.error).mockClear()
})

it('migrates once, in one setItem, and never writes v1', async () => {
  seed('plan-210-user')
  const v1 = localStorage.getItem(SCENE_LIBRARY_KEY)
  const writes = watchWrites()
  const first = await mount()
  expect(writes).toHaveBeenCalledTimes(1)
  expect(writes.mock.calls[0]![0]).toBe(SCENES_KEY)
  expect(localStorage.getItem(SCENE_LIBRARY_KEY)).toBe(v1)
  expect(first.current.scenes.map(({ name }) => name)).toEqual([
    'Figma',
    'T3 Code',
    'Screen only',
    'Camera only',
    'Side by side'
  ])
  expect(first.current.onStreamId).toBe('5d0c8a4e-figma')
  expect(first.current.readOnly).toBe(false)
  expect(first.current.error).toBeNull()
  expect(first.current.migratedShortcuts).toEqual({
    scenes: { '9b7e21c3-t3code': 'Control+Alt+T' }
  })
  const written = hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!))
  expect(written.library?.scenes).toEqual(first.current.scenes)
  expect(written.library?.onStreamId).toBe('5d0c8a4e-figma')
  const migrated = first.current.scenes

  // The keys wait in the library until the Studio stored its settings.
  expect(written.library?.pendingShortcuts).toEqual(first.current.migratedShortcuts)

  // The next launch reads v2: no migration, no write, the same scenes.
  await unmount!()
  writes.mockClear()
  const second = await mount()
  expect(writes).not.toHaveBeenCalled()
  expect(second.current.scenes).toEqual(migrated)
  expect(second.current.onStreamId).toBe('5d0c8a4e-figma')
  // Review #5: the first launch never settled its keys (its settings write
  // failed, or it was cut short): this one saves them again, the same keys,
  // and never makes the library again.
  expect(second.current.migratedShortcuts).toEqual({
    scenes: { '9b7e21c3-t3code': 'Control+Alt+T' }
  })
  await act(async () => expect(second.current.settleShortcuts()).toBe(true))
  expect(second.current.migratedShortcuts).toBeNull()
  expect(writes).toHaveBeenCalledTimes(1)
  const settled = hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library!
  expect(settled.pendingShortcuts).toBeUndefined()
  expect(settled.scenes).toEqual(migrated)

  // Settled: the launch after migrates nothing and saves no keys.
  await unmount!()
  writes.mockClear()
  const third = await mount()
  expect(writes).not.toHaveBeenCalled()
  expect(third.current.migratedShortcuts).toBeNull()
  expect(third.current.scenes).toEqual(migrated)
})

// Review #5: every other write keeps the pending keys with the library, and a
// failed settle keeps them for the next launch.
it('keeps the pending keys through library edits and a failed settle', async () => {
  seed('builtin-user-layout-keys')
  const result = await mount()
  const pending = result.current.migratedShortcuts
  expect(pending?.scenes).toBeDefined()
  const stored = () => hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library!
  await act(async () => expect(result.current.rename('default-screen-only', 'Board')).toBe(true))
  expect(stored().pendingShortcuts).toEqual(pending)
  storage.setItem.mockImplementationOnce(() => {
    throw new Error('QuotaExceededError')
  })
  await act(async () => expect(result.current.settleShortcuts()).toBe(false))
  expect(result.current.migratedShortcuts).toEqual(pending)
  expect(stored().pendingShortcuts).toEqual(pending)
  expect(toast.error).not.toHaveBeenCalled()
  await act(async () => expect(result.current.settleShortcuts()).toBe(true))
  expect(stored().pendingShortcuts).toBeUndefined()
  expect(stored().scenes.find(({ id }) => id === 'default-screen-only')?.name).toBe('Board')
})

it('writes the migration once under StrictMode', async () => {
  seed('builtin-user-layout-keys')
  const writes = watchWrites()
  const result = await mount(true)
  expect(writes).toHaveBeenCalledTimes(1)
  expect(writes.mock.calls[0]![0]).toBe(SCENES_KEY)
  expect(result.current.migratedShortcuts?.layouts).toBeUndefined()
  expect(result.current.migratedShortcuts?.scenes).toEqual({
    'default-screen-camera': 'Control+Alt+1',
    'default-camera-only': 'Control+Alt+3',
    'default-side-by-side': 'Control+Alt+7'
  })
  expect(hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library?.scenes).toEqual(
    result.current.scenes
  )
})

it('gives a new user the four defaults', async () => {
  const writes = watchWrites()
  const result = await mount()
  expect(result.current.scenes.map(({ id }) => id)).toEqual([
    'default-screen-camera',
    'default-screen-only',
    'default-camera-only',
    'default-side-by-side'
  ])
  expect(result.current.onStreamId).toBe('default-screen-camera')
  expect(writes).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(SCENE_LIBRARY_KEY)).toBeNull()
})

it('is read-only on an unknown version: nothing is written, today’s setup stays usable', async () => {
  seed('unknown-version')
  const future = localStorage.getItem(SCENES_KEY)
  const writes = watchWrites()
  const result = await mount()
  expect(result.current.readOnly).toBe(true)
  expect(result.current.error).toBe(
    'Update Videorc to open these scenes. Your saved data is preserved.'
  )
  expect(result.current.migratedShortcuts).toBeNull()
  // In memory only: the four defaults on today's screen, never the v1 scenes.
  expect(result.current.scenes.map(({ name }) => name)).toEqual([
    'Screen + camera',
    'Screen only',
    'Camera only',
    'Side by side'
  ])
  expect(result.current.onStreamId).toBe('default-screen-camera')
  const scene = result.current.scenes[1]!
  await act(async () => {
    expect(result.current.rename(scene.id, 'Mine')).toBe(false)
    expect(result.current.move(scene.id, 0)).toBe(false)
    expect(result.current.setOnStream(scene.id)).toBe(false)
    expect(result.current.remove(scene.id, { sessionActive: false })).toBe(false)
    expect(result.current.replace({ ...scene, name: 'Mine' })).toBe(false)
    expect(result.current.insert([{ ...scene, id: 'new', name: 'New' }])).toBe(false)
  })
  expect(writes).not.toHaveBeenCalled()
  expect(localStorage.getItem(SCENES_KEY)).toBe(future)
  expect(result.current.scenes[1]!.name).toBe('Screen only')
})

it('writes every change as the whole library in one setItem, to v2 only', async () => {
  seed('plan-210-user')
  const v1 = localStorage.getItem(SCENE_LIBRARY_KEY)
  const result = await mount()
  const writes = watchWrites()
  const written = () => hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library!
  const names = () => result.current.scenes.map(({ name }) => name)
  const chrome: Scene = {
    ...result.current.scenes[0]!,
    id: 'chrome',
    name: 'Chrome',
    shows: { kind: 'app', bundleId: 'com.google.Chrome', name: 'Chrome', follows: true }
  }

  // A new scene goes at the end, so no key in use moves (D5).
  await act(async () => expect(result.current.insert([chrome])).toBe(true))
  expect(names()).toEqual([
    'Figma',
    'T3 Code',
    'Screen only',
    'Camera only',
    'Side by side',
    'Chrome'
  ])
  // A duplicate goes right after its original; a taken name or id is refused.
  await act(async () => {
    expect(result.current.insert([{ ...chrome, id: 'chrome-2', name: 'Chrome 2' }], 'chrome')).toBe(
      true
    )
    expect(result.current.insert([{ ...chrome, id: 'other' }])).toBe(false)
    expect(result.current.insert([{ ...chrome, name: 'Other' }])).toBe(false)
    expect(
      result.current.insert([{ ...chrome, id: 'bad', name: 'Bad', shows: {} as Scene['shows'] }])
    ).toBe(false)
  })
  expect(names().slice(-2)).toEqual(['Chrome', 'Chrome 2'])

  await act(async () => expect(result.current.move('chrome', 0)).toBe(true))
  expect(names()[0]).toBe('Chrome')
  await act(async () => {
    expect(result.current.move('chrome', 0)).toBe(false)
    expect(result.current.move('gone', 1)).toBe(false)
  })

  await act(async () => expect(result.current.rename('chrome', ' Browser ')).toBe(true))
  expect(names()[0]).toBe('Browser')
  await act(async () => expect(result.current.rename('chrome', 'figma')).toBe(false))
  expect(toast.error).toHaveBeenCalledWith('A scene with this name already exists.')

  await act(async () =>
    expect(
      result.current.replace({
        ...result.current.scenes[0]!,
        shows: { kind: 'display', screenId: 'screen:2', screenName: 'Display 2' }
      })
    ).toBe(true)
  )
  expect(result.current.scenes[0]!.shows).toEqual({
    kind: 'display',
    screenId: 'screen:2',
    screenName: 'Display 2'
  })
  await act(async () => {
    expect(result.current.replace({ ...chrome, id: 'gone' })).toBe(false)
    expect(result.current.replace({ ...result.current.scenes[0]!, name: 'Figma' })).toBe(false)
  })

  await act(async () => expect(result.current.setOnStream('chrome')).toBe(true))
  expect(result.current.onStreamId).toBe('chrome')
  expect(written().onStreamId).toBe('chrome')
  await act(async () => expect(result.current.setOnStream('gone')).toBe(false))

  // D16: live, the scene on stream stays; off air it goes after naming the next one on stream.
  await act(async () =>
    expect(result.current.remove('chrome', { sessionActive: true })).toBe(false)
  )
  await act(async () =>
    expect(result.current.remove('chrome', { sessionActive: false })).toBe(true)
  )
  expect(names()).toEqual([
    'Figma',
    'T3 Code',
    'Screen only',
    'Camera only',
    'Side by side',
    'Chrome 2'
  ])
  expect(result.current.onStreamId).toBe('5d0c8a4e-figma')
  await act(async () =>
    expect(result.current.remove('chrome-2', { sessionActive: true })).toBe(true)
  )

  // Eight changes, eight writes, all of them v2; setOnStream to itself writes nothing.
  await act(async () => expect(result.current.setOnStream('5d0c8a4e-figma')).toBe(true))
  expect(writes.mock.calls.map(([key]) => key)).toEqual(Array(8).fill(SCENES_KEY))
  expect(written().scenes).toEqual(result.current.scenes)
  expect(localStorage.getItem(SCENE_LIBRARY_KEY)).toBe(v1)
})

it('never deletes the last scene', async () => {
  localStorage.setItem(
    SCENES_KEY,
    JSON.stringify({
      version: 2,
      scenes: defaultScenes(null, '2026-11-15T12:00:00.000Z').slice(0, 1),
      onStreamId: 'default-screen-camera'
    })
  )
  const result = await mount()
  // The launch marked the library checked (`verticalLayoutsRepaired`); the refusal writes nothing.
  const writes = watchWrites()
  await act(async () =>
    expect(result.current.remove('default-screen-camera', { sessionActive: false })).toBe(false)
  )
  expect(result.current.scenes).toHaveLength(1)
  expect(writes).not.toHaveBeenCalled()
})

it('keeps working when storage refuses every read and write', async () => {
  seed('plan-210-user')
  storage.getItem.mockImplementation(() => {
    throw new Error('storage is unavailable')
  })
  const writes = watchWrites().mockImplementation(() => {
    throw new Error('quota exceeded')
  })
  const result = await mount()
  // Nothing readable is a new user's defaults, in memory; the silent first write failed.
  expect(result.current.scenes.map(({ id }) => id)).toEqual([
    'default-screen-camera',
    'default-screen-only',
    'default-camera-only',
    'default-side-by-side'
  ])
  expect(writes).toHaveBeenCalledTimes(1)
  expect(toast.error).not.toHaveBeenCalled()
  await act(async () => expect(result.current.move('default-screen-only', 0)).toBe(false))
  expect(result.current.scenes[0]!.id).toBe('default-screen-camera')
  expect(toast.error).toHaveBeenCalledWith("Couldn't save the scene", {
    id: 'scene-save-storage',
    description: 'Free up disk space, then save it again.'
  })
})

it('writes the migration with the first change when the first write failed', async () => {
  seed('plan-210-user')
  const writes = watchWrites().mockImplementationOnce(() => {
    throw new Error('quota exceeded')
  })
  const result = await mount()
  expect(localStorage.getItem(SCENES_KEY)).toBeNull()
  await act(async () => expect(result.current.move('9b7e21c3-t3code', 0)).toBe(true))
  expect(writes).toHaveBeenCalledTimes(2)
  expect(
    hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library?.scenes.map(
      ({ name }) => name
    )
  ).toEqual(['T3 Code', 'Figma', 'Screen only', 'Camera only', 'Side by side'])
})

// Owner report 2026-11-23 (0.37.0): a library 0.34.0's migration made for a
// streamer whose last 9:16 pick was Camera only has a Screen + camera and a
// Side by side that show only the camera in 9:16. The launch repairs it once.
it('repairs a stored library whose Screen + camera and Side by side lost their screen in 9:16, once', async () => {
  seed('v2-vertical-camera-only')
  const working = localStorage.getItem(WORKING_SCENE_KEY)
  const writes = watchWrites()
  const first = await mount()
  expect(writes).toHaveBeenCalledTimes(1)
  expect(writes.mock.calls[0]![0]).toBe(SCENES_KEY)
  expect(
    first.current.scenes.map((scene) => [
      scene.name,
      scene.layouts.horizontal.layoutPreset,
      scene.layouts.vertical.layoutPreset
    ])
  ).toEqual([
    ['Screen + camera', 'screen-camera', 'vertical-camera-top'],
    ['Screen only', 'screen-only', 'vertical-screen-only'],
    ['Camera only', 'camera-only', 'vertical-camera-only'],
    ['Side by side', 'side-by-side', 'vertical-camera-top']
  ])
  expect(first.current.onStreamId).toBe('default-camera-only')
  expect(first.current.error).toBeNull()
  // Camera only is on stream: the working setup is left as it was.
  expect(localStorage.getItem(WORKING_SCENE_KEY)).toBe(working)
  const stored = hydrateScenes(JSON.parse(localStorage.getItem(SCENES_KEY)!)).library!
  expect(stored.verticalLayoutsRepaired).toBe(true)
  expect(stored.scenes).toEqual(first.current.scenes)

  // A 9:16 pick made after the repair is the streamer's: never undone.
  const sideBySide = first.current.scenes.find(({ id }) => id === 'default-side-by-side')!
  await act(async () =>
    expect(
      first.current.replace({
        ...sideBySide,
        layouts: {
          ...sideBySide.layouts,
          vertical: { ...sideBySide.layouts.vertical, layoutPreset: 'vertical-camera-only' }
        }
      })
    ).toBe(true)
  )
  await unmount!()
  writes.mockClear()
  const second = await mount()
  expect(writes).not.toHaveBeenCalled()
  expect(
    second.current.scenes.find(({ id }) => id === 'default-side-by-side')!.layouts.vertical
      .layoutPreset
  ).toBe('vertical-camera-only')
})

it('a failed repair write leaves the library as stored, and the next launch repairs it', async () => {
  seed('v2-vertical-camera-only')
  const before = localStorage.getItem(SCENES_KEY)
  watchWrites().mockImplementationOnce(() => {
    throw new Error('quota exceeded')
  })
  const first = await mount()
  expect(localStorage.getItem(SCENES_KEY)).toBe(before)
  expect(first.current.scenes[0]!.layouts.vertical.layoutPreset).toBe('vertical-camera-only')
  await unmount!()
  const second = await mount()
  expect(second.current.scenes[0]!.layouts.vertical.layoutPreset).toBe('vertical-camera-top')
})
