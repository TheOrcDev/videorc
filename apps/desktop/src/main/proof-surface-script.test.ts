import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  NativePreviewMutationQueue,
  runPreparedNativePreviewMutation
} from './native-preview-operation-queue'
import { executeProofSurfaceScript } from './proof-surface-script'

function contents() {
  const events = new EventEmitter()
  let destroyed = false
  return Object.assign(events, {
    isDestroyed: () => destroyed,
    executeJavaScript: vi.fn<(_code: string, _gesture?: boolean) => Promise<unknown>>(),
    destroy: () => {
      destroyed = true
      events.emit('destroyed')
    }
  })
}

describe('proof surface script lifetime', () => {
  it('returns the live result and removes its destruction listener', async () => {
    const page = contents()
    page.executeJavaScript.mockResolvedValue({ frame: 7 })
    await expect(executeProofSurfaceScript(page, 'present()', true)).resolves.toEqual({ frame: 7 })
    expect(page.executeJavaScript).toHaveBeenCalledWith('present()', true)
    expect(page.listenerCount('destroyed')).toBe(0)
  })

  it('propagates live script failures and removes listeners', async () => {
    const page = contents()
    const error = new Error('renderer failed')
    page.executeJavaScript.mockRejectedValueOnce(error).mockImplementationOnce(() => {
      throw error
    })
    await expect(executeProofSurfaceScript(page, 'present()')).rejects.toBe(error)
    await expect(executeProofSurfaceScript(page, 'present()')).rejects.toBe(error)
    expect(page.listenerCount('destroyed')).toBe(0)
  })

  it('never evaluates a script in a destroyed page', async () => {
    const page = contents()
    page.destroy()
    await expect(executeProofSurfaceScript(page, 'present()')).resolves.toBeUndefined()
    expect(page.executeJavaScript).not.toHaveBeenCalled()
  })

  it('releases queued teardown when a renderer dies with a never-settling evaluation', async () => {
    const page = contents()
    page.executeJavaScript.mockImplementation(() => new Promise(() => {}))
    const queue = new NativePreviewMutationQueue()
    const apply = vi.fn()
    const prepare = vi.fn(() => executeProofSurfaceScript(page, 'present()'))
    const update = runPreparedNativePreviewMutation(queue, {
      canApply: () => !page.isDestroyed(),
      prepare,
      apply,
      rejected: () => 'retired'
    })
    await Promise.resolve()
    expect(prepare).toHaveBeenCalledOnce()
    const teardown = vi.fn()
    const closed = queue.run(teardown, 'destroy')
    page.destroy()
    await expect(update).resolves.toBe('retired')
    await closed
    await queue.waitForIdle()
    expect(apply).not.toHaveBeenCalled()
    expect(teardown).toHaveBeenCalledOnce()
    expect(page.listenerCount('destroyed')).toBe(0)
    expect(queue.metrics().currentDepth).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a late %s without affecting the replacement page',
    async (outcome) => {
      const old = contents()
      const replacement = contents()
      let resolve!: (value: unknown) => void
      let reject!: (error: unknown) => void
      old.executeJavaScript.mockImplementation(
        () =>
          new Promise((yes, no) => {
            resolve = yes
            reject = no
          })
      )
      replacement.executeJavaScript.mockResolvedValue({ frame: 8 })
      const retired = executeProofSurfaceScript(old, 'present()')
      old.destroy()
      await expect(retired).resolves.toBeUndefined()
      if (outcome === 'resolve') resolve({ frame: 7 })
      else reject(new Error('old renderer died'))
      await expect(executeProofSurfaceScript(replacement, 'present()')).resolves.toEqual({
        frame: 8
      })
      expect(old.listenerCount('destroyed')).toBe(0)
      expect(replacement.isDestroyed()).toBe(false)
    }
  )
})
