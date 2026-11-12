import { describe, expect, it } from 'vitest'

import {
  frameOnScreen,
  planStreamManagerScreenSwap,
  FOCUS_ON_ARRIVAL,
  focusAfterSwap,
  focusReturnTarget,
  SCREEN_FROM_ELSEWHERE,
  screenFrames,
  screenOptions,
  streamManagerHoldAction,
  type StreamManagerPlace
} from './stream-manager-screen'

const PRESENTING = '1'
const MONITOR = '2'
const LAPTOP = '3'
const SCREENS = [PRESENTING, MONITOR, LAPTOP]
const KEY = { presentingScreen: PRESENTING, monitorScreen: MONITOR }

function place(overrides: Partial<StreamManagerPlace> = {}): StreamManagerPlace {
  return { open: true, visible: true, screenId: MONITOR, ...overrides }
}

describe('planStreamManagerScreenSwap', () => {
  it('sends the window from the Monitor screen to the Presenting screen', () => {
    expect(planStreamManagerScreenSwap(place(), KEY, SCREENS)).toEqual({
      kind: 'move',
      screen: 'presenting',
      screenId: PRESENTING
    })
  })

  it('sends the window from the Presenting screen to the Monitor screen', () => {
    expect(planStreamManagerScreenSwap(place({ screenId: PRESENTING }), KEY, SCREENS)).toEqual({
      kind: 'move',
      screen: 'monitor',
      screenId: MONITOR
    })
  })

  it("sends the window to the Monitor screen from anywhere else (D3, the owner's call)", () => {
    expect(SCREEN_FROM_ELSEWHERE).toBe('monitor')
    for (const where of [
      place({ open: false, visible: false, screenId: null }),
      place({ visible: false }),
      place({ visible: false, screenId: PRESENTING }),
      place({ screenId: LAPTOP })
    ]) {
      expect(planStreamManagerScreenSwap(where, KEY, SCREENS)).toEqual({
        kind: 'move',
        screen: 'monitor',
        screenId: MONITOR
      })
    }
  })

  it('refuses when either screen is gone, never guessing (D6)', () => {
    for (const where of [
      place(),
      place({ screenId: PRESENTING }),
      place({ open: false, visible: false, screenId: null })
    ]) {
      for (const connected of [[MONITOR, LAPTOP], [PRESENTING, LAPTOP], [LAPTOP]]) {
        expect(planStreamManagerScreenSwap(where, KEY, connected)).toEqual({
          kind: 'refuse',
          reason: 'screen-missing'
        })
      }
    }
  })

  it('refuses the same screen twice', () => {
    expect(
      planStreamManagerScreenSwap(
        place(),
        { presentingScreen: PRESENTING, monitorScreen: PRESENTING },
        SCREENS
      )
    ).toEqual({ kind: 'refuse', reason: 'same-screen' })
  })
})

describe("FOCUS_ON_ARRIVAL (the owner's call)", () => {
  it('gives the window the focus on the Presenting screen, to answer viewers', () => {
    expect(FOCUS_ON_ARRIVAL).toEqual({ presenting: true, monitor: false })
  })
})

describe('focusReturnTarget (Q14)', () => {
  const keynote = { name: 'Keynote', pid: 41, bundleId: 'com.apple.iWork.Keynote' }

  it('hands the focus to the last other app on macOS, never Videorc itself or an odd id', () => {
    expect(focusReturnTarget('darwin', keynote, ['com.videorc.app'])).toEqual({
      kind: 'app',
      bundleId: 'com.apple.iWork.Keynote',
      pid: 41
    })
    for (const last of [
      { ...keynote, bundleId: 'com.videorc.app' },
      { ...keynote, bundleId: null },
      { ...keynote, bundleId: '-a Terminal' },
      null
    ]) {
      expect(focusReturnTarget('darwin', last, ['com.videorc.app'])).toBeNull()
    }
  })

  it('hands it to the window behind on Windows, and nothing on Linux', () => {
    expect(focusReturnTarget('win32', null, [])).toEqual({ kind: 'behind' })
    expect(focusReturnTarget('linux', keynote, [])).toBeNull()
  })
})

describe('focusAfterSwap (Q13, Q14)', () => {
  const keynote = { name: 'Keynote', pid: 41, bundleId: 'com.apple.iWork.Keynote' }
  const base = { platform: 'darwin', lastOther: keynote, selfBundleIds: [] }

  it('hands the focus on only when a focused Stream Manager goes to the Monitor screen', () => {
    expect(focusAfterSwap({ ...base, to: 'monitor', focused: true })).toEqual({
      kind: 'app',
      bundleId: 'com.apple.iWork.Keynote',
      pid: 41
    })
    expect(focusAfterSwap({ ...base, to: 'monitor', focused: false })).toBeNull()
    expect(focusAfterSwap({ ...base, to: 'presenting', focused: true })).toBeNull()
    expect(focusAfterSwap({ ...base, to: 'presenting', focused: false })).toBeNull()
  })
})

