import { describe, expect, it, vi } from 'vitest'

import type { CohostCommandRelayCommand, CohostState, CommentsCommandResolution } from './backend'
import { startCohostCommandRelay } from './cohost-command-relay'
import { EMPTY_COHOST_STATE } from './cohost-view'

const state: CohostState = { ...EMPTY_COHOST_STATE, sessionId: 's1', status: 'listening' }

function harness(handler: (method: string, params: unknown) => Promise<CohostState>) {
  const calls: { method: string; params: unknown }[] = []
  const pushed: CommentsCommandResolution<CohostState>[] = []
  const committed: CohostState[] = []
  let onRequest: ((command: CohostCommandRelayCommand) => void) | null = null
  const stop = startCohostCommandRelay({
    client: {
      requestTyped: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params })
        return handler(method, params)
      })
    } as never,
    sessionId: () => 's1',
    commit: (next) => committed.push(next),
    api: {
      onCohostCommandRequest: (callback) => {
        onRequest = callback
        return () => {
          onRequest = null
        }
      },
      pushCohostCommandResult: async (resolution) => {
        pushed.push(resolution)
        return true
      }
    }
  })
  return {
    calls,
    pushed,
    committed,
    stop,
    listening: () => onRequest !== null,
    send: async (command: CohostCommandRelayCommand) => {
      onRequest?.(command)
      await vi.waitFor(() =>
        expect(pushed.some((entry) => entry.requestId === command.requestId)).toBe(true)
      )
      return pushed.find((entry) => entry.requestId === command.requestId)!
    }
  }
}

describe('the Stream Manager answers Golem (plan 140, S6 part B)', () => {
  it('maps each answer to its cohost.command call and commits the state', async () => {
    const test = harness(async () => state)
    await test.send({
      requestId: 'r1',
      sessionId: 's1',
      action: 'choose',
      commandId: 'cmd-1',
      index: 2
    })
    await test.send({ requestId: 'r2', sessionId: 's1', action: 'confirm', commandId: 'cmd-1' })
    await test.send({ requestId: 'r3', sessionId: 's1', action: 'cancel', commandId: 'cmd-1' })
    expect(test.calls).toEqual([
      { method: 'cohost.command.choose', params: { commandId: 'cmd-1', index: 2 } },
      { method: 'cohost.command.confirm', params: { commandId: 'cmd-1' } },
      { method: 'cohost.command.cancel', params: { commandId: 'cmd-1' } }
    ])
    expect(test.committed).toHaveLength(3)
    expect(test.pushed[0]).toEqual({ requestId: 'r1', ok: true, value: state })
  })

  it("says why an answer didn't land, and refuses an old session", async () => {
    const test = harness(async () => {
      throw new Error('No such command waits for that answer.')
    })
    expect(
      await test.send({ requestId: 'r1', sessionId: 's1', action: 'cancel', commandId: 'cmd-1' })
    ).toEqual({ requestId: 'r1', ok: false, error: 'No such command waits for that answer.' })
    expect(
      await test.send({ requestId: 'r2', sessionId: 'old', action: 'cancel', commandId: 'cmd-1' })
    ).toMatchObject({ ok: false, error: 'That chat view is no longer the active livestream.' })
    expect(test.calls).toHaveLength(1)
    expect(test.committed).toHaveLength(0)
    test.stop()
    expect(test.listening()).toBe(false)
  })
})
