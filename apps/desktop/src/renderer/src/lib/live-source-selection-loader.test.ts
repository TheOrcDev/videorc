import { describe, expect, it, vi } from 'vitest'
import * as controllerModule from './live-source-selection'
import { LazyLiveSourceSelectionController } from './live-source-selection-loader'
import type { SessionSources } from './backend'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const snapshot = (sessionId: string): SessionSources => ({
  sessionId,
  sourceRevision: 0,
  confirmed: {
    screenId: null,
    windowId: null,
    cameraId: null,
    microphoneId: null,
    testPattern: false
  },
  pending: null,
  lastOperation: null,
  audio: null,
  outputProcessId: 7,
  health: [],
  capabilities: [{ kind: 'microphone', supported: true, reason: null }]
})
function options() {
  return {
    get: vi.fn(async (id: string) => snapshot(id)),
    switch: vi.fn(async () => snapshot('new')),
    changed: vi.fn(),
    confirmed: vi.fn(),
    requestId: () => 'request'
  }
}
describe('lazy live source controller admission', () => {
  it('blocks all active picker actions during load and uses latest session authority', async () => {
    const module = deferred<typeof controllerModule>()
    const callbacks = options()
    const controller = new LazyLiveSourceSelectionController(callbacks, () => module.promise)
    controller.setSession('old', 'starting')
    const refresh = controller.refresh()
    for (const kind of ['capture', 'camera', 'microphone'] as const)
      expect(controller.reason(kind)).toContain('Loading')
    await expect(controller.select('microphone', null, Promise.resolve([]))).rejects.toThrow(
      'loading'
    )
    controller.setSession('new', 'recording')
    module.resolve(controllerModule)
    await refresh
    expect(callbacks.get).toHaveBeenCalledExactlyOnceWith('new')
    expect(callbacks.switch).not.toHaveBeenCalled()
    expect(controller.reason('microphone')).toBeNull()
    controller.dispose()
  })
  it('does not initialize or publish after disposal and permits a fresh StrictMode activation', async () => {
    const first = deferred<typeof controllerModule>()
    const callbacks = options()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(controllerModule)
    const controller = new LazyLiveSourceSelectionController(callbacks, load)
    controller.setSession('old', 'recording')
    const oldRefresh = controller.refresh()
    controller.dispose()
    controller.setSession('new', 'recording')
    await controller.refresh()
    const changes = callbacks.changed.mock.calls.length
    first.reject(new Error('late obsolete chunk error'))
    await oldRefresh
    expect(callbacks.changed).toHaveBeenCalledTimes(changes)
    expect(callbacks.get).toHaveBeenCalledExactlyOnceWith('new')
    controller.dispose()
  })
  it('clears a load failure on Stop and ignores a late failure while idle', async () => {
    const callbacks = options()
    const late = deferred<typeof controllerModule>()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(late.promise)
    const controller = new LazyLiveSourceSelectionController(callbacks, load)
    controller.setSession('active', 'recording')
    await controller.refresh()
    expect(callbacks.changed).toHaveBeenLastCalledWith(expect.objectContaining({ checking: true }))
    const retry = controller.retryStatus()
    controller.setSession(null, 'idle')
    const changes = callbacks.changed.mock.calls.length
    expect(callbacks.changed).toHaveBeenLastCalledWith({
      snapshot: null,
      pending: null,
      checking: false,
      error: null
    })
    late.reject(new Error('late chunk failure'))
    await retry
    expect(callbacks.changed).toHaveBeenCalledTimes(changes)
    expect(controller.reason('microphone')).toBeNull()
    controller.dispose()
  })

  it('exposes a chunk failure and retries without admitting an unloaded action', async () => {
    const callbacks = options()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(controllerModule)
    const controller = new LazyLiveSourceSelectionController(callbacks, load)
    controller.setSession('new', 'recording')
    await controller.refresh()
    expect(callbacks.changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ checking: true, error: expect.stringContaining('Retry') })
    )
    await expect(controller.select('microphone', null, Promise.resolve([]))).rejects.toThrow(
      'loading'
    )
    await controller.retryStatus()
    expect(callbacks.get).toHaveBeenCalledExactlyOnceWith('new')
    expect(controller.reason('microphone')).toBeNull()
    controller.dispose()
  })
})
