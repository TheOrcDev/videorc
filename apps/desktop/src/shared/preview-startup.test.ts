import { describe, expect, it } from 'vitest'

import {
  PREVIEW_STARTUP_TITLE,
  type PreviewStartupSource,
  previewStartupSourceName,
  previewStartupStep,
  previewStartupView
} from './preview-startup'

const screen = (live: boolean, name: string | null = 'LG HDR 4K'): PreviewStartupSource => ({
  kind: 'screen',
  name,
  live
})
const camera = (live: boolean, name: string | null = 'ZV-E10M2'): PreviewStartupSource => ({
  kind: 'camera',
  name,
  live
})

describe('previewStartupStep', () => {
  it('waits for the capture engine before anything else', () => {
    expect(previewStartupStep(false, [screen(true), camera(true)])).toBe(1)
  })

  it('waits for the sources the scene uses once connected', () => {
    expect(previewStartupStep(true, [screen(false), camera(true)])).toBe(2)
    expect(previewStartupStep(true, [screen(true), camera(false)])).toBe(2)
  })

  it('draws the first frame once every source is live, or when the scene uses none', () => {
    expect(previewStartupStep(true, [screen(true), camera(true)])).toBe(3)
    expect(previewStartupStep(true, [])).toBe(3)
  })
})

describe('previewStartupView', () => {
  it('names the step in plain words', () => {
    expect(previewStartupView({ engineConnected: false, sources: [], stalled: false })).toEqual({
      step: 1,
      title: PREVIEW_STARTUP_TITLE,
      detail: 'Waiting for the capture engine',
      stalled: false,
      action: null
    })
    expect(
      previewStartupView({ engineConnected: true, sources: [screen(true)], stalled: false }).detail
    ).toBe('Drawing the first frame')
  })

  it('names only the sources still connecting', () => {
    expect(
      previewStartupView({
        engineConnected: true,
        sources: [screen(false), camera(false)],
        stalled: false
      }).detail
    ).toBe('Connecting LG HDR 4K and ZV-E10M2')
    expect(
      previewStartupView({
        engineConnected: true,
        sources: [screen(true), camera(false)],
        stalled: false
      }).detail
    ).toBe('Connecting ZV-E10M2')
  })

  it('says what is stuck after a stall and offers Sources for a quiet source', () => {
    const one = previewStartupView({
      engineConnected: true,
      sources: [screen(true), camera(false)],
      stalled: true
    })
    expect(one.detail).toBe('ZV-E10M2 hasn’t sent a picture yet.')
    expect(one.action).toBe('open-sources')
    expect(one.stalled).toBe(true)

    const both = previewStartupView({
      engineConnected: true,
      sources: [screen(false, null), camera(false, null)],
      stalled: true
    })
    expect(both.detail).toBe('Your screen and camera haven’t sent a picture yet.')
    expect(
      previewStartupView({
        engineConnected: true,
        sources: [screen(false, null), camera(false)],
        stalled: false
      }).detail
    ).toBe('Connecting your screen and ZV-E10M2')
  })

  it('says a blocked source is stuck at once', () => {
    const view = previewStartupView({
      engineConnected: true,
      sources: [screen(true), { ...camera(false), blocked: true }],
      stalled: false
    })
    expect(view.stalled).toBe(true)
    expect(view.detail).toBe('ZV-E10M2 hasn’t sent a picture yet.')
    expect(view.action).toBe('open-sources')
  })

  it('offers no button where no fix applies', () => {
    const engine = previewStartupView({ engineConnected: false, sources: [], stalled: true })
    expect(engine.detail).toBe('The capture engine is taking longer than usual.')
    expect(engine.action).toBeNull()
    const frame = previewStartupView({ engineConnected: true, sources: [], stalled: true })
    expect(frame.detail).toBe('The first frame is taking longer than usual.')
    expect(frame.action).toBeNull()
  })
})

describe('previewStartupSourceName', () => {
  it('drops the detail after a middle dot and falls back to the kind', () => {
    expect(previewStartupSourceName(screen(false, 'LG HDR 4K · 3840×2160'))).toBe('LG HDR 4K')
    expect(previewStartupSourceName(screen(false, '  '))).toBe('your screen')
    expect(previewStartupSourceName(camera(false, null))).toBe('your camera')
  })
})