describe('streamManagerHoldAction', () => {
  it('closes the window only while it has the focus', () => {
    expect(streamManagerHoldAction({ open: true, visible: true, focused: true })).toBe('close')
  })

  it('brings it to the front from anywhere else', () => {
    for (const where of [
      { open: true, visible: true, focused: false },
      { open: true, visible: false, focused: true },
      { open: false, visible: false, focused: false }
    ]) {
      expect(streamManagerHoldAction(where)).toBe('front')
    }
  })
})

describe('frameOnScreen (D4)', () => {
  const portrait = { x: 3840, y: 0, width: 1080, height: 1920 }

  it('uses the frame the screen remembers', () => {
    const saved = { x: 3840, y: 0, width: 1080, height: 1900 }
    expect(frameOnScreen({ x: 0, y: 0, width: 600, height: 800 }, saved, portrait)).toEqual(saved)
  })

  it('pulls a remembered frame back inside the work area', () => {
    const saved = { x: 4500, y: 1500, width: 1200, height: 800 }
    expect(frameOnScreen({ x: 0, y: 0, width: 600, height: 800 }, saved, portrait)).toEqual({
      x: 3840,
      y: 1120,
      width: 1080,
      height: 800
    })
  })

  it('pulls a frame from an old layout back from the left and the top', () => {
    const saved = { x: 0, y: -400, width: 600, height: 800 }
    expect(frameOnScreen({ x: 0, y: 0, width: 600, height: 800 }, saved, portrait)).toEqual({
      x: 3840,
      y: 0,
      width: 600,
      height: 800
    })
  })

  it('centres the current size on a screen without a frame', () => {
    expect(frameOnScreen({ x: 100, y: 100, width: 600, height: 800 }, undefined, portrait)).toEqual(
      { x: 4080, y: 560, width: 600, height: 800 }
    )
  })

  it('shrinks the current size to fit a smaller screen', () => {
    const small = { x: 0, y: 25, width: 1440, height: 875 }
    expect(frameOnScreen({ x: 0, y: 0, width: 600, height: 1900 }, undefined, small)).toEqual({
      x: 420,
      y: 25,
      width: 600,
      height: 875
    })
  })
})

describe('screenOptions', () => {
  it('names each screen as the OS does, by its id', () => {
    expect(
      screenOptions([
        { id: 1, label: 'DELL U2723QE', size: { width: 3840, height: 2160 } },
        { id: 2, label: 'Built-in Retina Display', size: { width: 1512, height: 982 } }
      ])
    ).toEqual([
      { id: '1', name: 'DELL U2723QE' },
      { id: '2', name: 'Built-in Retina Display' }
    ])
  })

  it('leaves out displays whose id the OS does not know yet', () => {
    expect(
      screenOptions([
        { id: -1, label: 'Unknown', size: { width: 1, height: 1 } },
        { id: -10, label: 'Unified', size: { width: 1, height: 1 } },
        { id: 3, label: 'DELL U2723QE', size: { width: 2560, height: 1440 } }
      ])
    ).toEqual([{ id: '3', name: 'DELL U2723QE' }])
  })

  it('tells twin monitors apart by their size, and names a screen without a label', () => {
    expect(
      screenOptions([
        { id: 1, label: 'DELL U2311H', size: { width: 1920, height: 1080 } },
        { id: 2, label: 'DELL U2311H', size: { width: 1080, height: 1920 } },
        { id: 3, label: '', size: { width: 1280, height: 720 } }
      ])
    ).toEqual([
      { id: '1', name: 'DELL U2311H (1920 × 1080)' },
      { id: '2', name: 'DELL U2311H (1080 × 1920)' },
      { id: '3', name: 'Screen 3' }
    ])
  })

  it('numbers twin monitors that also share a size', () => {
    expect(
      screenOptions([
        { id: 7, label: 'DELL U2723QE', size: { width: 2560, height: 1440 } },
        { id: 8, label: 'DELL U2723QE', size: { width: 2560, height: 1440 } }
      ])
    ).toEqual([
      { id: '7', name: 'DELL U2723QE 1 (2560 × 1440)' },
      { id: '8', name: 'DELL U2723QE 2 (2560 × 1440)' }
    ])
  })
})

describe('screenFrames', () => {
  it('keeps well-formed frames and drops the rest', () => {
    const frame = { x: -1080, y: 0, width: 1080, height: 1900 }
    expect(
      screenFrames({
        '1': { ...frame, extra: true },
        '2': { x: 0, y: 0, width: 0, height: 10 },
        '3': { x: '0', y: 0, width: 10, height: 10 },
        '5': { x: 10.5, y: 0, width: 10, height: 10 },
        '4': null
      })
    ).toEqual({ '1': frame })
    for (const broken of [undefined, null, 'frames', [frame]]) {
      expect(screenFrames(broken)).toEqual({})
    }
  })
})
