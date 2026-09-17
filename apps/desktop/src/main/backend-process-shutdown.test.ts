import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import {
  BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS,
  BACKEND_PRE_BOOTSTRAP_SHUTDOWN_TIMEOUT_MS,
  BACKEND_SHUTDOWN_KILL_GRACE_MS,
  BACKEND_SHUTDOWN_TIMEOUT_MS,
  backendQuitAction,
  backendShutdownAllowsForceKill,
  classifyBackendShutdownTarget,
  handleBackendBeforeQuit,
  installPersistentBackendShutdownSignalHandlers,
  stopPreBootstrapBackendProcess,
  stopBackendProcess,
  waitForBackendBootstrapOutputDrain
} from './backend-process-shutdown'

class FakeOutputStream extends EventEmitter {
  destroyed = false
  readableEnded = false
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kills: NodeJS.Signals[] = []
  stdout = new FakeOutputStream()
  stderr = new FakeOutputStream()

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }
}

describe('stopBackendProcess', () => {
  const expectedReceipt = { requestId: 'shutdown-request-1', backendPid: 42 }
  const validReceipt = {
    shutdownLatched: true,
    captureFinalizationComplete: true,
    ...expectedReceipt
  }

  it('keeps every repeated quit prevented until backend shutdown completes', () => {
    expect(backendQuitAction(false, false)).toBe('prevent-and-start')
    expect(backendQuitAction(false, true)).toBe('prevent-and-wait')
    expect(backendQuitAction(true, false)).toBe('allow')
    expect(backendQuitAction(true, true)).toBe('allow')
  })

  it('routes repeated process signals through graceful app quit every time', () => {
    const source = new EventEmitter()
    const requestQuit = vi.fn()
    installPersistentBackendShutdownSignalHandlers(source, requestQuit)

    source.emit('SIGTERM')
    source.emit('SIGTERM')
    source.emit('SIGINT')
    source.emit('SIGINT')

    expect(requestQuit.mock.calls).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGINT'], ['SIGINT']])
  })

  it('prevents every repeated before-quit event and never quits after shutdown rejection', async () => {
    const state = { complete: false, inProgress: false }
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }
    const quit = vi.fn()
    const onFailure = vi.fn()
    let rejectShutdown: (error: Error) => void = () => undefined
    const shutdown = new Promise<never>((_resolve, reject) => {
      rejectShutdown = reject
    })
    const options = { stopBackend: () => shutdown, quit, onFailure }

    expect(handleBackendBeforeQuit(firstEvent, state, options)).toBe('prevent-and-start')
    expect(handleBackendBeforeQuit(repeatedEvent, state, options)).toBe('prevent-and-wait')
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(state).toEqual({ complete: false, inProgress: true })

    const failure = new Error('shutdown receipt unavailable')
    rejectShutdown(failure)
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure))
    expect(state).toEqual({ complete: false, inProgress: false })
    expect(quit).not.toHaveBeenCalled()
  })

  it('allows exactly the follow-up quit after backend shutdown succeeds', async () => {
    const state = { complete: false, inProgress: false }
    const event = { preventDefault: vi.fn() }
    const quit = vi.fn()
    const onFailure = vi.fn()

    expect(
      handleBackendBeforeQuit(event, state, {
        stopBackend: async () => 'closed',
        quit,
        onFailure
      })
    ).toBe('prevent-and-start')
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(state).toEqual({ complete: true, inProgress: false })
    expect(onFailure).not.toHaveBeenCalled()

    const followUp = { preventDefault: vi.fn() }
    expect(
      handleBackendBeforeQuit(followUp, state, {
        stopBackend: async () => 'closed',
        quit,
        onFailure
      })
    ).toBe('allow')
    expect(followUp.preventDefault).not.toHaveBeenCalled()
  })

  it('permits skipped shutdown only when both process ownership sides are absent', () => {
    const child = {}
    expect(classifyBackendShutdownTarget(null, null)).toBe('absent')
    expect(classifyBackendShutdownTarget(child, { process: child })).toBe('exact')
    expect(classifyBackendShutdownTarget(child, null)).toBe('inconsistent')
    expect(classifyBackendShutdownTarget(null, { process: child })).toBe('inconsistent')
    expect(classifyBackendShutdownTarget(child, { process: {} })).toBe('inconsistent')
  })

  it('waits for an unconfirmed backend to close without signaling it', async () => {
    const child = new FakeChildProcess()
    const stopped = stopBackendProcess(child as never, {
      killGraceMs: 50,
      timeoutMs: 100
    })

    expect(child.kills).toEqual([])
    child.emit('close', 0, null)

    await expect(stopped).resolves.toBe('closed')
    expect(child.kills).toEqual([])
  })

  it('bounds shutdown before READY because capture authority does not exist yet', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopPreBootstrapBackendProcess(child as never)

      expect(child.kills).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS + 1)
      expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])

      await vi.advanceTimersByTimeAsync(
        BACKEND_PRE_BOOTSTRAP_SHUTDOWN_TIMEOUT_MS - BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS
      )
      await expect(stopped).resolves.toBe('timed-out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes the bounded pre-bootstrap path as soon as the child closes', async () => {
    const child = new FakeChildProcess()
    const stopped = stopPreBootstrapBackendProcess(child as never, {
      killGraceMs: 50,
      timeoutMs: 100
    })

    expect(child.kills).toEqual(['SIGTERM'])
    child.emit('close', 0, 'SIGTERM')

    await expect(stopped).resolves.toBe('closed')
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('waits for inherited backend output to close after the wrapper exits', async () => {
    const child = new FakeChildProcess()
    const settled = vi.fn()
    const stopped = stopPreBootstrapBackendProcess(child as never, {
      killGraceMs: 50,
      timeoutMs: 100
    })
    void stopped.then(settled)

    child.exitCode = 0
    child.emit('exit', 0, null)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    child.stdout.emit('data', 'late output inherited by the real backend')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    child.stdout.readableEnded = true
    child.stderr.readableEnded = true
    child.emit('close', 0, null)

    await expect(stopped).resolves.toBe('closed')
    expect(settled).toHaveBeenCalledWith('closed')
  })

  it('recognizes an exited pre-bootstrap process only after both output channels drained', async () => {
    const child = new FakeChildProcess()
    child.exitCode = 0
    child.stdout.readableEnded = true
    child.stderr.readableEnded = true

    await expect(stopPreBootstrapBackendProcess(child as never)).resolves.toBe('already-exited')
    expect(child.kills).toEqual([])
  })

  it('keeps waiting for inherited output after the bounded shutdown timer expires', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopPreBootstrapBackendProcess(child as never)
      child.exitCode = 0
      child.emit('exit', 0, null)

      await vi.advanceTimersByTimeAsync(BACKEND_PRE_BOOTSTRAP_SHUTDOWN_TIMEOUT_MS)
      await expect(stopped).resolves.toBe('timed-out')

      const settled = vi.fn()
      const drained = waitForBackendBootstrapOutputDrain(child as never)
      void drained.then(settled)
      child.stdout.emit('data', 'OWNERSHIP arrives after the shutdown timeout')
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()

      child.stdout.readableEnded = true
      child.stderr.readableEnded = true
      child.emit('close', 0, null)
      await expect(drained).resolves.toBeUndefined()
      expect(settled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses SIGKILL only when a validated shutdown receipt later hangs', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopBackendProcess(child as never, {
        shutdownReceipt: validReceipt,
        expectedShutdownReceipt: expectedReceipt,
        killGraceMs: 50,
        timeoutMs: 100
      })

      await vi.advanceTimersByTimeAsync(51)
      expect(child.kills).toEqual(['SIGKILL'])

      child.emit('exit', null, 'SIGKILL')
      await expect(stopped).resolves.toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms the bounded emergency kill only after capture finalization was confirmed', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopBackendProcess(child as never, {
        shutdownReceipt: validReceipt,
        expectedShutdownReceipt: expectedReceipt
      })

      await vi.advanceTimersByTimeAsync(25_001)
      expect(child.kills).toEqual([])

      await vi.advanceTimersByTimeAsync(BACKEND_SHUTDOWN_KILL_GRACE_MS - 25_001 + 1)
      expect(child.kills).toEqual(['SIGKILL'])

      await vi.advanceTimersByTimeAsync(
        BACKEND_SHUTDOWN_TIMEOUT_MS - BACKEND_SHUTDOWN_KILL_GRACE_MS
      )
      await expect(stopped).resolves.toBe('timed-out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves after the bounded timeout even when no close event arrives', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopBackendProcess(child as never, {
        shutdownReceipt: validReceipt,
        expectedShutdownReceipt: expectedReceipt,
        killGraceMs: 50,
        timeoutMs: 100
      })

      await vi.advanceTimersByTimeAsync(101)

      await expect(stopped).resolves.toBe('timed-out')
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never force-kills or times out when capture finalization is unconfirmed', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChildProcess()
      const stopped = stopBackendProcess(child as never, {
        killGraceMs: 50,
        timeoutMs: 100
      })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(child.kills).toEqual([])

      child.emit('close', 0, null)
      await expect(stopped).resolves.toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires both exact backend shutdown acknowledgements before allowing SIGKILL', () => {
    const expected = expectedReceipt
    expect(
      backendShutdownAllowsForceKill(
        {
          shutdownLatched: true,
          captureFinalizationComplete: true,
          requestId: expected.requestId,
          backendPid: expected.backendPid
        },
        expected
      )
    ).toBe(true)
    expect(
      backendShutdownAllowsForceKill(
        {
          shutdownLatched: true,
          captureFinalizationComplete: false,
          requestId: expected.requestId,
          backendPid: expected.backendPid
        },
        expected
      )
    ).toBe(false)
    expect(
      backendShutdownAllowsForceKill(
        {
          shutdownLatched: true,
          captureFinalizationComplete: true,
          requestId: 'stale-request',
          backendPid: expected.backendPid
        },
        expected
      )
    ).toBe(false)
    expect(
      backendShutdownAllowsForceKill(
        {
          shutdownLatched: true,
          captureFinalizationComplete: true,
          requestId: expected.requestId,
          backendPid: 99
        },
        expected
      )
    ).toBe(false)
    expect(backendShutdownAllowsForceKill(null, expected)).toBe(false)
  })
})
