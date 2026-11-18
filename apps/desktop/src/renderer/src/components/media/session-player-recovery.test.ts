// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionPlayer } from '@/components/media/session-player'
import { TooltipProvider } from '@/components/ui/tooltip'

// QA F18: a recording that recovers from a media error picks up where it
// was, like a scheduled grant renewal does.

const OLD_URL = 'videorc-asset://session-media/old'
const NEW_URL = 'videorc-asset://session-media/new'

let root: Root
let container: HTMLDivElement
let grant: ReturnType<typeof vi.fn>
let play: ReturnType<typeof vi.fn>
let paused: boolean
let errorCode: number | null

async function mount(sessionId = 'session-1'): Promise<HTMLVideoElement> {
  await act(async () =>
    root.render(createElement(TooltipProvider, null, createElement(SessionPlayer, { sessionId })))
  )
  const video = container.querySelector('video')!
  Object.defineProperties(video, {
    duration: { configurable: true, value: 600 },
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, value: false },
    play: { configurable: true, value: play },
    error: { configurable: true, get: () => (errorCode === null ? null : { code: errorCode }) }
  })
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
  return video
}

/** Play from 120 s on the first grant. */
async function playAt120(video: HTMLVideoElement): Promise<void> {
  await act(async () => {
    paused = false
    video.currentTime = 120
    video.dispatchEvent(new Event('timeupdate'))
    video.dispatchEvent(new Event('play'))
  })
}

/**
 * Happy-dom decodes nothing: the new source's load is modelled as the
 * browser does it, back at 0 and paused, before its metadata arrives.
 */
async function reload(video: HTMLVideoElement): Promise<void> {
  expect(video.getAttribute('src')).toBe(NEW_URL)
  paused = true
  errorCode = null
  video.currentTime = 0
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  paused = true
  errorCode = null
  play = vi.fn(async () => undefined)
  grant = vi
    .fn()
    .mockResolvedValueOnce({ url: OLD_URL, expiresAt: Date.now() + 65_000 })
    .mockResolvedValue({ url: NEW_URL, expiresAt: Date.now() + 3_600_000 })
  vi.stubGlobal('videorc', { grantSessionMedia: grant })
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

describe('SessionPlayer recovery (QA F18)', () => {
  it('keeps the position and play state across a scheduled renewal', async () => {
    const video = await mount()
    await playAt120(video)
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(grant).toHaveBeenCalledTimes(2)
    await reload(video)
    expect(video.currentTime).toBe(120)
    expect(play).toHaveBeenCalledOnce()
  })

  for (const code of [2, 4]) {
    it(`keeps the position and play state across a re-grant after media error ${code}`, async () => {
      const video = await mount()
      await playAt120(video)
      errorCode = code
      await act(async () => video.dispatchEvent(new Event('error')))
      expect(grant).toHaveBeenCalledTimes(2)
      await reload(video)
      expect(video.currentTime).toBe(120)
      expect(play).toHaveBeenCalledOnce()
    })
  }

  it('keeps a paused position paused across the re-grant', async () => {
    const video = await mount()
    await act(async () => {
      video.currentTime = 45
      video.dispatchEvent(new Event('timeupdate'))
    })
    errorCode = 2
    await act(async () => video.dispatchEvent(new Event('error')))
    await reload(video)
    expect(video.currentTime).toBe(45)
    expect(play).not.toHaveBeenCalled()
  })

  it('starts another recording from the start', async () => {
    const video = await mount('session-1')
    await playAt120(video)
    errorCode = 2
    await act(async () => video.dispatchEvent(new Event('error')))
    // The player is pointed at another recording before the re-grant lands.
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(SessionPlayer, { sessionId: 'session-2' })
        )
      )
    )
    await reload(video)
    expect(video.currentTime).toBe(0)
    expect(play).not.toHaveBeenCalled()
  })
})
