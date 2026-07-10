import { describe, expect, it } from 'vitest'

import { runNativePreviewDriverReset } from './native-preview-driver-reset'

describe('native preview driver reset', () => {
  it('retires the wedged driver before resolving and attaching a replacement', async () => {
    const oldDriver = { stopped: false }
    const replacement = { attached: false }
    let currentDriver: typeof oldDriver | typeof replacement | null = oldDriver
    let retryBlocked = true

    await runNativePreviewDriverReset({
      retire: async () => {
        oldDriver.stopped = true
        currentDriver = null
      },
      allowImmediateRetry: () => {
        retryBlocked = false
      },
      reconcile: async () => {
        if (!retryBlocked && currentDriver === null) {
          replacement.attached = true
          currentDriver = replacement
        }
      }
    })

    expect(oldDriver.stopped).toBe(true)
    expect(replacement.attached).toBe(true)
    expect(currentDriver).toBe(replacement)
  })
})
