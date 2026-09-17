import { describe, expect, it, vi } from 'vitest'

import { requestMediaAccessWithRestart, type MediaAccessDeps } from './media-access'

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
