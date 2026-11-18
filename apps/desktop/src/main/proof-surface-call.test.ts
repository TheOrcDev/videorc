import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
  ProofSurfaceGoneError,
  executeProofSurfaceScript,
  runDetachedProofSurfaceWork,
  settleWithProofSurface
} from './proof-surface-call'

class FakeSurface extends EventEmitter {
  destroyed = false
  scripts: string[] = []
  readonly webContents = {
    executeJavaScript: (code: string): Promise<unknown> => {
      this.scripts.push(code)
      return this.pending
    }
  }
  // The call that never settles on its own: what a closed WebContentsView's
  // web contents does to a pending executeJavaScript (plan 216 C regression).
  pending: Promise<unknown> = new Promise(() => undefined)
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

describe('settleWithProofSurface', () => {
  it('passes a settled call through and drops its closed listener', async () => {
    const surface = new FakeSurface()
    await expect(settleWithProofSurface(surface, () => Promise.resolve(42))).resolves.toBe(42)
    await expect(
      settleWithProofSurface(surface, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    expect(surface.listenerCount('closed')).toBe(0)
  })

  it('rejects a hung call once the surface is destroyed, so a queued mutation ends', async () => {
    const surface = new FakeSurface()
    const call = settleWithProofSurface(surface, () => surface.pending)
    let settled = false
    void call.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    surface.destroy()
    await expect(call).rejects.toBeInstanceOf(ProofSurfaceGoneError)
    expect(surface.listenerCount('closed')).toBe(0)
  })

  it('rejects without calling when the surface is already destroyed', async () => {
    const surface = new FakeSurface()
    surface.destroy()
    let called = 0
    await expect(
      settleWithProofSurface(surface, () => {
        called += 1
        return Promise.resolve()
      })
    ).rejects.toBeInstanceOf(ProofSurfaceGoneError)
    expect(called).toBe(0)
  })

  it('rejects with the call error when the call itself throws', async () => {
    const surface = new FakeSurface()
    await expect(
      settleWithProofSurface(surface, () => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
    expect(surface.listenerCount('closed')).toBe(0)
  })

  it('keeps the first settlement when the call settles after the surface closed', async () => {
    const surface = new FakeSurface()
    let resolveCall: (value: string) => void = () => undefined
    const call = settleWithProofSurface(
      surface,
      () => new Promise<string>((resolve) => (resolveCall = resolve))
    )
    surface.destroy()
    resolveCall('late')
    await expect(call).rejects.toBeInstanceOf(ProofSurfaceGoneError)
  })
})

describe('executeProofSurfaceScript', () => {
  it('runs the script as a user gesture and settles with the surface', async () => {
    const surface = new FakeSurface()
    surface.pending = Promise.resolve('function')
    await expect(
      executeProofSurfaceScript(surface, 'typeof window.__videorcSetPreviewScene')
    ).resolves.toBe('function')
    expect(surface.scripts).toEqual(['typeof window.__videorcSetPreviewScene'])

    const hung = new FakeSurface()
    const call = executeProofSurfaceScript(
      hung,
      'window.__videorcSetProofSurfaceSuspended?.(false)'
    )
    hung.destroy()
    await expect(call).rejects.toThrow('Proof surface was destroyed before the call settled.')
  })
})

describe('runDetachedProofSurfaceWork', () => {
  // QA F1: a debounced/void resync awaiting a script on a surface the preview
  // lifecycle destroys must not end as an unhandled rejection in main.
  it('ends surface-gone cancellation as a normal outcome, not an unhandled rejection', async () => {
    const surface = new FakeSurface()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const errors: unknown[] = []
    const gone: unknown[] = []
    try {
      runDetachedProofSurfaceWork(
        async () => {
          await executeProofSurfaceScript(surface, 'window.__videorcSetFramePollingProfile?.({})')
        },
        { onError: (error) => errors.push(error), onSurfaceGone: (error) => gone.push(error) }
      )
      await Promise.resolve()
      surface.destroy()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
    expect(errors).toEqual([])
    expect(gone).toHaveLength(1)
    expect(gone[0]).toBeInstanceOf(ProofSurfaceGoneError)
  })

  it('reports any other failure through onError, never swallowing it', async () => {
    const errors: unknown[] = []
    const gone: unknown[] = []
    const failure = new Error('script threw')
    runDetachedProofSurfaceWork(() => Promise.reject(failure), {
      onError: (error) => errors.push(error),
      onSurfaceGone: (error) => gone.push(error)
    })
    runDetachedProofSurfaceWork(
      () => {
        throw failure
      },
      { onError: (error) => errors.push(error) }
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual([failure, failure])
    expect(gone).toEqual([])
  })
})
