import { describe, expect, it } from 'vitest'

import {
  BackendRuntimeOwner,
  claimDurableBackendPid,
  classifyOwnedProcessPids,
  requestBackendRuntimeTermination,
  settleBackendRuntimeExit
} from './backend-runtime-owner'

describe('BackendRuntimeOwner', () => {
  it('retains exact ownership and rejects a replacement after shutdown becomes unconfirmed', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})

    owner.recordOwnedPid(runtime, 101)
    owner.recordOwnedPid(runtime, 202)
    owner.beginShutdown(runtime)
    owner.markShutdownUnconfirmed(runtime)

    expect(owner.current()).toBe(runtime)
    expect(runtime.state).toBe('shutdown-unconfirmed')
    expect([...runtime.ownedProcessPids]).toEqual([101, 202])
    expect(() => owner.start({})).toThrow('previous backend runtime is still owned')
  })

  it('does not let a late completion from an old runtime clear its replacement', () => {
    const owner = new BackendRuntimeOwner<object>()
    const first = owner.start({})
    owner.recordOwnedPid(first, 101)
    owner.beginShutdown(first)

    expect(owner.complete(first)).toEqual({
      wasCurrent: true,
      wasIntentional: true,
      ownedProcessPids: [101]
    })

    const replacement = owner.start({})
    owner.recordOwnedPid(replacement, 202)

    expect(owner.complete(first)).toEqual({
      wasCurrent: false,
      wasIntentional: true,
      ownedProcessPids: []
    })
    expect(owner.current()).toBe(replacement)
    expect([...replacement.ownedProcessPids]).toEqual([202])
  })

  it('treats an unexpected exit differently from an intentional shutdown', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})

    expect(owner.complete(runtime)).toMatchObject({
      wasCurrent: true,
      wasIntentional: false
    })
  })

  it('requests termination and retains ownership when durable persistence fails', () => {
    const child = { kills: [] as NodeJS.Signals[] }
    const owner = new BackendRuntimeOwner<typeof child>()
    const runtime = owner.start(child)

    expect(() =>
      claimDurableBackendPid(owner, runtime, 4242, {
        persist: () => {
          throw new Error('ledger is read-only')
        },
        terminate: () => {
          child.kills.push('SIGKILL')
        }
      })
    ).toThrow('Could not durably record backend process 4242')

    expect(child.kills).toEqual(['SIGKILL'])
    expect(runtime.state).toBe('shutdown-unconfirmed')
    expect([...runtime.ownedProcessPids]).toEqual([4242])
    expect(owner.current()).toBe(runtime)
  })

  it('retains unpersisted pid ownership when termination is unconfirmed after the wrapper closes', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})
    owner.recordOwnedPid(runtime, 101)

    expect(() =>
      claimDurableBackendPid(owner, runtime, 202, {
        persist: () => {
          throw new Error('ledger is read-only')
        },
        terminate: () => {
          throw new Error('operation not permitted')
        }
      })
    ).toThrow('terminating it also failed')

    expect(runtime.state).toBe('shutdown-unconfirmed')
    expect([...runtime.ownedProcessPids]).toEqual([101, 202])

    const wrapperClose = settleBackendRuntimeExit(owner, runtime, 101, (pid) => pid === 202)
    expect(wrapperClose).toEqual({
      completed: false,
      wasCurrent: true,
      wasIntentional: true,
      confirmedDead: [101],
      stillLive: [202]
    })
    expect(owner.current()).toBe(runtime)
    expect([...runtime.ownedProcessPids]).toEqual([202])
    expect(() => owner.start({})).toThrow('previous backend runtime is still owned')

    const lateWrapperClose = settleBackendRuntimeExit(owner, runtime, 101, () => false)
    expect(lateWrapperClose).toEqual({
      completed: true,
      wasCurrent: true,
      wasIntentional: true,
      confirmedDead: [202],
      stillLive: []
    })
    expect(owner.current()).toBeNull()
  })

  it('releases an unconfirmed runtime when identity-aware reconciliation detects pid reuse', () => {
    const owner = new BackendRuntimeOwner<object>()
    const runtime = owner.start({})
    owner.recordOwnedPid(runtime, 202)
    owner.markShutdownUnconfirmed(runtime)

    const settlement = settleBackendRuntimeExit(owner, runtime, undefined, () => false)

    expect(settlement).toEqual({
      completed: true,
      wasCurrent: true,
      wasIntentional: true,
      confirmedDead: [202],
      stillLive: []
    })
    expect(owner.current()).toBeNull()
  })

  it('reports both a rejected direct signal and a false wrapper signal', () => {
    const runtimeProcess = {}
    const owner = new BackendRuntimeOwner<typeof runtimeProcess>()
    const runtime = owner.start(runtimeProcess)

    let error: unknown
    try {
      requestBackendRuntimeTermination(runtime, 202, {
        runtimePid: 101,
        signalExactPid: () => {
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
        },
        signalRuntimeProcess: () => false
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((failure) => String(failure))).toEqual([
      'Error: operation not permitted',
      'Error: Backend wrapper process 101 rejected SIGKILL.'
    ])
  })
})

describe('classifyOwnedProcessPids', () => {
  it('removes only the exited child and exact pids confirmed dead', () => {
    const alive = new Set([303])

    expect(classifyOwnedProcessPids([101, 202, 303], 101, (pid) => alive.has(pid))).toEqual({
      confirmedDead: [101, 202],
      stillLive: [303]
    })
  })

  it('retains a pid when liveness cannot be disproved', () => {
    expect(classifyOwnedProcessPids([404], undefined, () => true)).toEqual({
      confirmedDead: [],
      stillLive: [404]
    })
  })
})
