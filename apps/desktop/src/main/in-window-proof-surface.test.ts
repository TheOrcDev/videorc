import { EventEmitter } from 'node:events'

import type { BrowserWindow, WebContentsView } from 'electron'
import { describe, expect, it } from 'vitest'

import {
  InWindowProofSurface,
  forwardedMouseEvent,
  heldButtonsAfter,
  proofSurfaceHostNote,
  viewRectInParent,
  withHeldButtons,
  type ObservedInputEvent
} from './in-window-proof-surface'
import type { Rect } from './preview-dock'

class FakeWebContents extends EventEmitter {
  static nextId = 1
  readonly id = FakeWebContents.nextId++
  destroyed = false
  focused = 0
  sent: unknown[] = []
  loaded: string[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
  focus(): void {
    this.focused += 1
  }
  sendInputEvent(event: unknown): void {
    this.sent.push(event)
  }
  async loadFile(path: string): Promise<void> {
    this.loaded.push(path)
  }
}

class FakeView {
  readonly webContents = new FakeWebContents()
  bounds: Rect | null = null
  visible = true
  radius: number | null = null
  setBounds(bounds: Rect): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  setBorderRadius(radius: number): void {
    this.radius = radius
  }
}

class FakeWindow {
  readonly webContents = new FakeWebContents()
  readonly children: FakeView[] = []
  destroyed = false
  visible = true
  constructor(public content: Rect) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible && !this.destroyed
  }
  getContentBounds(): Rect {
    return { ...this.content }
  }
  readonly contentView = {
    addChildView: (view: FakeView): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) {
        this.children.splice(index, 1)
      }
      this.children.push(view)
    },
    removeChildView: (view: FakeView): void => {
      const index = this.children.indexOf(view)
      if (index >= 0) {
        this.children.splice(index, 1)
      }
    }
  }
}

function harness(): {
  surface: InWindowProofSurface
  view: FakeView
  main: FakeWindow
  preview: FakeWindow
  setMode: (mode: 'docked' | 'floating') => void
} {
  const view = new FakeView()
  // Wayland reports every window at the origin; the math must not care.
  const main = new FakeWindow({ x: 0, y: 0, width: 1896, height: 1030 })
  const preview = new FakeWindow({ x: 0, y: 0, width: 960, height: 568 })
  let mode: 'docked' | 'floating' = 'docked'
  const surface = new InWindowProofSurface({
    createView: () => view as unknown as WebContentsView,
    resolveParent: () => (mode === 'docked' ? main : preview) as unknown as BrowserWindow,
    cornerRadius: () => (mode === 'docked' ? 12 : 0)
  })
  return { surface, view, main, preview, setMode: (next) => (mode = next) }
}

describe('viewRectInParent', () => {
  it('expresses the screen rect in the host content coordinates', () => {
    expect(
      viewRectInParent(
        { x: 1440, y: 318, width: 1320.4, height: 742.6 },
        {
          x: 1000,
          y: 150,
          width: 1896,
          height: 1030
        }
      )
    ).toEqual({ x: 440, y: 168, width: 1320, height: 743 })
  })

  it('never produces an empty rect', () => {
    expect(
      viewRectInParent({ x: 5, y: 5, width: 0, height: 0.2 }, { x: 0, y: 0, width: 1, height: 1 })
    ).toEqual({ x: 5, y: 5, width: 1, height: 1 })
  })
})

describe('forwardedMouseEvent', () => {
  const origin = { x: 440, y: 168 }

  it('replays a click at the same point of the host window', () => {
    expect(
      forwardedMouseEvent(
        { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: ['shift'] },
        origin
      )
    ).toEqual({
      type: 'mouseDown',
      x: 450,
      y: 188,
      button: 'left',
      clickCount: 1,
      modifiers: ['shift']
    })
  })

  it('keeps wheel deltas so the Studio page still scrolls under the pointer', () => {
    expect(
      forwardedMouseEvent(
        { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: -120, canScroll: true },
        origin
      )
    ).toEqual({
      type: 'mouseWheel',
      x: 441,
      y: 170,
      modifiers: [],
      deltaX: 0,
      deltaY: -120,
      canScroll: true
    })
  })

  it('drops keys, enter/leave, and events without a point', () => {
    const dropped: ObservedInputEvent[] = [
      { type: 'keyDown' },
      { type: 'mouseEnter', x: 1, y: 1 },
      { type: 'mouseLeave', x: 1, y: 1 },
      { type: 'mouseMove' }
    ]
    for (const input of dropped) {
      expect(forwardedMouseEvent(input, origin)).toBeNull()
    }
  })
})

