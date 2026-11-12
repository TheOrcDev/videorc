import { describe, expect, it, vi } from 'vitest'

import {
  frameOnScreen,
  framesHeldBySystem,
  handFocusPastOwnWindows,
  planStreamManagerScreenSwap,
  FOCUS_ON_ARRIVAL,
  focusAfterSwap,
  focusReturnTarget,
  runStreamManagerScreenSwap,
  SCREEN_FROM_ELSEWHERE,
  screenFrames,
  screenOptions,
  setBoundsExactly,
  showStreamManagerWindow,
  streamManagerHoldAction,
  streamManagerScreenMoves,
  type StreamManagerMoveResult,
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
    // A minimized window may take the focus when it is restored.
    expect(focusAfterSwap({ ...base, to: 'monitor', focused: false, minimized: true })).toEqual(
      focusAfterSwap({ ...base, to: 'monitor', focused: true })
    )
    expect(
      focusAfterSwap({ ...base, to: 'presenting', focused: false, minimized: true })
    ).toBeNull()
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

// A Stream Manager window as each OS treats it: `restore()` activates it on
// macOS and Windows; `showInactive()` brings a minimized window back
// without the focus on Windows only.
function fakeWindow(platform: string, state: { minimized: boolean; focused: boolean }) {
  const calls: string[] = []
  const window = {
    calls,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    restore: () => {
      calls.push('restore')
      state.minimized = false
      if (platform !== 'linux') state.focused = true
    },
    show: () => calls.push('show'),
    focus: () => {
      calls.push('focus')
      state.focused = true
    },
    showInactive: () => {
      calls.push('showInactive')
      if (platform === 'win32') state.minimized = false
    }
  }
  return window
}

describe('showStreamManagerWindow', () => {
  it('brings a minimized window back on Windows without restore(), so it never takes the focus', () => {
    const state = { minimized: true, focused: false }
    const window = fakeWindow('win32', state)
    showStreamManagerWindow(window, false, 'win32')
    expect(window.calls).toEqual(['showInactive'])
    expect(state).toEqual({ minimized: false, focused: false })
  })

  it('restores a minimized window on macOS and Linux, where showInactive() cannot', () => {
    for (const platform of ['darwin', 'linux']) {
      const window = fakeWindow(platform, { minimized: true, focused: false })
      showStreamManagerWindow(window, false, platform)
      expect(window.calls).toEqual(['restore', 'showInactive'])
    }
  })

  it('restores, shows and focuses when the window should take the focus', () => {
    const window = fakeWindow('win32', { minimized: true, focused: false })
    showStreamManagerWindow(window, true, 'win32')
    expect(window.calls).toEqual(['restore', 'show', 'focus'])
  })
})

describe('runStreamManagerScreenSwap', () => {
  const KEYNOTE = { bundleId: 'com.apple.iWork.Keynote', pid: 42 }

  function swap(
    platform: string,
    state: { minimized: boolean; focused: boolean },
    {
      screen = 'monitor' as const,
      moved = 'moved' as StreamManagerMoveResult,
      studio = null as { focus(): void } | null
    }: {
      screen?: 'monitor' | 'presenting'
      moved?: StreamManagerMoveResult
      studio?: { focus(): void } | null
    } = {}
  ) {
    const window = fakeWindow(platform, state)
    const steps: string[] = []
    const giveFocusBack = vi.fn()
    const warn = vi.fn()
    const result = runStreamManagerScreenSwap({
      plan: { screen, screenId: screen === 'monitor' ? MONITOR : PRESENTING },
      platform,
      window: () => window,
      focusedOwnWindow: () => studio,
      lastOther: KEYNOTE,
      selfBundleIds: ['com.videorc.app'],
      placeMinimized: (screenId) => steps.push(`place ${screenId}`),
      open: async ({ focus }) => {
        steps.push(`open focus=${focus}`)
        showStreamManagerWindow(window, focus, platform)
      },
      move: (screenId) => {
        steps.push(`move ${screenId}`)
        return moved
      },
      giveFocusBack,
      warn
    })
    return { result, window, steps, giveFocusBack, warn, state }
  }

  it('minimized, then a tap to the Monitor screen on macOS: restore() takes the focus, so it goes back to the app', async () => {
    const run = swap('darwin', { minimized: true, focused: false })
    await expect(run.result).resolves.toEqual({ ok: true, screen: 'monitor' })
    expect(run.steps).toEqual([`place ${MONITOR}`, 'open focus=false', `move ${MONITOR}`])
    expect(run.window.calls).toEqual(['restore', 'showInactive'])
    expect(run.giveFocusBack).toHaveBeenCalledWith({ kind: 'app', ...KEYNOTE })
  })

  it('minimized, then a tap to the Monitor screen on macOS while the streamer works in the Studio: the Studio gets the focus back', async () => {
    const studio = { focus: vi.fn() }
    const run = swap('darwin', { minimized: true, focused: false }, { studio })
    await expect(run.result).resolves.toEqual({ ok: true, screen: 'monitor' })
    expect(run.giveFocusBack).not.toHaveBeenCalled()
    expect(studio.focus).toHaveBeenCalledTimes(1)
  })

  it('minimized, then a tap to the Monitor screen on Windows: shown without the focus, so nothing is blurred', async () => {
    const run = swap('win32', { minimized: true, focused: false })
    await expect(run.result).resolves.toEqual({ ok: true, screen: 'monitor' })
    expect(run.window.calls).toEqual(['showInactive'])
    expect(run.state.focused).toBe(false)
    expect(run.giveFocusBack).not.toHaveBeenCalled()
  })

  it('hands the focus behind on Windows when the window had it', async () => {
    const run = swap('win32', { minimized: false, focused: true })
    await expect(run.result).resolves.toEqual({ ok: true, screen: 'monitor' })
    expect(run.giveFocusBack).toHaveBeenCalledWith({ kind: 'behind' })
  })

  it('leaves the focus alone when the window neither had nor took it', async () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const run = swap(platform, { minimized: false, focused: false })
      await expect(run.result).resolves.toEqual({ ok: true, screen: 'monitor' })
      expect(run.giveFocusBack).not.toHaveBeenCalled()
    }
  })

  it('keeps the focus on the Presenting screen', async () => {
    const run = swap('darwin', { minimized: true, focused: false }, { screen: 'presenting' })
    await expect(run.result).resolves.toEqual({ ok: true, screen: 'presenting' })
    expect(run.window.calls).toEqual(['restore', 'show', 'focus'])
    expect(run.giveFocusBack).not.toHaveBeenCalled()
  })

  it('reports a move that did not land and hands nothing on', async () => {
    const run = swap('darwin', { minimized: false, focused: true }, { moved: 'not-moved' })
    await expect(run.result).resolves.toEqual({ ok: false, reason: 'not-moved' })
    expect(run.giveFocusBack).not.toHaveBeenCalled()
  })
})

