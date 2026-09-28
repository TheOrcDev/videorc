// In-window Electron proof surface (Linux). Wayland lets no client place its
// own toplevel: Hyprland, GNOME and KDE ignore the absolute frame the docked
// preview window and its child proof-surface window ask for, so the preview
// landed centred over the app instead of in the Studio slot (and a tiling
// compositor re-tiles it on top of that). On Linux the proof surface therefore
// lives INSIDE its host window as a WebContentsView — the main window while
// docked, the preview window while floating — at a content-relative rect,
// which every compositor honours.
//
// The host implements the slice of BrowserWindow the proof-surface code drives
// (bounds, visibility, lifecycle events), so the surface lifecycle, frame
// polling and first-frame contracts stay one code path. It is still the
// Electron proof surface: it never claims a native transport or backing.

import { EventEmitter } from 'node:events'

import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

import type { Rect } from './preview-dock'

// The BrowserWindow surface the proof-surface code in index.ts drives. A
// BrowserWindow satisfies it structurally; so does InWindowProofSurface.
export interface ProofSurfaceHost {
  readonly id: number
  readonly webContents: WebContents
  isDestroyed(): boolean
  isVisible(): boolean
  showInactive(): void
  hide(): void
  setBounds(bounds: Rect): void
  getBounds(): Rect
  getContentBounds(): Rect
  setIgnoreMouseEvents(ignore: boolean): void
  moveTop(): void
  loadFile(filePath: string): Promise<void>
  close(): void
  destroy(): void
  on(event: 'closed', listener: () => void): this
  on(event: 'resize', listener: () => void): this
  on(event: 'move', listener: () => void): this
}

// The screen rect the placement pipeline computes, expressed in the host
// window's content coordinates. Both sides come from the same Electron window
// geometry, so the result stays right even where Wayland reports every window
// at the origin.
export function viewRectInParent(screenRect: Rect, parentContentBounds: Rect): Rect {
  return {
    x: Math.round(screenRect.x - parentContentBounds.x),
    y: Math.round(screenRect.y - parentContentBounds.y),
    width: Math.max(1, Math.round(screenRect.width)),
    height: Math.max(1, Math.round(screenRect.height))
  }
}

type ForwardedMouseType = 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel' | 'contextMenu'

const FORWARDED_MOUSE_TYPES: ReadonlySet<string> = new Set<ForwardedMouseType>([
  'mouseDown',
  'mouseUp',
  'mouseMove',
  'mouseWheel',
  'contextMenu'
])

// Fields of the runtime `input-event` payload the pass-through reads. Electron
// types the listener argument as the base InputEvent; mouse events carry more.
export interface ObservedInputEvent {
  type: string
  modifiers?: string[]
  x?: number
  y?: number
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
  movementX?: number
  movementY?: number
  deltaX?: number
  deltaY?: number
  wheelTicksX?: number
  wheelTicksY?: number
  accelerationRatioX?: number
  accelerationRatioY?: number
  hasPreciseScrollingDeltas?: boolean
  canScroll?: boolean
}

export type ForwardedMouseEvent = Electron.MouseInputEvent | Electron.MouseWheelInputEvent

// Pointer pass-through: the docked BrowserWindow ignored mouse events so the
// Scene canvas hit layer under it kept every click and drag (plan 058), and the
// Studio page kept wheel scrolling. A WebContentsView cannot ignore input, so
// its mouse events are replayed on the host window's web contents at the same
// point. Non-mouse events (keys, enter/leave) are not replayed; null = drop.
export function forwardedMouseEvent(
  input: ObservedInputEvent,
  viewOrigin: { x: number; y: number }
): ForwardedMouseEvent | null {
  if (!FORWARDED_MOUSE_TYPES.has(input.type)) {
    return null
  }
  if (typeof input.x !== 'number' || typeof input.y !== 'number') {
    return null
  }
  const base = {
    x: Math.round(input.x + viewOrigin.x),
    y: Math.round(input.y + viewOrigin.y),
    modifiers: (input.modifiers ?? []) as Electron.MouseInputEvent['modifiers'],
    ...(input.button ? { button: input.button } : {}),
    ...(typeof input.clickCount === 'number' ? { clickCount: input.clickCount } : {}),
    ...(typeof input.movementX === 'number' ? { movementX: input.movementX } : {}),
    ...(typeof input.movementY === 'number' ? { movementY: input.movementY } : {})
  }
  if (input.type === 'mouseWheel') {
    return {
      ...base,
      type: 'mouseWheel',
      ...(typeof input.deltaX === 'number' ? { deltaX: input.deltaX } : {}),
      ...(typeof input.deltaY === 'number' ? { deltaY: input.deltaY } : {}),
      ...(typeof input.wheelTicksX === 'number' ? { wheelTicksX: input.wheelTicksX } : {}),
      ...(typeof input.wheelTicksY === 'number' ? { wheelTicksY: input.wheelTicksY } : {}),
      ...(typeof input.accelerationRatioX === 'number'
        ? { accelerationRatioX: input.accelerationRatioX }
        : {}),
      ...(typeof input.accelerationRatioY === 'number'
        ? { accelerationRatioY: input.accelerationRatioY }
        : {}),
      ...(typeof input.hasPreciseScrollingDeltas === 'boolean'
        ? { hasPreciseScrollingDeltas: input.hasPreciseScrollingDeltas }
        : {}),
      ...(typeof input.canScroll === 'boolean' ? { canScroll: input.canScroll } : {})
    }
  }
  return { ...base, type: input.type as Exclude<ForwardedMouseType, 'mouseWheel'> }
}

