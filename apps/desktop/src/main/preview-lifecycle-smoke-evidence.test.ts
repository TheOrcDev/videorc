import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import {
  MAIN_WINDOW_NOT_READY,
  PreviewLifecycleSmokeEvidence
} from './preview-lifecycle-smoke-evidence'
import { SmokeAppQuitGuard } from './smoke-app-quit-guard'
import { handleSmokeCommandRequest } from './smoke-command-security'

class TestContents extends EventEmitter {
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

class TestWindow extends EventEmitter {
  destroyed = false
  webContents = new TestContents()
  title = 'private-window-canary'
  id = 456
  nativeWindowHandle = 'private-handle-canary'

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.emit('close')
    this.webContents.destroy()
    this.destroyed = true
    this.emit('closed')
  }
}

function fixture(enabled = true) {
  const main = new TestWindow()
  let current: TestWindow | null = main
  let appIsQuitting = false
  let atMs = 1000
  let cleanupCount = 0
  const lines: string[] = []
  const cleanupOrder: string[] = []
  const quitGuard = new SmokeAppQuitGuard(enabled)
  const evidence: PreviewLifecycleSmokeEvidence = new PreviewLifecycleSmokeEvidence({
    enabled,
    currentMainWindow: () => current,
    appIsQuitting: () => appIsQuitting,
    quitGuard,
    emit: (line) => lines.push(line),
    now: () => atMs++
  })
  const bind = (owner: TestWindow): void => {
    // This is the same registered callback seam used by index.ts. Its
    // supplied cleanup still clears the global owner; no stale-close fix
    // is introduced or claimed by the diagnostic fixture.
    evidence.bindMainWindow(owner, () => {
      cleanupOrder.push('cleanup')
      cleanupCount += 1
      current = null
    })
  }
  bind(main)
  return {
    main,
    evidence,
    quitGuard,
    lines,
    cleanupOrder,
    bind,
    current: () => current,
    cleanupCount: () => cleanupCount,
    replace: (owner: TestWindow | null) => {
      current = owner
    },
    markQuitting: () => {
      appIsQuitting = true
    },
    requireReady: (command: string) => {
      evidence.requireMainWindow(current, command)
    }
  }
}