describe('InWindowProofSurface', () => {
  it('docks into the main window at the slot rect with the panel radius', () => {
    const { surface, view, main } = harness()
    surface.setBounds({ x: 440, y: 168, width: 1320, height: 743 })
    surface.showInactive()

    expect(main.children).toEqual([view])
    expect(view.bounds).toEqual({ x: 440, y: 168, width: 1320, height: 743 })
    expect(view.radius).toBe(12)
    expect(view.visible).toBe(true)
    expect(surface.isVisible()).toBe(true)
    expect(surface.hostWindow()).toBe(main)
    expect(surface.getBounds()).toEqual({ x: 440, y: 168, width: 1320, height: 743 })
  })

  it('starts hidden and hides without losing its host', () => {
    const { surface, view, main } = harness()
    expect(view.visible).toBe(false)
    expect(surface.isVisible()).toBe(false)
    surface.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    surface.showInactive()
    surface.hide()
    expect(view.visible).toBe(false)
    expect(surface.isVisible()).toBe(false)
    expect(main.children).toEqual([view])
  })

  it('re-parents the live view on a mode switch instead of recreating it', () => {
    const { surface, view, main, preview, setMode } = harness()
    surface.setBounds({ x: 440, y: 168, width: 1320, height: 743 })
    setMode('floating')
    // Floating: the video rect sits under the 28px drag strip.
    surface.setBounds({ x: 0, y: 28, width: 960, height: 540 })

    expect(main.children).toEqual([])
    expect(preview.children).toEqual([view])
    expect(view.bounds).toEqual({ x: 0, y: 28, width: 960, height: 540 })
    expect(view.radius).toBe(0)
    expect(surface.isDestroyed()).toBe(false)
  })

  it('re-applies bounds on a new host even when the screen rect is unchanged', () => {
    const { surface, view, main, setMode } = harness()
    main.content = { x: 100, y: 50, width: 1896, height: 1030 }
    surface.setBounds({ x: 100, y: 78, width: 960, height: 540 })
    expect(view.bounds).toEqual({ x: 0, y: 28, width: 960, height: 540 })
    setMode('floating')
    surface.setBounds({ x: 100, y: 78, width: 960, height: 540 })
    expect(view.bounds).toEqual({ x: 100, y: 78, width: 960, height: 540 })
  })

  it('emits resize and move like a BrowserWindow', () => {
    const { surface } = harness()
    const events: string[] = []
    surface.on('resize', () => events.push('resize'))
    surface.on('move', () => events.push('move'))
    surface.setBounds({ x: 10, y: 10, width: 300, height: 200 })
    surface.setBounds({ x: 10, y: 10, width: 300, height: 200 })
    surface.setBounds({ x: 20, y: 10, width: 300, height: 200 })
    expect(events).toEqual(['resize', 'move', 'move'])
  })

  it('cancels view mouse events, passes them to the host, and never keeps focus', () => {
    const { surface, view, main } = harness()
    surface.setBounds({ x: 440, y: 168, width: 1320, height: 743 })
    const prevented: string[] = []
    const emitMouse = (input: ObservedInputEvent): void => {
      view.webContents.emit(
        'before-mouse-event',
        {
          preventDefault: () => {
            prevented.push(input.type)
          }
        },
        input
      )
    }

    emitMouse({ type: 'mouseDown', x: 5, y: 6, button: 'left' })
    emitMouse({ type: 'mouseMove', x: 12, y: 14 })
    emitMouse({ type: 'mouseUp', x: 12, y: 14, button: 'left' })
    emitMouse({ type: 'mouseWheel', x: 12, y: 14, deltaY: -120 })
    emitMouse({ type: 'mouseEnter', x: 1, y: 1 })
    view.webContents.emit('focus')

    expect(prevented).toEqual(['mouseDown', 'mouseMove', 'mouseUp', 'mouseWheel'])
    // The press puts the left button down for the host; the move carries it
    // (Blink reads buttons from the move itself); the release lifts it.
    expect(main.webContents.sent).toEqual([
      { type: 'mouseDown', x: 445, y: 174, button: 'left', modifiers: ['leftbuttondown'] },
      { type: 'mouseMove', x: 452, y: 182, modifiers: ['leftbuttondown'] },
      { type: 'mouseUp', x: 452, y: 182, button: 'left', modifiers: [] },
      { type: 'mouseWheel', x: 452, y: 182, modifiers: [], deltaY: -120 }
    ])
    expect(view.webContents.focused).toBe(0)
    expect(main.webContents.focused).toBe(1)
  })

  it('is not visible when the host window is hidden or destroyed', () => {
    const { surface, main } = harness()
    surface.setBounds({ x: 440, y: 168, width: 1320, height: 743 })
    surface.showInactive()
    expect(surface.isVisible()).toBe(true)

    main.visible = false
    expect(surface.isVisible()).toBe(false)

    main.visible = true
    expect(surface.isVisible()).toBe(true)

    main.destroyed = true
    expect(surface.isVisible()).toBe(false)
  })

  it('stays detached while no host window exists', () => {
    const view = new FakeView()
    const surface = new InWindowProofSurface({
      createView: () => view as unknown as WebContentsView,
      resolveParent: () => null,
      cornerRadius: () => 0
    })
    surface.setBounds({ x: 1, y: 2, width: 3, height: 4 })
    surface.showInactive()
    expect(surface.isVisible()).toBe(false)
    expect(view.bounds).toBeNull()
  })

  it('destroys once: detaches, closes its web contents, emits closed', () => {
    const { surface, view, main } = harness()
    const closed: string[] = []
    surface.on('closed', () => closed.push('closed'))
    surface.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    surface.close()
    surface.destroy()

    expect(main.children).toEqual([])
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(surface.isDestroyed()).toBe(true)
    expect(closed).toEqual(['closed'])
  })

  it('tears down when its web contents die underneath it', () => {
    const { surface, view, main } = harness()
    const closed: string[] = []
    surface.on('closed', () => closed.push('closed'))
    surface.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    view.webContents.close()

    expect(surface.isDestroyed()).toBe(true)
    expect(main.children).toEqual([])
    expect(closed).toEqual(['closed'])
  })
})

