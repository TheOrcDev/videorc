// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/toast', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { COPIED_FEEDBACK_MS, copyText, useCopyText } from './copy-text'

// Plan 174 S1.6b (I-31): quiet success, a "Copied" moment, a loud failure.

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

afterEach(() => {
  toastError.mockReset()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('copyText', () => {
  it('copies quietly and says it landed', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    await expect(copyText('rtmp://example')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('rtmp://example')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says so when the write is refused, and never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await expect(copyText('token', "Couldn't copy the pairing token.")).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't copy the pairing token.")
  })

  it('says so when there is no clipboard at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await expect(copyText('token')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't copy that.")
  })
})

describe('useCopyText', () => {
  let root: Root
  let container: HTMLDivElement
  let latest: ReturnType<typeof useCopyText> | null = null

  function Probe(): null {
    latest = useCopyText()
    return null
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root.render(createElement(Probe)))
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  it('reads "Copied" for 1.5 s after a copy lands', async () => {
    vi.useFakeTimers()
    stubClipboard(async () => {})
    expect(COPIED_FEEDBACK_MS).toBe(1500)
    expect(latest?.copied).toBe(false)
    await act(async () => {
      await latest?.copy('link')
    })
    expect(latest?.copied).toBe(true)
    act(() => vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 1))
    expect(latest?.copied).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(latest?.copied).toBe(false)
  })

  it('stays quiet in place when the copy fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubClipboard(async () => {
      throw new Error('denied')
    })
    await act(async () => {
      await latest?.copy('link')
    })
    expect(latest?.copied).toBe(false)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
