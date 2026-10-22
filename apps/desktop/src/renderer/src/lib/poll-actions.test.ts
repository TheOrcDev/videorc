import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { PollStatus } from '@/lib/backend'
import { userErrorMessage } from '@/lib/user-error'
import {
  POLL_REFUSALS,
  pollActionContext,
  pollActionError,
  pollAfterReply,
  pollIsRunning,
  pollRefusal,
  runPollAction
} from './poll-actions'

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/high-risk-contracts.json', import.meta.url),
    'utf8'
  )
) as { poll: { open: PollStatus; final: PollStatus; untimed: PollStatus } }
const { open, final, untimed } = fixtures.poll

describe('poll actions (plan 188)', () => {
  it('calls the one RPC per action, by the poll id', async () => {
    const calls: Array<[string, unknown]> = []
    const client = {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push([method, params])
        return open as T
      }
    }
    const params = {
      question: 'Tabs?',
      options: ['Tabs', 'Spaces'],
      durationSeconds: 60,
      postInChat: true
    }
    await runPollAction(client, { action: 'start', params })
    for (const action of ['end', 'cancel', 'reshow'] as const) {
      await runPollAction(client, { action, pollId: 'p-1' })
    }
    expect(calls).toEqual([
      ['polls.start', params],
      ['polls.end', { pollId: 'p-1' }],
      ['polls.cancel', { pollId: 'p-1' }],
      ['polls.reshow', { pollId: 'p-1' }]
    ])
  })

  it('shows a refusal as its own sentence, a warning, through the IPC wrapper', () => {
    for (const sentence of POLL_REFUSALS) {
      const wrapped = new Error(
        `Error invoking remote method 'comments-window:poll': Error: ${sentence}`
      )
      expect(pollRefusal(wrapped)).toBe(sentence)
      const copy = userErrorMessage(pollActionError(wrapped), pollActionContext('start'))
      expect(copy).toMatchObject({
        title: "Couldn't start the poll",
        description: sentence,
        tone: 'warning'
      })
    }
    const other = new Error('socket closed unexpectedly')
    expect(pollRefusal(other)).toBeNull()
    expect(pollActionError(other)).toBe(other)
    expect(pollActionContext('reshow')).toEqual({ action: 'show', object: 'the poll result' })
  })

  it('knows which polls still take votes', () => {
    expect(pollIsRunning(open)).toBe(true)
    expect(pollIsRunning({ ...open, state: 'counting' })).toBe(true)
    expect(pollIsRunning(final)).toBe(false)
    expect(pollIsRunning({ ...final, state: 'cancelled' })).toBe(false)
    expect(pollIsRunning(null)).toBe(false)
  })

  it('lets a reply move the poll forward only, so newer events are never undone', () => {
    // No poll yet, or a new one: the reply lands.
    expect(pollAfterReply(null, open)).toBe(open)
    expect(pollAfterReply(final, untimed)).toBe(untimed)
    // A start reply that lost the race to a newer poll's events stays out.
    expect(pollAfterReply(untimed, open)).toBe(untimed)
    // Same poll: a later state lands; an equal or earlier one keeps the events'.
    const counting = { ...open, state: 'counting' as const, totalVotes: 51 }
    expect(pollAfterReply(open, counting)).toBe(counting)
    expect(pollAfterReply(counting, open)).toBe(counting)
    const newerTally = { ...open, totalVotes: 80 }
    expect(pollAfterReply(newerTally, open)).toBe(newerTally)
    expect(pollAfterReply(counting, { ...final, pollId: open.pollId })).toMatchObject({
      state: 'final'
    })
  })
})
