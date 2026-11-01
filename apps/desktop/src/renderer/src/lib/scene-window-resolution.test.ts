import { describe, expect, it, vi } from 'vitest'
import type { Device, ResolveAppWindowResult } from './backend'
import { defaultCaptureConfig, mergeSourceKind } from './capture'
import { scenesForApps } from './scene-apps'
import { hydrateWorkingScene, type SceneVisual } from './scene-presets'
import {
  heldAppWindow,
  rememberedSceneApps,
  rememberSceneWindowApp,
  resolveSceneWindowForApply,
  reconcileWorkingSceneSources,
  savedSceneApplyRetryAllowed,
  sceneAppState,
  sceneWindowRefusal,
  withoutSceneApp
} from './scene-window-resolution'

const app = { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
const visual = (): SceneVisual => ({
  layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
  sources: { windowId: 'window:screencapturekit:old', app },
  background: null
})
const device: Device = {
  id: 'window:screencapturekit:new',
  name: 'New design',
  kind: 'window',
  status: 'available',
  app: { ...app, pid: 12 }
}
const screen: Device = {
  id: 'screen:screencapturekit:1',
  name: 'Display',
  kind: 'screen',
  status: 'available'
}
const success: ResolveAppWindowResult = {
  ok: true,
  windowId: device.id,
  title: device.name,
  width: 800,
  height: 600
}

describe('scene window wiring', () => {
  it('resolves before apply, passes the preferred id, and never rewrites the saved visual', async () => {
    const saved = visual()
    const before = structuredClone(saved)
    const rpc = vi.fn(async () => success)
    expect(await resolveSceneWindowForApply(saved, [], rpc)).toMatchObject({
      kind: 'ready',
      sources: { windowId: device.id, app }
    })
    expect(rpc).toHaveBeenCalledWith({
      bundleId: app.bundleId,
      preferWindowId: saved.sources.windowId
    })
    expect(saved).toEqual(before)
  })
  it.each([
    ['not-running', "Figma isn't open"],
    ['no-window', 'Figma has no window open'],
    ['minimized', "Figma's window is minimized"]
  ] as const)('returns a typed %s refusal and shared caller copy', async (reason, message) => {
    const result = await resolveSceneWindowForApply(
      visual(),
      [],
      vi.fn(async (): Promise<ResolveAppWindowResult> => ({ ok: false, reason }))
    )
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') throw new Error('Expected refusal')
    expect(sceneWindowRefusal(visual(), result.reason)).toEqual({
      ok: false,
      reason: `app-${reason}`,
      message
    })
  })
  it('tries an exact legacy window, then remembered app, then source repair', async () => {
    const legacy = visual()
    delete legacy.sources.app
    const rpc = vi.fn(async () => success)
    expect(
      (
        await resolveSceneWindowForApply(
          legacy,
          [{ ...device, id: legacy.sources.windowId! }],
          rpc,
          app.bundleId
        )
      ).kind
    ).toBe('ready')
    expect(rpc).not.toHaveBeenCalled()
    expect((await resolveSceneWindowForApply(legacy, [], rpc, app.bundleId)).kind).toBe('ready')
    expect(rpc).toHaveBeenCalledOnce()
    expect(
      (
        await resolveSceneWindowForApply(
          legacy,
          [],
          async () => ({ ok: false, reason: 'no-window' }),
          app.bundleId
        )
      ).kind
    ).toBe('resolve-sources')
    expect((await resolveSceneWindowForApply(legacy, [], rpc)).kind).toBe('resolve-sources')
  })
  it('fills separate device memory, prunes deleted scenes and caps it at 200', () => {
    const scene = scenesForApps([{ ...app }], visual(), [], { id: () => 's', now: () => '' })[0]
    const legacy = { windowId: device.id }
    expect(rememberSceneWindowApp({}, 's', legacy, [device], [scene])).toEqual({ s: app.bundleId })
    expect(rememberedSceneApps({ s: app.bundleId, gone: app.bundleId, bad: 4 }, [scene])).toEqual({
      s: app.bundleId
    })
    const scenes = Array.from({ length: 205 }, (_, i) => ({ id: `s${i}` }))
    const memory = rememberedSceneApps(
      Object.fromEntries(scenes.map((s) => [s.id, app.bundleId])),
      scenes
    )
    expect(Object.keys(memory)).toHaveLength(200)
    expect(memory.s0).toBeUndefined()
  })
  it('restores working app identity at launch and resolves a different title before exact-name reconciliation', async () => {
    const working = hydrateWorkingScene(
      JSON.parse(JSON.stringify({ version: 1, sceneId: 's', visual: visual() }))
    )!
    const { sources: next, appState } = await reconcileWorkingSceneSources(
      working.visual.sources,
      [screen],
      vi.fn(async () => success)
    )
    expect(next.windowId).toBe(device.id)
    expect(next.captureOff).toBe(false)
    expect(next.app).toEqual(app)
    expect(appState).toBe('ready')
    expect(withoutSceneApp(next)).not.toHaveProperty('app')
  })
  // Plan 210 D1: the app quit overnight. The scene stays on, waiting for the
  // app's next window with no screen: never a whole display under its name.
  it.each(['not-running', 'no-window', 'minimized'] as const)(
    'holds Screen None on a working app refusal (%s), keeping app memory for its return',
    async (reason) => {
      const { sources: next, appState } = await reconcileWorkingSceneSources(
        visual().sources,
        [screen, device],
        vi.fn(async (): Promise<ResolveAppWindowResult> => ({ ok: false, reason }))
      )
      expect(next.screenId).toBeUndefined()
      expect(next.windowId).toBeUndefined()
      expect(next.captureOff).toBe(true)
      expect(next.app).toEqual(app)
      expect(appState).toBe(reason)
    }
  )
  it('takes the window on the refresh that finds the app again', async () => {
    const gone = await reconcileWorkingSceneSources(
      visual().sources,
      [screen],
      vi.fn(async (): Promise<ResolveAppWindowResult> => ({ ok: false, reason: 'not-running' }))
    )
    const back = await reconcileWorkingSceneSources(
      gone.sources,
      [screen, device],
      vi.fn(async () => success)
    )
    expect(back.sources.windowId).toBe(device.id)
    expect(back.sources.captureOff).toBe(false)
    expect(back.appState).toBe('ready')
  })
  it('answers no app state for a scene without an app, or before the first device list', async () => {
    const plain = await reconcileWorkingSceneSources(
      { ...visual().sources, app: undefined },
      [screen],
      vi.fn()
    )
    expect(plain.appState).toBeUndefined()
    const early = await reconcileWorkingSceneSources(visual().sources, [], vi.fn())
    expect(early.appState).toBeUndefined()
    expect(early.sources.windowId).toBe('window:screencapturekit:old')
  })
  it('exposes lazy app state and clears app identity on a manual capture pick', () => {
    expect(sceneAppState(visual(), [device])).toBe('ready')
    expect(sceneAppState(visual(), [], 'minimized')).toBe('minimized')
    expect(sceneAppState(visual(), [device], 'no-window')).toBe('no-window')
    expect(sceneAppState(visual(), [])).toBe('not-running')
    expect(sceneAppState({ ...visual(), sources: {} }, [])).toBeUndefined()
    expect(
      mergeSourceKind(visual().sources, { screenId: screen.id }, 'capture')
    ).not.toHaveProperty('app')
  })
})

describe('app scene switch without a resolver round trip (plan 210 D5)', () => {
  const remembered: Device = {
    id: 'window:screencapturekit:old',
    name: 'Figma — Old design',
    windowTitle: 'Old design',
    kind: 'window',
    status: 'available',
    app: { ...app, pid: 12 },
    width: 1280,
    height: 720
  }
  it('answers from the held list when it lists the remembered window under the scene app', async () => {
    const rpc = vi.fn(async () => success)
    const result = await resolveSceneWindowForApply(visual(), [remembered, screen], rpc)
    expect(result).toMatchObject({
      kind: 'ready',
      sources: {
        windowId: remembered.id,
        windowName: 'Old design',
        app,
        captureOff: false,
        testPattern: false
      }
    })
    expect(rpc).not.toHaveBeenCalled()
  })
  it("answers the follower's front window from the held list too", async () => {
    const front: Device = {
      ...remembered,
      id: 'window:screencapturekit:front',
      windowTitle: 'Front'
    }
    const rpc = vi.fn(async () => success)
    const result = await resolveSceneWindowForApply(
      visual(),
      [remembered, front],
      rpc,
      undefined,
      front.id
    )
    expect(result).toMatchObject({ kind: 'ready', sources: { windowId: front.id } })
    expect(rpc).not.toHaveBeenCalled()
  })
  const askedCases: Array<[string, Device[], SceneVisual | undefined]> = [
    ['the window is gone', [screen], undefined],
    ['the window is listed unavailable', [{ ...remembered, status: 'unavailable' }], undefined],
    [
      'the window belongs to another app',
      [{ ...remembered, app: { ...remembered.app!, bundleId: 'com.other' } }],
      undefined
    ],
    ['the window is a palette', [{ ...remembered, width: 320, height: 200 }], undefined],
    ['the scene remembers no window', [remembered], { ...visual(), sources: { app } }]
  ]
  it.each(askedCases)('asks the backend when %s', async (_case, devices, saved) => {
    const rpc = vi.fn(async () => success)
    const result = await resolveSceneWindowForApply(saved ?? visual(), devices, rpc)
    expect(result).toMatchObject({ kind: 'ready', sources: { windowId: device.id } })
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('asks the backend on a forced retry even when the held list answers', async () => {
    const rpc = vi.fn(async () => success)
    const result = await resolveSceneWindowForApply(
      visual(),
      [remembered],
      rpc,
      undefined,
      undefined,
      {
        forceResolve: true
      }
    )
    expect(result).toMatchObject({ kind: 'ready', sources: { windowId: device.id } })
    expect(rpc).toHaveBeenCalledWith({ bundleId: app.bundleId, preferWindowId: remembered.id })
  })
  it('judges a held window by id, app, availability and size', () => {
    expect(heldAppWindow([remembered], app.bundleId, remembered.id)).toBe(remembered)
    expect(heldAppWindow([remembered], app.bundleId, undefined)).toBeUndefined()
    expect(
      heldAppWindow(
        [{ ...remembered, width: undefined, height: undefined }],
        app.bundleId,
        remembered.id
      )
    ).toBeDefined()
    expect(
      heldAppWindow([{ ...remembered, kind: 'screen' }], app.bundleId, remembered.id)
    ).toBeUndefined()
  })
  it('retries a refused switch once, only while the pick is still the latest', () => {
    const base = { attempt: 0, generation: 3, latestGeneration: 3, intent: 10, latestIntent: 10 }
    expect(savedSceneApplyRetryAllowed(base)).toBe(true)
    expect(savedSceneApplyRetryAllowed({ ...base, attempt: 1 })).toBe(false)
    expect(savedSceneApplyRetryAllowed({ ...base, latestGeneration: 4 })).toBe(false)
    expect(savedSceneApplyRetryAllowed({ ...base, latestIntent: 11 })).toBe(false)
  })
})