describe('InWindowProofSurface on a macOS host (plan 216 C)', () => {
  // AppKit reports real screen frames: the main window sits at (120, 160)
  // with its content below a 28px title strip. The docked slot rect arrives
  // in screen coordinates, as the placement pipeline computes it.
  function macHarness(): {
    surface: InWindowProofSurface
    view: FakeView
    main: FakeWindow
    emitMouse: (input: ObservedInputEvent) => void
  } {
    const view = new FakeView()
    const main = new FakeWindow({ x: 120, y: 188, width: 1180, height: 752 })
    const surface = new InWindowProofSurface({
      createView: () => view as unknown as WebContentsView,
      resolveParent: () => main as unknown as BrowserWindow,
      cornerRadius: () => 12
    })
    const emitMouse = (input: ObservedInputEvent): void => {
      view.webContents.emit('before-mouse-event', { preventDefault: () => {} }, input)
    }
    return { surface, view, main, emitMouse }
  }

  it('is a view in the main window at the canvas rect, with the panel radius', () => {
    const { surface, view, main } = macHarness()
    surface.setBounds({ x: 420, y: 300, width: 640, height: 360 })
    surface.showInactive()

    expect(surface.hostWindow()).toBe(main)
    expect(main.children).toEqual([view])
    expect(view.bounds).toEqual({ x: 300, y: 112, width: 640, height: 360 })
    expect(view.radius).toBe(12)
    expect(surface.isVisible()).toBe(true)
  })

  it('replays a press, a drag with the button held, and the release on the host', () => {
    // The streamer's drag: the press lands on the view, AppKit keeps sending
    // the dragged events to it, and every one reaches the host window's Scene
    // canvas at the same screen point, button state included.
    const { surface, main, emitMouse } = macHarness()
    surface.setBounds({ x: 420, y: 300, width: 640, height: 360 })
    surface.showInactive()

    emitMouse({ type: 'mouseDown', x: 100, y: 80, button: 'left', clickCount: 1 })
    emitMouse({ type: 'mouseMove', x: 116, y: 89, modifiers: ['leftbuttondown'] })
    emitMouse({ type: 'mouseMove', x: 164, y: 116, modifiers: ['leftbuttondown'] })
    emitMouse({ type: 'mouseUp', x: 164, y: 116, button: 'left', clickCount: 1 })

    expect(main.webContents.sent).toEqual([
      {
        type: 'mouseDown',
        x: 400,
        y: 192,
        button: 'left',
        clickCount: 1,
        modifiers: ['leftbuttondown']
      },
      { type: 'mouseMove', x: 416, y: 201, modifiers: ['leftbuttondown'] },
      { type: 'mouseMove', x: 464, y: 228, modifiers: ['leftbuttondown'] },
      { type: 'mouseUp', x: 464, y: 228, button: 'left', clickCount: 1, modifiers: [] }
    ])
    expect(surface.forwardedInputCounts()).toEqual({
      mouseDown: 1,
      mouseMove: 2,
      mouseUp: 1,
      mouseWheel: 0,
      contextMenu: 0
    })
  })

  it('names the host in the surface message on macOS and Linux, never on Windows', () => {
    expect(proofSurfaceHostNote('darwin')).toContain('Hosted inside the app window')
    expect(proofSurfaceHostNote('linux')).toContain('Hosted inside the app window')
    expect(proofSurfaceHostNote('win32')).toBe('')
  })
})