describe('preview lifecycle main-owner evidence', () => {
  it('observes the actual closed callback before and after its unchanged cleanup', () => {
    const f = fixture()
    f.main.close()

    expect(f.cleanupCount()).toBe(1)
    expect(f.cleanupOrder).toEqual(['cleanup'])
    expect(f.current()).toBeNull()
    expect(() => f.requireReady('preview-window-toggle')).toThrow(MAIN_WINDOW_NOT_READY)
    expect(f.evidence.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'created', disposition: 'ready' }),
        expect.objectContaining({ event: 'close', callbackOwnerIsCurrent: true }),
        expect.objectContaining({ event: 'closed-before-cleanup', callbackOwnerIsCurrent: true }),
        expect.objectContaining({ event: 'closed-after-cleanup', disposition: 'absent' })
      ])
    )
    expect(f.evidence.snapshot().failedCommand).toMatchObject({
      command: 'preview-window-toggle',
      disposition: 'absent',
      attempts: 1
    })
  })

  it('distinguishes destroyed contents from a missing main window through real HTTP rejection', async () => {
    const f = fixture()
    f.main.webContents.destroy()
    const capability = 'a'.repeat(43)
    const server = createServer((request, response) => {
      void handleSmokeCommandRequest(request, response, {
        capability,
        runCommand: async (command) => {
          f.requireReady(command)
          return { ready: true }
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned fixture did not listen.')
      const response = await fetch('http://127.0.0.1:' + address.port + '/command', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'preview-window-set-mode', params: { mode: 'docked' } }),
        signal: AbortSignal.timeout(2000)
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: MAIN_WINDOW_NOT_READY })
    } finally {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned HTTP fixture did not close.')), 2000)
        server.close((error) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        })
        server.closeAllConnections()
      })
    }

    expect(f.current()).toBe(f.main)
    expect(f.main.isDestroyed()).toBe(false)
    expect(f.cleanupCount()).toBe(0)
    expect(f.evidence.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'contents-destroyed', disposition: 'contents-destroyed' })
      ])
    )
    expect(f.evidence.snapshot().failedCommand).toMatchObject({
      command: 'preview-window-set-mode',
      disposition: 'contents-destroyed'
    })
  })

  it('records that a late closed callback belonged to a retired owner without correcting it', () => {
    const f = fixture()
    const replacement = new TestWindow()
    f.replace(replacement)
    f.bind(replacement)
    f.main.close()

    expect(f.cleanupCount()).toBe(1)
    expect(f.current()).toBeNull()
    expect(f.evidence.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'closed-before-cleanup', callbackOwnerIsCurrent: false }),
        expect.objectContaining({ event: 'closed-after-cleanup', disposition: 'absent' })
      ])
    )
  })

  it('observes the actual prevented and allowed quit branches with the existing guard', () => {
    const f = fixture()
    const app = new EventEmitter()
    const calls: string[] = []
    const event = { preventDefault: () => calls.push('prevent') }
    f.evidence.bindBeforeQuit(app, {
      onPrevented: () => calls.push('warning'),
      onAllowed: () => {
        f.markQuitting()
        calls.push('shutdown')
      }
    })
    app.emit('before-quit', event)
    expect(calls).toEqual(['prevent', 'warning'])
    expect(f.quitGuard.shouldPreventQuit()).toBe(true)
    f.evidence.allowQuit()
    app.emit('before-quit', event)
    expect(calls).toEqual(['prevent', 'warning', 'shutdown'])
    expect(f.evidence.snapshot().events.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(['before-quit-prevented', 'quit-allowed', 'before-quit-allowed'])
    )
  })

  it('retains a bounded owner ring independently of repeated readiness refusals', () => {
    const f = fixture()
    for (let index = 0; index < 40; index += 1) {
      const window = new TestWindow()
      f.replace(window)
      f.bind(window)
      window.close()
    }
    const before = f.evidence.snapshot()
    for (let index = 0; index < 40; index += 1) {
      expect(() => f.requireReady('preview-window-toggle')).toThrow(MAIN_WINDOW_NOT_READY)
    }
    const after = f.evidence.snapshot()
    expect(before.events).toHaveLength(32)
    expect(before.omittedEvents).toBeGreaterThan(0)
    expect(after.events).toEqual(before.events)
    expect(after.failedCommand).toMatchObject({ attempts: 40, disposition: 'absent' })
    expect(JSON.stringify(after)).not.toContain('private-')
    expect(JSON.stringify(after)).not.toContain('nativeWindowHandle')
    expect(JSON.stringify(after)).not.toContain('"id"')
  })

  it('preserves normal quit and closed cleanup outside the probe', () => {
    const f = fixture(false)
    const app = new EventEmitter()
    const calls: string[] = []
    f.evidence.bindBeforeQuit(app, {
      onPrevented: () => calls.push('unexpected'),
      onAllowed: () => calls.push('shutdown')
    })
    app.emit('before-quit', { preventDefault: () => calls.push('unexpected') })
    f.main.close()
    expect(calls).toEqual(['shutdown'])
    expect(f.cleanupCount()).toBe(1)
    expect(f.evidence.snapshot()).toEqual({ events: [], omittedEvents: 0, failedCommand: null })
    expect(f.lines).toEqual([])
    expect(f.main.listenerCount('close')).toBe(0)
    expect(f.main.listenerCount('closed')).toBe(1)
    expect(f.main.webContents.listenerCount('destroyed')).toBe(0)
    expect(f.main.webContents.listenerCount('render-process-gone')).toBe(0)
  })

  it('distinguishes renderer loss from contents destruction without retaining its details', () => {
    const f = fixture()
    f.main.webContents.emit(
      'render-process-gone',
      {},
      {
        reason: 'crashed',
        exitCode: 123,
        private: 'private-renderer-canary'
      }
    )
    expect(() => f.requireReady('preview-window-state')).not.toThrow()
    expect(f.evidence.snapshot().events.at(-1)).toMatchObject({
      event: 'renderer-gone',
      disposition: 'ready',
      rendererGoneReason: 'crashed'
    })
    f.main.webContents.emit('render-process-gone', {}, { reason: 'private-reason-canary' })
    expect(f.evidence.snapshot().events.at(-1)?.rendererGoneReason).toBe('unknown')
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain('private-')
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain('exitCode')
  })

  it('preserves the exact readiness predicate and sanitizes the first failed command', () => {
    const f = fixture()
    f.main.destroyed = true
    // The existing predicate checks only absence and webContents destruction.
    // A window-only destroyed flag is evidence, never an added refusal.
    expect(() => f.requireReady('preview-window-state')).not.toThrow()
    f.main.webContents.destroy()
    expect(() => f.requireReady('private-command-canary')).toThrow(MAIN_WINDOW_NOT_READY)
    f.replace(null)
    expect(() => f.requireReady('app-quit')).toThrow(MAIN_WINDOW_NOT_READY)
    expect(f.evidence.snapshot().failedCommand).toMatchObject({
      command: 'other-command',
      disposition: 'window-destroyed',
      attempts: 2
    })
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain('private-')
  })

  it('keeps snapshots detached from retained evidence', () => {
    const f = fixture()
    f.main.close()
    expect(() => f.requireReady('preview-window-toggle')).toThrow(MAIN_WINDOW_NOT_READY)
    const original = f.evidence.snapshot()
    const edited = f.evidence.snapshot()
    edited.events[0].disposition = 'unknown'
    edited.events.length = 0
    if (edited.failedCommand) edited.failedCommand.attempts = 999
    expect(f.evidence.snapshot()).toEqual(original)
  })

  it('ignores throwing sinks without changing cleanup, quit or the readiness error', () => {
    const main = new TestWindow()
    let current: TestWindow | null = main
    let cleanup = 0
    const evidence: PreviewLifecycleSmokeEvidence = new PreviewLifecycleSmokeEvidence({
      enabled: true,
      currentMainWindow: () => current,
      appIsQuitting: () => false,
      quitGuard: new SmokeAppQuitGuard(true),
      emit: () => {
        throw new Error('private-sink-canary')
      }
    })
    evidence.bindMainWindow(main, () => {
      cleanup += 1
      current = null
    })
    expect(() => main.close()).not.toThrow()
    expect(cleanup).toBe(1)
    expect(() => evidence.requireMainWindow(current, 'preview-window-toggle')).toThrow(
      MAIN_WINDOW_NOT_READY
    )
    const app = new EventEmitter()
    const order: string[] = []
    evidence.bindBeforeQuit(app, {
      onPrevented: () => order.push('prevented'),
      onAllowed: () => order.push('allowed')
    })
    app.emit('before-quit', { preventDefault: () => order.push('preventDefault') })
    evidence.allowQuit()
    app.emit('before-quit', { preventDefault: () => order.push('unexpected') })
    expect(order).toEqual(['preventDefault', 'prevented', 'allowed'])
    expect(evidence.snapshot().failedCommand?.attempts).toBe(1)
    expect(JSON.stringify(evidence.snapshot())).not.toContain('private-')
  })

  it('preserves the original cleanup exception when observers cannot sample', () => {
    const main = new TestWindow()
    const original = new Error('original cleanup failure')
    const evidence: PreviewLifecycleSmokeEvidence = new PreviewLifecycleSmokeEvidence({
      enabled: true,
      currentMainWindow: () => {
        throw new Error('observer cannot read owner')
      },
      appIsQuitting: () => false,
      quitGuard: new SmokeAppQuitGuard(true),
      now: () => Number.NaN,
      emit: () => {
        throw new Error('unexpected emission')
      }
    })
    evidence.bindMainWindow(main, () => {
      throw original
    })
    expect(() => main.close()).toThrow(original)
    expect(() => evidence.requireMainWindow(null, 'preview-window-toggle')).toThrow(
      MAIN_WINDOW_NOT_READY
    )
    expect(evidence.snapshot()).toEqual({ events: [], omittedEvents: 0, failedCommand: null })
  })
})