export interface InWindowProofSurfaceOptions {
  createView: () => WebContentsView
  // The window that hosts the surface right now: main while docked, preview
  // while floating. Re-read on every placement, so a mode switch re-parents
  // the live view instead of tearing the surface down.
  resolveParent: () => BrowserWindow | null
  // Rounded clip for the docked Studio panel; 0 for the floating window.
  cornerRadius: () => number
}

export class InWindowProofSurface extends EventEmitter implements ProofSurfaceHost {
  private readonly view: WebContentsView
  private parent: BrowserWindow | null = null
  private screenBounds: Rect = { x: 0, y: 0, width: 1, height: 1 }
  private viewBounds: Rect | null = null
  private appliedCornerRadius: number | null = null
  private visible = false
  private destroyed = false

  constructor(private readonly options: InWindowProofSurfaceOptions) {
    super()
    this.view = options.createView()
    this.view.setVisible(false)
    this.view.webContents.on('input-event', (_event, input) => {
      this.forwardInput(input as ObservedInputEvent)
    })
    // The surface must never hold keyboard focus: shortcuts and Scene editing
    // keys belong to the window underneath, exactly as with the focusable:false
    // proof window this replaces.
    this.view.webContents.on('focus', () => {
      const target = this.parent
      if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
        target.webContents.focus()
      }
    })
    this.view.webContents.once('destroyed', () => this.destroy())
  }

  get id(): number {
    return this.view.webContents.id
  }

  get webContents(): WebContents {
    return this.view.webContents
  }

  // The window currently hosting the view (diagnostics and tests).
  hostWindow(): BrowserWindow | null {
    return this.parent
  }

  isDestroyed(): boolean {
    return this.destroyed || this.view.webContents.isDestroyed()
  }

  isVisible(): boolean {
    return !this.isDestroyed() && this.visible && this.parent !== null
  }

  showInactive(): void {
    if (this.isDestroyed() || !this.attach()) {
      return
    }
    this.visible = true
    this.view.setVisible(true)
  }

  hide(): void {
    this.visible = false
    if (!this.isDestroyed()) {
      this.view.setVisible(false)
    }
  }

  setBounds(bounds: Rect): void {
    if (this.isDestroyed()) {
      return
    }
    const parent = this.attach()
    const previous = this.screenBounds
    this.screenBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    }
    if (parent) {
      const next = viewRectInParent(this.screenBounds, parent.getContentBounds())
      const applied = this.viewBounds
      if (
        !applied ||
        applied.x !== next.x ||
        applied.y !== next.y ||
        applied.width !== next.width ||
        applied.height !== next.height
      ) {
        this.view.setBounds(next)
        this.viewBounds = next
      }
    }
    if (
      previous.width !== this.screenBounds.width ||
      previous.height !== this.screenBounds.height
    ) {
      this.emit('resize')
    }
    if (previous.x !== this.screenBounds.x || previous.y !== this.screenBounds.y) {
      this.emit('move')
    }
  }

  getBounds(): Rect {
    return { ...this.screenBounds }
  }

  getContentBounds(): Rect {
    return { ...this.screenBounds }
  }

  // Input always passes through to the host window (see forwardedMouseEvent).
  setIgnoreMouseEvents(_ignore: boolean): void {}

  moveTop(): void {
    const parent = this.parent
    if (!this.isDestroyed() && parent && !parent.isDestroyed()) {
      // Re-adding a child view the parent already holds reorders it topmost.
      parent.contentView.addChildView(this.view)
    }
  }

  loadFile(filePath: string): Promise<void> {
    return this.view.webContents.loadFile(filePath)
  }

  close(): void {
    this.destroy()
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.visible = false
    this.detach()
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close()
    }
    this.emit('closed')
  }

  private attach(): BrowserWindow | null {
    const candidate = this.options.resolveParent()
    const next = candidate && !candidate.isDestroyed() ? candidate : null
    if (next !== this.parent) {
      this.detach()
      if (next) {
        next.contentView.addChildView(this.view)
        this.parent = next
        // A new host means new content coordinates; the next setBounds must
        // re-apply even when the screen rect is unchanged.
        this.viewBounds = null
      }
    }
    const radius = this.parent ? this.options.cornerRadius() : 0
    if (this.parent && radius !== this.appliedCornerRadius) {
      this.view.setBorderRadius(radius)
      this.appliedCornerRadius = radius
    }
    return this.parent
  }

  private detach(): void {
    const parent = this.parent
    this.parent = null
    this.viewBounds = null
    if (parent && !parent.isDestroyed()) {
      try {
        parent.contentView.removeChildView(this.view)
      } catch {
        // A host tearing down may already have released its child views.
      }
    }
  }

  private forwardInput(input: ObservedInputEvent): void {
    const parent = this.parent
    const origin = this.viewBounds
    if (!parent || parent.isDestroyed() || parent.webContents.isDestroyed() || !origin) {
      return
    }
    const event = forwardedMouseEvent(input, origin)
    if (event) {
      parent.webContents.sendInputEvent(event)
    }
  }
}
