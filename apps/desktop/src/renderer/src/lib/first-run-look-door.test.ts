import { describe, expect, it, vi } from 'vitest'

import { warmFirstRunLook, withFirstRunLook } from './first-run-look-door'

describe('withFirstRunLook', () => {
  it('waits for the helpers once, then runs inside the call', async () => {
    const order: string[] = []
    withFirstRunLook(() => order.push('first'))
    withFirstRunLook(() => order.push('second'))
    // The setup chunk is still loading: nothing has run yet.
    expect(order).toEqual([])
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']))

    // Loaded: a look choice is applied inside its own press, so React draws
    // it before the next press and that press builds on it.
    const run = vi.fn()
    withFirstRunLook(run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].firstRunLookPatch).toBeTypeOf('function')
  })

  it('warming is safe to repeat', () => {
    warmFirstRunLook()
    warmFirstRunLook()
    const run = vi.fn()
    withFirstRunLook(run)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
