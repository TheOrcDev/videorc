import { describe, expect, it } from 'vitest'

import { NativePreviewLatestPump } from './native-preview-latest-pump'

describe('NativePreviewLatestPump', () => {
  it('keeps one apply active and replaces queued work with only the latest value', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const applied: number[] = []
    const superseded: number[] = []
    const pump = new NativePreviewLatestPump<number>({
      apply: async (value) => {
        applied.push(value)
        if (value === 1) {
          await firstMayFinish
        }
      },
      onSuperseded: (value) => superseded.push(value)
    })

    pump.enqueue(1)
    pump.enqueue(2)
    pump.enqueue(3)

    expect(pump.requestDepth).toBe(2)
    expect(applied).toEqual([1])
    expect(superseded).toEqual([2])

    releaseFirst()
    await pump.waitForIdle()

    expect(applied).toEqual([1, 3])
    expect(pump.requestDepth).toBe(0)
  })

  it('continues with the latest value after an apply failure', async () => {
    let releaseFirst!: () => void
    const firstMayFail = new Promise<void>((_, reject) => {
      releaseFirst = () => reject(new Error('present failed'))
    })
    const applied: number[] = []
    const errors: string[] = []
    const pump = new NativePreviewLatestPump<number>({
      apply: async (value) => {
        applied.push(value)
        if (value === 1) {
          await firstMayFail
        }
      },
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error))
    })

    pump.enqueue(1)
    pump.enqueue(2)
    releaseFirst()
    await pump.waitForIdle()

    expect(applied).toEqual([1, 2])
    expect(errors).toEqual(['present failed'])
  })

  it('can discard a pending frame during lifecycle teardown', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const applied: number[] = []
    const pump = new NativePreviewLatestPump<number>({
      apply: async (value) => {
        applied.push(value)
        if (value === 1) {
          await firstMayFinish
        }
      }
    })

    pump.enqueue(1)
    pump.enqueue(2)
    expect(pump.cancelPending()).toBe(2)
    releaseFirst()
    await pump.waitForIdle()

    expect(applied).toEqual([1])
  })
})
