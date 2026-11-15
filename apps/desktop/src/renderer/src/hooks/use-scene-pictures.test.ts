// @vitest-environment happy-dom
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenePictureTarget, ScenePicturesResult } from '@/lib/backend'
import { scenePictureTargetKey, useScenePictures } from './use-scene-pictures'

interface Request {
  method: string
  params: { targets: ScenePictureTarget[]; maxWidth: number }
  resolve: (value: ScenePicturesResult) => void
  reject: (error: Error) => void
}
const fake = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  clients: [] as Array<{ requests: Request[]; closed: boolean }>
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => fake.core }))
vi.mock('@/backendClient', () => ({
  BackendClient: class {
    requests: Request[] = []
    closed = false
    constructor() {
      fake.clients.push(this)
    }
    connect(): Promise<void> {
      return Promise.resolve()
    }
    close(): void {
      this.closed = true
      for (const request of this.requests) request.reject(new Error('closed'))
    }
    requestTyped(method: string, params: Request['params']): Promise<ScenePicturesResult> {
      return new Promise((resolve, reject) =>
        this.requests.push({ method, params, resolve, reject })
      )
    }
  }
}))

const app: ScenePictureTarget = { kind: 'app', bundleId: 'com.figma.Desktop' }
const display: ScenePictureTarget = { kind: 'display', screenId: 'screen:screencapturekit:1' }
const windowTarget: ScenePictureTarget = { kind: 'window', windowId: 'window:screencapturekit:7' }
let root: Root
let container: HTMLDivElement
let pictures: Map<string, string>
function Probe(props: { targets: ScenePictureTarget[]; hidden: boolean; busy: boolean }): null {
  pictures = useScenePictures(props)
  return null
}
async function render(
  targets: ScenePictureTarget[] = [app],
  hidden = false,
  busy = false,
  strict = false
): Promise<void> {
  const probe = createElement(Probe, { targets, hidden, busy })
  await act(async () => root.render(strict ? createElement(StrictMode, null, probe) : probe))
}
function requests(): Request[] {
  return fake.clients.flatMap((client) => client.requests)
}
async function answer(
  index = requests().length - 1,
  extra: Partial<ScenePicturesResult> = {}
): Promise<void> {
  const request = requests()[index]
  await act(async () =>
    request.resolve({
      pictures: request.params.targets.map((target) => ({ target, jpegBase64: '/9j/4AAQ' })),
      elapsedMs: 10,
      ...extra
    })
  )
}
async function visible(state: DocumentVisibilityState): Promise<void> {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake.core = {
    connection: { host: '127.0.0.1', port: 4000, token: 'fixture' },
    wsStatus: 'connected',
    runtimeInfo: { platform: 'darwin' }
  }
  fake.clients = []
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scene still pictures (plan 231 S5)', () => {
  it('batches every kind, returns keyed URLs, and never polls periodically', async () => {
    await render([app, display, windowTarget])
    expect(requests()).toHaveLength(1)
    expect(requests()[0]).toMatchObject({
      method: 'sources.scene_pictures',
      params: { targets: [app, display, windowTarget], maxWidth: 240 }
    })
    await answer()
    expect(pictures.get(scenePictureTargetKey(app))).toBe('data:image/jpeg;base64,/9j/4AAQ')
    expect(pictures.size).toBe(3)
    await advance(29_999)
    expect(requests()).toHaveLength(1)
    await render([windowTarget, display, { ...app }])
    expect(requests()).toHaveLength(1)
    await advance(90_000)
    expect(requests()).toHaveLength(1)
  })
  it('does not refresh for target removal or reorder', async () => {
    await render([app, display])
    await answer()
    await render([display, app])
    await render([app])
    await advance(90_000)
    expect(requests()).toHaveLength(1)
    await render([windowTarget])
    expect(requests()).toHaveLength(2)
  })
  it('refreshes when another scene adds the same target', async () => {
    await render([app])
    await answer()
    await render([app, { ...app }])
    expect(requests()).toHaveLength(2)
    expect(requests()[1].params.targets).toEqual([app, app])
  })
  it('never refreshes while the window is hidden, then refreshes on visibility', async () => {
    await visible('hidden')
    await render()
    await advance(90_000)
    expect(requests()).toHaveLength(0)
    await visible('visible')
    expect(requests()).toHaveLength(1)
    await answer()
    const last = pictures
    await visible('hidden')
    await render([display])
    await advance(90_000)
    expect(requests()).toHaveLength(1)
    expect(pictures).toBe(last)
    await visible('visible')
    expect(requests()).toHaveLength(2)
    expect(requests()[1].params.targets).toEqual([display])
  })
  it('defers hidden target changes until visible without applying the visibility cooldown', async () => {
    await render()
    await answer()
    await visible('hidden')
    await render([display])
    expect(requests()).toHaveLength(1)
    await advance(1_000)
    await visible('visible')
    expect(requests()).toHaveLength(2)
    expect(requests()[1].params.targets).toEqual([display])
  })
  it('limits visibility refreshes to once per 30 seconds without scheduling a retry', async () => {
    await render()
    await answer()
    await advance(10_000)
    await visible('hidden')
    await visible('visible')
    expect(requests()).toHaveLength(1)
    await advance(20_000)
    expect(requests()).toHaveLength(1)
    await visible('hidden')
    await visible('visible')
    expect(requests()).toHaveLength(2)
  })
  it('freezes while recording or live, drops late answers, and refreshes once on idle', async () => {
    await render()
    await answer()
    const last = pictures
    await render([display])
    await render([display], false, true)
    await answer()
    await render([windowTarget], false, true)
    await visible('hidden')
    await advance(90_000)
    await visible('visible')
    expect(requests()).toHaveLength(2)
    expect(pictures).toBe(last)
    await render([windowTarget], false, false)
    expect(requests()).toHaveLength(3)
    expect(requests()[2].params.targets).toEqual([windowTarget])
    await answer()
    await advance(90_000)
    expect(requests()).toHaveLength(3)
  })
  it('does not request on a busy mount or idle transition while Hide screen holds', async () => {
    await render([app], true, true)
    await advance(90_000)
    await render([app], true, false)
    expect(requests()).toHaveLength(0)
    await render([app], false, false)
    expect(requests()).toHaveLength(1)
  })
  it('freezes the last pictures for Hide screen, including changes and late responses', async () => {
    await render()
    await answer()
    const last = pictures
    await render([display])
    expect(requests()).toHaveLength(2)
    await render([display], true)
    await answer()
    await advance(90_000)
    await visible('hidden')
    await visible('visible')
    expect(requests()).toHaveLength(2)
    expect(pictures).toBe(last)
    await render([windowTarget], true)
    expect(requests()).toHaveLength(2)
    await render([windowTarget], false)
    expect(requests()).toHaveLength(3)
  })
  it('coalesces target changes with only one call in flight and drops obsolete answers', async () => {
    await render()
    await render([display])
    await render([windowTarget])
    await advance(90_000)
    expect(requests()).toHaveLength(1)
    await answer(0)
    expect(pictures.size).toBe(0)
    expect(requests()).toHaveLength(2)
    expect(requests()[1].params.targets).toEqual([windowTarget])
    await answer(1)
    expect([...pictures.keys()]).toEqual([scenePictureTargetKey(windowTarget)])
  })
  it('discards an answer spanning a hidden/visible cycle and retries once', async () => {
    await render()
    await visible('hidden')
    await advance(30_000)
    await visible('visible')
    await answer(0)
    expect(pictures.size).toBe(0)
    expect(requests()).toHaveLength(2)
    await answer(1)
    expect(pictures.size).toBe(1)
  })
  it('keeps glyphs on unsupported platforms and stops polling an unsupported RPC', async () => {
    fake.core.runtimeInfo = { platform: 'win32' }
    await render()
    expect(fake.clients).toHaveLength(0)
    expect(pictures.size).toBe(0)
    fake.core.runtimeInfo = { platform: 'darwin' }
    await render()
    await answer(0, { unsupported: true, pictures: [] })
    await advance(90_000)
    await render([display])
    await visible('hidden')
    await visible('visible')
    expect(requests()).toHaveLength(1)
    expect(pictures.size).toBe(0)
  })
  it('holds pictures for backend refusals and failures and cleans up in StrictMode', async () => {
    await render([app], false, false, true)
    expect(requests().length).toBeGreaterThan(0)
    await answer()
    const last = pictures
    await render([display], false, false, true)
    await answer(undefined, { hidden: true, pictures: [] })
    expect(pictures).toBe(last)
    await render([windowTarget], false, false, true)
    await act(async () => requests().at(-1)?.reject(new Error('offline')))
    expect(pictures).toBe(last)
    await act(async () => root.render(null))
    const count = requests().length
    await advance(90_000)
    expect(requests()).toHaveLength(count)
    expect(fake.clients.every((client) => client.closed)).toBe(true)
  })
})
