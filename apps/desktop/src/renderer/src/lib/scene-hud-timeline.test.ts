import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SceneHudTimeline, type SceneHudView } from './scene-hud-timeline'

describe('the key HUD clock (plan 231 D20)', () => {
  let views: SceneHudView<string>[]
  let timeline: SceneHudTimeline<string>

  beforeEach(() => {
    vi.useFakeTimers()
    views = []
    timeline = new SceneHudTimeline<string>((view) => views.push(view))
  })

  afterEach(() => {
    timeline.dispose()
    vi.useRealTimers()
  })

  const last = (): SceneHudView<string> | undefined => views.at(-1)

  it('shows at once, holds 900 ms, then fades over 120 ms on opacity alone', () => {
    timeline.present('Figma', { reducedMotion: false })
    expect(last()).toEqual({ item: 'Figma', phase: 'shown', fadeMs: 0 })
    vi.advanceTimersByTime(899)
    expect(last()?.phase).toBe('shown')
    vi.advanceTimersByTime(1)
    expect(last()).toEqual({ item: 'Figma', phase: 'fading', fadeMs: 120 })
    vi.advanceTimersByTime(119)
    expect(last()?.phase).toBe('fading')
    vi.advanceTimersByTime(1)
    expect(last()).toEqual({ item: null, phase: 'hidden', fadeMs: 0 })
  })

  it('replaces the chip and restarts the clock when a second switch lands inside the hold', () => {
    timeline.present('Figma', { reducedMotion: false })
    vi.advanceTimersByTime(600)
    timeline.present('T3 Code', { reducedMotion: false })
    expect(last()).toEqual({ item: 'T3 Code', phase: 'shown', fadeMs: 0 })
    // The first chip's clock is gone: 900 ms from the second switch, not the first.
    vi.advanceTimersByTime(300)
    expect(last()?.phase).toBe('shown')
    vi.advanceTimersByTime(600)
    expect(last()).toEqual({ item: 'T3 Code', phase: 'fading', fadeMs: 120 })
    vi.advanceTimersByTime(120)
    expect(last()?.phase).toBe('hidden')
    // Only the last scene was ever named after the switch.
    expect(views.filter((view) => view.item === 'Figma').every((v) => v.phase === 'shown')).toBe(
      true
    )
  })

  it('also replaces a chip that is already fading', () => {
    timeline.present('Figma', { reducedMotion: false })
    vi.advanceTimersByTime(950)
    expect(last()?.phase).toBe('fading')
    timeline.present('Chrome', { reducedMotion: false })
    expect(last()).toEqual({ item: 'Chrome', phase: 'shown', fadeMs: 0 })
    vi.advanceTimersByTime(200)
    expect(last()?.item).toBe('Chrome')
  })

  it('disappears without the fade under reduced motion', () => {
    timeline.present('Figma', { reducedMotion: true })
    vi.advanceTimersByTime(900)
    expect(last()).toEqual({ item: null, phase: 'hidden', fadeMs: 0 })
    expect(views.some((view) => view.phase === 'fading')).toBe(false)
  })

  it('takes a longer hold only when main asks for one (screenshots)', () => {
    timeline.present('Figma', { reducedMotion: false, holdMs: 5_000 })
    vi.advanceTimersByTime(4_999)
    expect(last()?.phase).toBe('shown')
    vi.advanceTimersByTime(1)
    expect(last()?.phase).toBe('fading')
  })
})