describe('held mouse buttons (plan 216 C)', () => {
  const none = { left: false, middle: false, right: false }

  it('follows presses and releases per button, and ignores moves', () => {
    const afterPress = heldButtonsAfter({ type: 'mouseDown', x: 1, y: 1, button: 'left' }, none)
    expect(afterPress).toEqual({ left: true, middle: false, right: false })
    expect(heldButtonsAfter({ type: 'mouseMove', x: 2, y: 2 }, afterPress)).toEqual(afterPress)
    expect(
      heldButtonsAfter({ type: 'mouseDown', x: 2, y: 2, button: 'right' }, afterPress)
    ).toEqual({ left: true, middle: false, right: true })
    expect(heldButtonsAfter({ type: 'mouseUp', x: 3, y: 3, button: 'left' }, afterPress)).toEqual(
      none
    )
    expect(heldButtonsAfter({ type: 'mouseDown', x: 1, y: 1 }, none)).toEqual(none)
  })

  it('marks a move with the buttons the host still has down, keeping its own modifiers lowercased', () => {
    expect(
      withHeldButtons(
        { type: 'mouseMove', x: 5, y: 6, modifiers: ['Shift', 'leftButtonDown'] },
        { left: true, middle: false, right: true }
      ).modifiers
    ).toEqual(['shift', 'leftbuttondown', 'rightbuttondown'])
    expect(withHeldButtons({ type: 'mouseMove', x: 5, y: 6 }, none).modifiers).toEqual([])
  })

  it('drags on the host from a press and bare moves, as the view reports them', () => {
    // What the drag on the fallback canvas needs: moves with no modifiers of
    // their own reach the stage with the left button down, and a move after
    // the release does not.
    const view = new FakeView()
    const main = new FakeWindow({ x: 0, y: 0, width: 1000, height: 800 })
    const surface = new InWindowProofSurface({
      createView: () => view as unknown as WebContentsView,
      resolveParent: () => main as unknown as BrowserWindow,
      cornerRadius: () => 0
    })
    surface.setBounds({ x: 100, y: 100, width: 400, height: 300 })
    const emit = (input: ObservedInputEvent): void => {
      view.webContents.emit('before-mouse-event', { preventDefault: () => {} }, input)
    }
    const modifiersSent = (): string[][] =>
      main.webContents.sent.map((event) => (event as { modifiers: string[] }).modifiers)
    emit({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 })
    emit({ type: 'mouseMove', x: 30, y: 20 })
    emit({ type: 'mouseUp', x: 30, y: 20, button: 'left', clickCount: 1 })
    emit({ type: 'mouseMove', x: 40, y: 25 })
    expect(modifiersSent()).toEqual([['leftbuttondown'], ['leftbuttondown'], [], []])
    expect(surface.lastObservedInput()).toEqual({ type: 'mouseMove', x: 40, y: 25 })
    // A surface hidden mid-press forgets the button: the host never sees that
    // release, and a later move must not read as a drag.
    emit({ type: 'mouseDown', x: 10, y: 10, button: 'left' })
    surface.hide()
    surface.showInactive()
    emit({ type: 'mouseMove', x: 12, y: 12 })
    expect(modifiersSent().at(-1)).toEqual([])
  })
})
