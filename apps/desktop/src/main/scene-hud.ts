import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'

import {
  SCENE_HUD_FADE_MS,
  SCENE_HUD_HOLD_MS,
  type SceneHudPresentation,
  type SceneHudRequest,
  type SceneHudShowResult,
  type SceneHudWindowState
} from '../shared/scene-hud'
import { streamManagerHideMethod } from './window-capture-protection'

/**
 * The key HUD's window (plan 231 D20): a click-through, non-focusable panel
 * that never activates Videorc, never takes key focus and never shows in the
 * Dock, the taskbar or Mission Control. It is left out of every capture:
 * content protection on macOS and Windows (on macOS that covers a cloud
 * room's Chromium screen share), and on macOS also Videorc's ScreenCaptureKit
 * filter (the window stays on screen, fully transparent, because the filter
 * only finds windows on screen). Linux shows none.
 */

/** Room for the widest pill (420 px) and the popup tier's drop around it. */
export const SCENE_HUD_WINDOW_SIZE = Object.freeze({ width: 520, height: 112 })
/** Below the menu bar, at the top centre of the display under the pointer. */
export const SCENE_HUD_TOP_MARGIN = 8
/** Windows hides the window once the fade is done (macOS keeps it on screen). */
export const SCENE_HUD_IDLE_AFTER_MS = SCENE_HUD_HOLD_MS + SCENE_HUD_FADE_MS + 250

/** macOS and Windows: the two platforms that can leave the window out of a capture. */
export function sceneHudSupported(platform: NodeJS.Platform): boolean {
  return streamManagerHideMethod(platform) !== 'unsupported'
}

/** Pure. The window's frame on a display's work area: top centre. */
export function sceneHudBounds(
  workArea: Rectangle,
  size: { width: number; height: number } = SCENE_HUD_WINDOW_SIZE
): Rectangle {
  const width = Math.max(1, Math.min(size.width, workArea.width))
  const height = Math.max(1, Math.min(size.height, workArea.height))
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + SCENE_HUD_TOP_MARGIN),
    width,
    height
  }
}

/**
 * Pure. Whether the exclusion holds well enough to draw (fail closed). Both
 * platforms: the window is alive, loaded and its content protection is
 * confirmed (on macOS that keeps it out of a cloud room's Chromium screen
 * share). macOS also: the window is on screen with a window id the Studio
 * can hand the capture filter (the Studio confirms the capture took it).
 * Anything else never draws.
 */
export function sceneHudWindowReady(input: {
  platform: NodeJS.Platform
  alive: boolean
  loaded: boolean
  onScreen: boolean
  windowId: number | undefined
  contentProtected: boolean
}): boolean {
  if (!input.alive || !input.loaded) return false
  const method = streamManagerHideMethod(input.platform)
  if (!input.contentProtected) return false
  if (method === 'capture-filter') return input.onScreen && input.windowId !== undefined
  return method === 'content-protection'
}

/**
 * Pure. Main's half of the decision; the Studio already checked where the
 * switch came from, the setting and the capture filter. A Videorc window in
 * front means the streamer can see the stage, so the HUD stays away.
 */
export function sceneHudShowDecision(input: {
  platform: NodeJS.Platform
  enabled: boolean
  ready: boolean
  videorcWindowFocused: boolean
}): SceneHudShowResult {
  if (!sceneHudSupported(input.platform)) return { shown: false, reason: 'unsupported' }
  if (!input.enabled) return { shown: false, reason: 'disabled' }
  if (input.videorcWindowFocused) return { shown: false, reason: 'videorc-in-front' }
  if (!input.ready) return { shown: false, reason: 'not-ready' }
  return { shown: true }
}

/**
 * Pure. Whether Windows can leave a window out of a capture: Electron asks
 * for `WDA_EXCLUDEFROMCAPTURE`, which needs Windows 10 2004 (build 19041);
 * before it Electron falls back to `WDA_MONITOR`, which paints the window
 * black in a capture instead of leaving it out. The HUD shows on neither.
 */
export function windowsExcludesFromCapture(osRelease: string): boolean {
  const [major, , build] = osRelease.split('.').map((part) => Number(part))
  return Number.isFinite(major) && Number.isFinite(build) && (major > 10 || build >= 19041)
}

