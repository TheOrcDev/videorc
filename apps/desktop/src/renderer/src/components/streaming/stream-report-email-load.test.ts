// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamReportEmailState } from '@/lib/backend'

import {
  STREAM_REPORT_LOAD_FAILED,
  STREAM_REPORT_LOAD_RETRY_MS,
  StreamReportEmailSection
} from './stream-report-email-section'

// QA F13: a failed first streamReport.email.get used to leave both switches
// and Send disabled with no error and no way back. It now says so, offers
// Try again, and retries on its own a few times.

const fake = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/hooks/use-studio', () => ({ useStudioDiagnostics: () => ({ client: fake.client }) }))
vi.mock('@/lib/user-error', () => ({ toastUserError: () => undefined }))

const ACCOUNT: StreamReportEmailState = {
  signedIn: true,
  email: 'fixture@example.invalid',
  enabled: true,
  history: true,
  envDisabled: false
}

let root: Root
let container: HTMLDivElement

const switches = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="switch"]')
]
const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text)

async function mount(request: ReturnType<typeof vi.fn>): Promise<void> {
  fake.client = { requestTyped: request, on: () => () => undefined }
  await act(async () => root.render(createElement(StreamReportEmailSection)))
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('StreamReportEmailSection first load', () => {
  it('says a failed first read failed, offers Try again, and recovers by itself', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('RPC timed out'))
      .mockResolvedValue(ACCOUNT)
    await mount(request)
    await advance(0)

    expect(container.textContent).toContain(STREAM_REPORT_LOAD_FAILED)
    expect(button('Try again')).toBeDefined()

    await advance(STREAM_REPORT_LOAD_RETRY_MS[0])
    expect(request).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain(STREAM_REPORT_LOAD_FAILED)
    expect(switches().map((entry) => entry.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    expect(button('Send')?.disabled).toBe(false)
  })

  it('stops retrying after a few tries, and Try again reads once more', async () => {
    const request = vi.fn().mockRejectedValue(new Error('RPC timed out'))
    await mount(request)
    await advance(10 * 60_000)

    expect(request).toHaveBeenCalledTimes(1 + STREAM_REPORT_LOAD_RETRY_MS.length)
    expect(container.textContent).toContain(STREAM_REPORT_LOAD_FAILED)

    request.mockResolvedValue(ACCOUNT)
    await act(async () => button('Try again')!.click())
    await advance(0)
    expect(request).toHaveBeenCalledTimes(2 + STREAM_REPORT_LOAD_RETRY_MS.length)
    expect(switches().map((entry) => entry.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  })

  it('keeps the choices it showed when a re-read after a failed save fails', async () => {
    let reads = 0
    const request = vi.fn((method: string) => {
      if (method === 'streamReport.email.get') {
        reads += 1
        return reads === 1 ? Promise.resolve(ACCOUNT) : Promise.reject(new Error('down'))
      }
      return Promise.reject(new Error('save failed'))
    })
    await mount(request)
    await advance(0)
    await act(async () => switches()[0]!.click())
    await advance(60_000)

    expect(reads).toBe(2)
    expect(container.textContent).not.toContain(STREAM_REPORT_LOAD_FAILED)
    expect(switches().map((entry) => entry.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  })

  it("forgets the old account's choices when the account changes and its read fails", async () => {
    let accountChanged: () => void = () => undefined
    const request = vi.fn().mockResolvedValueOnce(ACCOUNT).mockRejectedValue(new Error('down'))
    fake.client = {
      requestTyped: request,
      on: (_event: string, listener: () => void) => {
        accountChanged = listener
        return () => undefined
      }
    }
    await act(async () => root.render(createElement(StreamReportEmailSection)))
    await advance(0)
    await act(async () => accountChanged())
    await advance(0)

    expect(container.textContent).toContain(STREAM_REPORT_LOAD_FAILED)
    expect(switches().map((entry) => entry.getAttribute('aria-checked'))).toEqual(['false'])
    expect(button('Try again')).toBeDefined()
    await advance(STREAM_REPORT_LOAD_RETRY_MS[0]!)
    expect(request).toHaveBeenCalledTimes(3)
  })
})
