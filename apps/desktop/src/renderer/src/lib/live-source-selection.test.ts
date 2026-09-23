import { describe, expect, it, vi } from 'vitest'
import type { SessionSources, SourceSwitchParams } from '@/lib/backend'
import { confirmedSourceSelection, LiveSourceSelectionController } from './live-source-selection'

function snapshot(patch: Partial<SessionSources> = {}): SessionSources {
  return {
    sessionId: 'session-a',
    sourceRevision: 0,
    outputProcessId: 7,
    audio: null,
    confirmed: { microphoneId: 'mic-a' },
    health: [],
    pending: null,
    lastOperation: null,
    capabilities: ['capture', 'camera', 'microphone'].map((kind) => ({
      kind: kind as 'capture' | 'camera' | 'microphone',
      supported: true,
      reason: null
    })),
    ...patch
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function terminal(
  request: SourceSwitchParams,
  stage: 'applied' | 'failed' = 'applied'
): SessionSources {
  return snapshot({
    sourceRevision: stage === 'applied' ? 1 : 0,
    confirmed: { microphoneId: stage === 'applied' ? (request.deviceId ?? undefined) : 'mic-a' },
    lastOperation: {
      ...request,
      stage,
      reason: stage === 'failed' ? 'Device unavailable' : null,
      previousSource: 'preserved',
      outputObserved: stage === 'applied'
    }
  })
}
function controller(
  overrides: {
    get?: (sessionId: string) => Promise<SessionSources>
    switch?: (request: SourceSwitchParams) => Promise<SessionSources>
  } = {}
) {
  const changed = vi.fn(),
    confirmed = vi.fn()
  const get = vi.fn(overrides.get ?? (async () => snapshot()))
  const switchSource = vi.fn(overrides.switch ?? (async (request) => terminal(request)))
  const instance = new LiveSourceSelectionController({
    get,
    switch: switchSource,
    changed,
    confirmed,
    requestId: () => 'request-1'
  })
  instance.setSession('session-a', 'recording')
  return { instance, changed, confirmed, get, switchSource }
}

describe('live source selection authority', () => {
  it('stops output polling when a later scene explicitly supersedes the old proof', async () => {
    vi.useFakeTimers()
    const { instance, get, changed } = controller()
    try {
      const request: SourceSwitchParams = {
        sessionId: 'session-a',
        requestId: 'old-proof',
        expectedSourceRevision: 0,
        kind: 'camera',
        deviceId: 'cam-b',
        protectedOverlayWindowIds: []
      }
      const applied = terminal(request)
      applied.lastOperation!.outputObserved = false
      get.mockResolvedValue(applied)
      await instance.refresh()
      expect(changed.mock.lastCall?.[0].outputPending).toBe(true)
      get.mockResolvedValue({
        ...applied,
        lastOperation: { ...applied.lastOperation!, outputSuperseded: true }
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(changed.mock.lastCall?.[0]).toMatchObject({ outputPending: false, error: null })
      const reads = get.mock.calls.length
      await vi.advanceTimersByTimeAsync(6000)
      expect(get).toHaveBeenCalledTimes(reads)
    } finally {
      instance.dispose()
      vi.useRealTimers()
    }
  })

  it('admits only one request before the first await and never selects the candidate optimistically', async () => {
    const response = deferred<SessionSources>()
    const { instance, switchSource, confirmed } = controller({ switch: () => response.promise })
    await instance.refresh()
    const first = instance.select('microphone', 'mic-b', [])
    await expect(instance.select('camera', 'cam-b', [])).rejects.toThrow('Changing source')
    expect(switchSource).toHaveBeenCalledTimes(1)
    expect(confirmed.mock.lastCall?.[0].confirmed.microphoneId).toBe('mic-a')
    response.resolve(terminal(switchSource.mock.calls[0][0]))
    await first
    expect(confirmed.mock.lastCall?.[0].confirmed.microphoneId).toBe('mic-b')
  })

  it('shows the target without changing the confirmed selection and resolves late proof without events', async () => {
    vi.useFakeTimers()
    try {
      let final: SessionSources | null = null
      const { instance, changed, switchSource } = controller({
        get: async () => final ?? snapshot(),
        switch: async (request) => {
          final = terminal(request)
          final.lastOperation!.outputObserved = false
          return final
        }
      })
      await instance.refresh()
      const selection = instance.select('microphone', 'mic-b', [], 'Studio USB')
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        targetName: 'Studio USB',
        pending: 'microphone',
        snapshot: { confirmed: { microphoneId: 'mic-a' } }
      })
      await selection
      expect(changed.mock.lastCall?.[0].outputPending).toBe(true)
      final = terminal(switchSource.mock.calls[0][0])
      await vi.advanceTimersByTimeAsync(250)
      expect(changed.mock.lastCall?.[0].outputPending).toBe(false)
      expect(switchSource).toHaveBeenCalledTimes(1)
      instance.setSession(undefined, 'idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds output proof polling and allows explicit status retry without reissuing the switch', async () => {
    vi.useFakeTimers()
    try {
      let final: SessionSources | null = null
      const { instance, changed, get, switchSource } = controller({
        get: async () => final ?? snapshot(),
        switch: async (request) => {
          final = terminal(request)
          final.lastOperation!.outputObserved = false
          return final
        }
      })
      await instance.refresh()
      await instance.select('microphone', 'mic-b', [])
      await vi.advanceTimersByTimeAsync(6000)
      expect(get).toHaveBeenCalledTimes(21)
      expect(changed.mock.lastCall?.[0].error).toContain('output could not be confirmed')
      final = terminal(switchSource.mock.calls[0][0])
      await instance.retryStatus()
      expect(changed.mock.lastCall?.[0]).toMatchObject({ error: null, outputPending: false })
      expect(switchSource).toHaveBeenCalledTimes(1)
      instance.setSession(undefined, 'idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fences late RPC A success or rejection after GET confirms A and B starts in the same session', async () => {
    for (const rejected of [true, false]) {
      const first = deferred<SessionSources>(),
        second = deferred<SessionSources>()
      let id = 0
      const changed = vi.fn()
      let requestA!: SourceSwitchParams
      const instance = new LiveSourceSelectionController({
        get: async () => (requestA ? terminal(requestA) : snapshot()),
        switch: (request) => {
          if (!requestA) {
            requestA = request
            return first.promise
          }
          return second.promise
        },
        changed,
        confirmed: vi.fn(),
        requestId: () => `request-${++id}`
      })
      instance.setSession('session-a', 'recording')
      await instance.refresh()
      const a = instance.select('microphone', 'mic-b', [])
      await Promise.resolve()
      await instance.refresh()
      const b = instance.select('microphone', 'mic-c', [])
      await Promise.resolve()
      if (rejected)
        first.reject(
          Object.assign(new Error('Late reject'), { code: 'source-switch-stale-revision' })
        )
      else first.resolve(terminal(requestA))
      await a
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        pending: 'microphone',
        error: null,
        targetName: 'mic-c'
      })
      second.resolve(
        terminal({
          ...requestA,
          requestId: 'request-2',
          expectedSourceRevision: 1,
          deviceId: 'mic-c'
        })
      )
      await b
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        pending: null,
        snapshot: { confirmed: { microphoneId: 'mic-c' } }
      })
      instance.dispose()
    }
  })

  it('disposes timers and ignores every late authority publication', async () => {
    const late = deferred<SessionSources>()
    const { instance, get, confirmed } = controller()
    await instance.refresh()
    get.mockImplementationOnce(() => late.promise)
    const read = instance.refresh()
    instance.dispose()
    const before = confirmed.mock.calls.length
    late.resolve(snapshot({ sourceRevision: 9 }))
    await read
    expect(confirmed).toHaveBeenCalledTimes(before)
  })

  it('ignores an older GET resolving after a failed terminal response at the same source revision', async () => {
    const old = deferred<SessionSources>()
    const { instance, get, switchSource, changed } = controller({
      switch: async (request) => terminal(request, 'failed')
    })
    await instance.refresh()
    get.mockImplementationOnce(() => old.promise)
    const refresh = instance.refresh()
    await instance.select('microphone', 'mic-b', [])
    const request = switchSource.mock.calls[0][0]
    old.resolve(
      snapshot({
        pending: {
          ...request,
          stage: 'preparing',
          reason: null,
          previousSource: 'preserved',
          outputObserved: false
        }
      })
    )
    await refresh
    expect(changed.mock.lastCall?.[0]).toMatchObject({ pending: null, error: 'Device unavailable' })
  })

  it('drops old responses after Stop and a different session and makes repeated idle status idempotent', async () => {
    const response = deferred<SessionSources>()
    const { instance, switchSource, confirmed, changed } = controller({
      switch: () => response.promise
    })
    await instance.refresh()
    const switching = instance.select('microphone', 'mic-b', [])
    await Promise.resolve()
    instance.setSession('session-a', 'stopping')
    instance.setSession(undefined, 'idle')
    const idleCalls = changed.mock.calls.length
    instance.setSession(undefined, 'idle')
    expect(changed).toHaveBeenCalledTimes(idleCalls)
    instance.setSession('session-b', 'recording')
    const publications = confirmed.mock.calls.length
    response.resolve(terminal(switchSource.mock.calls[0][0]))
    await switching
    expect(confirmed).toHaveBeenCalledTimes(publications)
  })

  it('reconciles a lost committed reply from GET and retries a never-admitted request using the same identity', async () => {
    for (const committed of [true, false]) {
      let request: SourceSwitchParams | null = null
      let sends = 0
      const { instance, switchSource, confirmed } = controller({
        get: async () => (committed && request ? terminal(request) : snapshot()),
        switch: async (next) => {
          request = next
          if (++sends === 1) throw new Error('Socket disconnected')
          return terminal(next)
        }
      })
      await instance.refresh()
      await instance.select('microphone', 'mic-b', [77])
      expect(switchSource).toHaveBeenCalledTimes(committed ? 1 : 2)
      if (!committed) expect(switchSource.mock.calls[1][0]).toEqual(switchSource.mock.calls[0][0])
      expect(confirmed.mock.lastCall?.[0].confirmed.microphoneId).toBe('mic-b')
      expect(instance.reason('camera')).toBeNull()
    }
  })

  it('bounds automatic retries and offers explicit recovery with the original request identity', async () => {
    const { instance, switchSource, changed } = controller({
      switch: async () => {
        throw new Error('Disconnected')
      }
    })
    await instance.refresh()
    await instance.select('microphone', 'mic-b', [])
    await instance.refresh()
    await instance.refresh()
    expect(switchSource).toHaveBeenCalledTimes(3)
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      pending: 'microphone',
      checking: true,
      error: expect.stringContaining('Retry status')
    })
    const original = switchSource.mock.calls[0][0]
    switchSource.mockImplementationOnce(async (request) => terminal(request))
    await instance.retryStatus()
    expect(switchSource.mock.calls[3][0]).toEqual(original)
    expect(changed.mock.lastCall?.[0]).toMatchObject({ pending: null, checking: false })
    expect(instance.reason('camera')).toBeNull()
  })

  it('finishes bounded unknown-outcome reconciliation without needing another backend event', async () => {
    const { instance, switchSource, changed } = controller({
      switch: async () => {
        throw new Error('Offline')
      }
    })
    await instance.refresh()
    await instance.select('microphone', 'mic-b', [])
    expect(switchSource).toHaveBeenCalledTimes(3)
    expect(changed.mock.lastCall?.[0].error).toContain('Retry status')
  })

  it('offers recovery after a failed GET and clears connectivity errors after success', async () => {
    const { instance, get, changed } = controller()
    get.mockRejectedValueOnce(new Error('Offline'))
    await instance.refresh()
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      checking: true,
      error: expect.stringContaining('Retry status')
    })
    await instance.retryStatus()
    expect(changed.mock.lastCall?.[0]).toMatchObject({ checking: false, error: null })
    expect(instance.reason('camera')).toBeNull()
  })

  it('clears an externally admitted pending operation when it completes', async () => {
    const { instance, get, changed } = controller()
    const operation = {
      requestId: 'other-client',
      kind: 'camera' as const,
      deviceId: 'cam-b',
      stage: 'preparing' as const,
      reason: null,
      previousSource: 'preserved' as const,
      outputObserved: false
    }
    get.mockResolvedValueOnce(snapshot({ pending: operation }))
    await instance.refresh()
    expect(changed.mock.lastCall?.[0].pending).toBe('camera')
    get.mockResolvedValueOnce(
      snapshot({
        sourceRevision: 1,
        confirmed: { cameraId: 'cam-b' },
        lastOperation: { ...operation, stage: 'applied' }
      })
    )
    await instance.refresh()
    expect(changed.mock.lastCall?.[0].pending).toBeNull()
  })

  it('performs a follow-up read when an event invalidates an in-flight GET', async () => {
    const old = deferred<SessionSources>()
    const { instance, get, confirmed } = controller()
    get
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(snapshot({ sourceRevision: 1, confirmed: { microphoneId: 'mic-b' } }))
    const first = instance.refresh()
    void instance.refresh()
    old.resolve(snapshot())
    await first
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(2)
    expect(confirmed.mock.lastCall?.[0].confirmed.microphoneId).toBe('mic-b')
  })

  it('definitive admission errors clear pending while preserving confirmed selection', async () => {
    const error = Object.assign(new Error('Selection changed; refresh before retrying.'), {
      code: 'source-switch-stale-revision'
    })
    const { instance, changed, confirmed } = controller({
      switch: async () => {
        throw error
      }
    })
    await instance.refresh()
    await instance.select('microphone', 'mic-b', [])
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      pending: null,
      checking: false,
      error: error.message
    })
    expect(confirmed.mock.lastCall?.[0].confirmed.microphoneId).toBe('mic-a')
  })

  it('retains confirmed device names through inventory loss and ignores unrelated preference fields', () => {
    const current = {
      microphoneId: 'mic-a',
      microphoneName: 'Desk microphone',
      cameraId: 'cam-a',
      cameraName: 'Front camera',
      screenId: 'screen-a'
    }
    const merged = confirmedSourceSelection(
      current,
      snapshot({ confirmed: { microphoneId: 'mic-a', cameraId: 'cam-a', screenId: 'screen-a' } }),
      []
    )
    expect(merged.microphoneName).toBe('Desk microphone')
    expect(merged.cameraName).toBe('Front camera')
    expect(
      confirmedSourceSelection(current, snapshot({ confirmed: { microphoneId: undefined } }), [])
        .microphoneName
    ).toBeUndefined()
  })
})
