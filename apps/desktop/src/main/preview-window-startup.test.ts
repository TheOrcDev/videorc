import { describe, expect, it } from 'vitest'

import type { CompositorSourceStatus } from '../shared/backend'
import { PREVIEW_STARTUP_STALL_MS, PREVIEW_STARTUP_TITLE } from '../shared/preview-startup'
import {
  PREVIEW_WINDOW_INITIAL_HINT,
  PREVIEW_WINDOW_STEPS_CSS,
  compositorStartupSources,
  previewWindowHintHtml,
  previewWindowHintScript,
  previewWindowInitialHint,
  previewWindowSegmentStates,
  previewWindowStartupHint,
  previewWindowWarningHint
} from './preview-window-startup'

const source = (kind: CompositorSourceStatus['kind'], state: string): CompositorSourceStatus => ({
  kind,
  state
})

describe('previewWindowStartupHint', () => {
  it('waits for the capture engine while the backend is away', () => {
    const { hint } = previewWindowStartupHint({
      backendConnected: false,
      compositor: { sources: [source('screen', 'live')] },
      clock: null,
      nowMs: 0
    })
    expect(hint).toEqual({
      title: PREVIEW_STARTUP_TITLE,
      detail: 'Waiting for the capture engine',
      step: 1,
      stalled: false
    })
    expect(
      previewWindowStartupHint({ backendConnected: true, compositor: null, clock: null, nowMs: 0 })
        .hint.step
    ).toBe(1)
  })

  it('trusts the connection before the compositor status is read', () => {
    expect(previewWindowInitialHint(false).step).toBe(1)
    expect(previewWindowInitialHint(true)).toEqual({
      title: PREVIEW_STARTUP_TITLE,
      detail: 'Drawing the first frame',
      step: 3,
      stalled: false
    })
  })

  it('names the compositor sources still connecting by kind', () => {
    const { hint } = previewWindowStartupHint({
      backendConnected: true,
      compositor: { sources: [source('window', 'starting'), source('camera', 'starting')] },
      clock: null,
      nowMs: 0
    })
    expect(hint.step).toBe(2)
    expect(hint.detail).toBe('Connecting your screen and camera')
  })

  it('draws the first frame once every source is live', () => {
    const { hint } = previewWindowStartupHint({
      backendConnected: true,
      compositor: { sources: [source('screen', 'live'), source('camera', 'live')] },
      clock: null,
      nowMs: 0
    })
    expect(hint.detail).toBe('Drawing the first frame')
  })

  it('keeps the clock across a step and restarts it when the step changes', () => {
    const compositor = { sources: [source('camera', 'starting')] }
    const first = previewWindowStartupHint({
      backendConnected: true,
      compositor,
      clock: null,
      nowMs: 1_000
    })
    expect(first.clock).toEqual({ step: 2, startedAtMs: 1_000 })
    const later = previewWindowStartupHint({
      backendConnected: true,
      compositor,
      clock: first.clock,
      nowMs: 1_000 + PREVIEW_STARTUP_STALL_MS
    })
    expect(later.clock).toBe(first.clock)
    expect(later.hint.stalled).toBe(true)
    expect(later.hint.detail).toBe('Your camera hasn’t sent a picture yet.')
    const next = previewWindowStartupHint({
      backendConnected: true,
      compositor: { sources: [source('camera', 'live')] },
      clock: later.clock,
      nowMs: 2_000 + PREVIEW_STARTUP_STALL_MS
    })
    expect(next.clock).toEqual({ step: 3, startedAtMs: 2_000 + PREVIEW_STARTUP_STALL_MS })
    expect(next.hint.stalled).toBe(false)
  })
})

describe('compositorStartupSources', () => {
  it('marks a source that cannot send a picture as blocked', () => {
    expect(compositorStartupSources({ sources: [source('screen', 'source-missing')] })).toEqual([
      { kind: 'screen', name: null, live: false, blocked: true }
    ])
    expect(compositorStartupSources(null)).toEqual([])
  })
})

describe('the hint markup', () => {
  it('starts on step 1 with three segments', () => {
    expect(PREVIEW_WINDOW_INITIAL_HINT.step).toBe(1)
    const html = previewWindowHintHtml(PREVIEW_WINDOW_INITIAL_HINT)
    expect(html).toContain(PREVIEW_STARTUP_TITLE)
    expect(html).toContain('id="videorc-wait-detail"')
    expect(html.match(/data-state="current"/g)).toHaveLength(1)
    expect(html.match(/data-state="next"/g)).toHaveLength(2)
    expect(html).not.toContain(' hidden')
  })

  it('hides the segments under a warning and escapes the reason', () => {
    const warning = previewWindowWarningHint('Stalled: <helper> lost')
    expect(previewWindowSegmentStates(warning)).toEqual(['next', 'next', 'next'])
    const html = previewWindowHintHtml(warning)
    expect(html).toContain('class="steps" hidden')
    expect(html).toContain('Stalled: &lt;helper&gt; lost')
  })

  it('never names the engine room in the waiting words', () => {
    const html = previewWindowHintHtml(PREVIEW_WINDOW_INITIAL_HINT)
    expect(html).not.toMatch(/native surface|compositor/i)
  })

  it('breathes the running step and rests it under reduced motion', () => {
    expect(PREVIEW_WINDOW_STEPS_CSS).toContain('animation: steps-breathe')
    expect(PREVIEW_WINDOW_STEPS_CSS).toContain('prefers-reduced-motion')
  })
})

describe('previewWindowHintScript', () => {
  it('hides the whole hint block for null', () => {
    const script = previewWindowHintScript(null)
    expect(script).toContain("hint.style.display = 'none'")
    expect(script).not.toContain('innerHTML')
  })

  it('repaints the hint in place for a hint', () => {
    const script = previewWindowHintScript(PREVIEW_WINDOW_INITIAL_HINT)
    expect(script).toContain('hint.innerHTML = ')
    expect(script).toContain("hint.style.display = 'flex'")
    expect(script).toContain(JSON.stringify(previewWindowHintHtml(PREVIEW_WINDOW_INITIAL_HINT)))
  })
})
