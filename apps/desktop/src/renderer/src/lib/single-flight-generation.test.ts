import { describe, expect, it } from 'vitest'

import {
  LatestRequestByKey,
  SingleFlightByKey,
  SingleFlightGeneration
} from './single-flight-generation'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SingleFlightGeneration', () => {
  it('single-flights duplicate focus refreshes in the same client generation', async () => {
    const coordinator = new SingleFlightGeneration()
    const gate = deferred()
    let requests = 0

    const first = coordinator.run(async () => {
      requests += 1
      await gate.promise
    })
    const second = coordinator.run(async () => {
      requests += 1
    })

    expect(first).toBe(second)
    expect(requests).toBe(1)
    gate.resolve()
    await first
  })

  it('prevents a stale slow focus refresh from overwriting a newer client generation', async () => {
    const coordinator = new SingleFlightGeneration()
    const staleGate = deferred()
    const commits: string[] = []

    const stale = coordinator.run(async (isCurrent) => {
      await staleGate.promise
      if (isCurrent()) commits.push('stale')
    })
    coordinator.invalidate()
    await coordinator.run(async (isCurrent) => {
      if (isCurrent()) commits.push('current')
    })
    staleGate.resolve()
    await stale

    expect(commits).toEqual(['current'])
  })
})

describe('LatestRequestByKey', () => {
  it('does not let a stale completion match after cleanup and reload', () => {
    const coordinator = new LatestRequestByKey<string>()
    const stale = coordinator.begin('session-1')

    expect(coordinator.finish('session-1', stale)).toBe(true)
    expect(coordinator.activeCount).toBe(0)

    const reloaded = coordinator.begin('session-1')
    expect(coordinator.isCurrent('session-1', stale)).toBe(false)
    expect(coordinator.finish('session-1', stale)).toBe(false)
    expect(coordinator.isCurrent('session-1', reloaded)).toBe(true)
    expect(coordinator.finish('session-1', reloaded)).toBe(true)
    expect(coordinator.activeCount).toBe(0)
  })

  it('invalidates evicted keys without retaining bookkeeping', () => {
    const coordinator = new LatestRequestByKey<string>()
    const evicted = coordinator.begin('session-1')
    coordinator.begin('session-2')

    expect(coordinator.invalidate('session-1')).toBe(true)
    expect(coordinator.isCurrent('session-1', evicted)).toBe(false)
    expect(coordinator.activeCount).toBe(1)
    coordinator.clear()
    expect(coordinator.activeCount).toBe(0)
  })
})

describe('SingleFlightByKey', () => {
  it('coalesces equal keyed work and releases all bookkeeping when it settles', async () => {
    const coordinator = new SingleFlightByKey<string, object>()
    const identity = {}
    const gate = deferred()
    let requests = 0

    const first = coordinator.run('session-1', identity, async () => {
      requests += 1
      await gate.promise
    })
    const duplicate = coordinator.run('session-1', identity, async () => {
      requests += 1
    })

    expect(duplicate).toBe(first)
    expect(requests).toBe(1)
    expect(coordinator.activeCount).toBe(1)
    gate.resolve()
    await first
    expect(coordinator.activeCount).toBe(0)
  })

  it('does not let an older identity clear replacement work for the same key', async () => {
    const coordinator = new SingleFlightByKey<string, object>()
    const oldGate = deferred()
    const newGate = deferred()

    const oldRequest = coordinator.run('session-1', {}, () => oldGate.promise)
    const newRequest = coordinator.run('session-1', {}, () => newGate.promise)
    oldGate.resolve()
    await oldRequest
    expect(coordinator.activeCount).toBe(1)

    newGate.resolve()
    await newRequest
    expect(coordinator.activeCount).toBe(0)
  })
})