/** Pure. A ScreenCaptureKit window id from Electron's `window:<id>:0`. */
export function sceneHudWindowIdFromMediaSourceId(mediaSourceId: string): number | undefined {
  const match = /^window:(\d+):/.exec(mediaSourceId)
  const id = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Pure. The window's options, without its web preferences (main adds them). */
export function sceneHudWindowOptions(
  platform: NodeJS.Platform
): Omit<BrowserWindowConstructorOptions, 'webPreferences'> {
  return {
    ...SCENE_HUD_WINDOW_SIZE,
    // A non-activating NSPanel on macOS: showing it never brings Videorc
    // forward over the app the streamer is in.
    ...(platform === 'darwin' ? { type: 'panel', hiddenInMissionControl: true } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never takes key focus (on Windows this also keeps it off the taskbar).
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: ''
  }
}

/** The window as the controller drives it (a BrowserWindow in the app). */
export interface SceneHudWindowHandle {
  isDestroyed(): boolean
  destroy(): void
  setBounds(bounds: Rectangle): void
  showInactive(): void
  hide(): void
  moveTop(): void
  isVisible(): boolean
  getMediaSourceId(): string
}

export interface SceneHudHost<W extends SceneHudWindowHandle = SceneHudWindowHandle> {
  platform: NodeJS.Platform
  /** Makes the window and loads its page; null when it could not. */
  createWindow(): Promise<W | null>
  /** Applies content protection and confirms it (`isContentProtected`). */
  protect(window: W): boolean
  /** The work area of the display under the pointer. */
  cursorWorkArea(): Rectangle
  /** Whether any Videorc window has focus (the stage is in view). */
  videorcWindowFocused(): boolean
  appIcon(bundleId: string): Promise<string | undefined>
  present(window: W, presentation: SceneHudPresentation): void
  emitState(state: SceneHudWindowState): void
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  warn(message: string): void
}

/**
 * Owns the one HUD window: made while the setting is on, dropped while it is
 * off. Every show re-checks focus and readiness, so a window that lost its
 * protection never draws.
 */
export class SceneHudController<W extends SceneHudWindowHandle = SceneHudWindowHandle> {
  private window: W | null = null
  private creating: Promise<void> | null = null
  private enabled = false
  private contentProtected = false
  private sequence = 0
  private idleTimer: unknown = null
  /** Smoke only: the next presentation's hold, for screenshots. */
  private nextHoldMs: number | null = null
  lastResult: SceneHudShowResult | null = null
  /** Every show asked for, drawn or not (the smokes wait on it). */
  requests = 0

  constructor(private readonly host: SceneHudHost<W>) {}

  state(): SceneHudWindowState {
    const window = this.liveWindow()
    const windowId =
      window && this.host.platform === 'darwin'
        ? sceneHudWindowIdFromMediaSourceId(window.getMediaSourceId())
        : undefined
    return {
      enabled: this.enabled && sceneHudSupported(this.host.platform),
      method: streamManagerHideMethod(this.host.platform),
      ...(windowId !== undefined ? { windowId } : {}),
      ready: sceneHudWindowReady({
        platform: this.host.platform,
        alive: window !== null,
        loaded: window !== null,
        onScreen: window?.isVisible() ?? false,
        windowId,
        contentProtected: this.contentProtected
      })
    }
  }

  async setEnabled(enabled: boolean): Promise<SceneHudWindowState> {
    this.enabled = enabled
    if (!enabled || !sceneHudSupported(this.host.platform)) {
      this.drop()
      this.emit()
      return this.state()
    }
    await this.ensureWindow()
    return this.state()
  }

  /** Smoke only (screenshots): hold the next chip this long. */
  holdNext(ms: number): void {
    this.nextHoldMs = Math.max(0, Math.min(120_000, Math.round(ms)))
  }

  async show(
    request: SceneHudRequest,
    options: { ignoreFocus?: boolean } = {}
  ): Promise<SceneHudShowResult> {
    this.requests += 1
    const state = this.state()
    const decision = sceneHudShowDecision({
      platform: this.host.platform,
      enabled: state.enabled,
      ready: state.ready,
      videorcWindowFocused: options.ignoreFocus ? false : this.host.videorcWindowFocused()
    })
    this.lastResult = decision
    const window = this.liveWindow()
    if (!decision.shown || !window) return decision
    const iconDataUrl =
      request.icon.kind === 'app' ? await this.host.appIcon(request.icon.bundleId) : undefined
    // The window may have gone while the icon was read.
    if (this.liveWindow() !== window) {
      this.lastResult = { shown: false, reason: 'not-ready' }
      return this.lastResult
    }
    window.setBounds(sceneHudBounds(this.host.cursorWorkArea()))
    if (this.host.platform !== 'darwin') window.showInactive()
    window.moveTop()
    this.sequence += 1
    const holdMs = this.nextHoldMs
    this.nextHoldMs = null
    this.host.present(window, {
      ...request,
      sequence: this.sequence,
      platform: this.host.platform,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      ...(holdMs !== null ? { holdMs } : {})
    })
    this.scheduleIdle(holdMs)
    return decision
  }

  dispose(): void {
    this.enabled = false
    this.drop()
  }

  private liveWindow(): W | null {
    const window = this.window
    return window && !window.isDestroyed() ? window : null
  }

  private async ensureWindow(): Promise<void> {
    if (this.liveWindow()) return
    if (!this.creating) {
      this.creating = (async () => {
        try {
          const window = await this.host.createWindow()
          if (!window) return
          if (!this.enabled) {
            window.destroy()
            return
          }
          this.window = window
          this.contentProtected = this.host.protect(window)
          if (!this.contentProtected) {
            // Fail closed: the window stays, and never draws (`ready` false).
            this.host.warn('Scene HUD content protection could not be confirmed.')
          }
          if (this.host.platform === 'darwin') {
            // On screen and transparent for good: the capture filter only
            // finds a window that is on screen when it is built.
            window.setBounds(sceneHudBounds(this.host.cursorWorkArea()))
            window.showInactive()
          }
        } catch (error) {
          this.host.warn(
            `Scene HUD window could not be made: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          this.creating = null
          this.emit()
        }
      })()
    }
    await this.creating
  }

  private drop(): void {
    if (this.idleTimer !== null) this.host.clearTimeout(this.idleTimer)
    this.idleTimer = null
    const window = this.liveWindow()
    this.window = null
    this.contentProtected = false
    window?.destroy()
  }

  private scheduleIdle(holdMs: number | null): void {
    if (this.host.platform === 'darwin') return
    if (this.idleTimer !== null) this.host.clearTimeout(this.idleTimer)
    const ms = holdMs === null ? SCENE_HUD_IDLE_AFTER_MS : holdMs + SCENE_HUD_FADE_MS + 250
    this.idleTimer = this.host.setTimeout(() => {
      this.idleTimer = null
      this.liveWindow()?.hide()
    }, ms)
  }

  private emit(): void {
    this.host.emitState(this.state())
  }
}
