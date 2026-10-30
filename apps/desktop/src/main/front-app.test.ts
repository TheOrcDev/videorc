import { describe, expect, it, vi } from 'vitest'
import { createFrontAppMonitor, frontAppSenderIsMain, type FrontAppBinding } from './front-app'
import { apiForRendererRole } from '../preload/api-policy'
import type { VideorcApi } from '../shared/backend'
import {
  validateElectronEventPayload,
  validateElectronInvokeArgs
} from '../shared/electron-ipc-contract'

function fixture(platform = 'darwin') {
  let activate: ((app: { name: string; pid: number }) => void) | undefined
  let tick: (() => void) | undefined
  let windowId: string | undefined = 'window:screencapturekit:42'
  const app = { name: 'Fixture', pid: 12 }
  const cancel = vi.fn()
  const binding: FrontAppBinding = {
    frontmostApp: vi.fn(() => app),
    frontWindowForPid: vi.fn(() => (windowId ? { windowId, width: 800, height: 600 } : null)),
    selfBundleId: vi.fn(() => 'test.self'),
    startFrontAppObserver: vi.fn((cb) => {
      activate = cb
    }),
    stopFrontAppObserver: vi.fn()
  }
  const send = vi.fn()
  const every = vi.fn((cb: () => void, _ms: number) => {
    tick = cb
    return cancel
  })
  const monitor = createFrontAppMonitor({ platform, binding, send, every, now: () => 123 })
  return {
    monitor,
    binding,
    send,
    every,
    cancel,
    app,
    activate: () => activate?.(app),
    tick: () => tick?.(),
    setWindow: (id?: string) => {
      windowId = id
    }
  }
}

describe('front app monitor', () => {
  it('dedupes metadata regardless of timestamp and drops callbacks after stop', () => {
    const f = fixture()
    f.monitor.start()
    f.activate()
    f.activate()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][0]).toEqual({
      ...f.app,
      frontWindowId: 'window:screencapturekit:42',
      at: 123
    })
    f.monitor.stop()
    f.activate()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.binding.stopFrontAppObserver).toHaveBeenCalledOnce()
  })
  it('polls at 2 Hz only while enabled, including window disappearance', () => {
    const f = fixture()
    f.monitor.start()
    expect(f.every).not.toHaveBeenCalled()
    f.monitor.setWatch(true)
    expect(f.every).toHaveBeenCalledWith(expect.any(Function), 500)
    f.tick()
    expect(f.send).toHaveBeenCalledTimes(1)
    f.setWindow('window:screencapturekit:43')
    f.tick()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.setWindow()
    f.tick()
    expect(f.send.mock.calls[2][0].frontWindowId).toBeUndefined()
    f.monitor.setWatch(false)
    expect(f.cancel).toHaveBeenCalledOnce()
    f.setWindow('window:screencapturekit:44')
    f.tick()
    expect(f.send).toHaveBeenCalledTimes(3)
    f.monitor.stop()
  })
  it('preserves a watch requested before the renderer finishes loading', () => {
    const f = fixture()
    f.monitor.setWatch(true)
    expect(f.every).not.toHaveBeenCalled()
    f.monitor.start()
    expect(f.every).toHaveBeenCalledOnce()
    f.monitor.stop()
    expect(f.cancel).toHaveBeenCalledOnce()
  })
  it.each(['win32', 'linux'])('is inert on %s', (platform) => {
    const f = fixture(platform)
    f.monitor.start()
    f.monitor.setWatch(true)
    f.monitor.stop()
    expect(f.monitor.selfBundleIds()).toEqual([])
    expect(f.binding.startFrontAppObserver).not.toHaveBeenCalled()
    expect(f.every).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('gets the real self bundle id', () => {
    expect(fixture().monitor.selfBundleIds()).toEqual(['test.self'])
  })
  it('accepts only the current main sender and exposes no auxiliary API', () => {
    expect(frontAppSenderIsMain(2, 2)).toBe(true)
    expect(frontAppSenderIsMain(3, 2)).toBe(false)
    expect(frontAppSenderIsMain(2, undefined)).toBe(false)
    const api = {
      onFrontAppChanged: vi.fn(),
      setFrontWindowWatch: vi.fn(),
      getSelfBundleIds: vi.fn()
    } as unknown as VideorcApi
    for (const role of ['notes', 'comments', 'captions'] as const) {
      expect(apiForRendererRole(api, role)).not.toHaveProperty('onFrontAppChanged')
      expect(apiForRendererRole(api, role)).not.toHaveProperty('setFrontWindowWatch')
      expect(apiForRendererRole(api, role)).not.toHaveProperty('getSelfBundleIds')
    }
  })
  it('validates the new IPC boundary', () => {
    expect(validateElectronInvokeArgs('app:front-window-watch', [{ enabled: true }])).toEqual([
      { enabled: true }
    ])
    expect(() => validateElectronInvokeArgs('app:front-window-watch', ['true'])).toThrow()
    expect(() =>
      validateElectronEventPayload('app:front-changed', {
        name: 'x',
        pid: 2,
        at: 1,
        title: 'secret'
      })
    ).toThrow()
  })
})
