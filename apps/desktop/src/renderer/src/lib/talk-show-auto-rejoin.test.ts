import { describe, expect, it, vi } from 'vitest'

import type { CloudOnAir, CloudStatus } from './backend'
import {
  AUTO_REJOIN_RETRY_MS,
  AUTO_REJOIN_WAITS,
  autoRejoinDecision,
  runAutoRejoin,
  type AutoRejoinIo
} from './talk-show-auto-rejoin'

// 2026-11-19: the backend restarted in the middle of a live talk show and the
// host stayed out of the room until they pressed Resume. The Studio now asks
// for the room back by itself, but only for a show the new backend confirmed
// as this computer's.

const held = { showId: 'sh_talk' }
const since = '2026-11-19T14:21:19.000Z'
/** What a restarted backend reports once it found the show and renewed its epoch. */
const mine: CloudStatus = {
  phase: 'live',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
  show: { id: 'sh_talk', nodeId: 'managed', resumable: true, kind: 'talk' },
  connected: true,
  directFallbackAvailable: false,
  controller: { controllerEpoch: 3, needsEnable: [], restoredViews: 0, cleared: [] }
}
const open: CloudStatus = {
  ...mine,
  show: { ...mine.show!, resumable: false },
  room: { phase: 'open' } as CloudStatus['room']
}
const onAir = (patch: Partial<CloudOnAir>): CloudOnAir => ({
  name: 'iPhone',
  kind: 'phone',
  source: 'host',
  waiting: false,
  thisDevice: false,
  since,
  ...patch
})
const decide = (status: CloudStatus | null, failures = 0) =>
  autoRejoinDecision({ held, failures, status })

describe('autoRejoinDecision', () => {
  it('resumes the show this computer still controls', () => {
    expect(decide(mine)).toEqual({ action: 'resume' })
    expect(decide({ ...mine, onAir: onAir({ thisDevice: true }) })).toEqual({ action: 'resume' })
    // Open and not live yet: the room is the host's all the same.
    expect(decide({ ...mine, phase: 'hold' })).toEqual({ action: 'resume' })
  })

  it('never resumes a show another device took over: Continue here stays explicit', () => {
    const elsewhere = { action: 'stop', reason: 'elsewhere' }
    expect(decide({ ...mine, onAir: onAir({}) })).toEqual(elsewhere)
    expect(decide({ ...mine, controller: { ...mine.controller!, lost: true } })).toEqual(elsewhere)
    expect(
      decide({ ...mine, controller: { ...mine.controller!, takenOverFrom: 'another-device' } })
    ).toEqual(elsewhere)
    expect(decide({ ...mine, stoppedBy: 'taken-over' })).toEqual(elsewhere)
    expect(decide({ ...mine, onAir: onAir({ waiting: true }) })).toEqual({
      action: 'stop',
      reason: 'handed-off'
    })
  })

  it('waits for the renewed controller epoch, and never resumes without it', () => {
    // A kept epoch videorc.com refused (another computer has the show) looks
    // exactly like this, and Resume would take the show over.
    expect(decide({ ...mine, controller: undefined })).toEqual({ action: 'wait', on: 'controller' })
    expect(decide(null)).toEqual({ action: 'wait', on: 'backend' })
    expect(decide({ ...mine, show: undefined })).toEqual({ action: 'wait', on: 'show' })
  })

  it('does nothing for a room the host closed, or with no room open before', () => {
    // The hook forgets the room when it closes under the backend that held it.
    expect(autoRejoinDecision({ held: null, failures: 0, status: mine })).toEqual({
      action: 'stop',
      reason: 'nothing-held'
    })
  })

  it('does nothing for a show that ended, is ending, or is another show', () => {
    const over = { action: 'stop', reason: 'show-over' }
    expect(decide({ ...mine, phase: 'ending' })).toEqual(over)
    expect(decide({ ...mine, phase: 'off' })).toEqual(over)
    expect(decide({ ...mine, phase: 'failed' })).toEqual(over)
    expect(decide({ ...mine, show: { ...mine.show!, kind: 'solo' } })).toEqual(over)
    expect(decide({ ...mine, show: { ...mine.show!, resumable: false } })).toEqual(over)
    expect(decide({ ...mine, show: { ...mine.show!, id: 'sh_other' } })).toEqual({
      action: 'stop',
      reason: 'other-show'
    })
  })

  it('leaves a room the backend still holds to the join itself', () => {
    expect(decide(open)).toEqual({ action: 'stop', reason: 'room-open' })
    // Even after failures: an open room is never a failure.
    expect(decide(open, AUTO_REJOIN_RETRY_MS.length + 1)).toEqual({
      action: 'stop',
      reason: 'room-open'
    })
  })

  it('gives up after the last retry instead of looping', () => {
    expect(decide(mine, AUTO_REJOIN_RETRY_MS.length)).toEqual({ action: 'resume' })
    expect(decide(mine, AUTO_REJOIN_RETRY_MS.length + 1)).toEqual({
      action: 'stop',
      reason: 'gave-up'
    })
    expect(decide(null, AUTO_REJOIN_RETRY_MS.length + 1)).toEqual({
      action: 'stop',
      reason: 'gave-up'
    })
  })
})