describe('handFocusPastOwnWindows', () => {
  // Windows' z-order, front first: `blur()` activates the next visible one.
  function zOrder(names: string[], own: Set<string>) {
    let focused: string | null = names[0]!
    const windowFor = (name: string) => ({
      blur: () => {
        if (focused !== name) return
        focused = names[names.indexOf(name) + 1] ?? null
      }
    })
    return {
      focused: () => focused,
      first: windowFor(names[0]!),
      focusedOwnWindow: () => (focused && own.has(focused) ? windowFor(focused) : null)
    }
  }
  const settle = async (): Promise<void> => {}

  it('blurs past Videorc main and preview windows to the presenting app', async () => {
    const own = new Set(['stream-manager', 'main', 'preview'])
    const z = zOrder(['stream-manager', 'main', 'preview', 'keynote'], own)
    await expect(handFocusPastOwnWindows({ ...z, settle, maxSteps: 3 })).resolves.toBe(true)
    expect(z.focused()).toBe('keynote')
  })

  it('stops after one blur when the window behind is another app', async () => {
    const own = new Set(['stream-manager', 'main'])
    const z = zOrder(['stream-manager', 'keynote', 'main'], own)
    const settleSpy = vi.fn(settle)
    await expect(handFocusPastOwnWindows({ ...z, settle: settleSpy, maxSteps: 3 })).resolves.toBe(
      true
    )
    expect(z.focused()).toBe('keynote')
    expect(settleSpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxSteps and says the focus stayed on Videorc', async () => {
    const own = new Set(['stream-manager', 'main', 'preview'])
    const z = zOrder(['stream-manager', 'main', 'preview', 'keynote'], own)
    await expect(handFocusPastOwnWindows({ ...z, settle, maxSteps: 1 })).resolves.toBe(false)
  })
})

describe('setBoundsExactly', () => {
  const frame = { x: 1920, y: 0, width: 600, height: 800 }

  it('sets the frame a second time when Windows scaled the size by the old display', () => {
    let bounds = { x: 0, y: 0, width: 0, height: 0 }
    let sets = 0
    const window = {
      setBounds: (next: typeof frame) => {
        sets += 1
        // The first set lands on the new display with the old DPI's size.
        bounds = sets === 1 ? { ...next, width: 900, height: 1200 } : { ...next }
      },
      getBounds: () => bounds
    }
    expect(setBoundsExactly(window, frame)).toBe(true)
    expect(sets).toBe(2)
    expect(bounds).toEqual(frame)
  })

  it('sets once when the frame lands', () => {
    let bounds = frame
    const setBounds = vi.fn((next: typeof frame) => {
      bounds = next
    })
    expect(setBoundsExactly({ setBounds, getBounds: () => bounds }, frame)).toBe(true)
    expect(setBounds).toHaveBeenCalledTimes(1)
  })

  it('says so when the window still is not where it was sent', () => {
    const setBounds = vi.fn()
    expect(setBoundsExactly({ setBounds, getBounds: () => ({ ...frame, x: 0 }) }, frame)).toBe(
      false
    )
    expect(setBounds).toHaveBeenCalledTimes(2)
  })
})

describe('streamManagerScreenMoves', () => {
  it('is wayland only for Linux on the Wayland ozone platform', () => {
    expect(streamManagerScreenMoves({ platform: 'linux', ozonePlatform: 'wayland' })).toBe(
      'wayland'
    )
    expect(streamManagerScreenMoves({ platform: 'linux', ozonePlatform: ' Wayland ' })).toBe(
      'wayland'
    )
    expect(streamManagerScreenMoves({ platform: 'linux', ozonePlatform: 'x11' })).toBe('supported')
    expect(streamManagerScreenMoves({ platform: 'linux', ozonePlatform: '' })).toBe('supported')
    expect(streamManagerScreenMoves({ platform: 'darwin', ozonePlatform: 'wayland' })).toBe(
      'supported'
    )
  })
})

describe('framesHeldBySystem', () => {
  const held = { placedBySystem: true, now: 1_000, heldUntil: 3_000 }

  it('holds frames on macOS and Windows until the streamer places the window', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(framesHeldBySystem({ platform, ...held })).toBe(true)
      expect(framesHeldBySystem({ platform, ...held, now: 10_000 })).toBe(true)
    }
  })

  it('lets Linux, which sends no will-move, go once the hold time is over', () => {
    expect(framesHeldBySystem({ platform: 'linux', ...held })).toBe(true)
    expect(framesHeldBySystem({ platform: 'linux', ...held, now: 3_000 })).toBe(false)
  })

  it('holds nothing the system did not place', () => {
    expect(framesHeldBySystem({ platform: 'darwin', ...held, placedBySystem: false })).toBe(false)
  })
})
