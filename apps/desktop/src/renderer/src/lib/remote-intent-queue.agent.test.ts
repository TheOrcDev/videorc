import { describe, expect, it, vi } from 'vitest'

import { REMOTE_SOUND_INTENT_STALE_MS, createRemoteIntentQueue } from './remote-intent-queue'
import type { AgentIntent } from './studio-actions/agent'

// Plan 209 S5: agents' tool calls get a lane of their own, beside the remote
// lane and the sound lane. The remote lane's own rules stay in
// remote-intent-queue.test.ts, unchanged.

const remote = (intentId: string, kind: string) => ({ intentId, intent: { kind } })
const agent = (intentId: string, tool: string): AgentIntent => ({
  intentId,
  agentId: 'agent-1',
  agentName: 'Claude Desktop',
  tool,
  args: {}
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

describe('the agents lane', () => {
  it('runs agent intents one at a time, in arrival order, and a failure does not poison the lane', async () => {
    const first = deferred()
    const ran: string[] = []
    const queue = createRemoteIntentQueue({
      run: vi.fn(async () => undefined),
      refuseStale: vi.fn(async () => undefined),
      runAgent: async (intent) => {
        ran.push(intent.intentId)
        if (intent.intentId === 'ai-1') await first.promise
        return { ok: true }
      }
    })
    const one = queue.enqueueAgent(agent('ai-1', 'start_recording'))
    const two = queue.enqueueAgent(agent('ai-2', 'switch_scene'))
    await flush()
    expect(ran).toEqual(['ai-1'])
    first.reject(new Error('backend hiccup'))
    await expect(one).rejects.toThrow('backend hiccup')
    await expect(two).resolves.toEqual({ ok: true })
    expect(ran).toEqual(['ai-1', 'ai-2'])
  })

  it('runs an agent intent at once while a slow remote intent is still running, and the other way round', async () => {
    const scene = deferred()
    const picture = deferred()
    const ran: string[] = []
    const queue = createRemoteIntentQueue({
      run: async (payload) => {
        const id = (payload as { intentId: string }).intentId
        ran.push(id)
        if (id === 'ri-scene') await scene.promise
      },
      refuseStale: vi.fn(async () => undefined),
      runAgent: async (intent) => {
        ran.push(intent.intentId)
        if (intent.intentId === 'ai-picture') await picture.promise
        return { ok: true }
      }
    })
    void queue.enqueue(remote('ri-scene', 'sceneApply'))
    await expect(queue.enqueueAgent(agent('ai-status', 'get_status'))).resolves.toEqual({
      ok: true
    })
    expect(ran).toEqual(['ri-scene', 'ai-status'])
    scene.resolve()
    // A slow tool never holds a key back either.
    void queue.enqueueAgent(agent('ai-picture', 'get_picture'))
    await flush()
    expect(ran).toEqual(['ri-scene', 'ai-status', 'ai-picture'])
    await queue.enqueue(remote('ri-stop', 'recordStop'))
    expect(ran).toEqual(['ri-scene', 'ai-status', 'ai-picture', 'ri-stop'])
    picture.resolve()
  })

  it('never holds a sound press behind an agent intent, nor an agent intent behind a sound', async () => {
    const picture = deferred()
    const loop = deferred()
    const ran: string[] = []
    const queue = createRemoteIntentQueue({
      run: async (payload) => {
        const id = (payload as { intentId: string }).intentId
        ran.push(id)
        if (id === 'ri-loop') await loop.promise
      },
      refuseStale: vi.fn(async () => undefined),
      runAgent: async (intent) => {
        ran.push(intent.intentId)
        if (intent.intentId === 'ai-picture') await picture.promise
        return { ok: true }
      }
    })
    void queue.enqueueAgent(agent('ai-picture', 'get_picture'))
    await queue.enqueue(remote('ri-airhorn', 'soundPlay'))
    expect(ran).toEqual(['ai-picture', 'ri-airhorn'])
    picture.resolve()
    // A sound still playing never holds a tool back either.
    void queue.enqueue(remote('ri-loop', 'soundPlay'))
    await flush()
    expect(ran).toEqual(['ai-picture', 'ri-airhorn', 'ri-loop'])
    await expect(queue.enqueueAgent(agent('ai-scene', 'switch_scene'))).resolves.toEqual({
      ok: true
    })
    expect(ran).toEqual(['ai-picture', 'ri-airhorn', 'ri-loop', 'ai-scene'])
    loop.resolve()
  })

  it('resolves to the runner outcome as it is, and never refuses an agent intent for waiting', async () => {
    let clock = 0
    const slow = deferred()
    const refuseStale = vi.fn(async () => undefined)
    const queue = createRemoteIntentQueue({
      run: vi.fn(async () => undefined),
      refuseStale,
      now: () => clock,
      runAgent: async (intent) => {
        if (intent.intentId === 'ai-slow') await slow.promise
        return intent.tool === 'get_status'
          ? { ok: true, result: { live: false } }
          : { ok: false, message: "You're not recording or live." }
      }
    })
    void queue.enqueueAgent(agent('ai-slow', 'stop'))
    const status = queue.enqueueAgent(agent('ai-status', 'get_status'))
    await flush()
    clock = REMOTE_SOUND_INTENT_STALE_MS * 60
    slow.resolve()
    await expect(status).resolves.toEqual({ ok: true, result: { live: false } })
    expect(refuseStale).not.toHaveBeenCalled()
    await expect(queue.enqueueAgent(agent('ai-stop', 'stop'))).resolves.toEqual({
      ok: false,
      message: "You're not recording or live."
    })
  })

  it('rejects an agent intent when the queue was built without an agent runner', async () => {
    const queue = createRemoteIntentQueue({
      run: vi.fn(async () => undefined),
      refuseStale: vi.fn(async () => undefined)
    })
    await expect(queue.enqueueAgent(agent('ai-1', 'get_status'))).rejects.toThrow('runAgent')
  })
})
