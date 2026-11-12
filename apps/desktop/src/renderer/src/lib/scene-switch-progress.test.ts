import { describe, expect, it } from 'vitest'

import {
  advanceSceneSwitchProgress,
  SCENE_SWITCH_STATUS_DELAY_MS,
  sceneSwitchStatusLine,
  sceneSwitchStatusVisible,
  startSceneSwitchProgress
} from './scene-switch-progress'

// Issue #1275: a slow switch shows what was clicked and what it waits for.

const start = (target: string, intentId = 1, nowMs = 1_000) =>
  startSceneSwitchProgress(null, { intentId, target, nowMs })

describe('scene switch progress', () => {
  it('names the clicked scene and each phase it waits on', () => {
    let progress = start('Side by side')
    expect(sceneSwitchStatusLine(progress).title).toBe('Side by side · Getting ready…')
    progress = advanceSceneSwitchProgress(progress, 1, {
      phase: 'starting',
      showsCamera: true,
      showsScreen: true
    })!
    expect(sceneSwitchStatusLine(progress).title).toBe(
      "Side by side · Waiting for the camera's first frame…"
    )
    progress = advanceSceneSwitchProgress(progress, 1, { phase: 'drawing' })!
    expect(sceneSwitchStatusLine(progress).title).toBe('Side by side · Drawing the new scene…')
    progress = advanceSceneSwitchProgress(progress, 1, { phase: 'presenting' })!
    expect(sceneSwitchStatusLine(progress).title).toBe('Side by side · Updating the preview…')
  })

  it('waits on the screen, or just applies, when the scene has no camera', () => {
    const screen = advanceSceneSwitchProgress(start('Screen only'), 1, {
      phase: 'starting',
      showsScreen: true
    })!
    expect(sceneSwitchStatusLine(screen).title).toBe(
      "Screen only · Waiting for the screen's first frame…"
    )
    const neither = advanceSceneSwitchProgress(start('Freeform'), 1, { phase: 'starting' })!
    expect(sceneSwitchStatusLine(neither).title).toBe('Freeform · Applying…')
  })

  it('ignores a phase from a switch a newer click replaced', () => {
    const progress = start('Camera only', 2)
    expect(advanceSceneSwitchProgress(progress, 1, { phase: 'drawing' })).toBe(progress)
    expect(advanceSceneSwitchProgress(null, 1, { phase: 'drawing' })).toBeNull()
  })

  it('keeps the same object when nothing changes, so React does not re-render', () => {
    const progress = start('Camera only')
    expect(advanceSceneSwitchProgress(progress, 1, { phase: 'preparing' })).toBe(progress)
  })

  it('shows the line after a moment, and at once when a click took over', () => {
    const progress = start('Side by side', 1, 1_000)
    expect(sceneSwitchStatusVisible(progress, 1_000 + SCENE_SWITCH_STATUS_DELAY_MS - 1)).toBe(false)
    expect(sceneSwitchStatusVisible(progress, 1_000 + SCENE_SWITCH_STATUS_DELAY_MS)).toBe(true)

    const takeover = startSceneSwitchProgress(progress, {
      intentId: 2,
      target: 'Camera only',
      nowMs: 1_200
    })
    expect(takeover.replaced).toBe('Side by side')
    expect(sceneSwitchStatusVisible(takeover, 1_200)).toBe(true)
    expect(sceneSwitchStatusLine(takeover)).toEqual({
      title: 'Camera only · Getting ready…',
      detail: 'Replaces the switch to Side by side.'
    })
  })

  it('a second click on the same scene replaces nothing', () => {
    const progress = start('Side by side')
    expect(
      startSceneSwitchProgress(progress, { intentId: 2, target: 'Side by side', nowMs: 1_100 })
        .replaced
    ).toBeNull()
  })

  it('says a slow camera is the reason, only when the scene shows it', () => {
    const lowFrameRate = { fps: 14.7, expectedFps: 30 }
    const camera = advanceSceneSwitchProgress(start('Camera only'), 1, {
      phase: 'starting',
      showsCamera: true
    })!
    expect(sceneSwitchStatusLine(camera, { name: 'C920', lowFrameRate }).detail).toBe(
      'C920 is sending 15 of 30 fps. More light usually helps.'
    )
    const screen = advanceSceneSwitchProgress(start('Screen only'), 1, {
      phase: 'starting',
      showsScreen: true
    })!
    expect(sceneSwitchStatusLine(screen, { name: 'C920', lowFrameRate }).detail).toBeNull()
    expect(sceneSwitchStatusLine(camera, { name: 'C920', lowFrameRate: null }).detail).toBeNull()
  })
})
