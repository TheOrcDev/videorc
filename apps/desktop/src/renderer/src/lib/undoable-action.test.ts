import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scheduleUndoableAction } from './undoable-action'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleUndoableAction (plan 174 S0.3, E-8)', () => {
  it('runs once the window passes', () => {
    const run = vi.fn()
    const action = scheduleUndoableAction(run, 5000)
    expect(action.state).toBe('pending')
    vi.advanceTimersByTime(4999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledOnce()
    expect(action.state).toBe('done')
    // Late calls change nothing.
    action.undo()
    action.flush()
    expect(run).toHaveBeenCalledOnce()
    expect(action.state).toBe('done')
  })

  it('never runs once undone inside the window', () => {
    const run = vi.fn()
    const action = scheduleUndoableAction(run, 5000)
    vi.advanceTimersByTime(1000)
    action.undo()
    expect(action.state).toBe('undone')
    vi.advanceTimersByTime(10_000)
    action.flush()
    expect(run).not.toHaveBeenCalled()
    expect(action.state).toBe('undone')
  })

  it('runs at once when flushed, and not again later', () => {
    const run = vi.fn()
    const action = scheduleUndoableAction(run, 5000)
    action.flush()
    expect(run).toHaveBeenCalledOnce()
    expect(action.state).toBe('done')
    vi.advanceTimersByTime(10_000)
    expect(run).toHaveBeenCalledOnce()
  })

  it('takes injected timers', () => {
    const setTimeoutSpy = vi.fn(() => 'handle')
    const clearTimeoutSpy = vi.fn()
    const action = scheduleUndoableAction(vi.fn(), 3000, {
      setTimeout: setTimeoutSpy,
      clearTimeout: clearTimeoutSpy
    })
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000)
    action.undo()
    expect(clearTimeoutSpy).toHaveBeenCalledWith('handle')
  })
})
