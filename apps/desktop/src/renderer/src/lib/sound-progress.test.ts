import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVoiceProgressSource, voiceProgress } from './sound-progress'

// Plan 189: a pad's progress bar runs on the shared frame loop with no React
// render, and leaves the loop when the sound reaches its end.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('voice progress', () => {
  it('runs 0 to 1 over the voice, clamped', () => {
    const voice = { startedAtMs: 1000, durationMs: 2000 }
    expect(voiceProgress(voice, 500)).toBe(0)
    expect(voiceProgress(voice, 2000)).toBe(0.5)
    expect(voiceProgress(voice, 9000)).toBe(1)
    expect(voiceProgress({ startedAtMs: 0, durationMs: 0 }, 0)).toBe(1)
  })

  it('emits every frame and leaves the loop at the end', () => {
    const frames: Array<(time: number) => void> = []
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    let now = 1000
    const source = createVoiceProgressSource({ startedAtMs: 1000, durationMs: 1000 }, () => now)
    const seen: number[] = []
    source.subscribe((progress) => seen.push(progress))
    now = 1500
    frames.shift()?.(0)
    now = 2500
    frames.shift()?.(0)
    expect(seen).toEqual([0, 0.5, 1])
    // At its end nothing asks for another frame.
    expect(frames).toHaveLength(0)
  })
})
