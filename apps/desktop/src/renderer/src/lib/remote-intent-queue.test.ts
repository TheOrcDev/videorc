import { describe, expect, it, vi } from 'vitest'

import {
  REMOTE_SOUND_INTENT_STALE_MS,
  createRemoteIntentQueue,
  isSoundIntent,
  remoteIntentKind
} from './remote-intent-queue'

// Release test 147, plan 0003: a Stream Deck sound press sent while a scene
// switch was still running played 12 s late. Sound intents get their own lane.

const intent = (intentId: string, kind: string, fields: Record<string, unknown> = {}) => ({
  intentId,
  intent: { kind, ...fields }
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('remote intent kinds', () => {
  it('reads the relayed envelope and knows the two sound intents', () => {
    expect(remoteIntentKind(intent('ri-1', 'soundPlay', { soundId: 's' }))).toBe('soundPlay')
    expect(remoteIntentKind({ kind: 'soundPlay' })).toBeUndefined()
    expect(remoteIntentKind(null)).toBeUndefined()
    expect(isSoundIntent(intent('ri-1', 'soundPlay'))).toBe(true)
    expect(isSoundIntent(intent('ri-1', 'soundStop'))).toBe(true)
    expect(isSoundIntent(intent('ri-1', 'sceneApply'))).toBe(false)
  })
})

describe('the remote intent queue', () => {
  it('runs a sound press at once while a slow scene switch is still running', async () => {
    const scene = deferred()
    const ran: string[] = []
    const queue = createRemoteIntentQueue({
      run: async (payload) => {
        const id = (payload as { intentId: string }).intentId
        ran.push(id)
        if (id === 'ri-scene') await scene.promise
      },
      refuseStale: vi.fn(async () => undefined)
    })
    void queue.enqueue(intent('ri-scene', 'sceneApply', { layoutPreset: 'side-by-side' }))
    const sound = queue.enqueue(intent('ri-sound', 'soundPlay', { soundId: 'rimshot' }))
    const stop = queue.enqueue(intent('ri-stop', 'recordStop'))
    await sound
    expect(ran).toEqual(['ri-scene', 'ri-sound'])
    // Every other intent still waits its turn, in arrival order.
    scene.resolve()
    await stop
    expect(ran).toEqual(['ri-scene', 'ri-sound', 'ri-stop'])
  })

  it('keeps sound intents in order among themselves, and a failure does not poison the lane', async () => {
    const first = deferred()
    const ran: string[] = []
    const queue = createRemoteIntentQueue({
      run: async (payload) => {
        const id = (payload as { intentId: string }).intentId
        ran.push(id)
        if (id === 'ri-1') await first.promise
      },
      refuseStale: vi.fn(async () => undefined)
    })
    const one = queue.enqueue(intent('ri-1', 'soundPlay', { soundId: 'loop' }))
    const two = queue.enqueue(intent('ri-2', 'soundStop', { soundId: 'loop' }))
    await flush()
    expect(ran).toEqual(['ri-1'])
    first.reject(new Error('backend hiccup'))
    await expect(one).rejects.toThrow('backend hiccup')
    await two
    expect(ran).toEqual(['ri-1', 'ri-2'])
  })

  it('refuses a sound press that still waited past the stale budget, and plays a fresh one', async () => {
    let clock = 0
    const slow = deferred()
    const run = vi.fn(async (payload: unknown) => {
      if ((payload as { intentId: string }).intentId === 'ri-slow') await slow.promise
    })
    const refuseStale = vi.fn(async () => undefined)
    const queue = createRemoteIntentQueue({ run, refuseStale, now: () => clock })
    void queue.enqueue(intent('ri-slow', 'soundPlay', { soundId: 'a' }))
    const late = queue.enqueue(intent('ri-late', 'soundPlay', { soundId: 'b' }))
    // Let ri-slow start its turn before the clock moves: only ri-late waited.
    await flush()
    expect(run).toHaveBeenCalledWith(intent('ri-slow', 'soundPlay', { soundId: 'a' }))
    clock = REMOTE_SOUND_INTENT_STALE_MS + 1
    slow.resolve()
    await late
    expect(refuseStale).toHaveBeenCalledTimes(1)
    expect(refuseStale).toHaveBeenCalledWith(intent('ri-late', 'soundPlay', { soundId: 'b' }))
    expect(run).not.toHaveBeenCalledWith(intent('ri-late', 'soundPlay', { soundId: 'b' }))
    await queue.enqueue(intent('ri-fresh', 'soundPlay', { soundId: 'c' }))
    expect(run).toHaveBeenLastCalledWith(intent('ri-fresh', 'soundPlay', { soundId: 'c' }))
  })

  it('never refuses a non-sound intent for waiting, however long', async () => {
    let clock = 0
    const slow = deferred()
    const run = vi.fn(async (payload: unknown) => {
      if ((payload as { intentId: string }).intentId === 'ri-1') await slow.promise
    })
    const refuseStale = vi.fn(async () => undefined)
    const queue = createRemoteIntentQueue({ run, refuseStale, now: () => clock })
    void queue.enqueue(intent('ri-1', 'sceneApply'))
    const stop = queue.enqueue(intent('ri-2', 'recordStop'))
    await flush()
    clock = 60_000
    slow.resolve()
    await stop
    expect(run).toHaveBeenCalledTimes(2)
    expect(refuseStale).not.toHaveBeenCalled()
  })
})

it('runs privacy independently of a blocked scene, in privacy arrival order', async () => {
  const scene = deferred()
  const ran: string[] = []
  const queue = createRemoteIntentQueue({
    run: async (p) => {
      const kind = remoteIntentKind(p)!
      ran.push(kind)
      if (kind === 'sceneApply') await scene.promise
    },
    refuseStale: vi.fn()
  })
  const pending = queue.enqueue(intent('scene', 'sceneApply'))
  await queue.enqueue(intent('hide', 'screenHide'))
  await queue.enqueue(intent('show', 'screenShow'))
  expect(ran).toEqual(['sceneApply', 'screenHide', 'screenShow'])
  scene.resolve()
  await pending
})