function io(patch: Partial<AutoRejoinIo>): AutoRejoinIo & { slept: number[] } {
  const slept: number[] = []
  return {
    held,
    readStatus: vi.fn(async () => mine),
    resume: vi.fn(async () => open),
    sleep: async (ms) => {
      slept.push(ms)
    },
    cancelled: () => false,
    onStatus: vi.fn(),
    onReconnecting: vi.fn(),
    slept,
    ...patch
  }
}

describe('runAutoRejoin', () => {
  it('resumes once and reports the open room', async () => {
    const run = io({})
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'resumed', status: open })
    expect(run.resume).toHaveBeenCalledTimes(1)
    expect(run.onReconnecting).toHaveBeenCalledTimes(1)
    expect(run.onStatus).toHaveBeenCalledWith(mine)
    expect(run.slept).toEqual([])
  })

  it('asks again while the new backend finds the show and renews its epoch', async () => {
    const answers: (CloudStatus | Error)[] = [
      new Error('not connected'),
      { ...mine, show: undefined, controller: undefined },
      { ...mine, controller: undefined },
      mine
    ]
    const run = io({
      readStatus: vi.fn(async () => {
        const next = answers.shift() ?? mine
        if (next instanceof Error) throw next
        return next
      })
    })
    await expect(runAutoRejoin(run)).resolves.toMatchObject({ result: 'resumed' })
    expect(run.resume).toHaveBeenCalledTimes(1)
    expect(run.slept).toEqual([1_000, 1_000, 1_000])
    expect(run.onReconnecting).toHaveBeenCalledTimes(1)
  })

  it('backs off after a failed resume, then gives up: it never loops', async () => {
    const run = io({ resume: vi.fn(async () => Promise.reject(new Error('A room is opening.'))) })
    const outcome = await runAutoRejoin(run)
    expect(outcome).toMatchObject({ result: 'failed', reason: 'resume-failed' })
    expect(run.resume).toHaveBeenCalledTimes(AUTO_REJOIN_RETRY_MS.length + 1)
    expect(run.slept).toEqual([...AUTO_REJOIN_RETRY_MS])
  })

  it('a retry that works puts the host back', async () => {
    const resume = vi
      .fn<() => Promise<CloudStatus>>()
      .mockRejectedValueOnce(new Error('The camera is still returning.'))
      .mockResolvedValue(open)
    const run = io({ resume })
    await expect(runAutoRejoin(run)).resolves.toMatchObject({ result: 'resumed' })
    expect(resume).toHaveBeenCalledTimes(2)
    expect(run.slept).toEqual([AUTO_REJOIN_RETRY_MS[0]])
  })

  it('stops without a word and without a resume when another device has the show', async () => {
    const run = io({ readStatus: vi.fn(async () => ({ ...mine, onAir: onAir({}) })) })
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'stopped', reason: 'elsewhere' })
    expect(run.resume).not.toHaveBeenCalled()
    expect(run.onReconnecting).not.toHaveBeenCalled()
  })

  it('a show taken over between two retries is not resumed again', async () => {
    const answers: CloudStatus[] = [
      mine,
      { ...mine, controller: { ...mine.controller!, lost: true } }
    ]
    const run = io({
      readStatus: vi.fn(async () => answers.shift() ?? mine),
      resume: vi.fn(async () => Promise.reject(new Error('refused')))
    })
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'stopped', reason: 'elsewhere' })
    expect(run.resume).toHaveBeenCalledTimes(1)
  })

  it('fails, without resuming, when the controller epoch never comes back', async () => {
    const run = io({ readStatus: vi.fn(async () => ({ ...mine, controller: undefined })) })
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'failed', reason: 'unconfirmed' })
    expect(run.resume).not.toHaveBeenCalled()
    expect(run.slept).toHaveLength(AUTO_REJOIN_WAITS)
  })

  it('ends quietly when the show is gone', async () => {
    const run = io({ readStatus: vi.fn(async () => ({ ...mine, show: undefined })) })
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'stopped', reason: 'show-over' })
    expect(run.resume).not.toHaveBeenCalled()
    expect(run.onReconnecting).not.toHaveBeenCalled()
  })

  it('stops as soon as the backend connection changes again', async () => {
    let cancelled = false
    const run = io({
      cancelled: () => cancelled,
      readStatus: vi.fn(async () => {
        cancelled = true
        return mine
      })
    })
    await expect(runAutoRejoin(run)).resolves.toEqual({ result: 'cancelled' })
    expect(run.resume).not.toHaveBeenCalled()
    expect(run.onStatus).not.toHaveBeenCalled()
  })
})
