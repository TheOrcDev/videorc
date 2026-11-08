import { describe, expect, it, vi } from 'vitest'

import {
  requestMediaAccessWithRestart,
  requestScreenAccessWithWatch,
  SCREEN_ACCESS_RESTART_REASON,
  type MediaAccessDeps,
  type ScreenAccessDeps
} from './media-access'

function deps(overrides: Partial<MediaAccessDeps> = {}): MediaAccessDeps {
  return {
    getStatus: vi.fn(() => 'not-determined'),
    askForAccess: vi.fn(async () => true),
    restartBackend: vi.fn(async () => ({ restarted: true })),
    stopGrantWatcher: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
}

describe('requestMediaAccessWithRestart', () => {
  it('already-granted skips the prompt AND the backend restart (the FX1 race)', async () => {
    const d = deps({ getStatus: vi.fn(() => 'granted') })
    await expect(requestMediaAccessWithRestart(d, 'microphone')).resolves.toEqual({
      granted: true,
      restarted: false
    })
    expect(d.askForAccess).not.toHaveBeenCalled()
    expect(d.restartBackend).not.toHaveBeenCalled()
  })

  it('not-determined → user grants → watcher stopped + backend restarted', async () => {
    const d = deps({
      restartBackend: vi.fn(async () => ({
        restarted: true,
        staleBackend: { pid: 42, port: 9988 }
      }))
    })
    await expect(requestMediaAccessWithRestart(d, 'camera')).resolves.toEqual({
      granted: true,
      restarted: true,
      staleBackend: { pid: 42, port: 9988 }
    })
    expect(d.stopGrantWatcher).toHaveBeenCalledOnce()
    expect(d.restartBackend).toHaveBeenCalledOnce()
  })

  it('reports a granted permission without claiming a deferred restart already ran', async () => {
    const d = deps({
      restartBackend: vi.fn(async () => ({
        restarted: false,
        staleBackend: { pid: 43, port: 9989 }
      }))
    })

    await expect(requestMediaAccessWithRestart(d, 'camera')).resolves.toEqual({
      granted: true,
      restarted: false,
      staleBackend: { pid: 43, port: 9989 }
    })
  })

  it('not-determined → user denies → no restart', async () => {
    const d = deps({ askForAccess: vi.fn(async () => false) })
    await expect(requestMediaAccessWithRestart(d, 'microphone')).resolves.toEqual({
      granted: false,
      restarted: false
    })
    expect(d.restartBackend).not.toHaveBeenCalled()
  })

  it('previously denied never re-prompts (System Settings is the only door)', async () => {
    const d = deps({ getStatus: vi.fn(() => 'denied') })
    await expect(requestMediaAccessWithRestart(d, 'camera')).resolves.toEqual({
      granted: false,
      restarted: false
    })
    expect(d.askForAccess).not.toHaveBeenCalled()
  })

  it('status/prompt errors log a warning and report not granted', async () => {
    const throwing = deps({
      getStatus: vi.fn(() => {
        throw new Error('tcc unavailable')
      })
    })
    await expect(requestMediaAccessWithRestart(throwing, 'microphone')).resolves.toEqual({
      granted: false,
      restarted: false
    })
    expect(throwing.log).toHaveBeenCalled()

    const rejecting = deps({ askForAccess: vi.fn(async () => Promise.reject(new Error('boom'))) })
    await expect(requestMediaAccessWithRestart(rejecting, 'camera')).resolves.toEqual({
      granted: false,
      restarted: false
    })
    expect(rejecting.log).toHaveBeenCalled()
  })
})

function screenDeps(overrides: Partial<ScreenAccessDeps> = {}): ScreenAccessDeps {
  return {
    platform: 'darwin',
    getStatus: vi.fn(() => 'not-determined'),
    requestAccess: vi.fn(async () => undefined),
    watchGrant: vi.fn(),
    restartBackend: vi.fn(async () => ({ restarted: true })),
    stopGrantWatcher: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
}

describe('requestScreenAccessWithWatch (plan 203 S2)', () => {
  it('answers not-applicable off macOS without asking or watching', async () => {
    const d = screenDeps({ platform: 'win32' })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'not-applicable',
      granted: false,
      restarted: false
    })
    expect(d.getStatus).not.toHaveBeenCalled()
    expect(d.requestAccess).not.toHaveBeenCalled()
    expect(d.watchGrant).not.toHaveBeenCalled()
  })

  it('already-granted skips the request, the watcher and the restart', async () => {
    const d = screenDeps({ getStatus: vi.fn(() => 'granted') })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'granted',
      granted: true,
      restarted: false
    })
    expect(d.requestAccess).not.toHaveBeenCalled()
    expect(d.watchGrant).not.toHaveBeenCalled()
    expect(d.restartBackend).not.toHaveBeenCalled()
  })

  it('denied or restricted never re-prompts (System Settings is the only door)', async () => {
    for (const status of ['denied', 'restricted'] as const) {
      const d = screenDeps({ getStatus: vi.fn(() => status) })
      await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
        status,
        granted: false,
        restarted: false
      })
      expect(d.requestAccess).not.toHaveBeenCalled()
      expect(d.watchGrant).not.toHaveBeenCalled()
    }
  })

  it('not-determined: starts the watcher, then asks, and reports the status after the request', async () => {
    const order: string[] = []
    const d = screenDeps({
      watchGrant: vi.fn(() => {
        order.push('watch')
      }),
      requestAccess: vi.fn(async () => {
        order.push('request')
      })
    })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'not-determined',
      granted: false,
      restarted: false
    })
    expect(order).toEqual(['watch', 'request'])
    expect(d.watchGrant).toHaveBeenCalledWith(SCREEN_ACCESS_RESTART_REASON)
    expect(d.restartBackend).not.toHaveBeenCalled()
    expect(d.stopGrantWatcher).not.toHaveBeenCalled()
  })

  it('a grant that lands in place restarts capture once and retires the watcher', async () => {
    const statuses = ['not-determined', 'granted']
    const d = screenDeps({
      getStatus: vi.fn(() => statuses.shift() ?? 'granted'),
      restartBackend: vi.fn(async () => ({
        restarted: true,
        staleBackend: { pid: 42, port: 9988 }
      }))
    })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'granted',
      granted: true,
      restarted: true,
      staleBackend: { pid: 42, port: 9988 }
    })
    expect(d.stopGrantWatcher).toHaveBeenCalledOnce()
    expect(d.restartBackend).toHaveBeenCalledOnce()
  })

  it('a failing request still leaves the watcher running and logs', async () => {
    const d = screenDeps({
      requestAccess: vi.fn(async () => Promise.reject(new Error('no sources')))
    })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'not-determined',
      granted: false,
      restarted: false
    })
    expect(d.watchGrant).toHaveBeenCalledOnce()
    expect(d.stopGrantWatcher).not.toHaveBeenCalled()
    expect(d.log).toHaveBeenCalled()
  })

  it('a status read error reports unknown without asking', async () => {
    const d = screenDeps({
      getStatus: vi.fn(() => {
        throw new Error('tcc unavailable')
      })
    })
    await expect(requestScreenAccessWithWatch(d)).resolves.toEqual({
      status: 'unknown',
      granted: false,
      restarted: false
    })
    expect(d.requestAccess).not.toHaveBeenCalled()
  })
})
