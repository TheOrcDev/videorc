// HTML overlays (plan 231): the offscreen windows that render them.
//
// The backend says which overlays to render and at what pixel size and rate
// (`htmlOverlays.targets`); this host keeps exactly one offscreen window per
// target and sends what each paints down the frame upload. Every rule about
// what a page may do lives in `html-overlay-policy.ts`; this file applies
// them to Electron and owns no policy of its own.
//
// A window exists only while its overlay shows. Hiding it destroys the
// window and its in-memory session: nothing of the page outlives it.

import { BrowserWindow, net, screen, session as electronSession, type Session } from 'electron'
import { lstatSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { HtmlOverlayHostState, HtmlOverlayTarget } from '../shared/backend'
import {
  HtmlOverlayFrameUploader,
  type HtmlOverlayUploadConnection,
  type HtmlOverlayUploadStats
} from './html-overlay-frames'
import {
  HTML_OVERLAY_CONTENT_SECURITY_POLICY,
  HTML_OVERLAY_SCHEME,
  htmlOverlayBitmapSize,
  htmlOverlayContentType,
  htmlOverlayEntryUrl,
  htmlOverlayFolderName,
  htmlOverlayFrameDecision,
  htmlOverlayFrameRate,
  htmlOverlayNavigationAllowed,
  htmlOverlayPartition,
  htmlOverlayPermissionAllowed,
  htmlOverlayRequestVerdict,
  htmlOverlayWebPreferences,
  htmlOverlayWindowGeometry,
  isHtmlOverlayId,
  resolveHtmlOverlayFile,
  type HtmlOverlayFileSystem,
  type HtmlOverlayWindowGeometry
} from './html-overlay-policy'

export interface HtmlOverlayHostOptions {
  /** The backend-managed Banners folder, or `null` before the backend is ready. */
  bannersRoot: () => string | null
  /** The backend's admin connection, or `null` while there is none. */
  connection: () => HtmlOverlayUploadConnection | null
  /** Tell the backend how a page stands (`htmlOverlays.host.report`). */
  report: (report: {
    id: string
    state: HtmlOverlayHostState
    detail?: string
    blockedRequests?: number
  }) => void
  log: (level: 'info' | 'warn', message: string) => void
}

/** The offscreen windows this host made. They are not app windows: nothing
 * is broadcast to them and they never count as "a window is open". */
const overlayWindows = new WeakSet<BrowserWindow>()

export function isHtmlOverlayWindow(window: BrowserWindow): boolean {
  return overlayWindows.has(window)
}

export interface HtmlOverlayHostStats extends HtmlOverlayUploadStats {
  windows: number
  framesPainted: number
  framesDroppedEarly: number
  framesDroppedOversize: number
  /** Time spent copying painted bitmaps out of Chromium, in milliseconds. */
  copyMs: number
  /** Time spent handing frames to the upload, in milliseconds. */
  writeMs: number
  blockedRequests: number
}

const fileSystem: HtmlOverlayFileSystem = {
  lstat: (path) => {
    try {
      return lstatSync(path)
    } catch {
      return null
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  },
  sep,
  join
}

interface OverlayWindow {
  id: string
  target: HtmlOverlayTarget
  window: BrowserWindow
  session: Session
  geometry: HtmlOverlayWindowGeometry
  displayScale: number
  sequence: bigint
  lastSentMs: number | null
  blockedRequests: number
  reportedBlockedRequests: number
  state: HtmlOverlayHostState
  /** A repaint asked for because a frame was dropped (see `repaintSoon`). */
  repaintTimer: NodeJS.Timeout | null
}

/** How often a page's blocked-request count is reported while it grows. */
const BLOCKED_REPORT_INTERVAL_MS = 2000

export class HtmlOverlayHost {
  private readonly windows = new Map<string, OverlayWindow>()
  /** Sessions already given their rules: a session outlives its window, and
   * its listeners must be added once. */
  private readonly sessions = new Map<string, Session>()
  private readonly uploader: HtmlOverlayFrameUploader
  private blockedReportTimer: NodeJS.Timeout | null = null
  private framesPainted = 0
  private framesDroppedEarly = 0
  private framesDroppedBusy = 0
  private framesDroppedOversize = 0
  private copyMs = 0
  private writeMs = 0
  private blockedRequests = 0

  constructor(private readonly options: HtmlOverlayHostOptions) {
    this.uploader = new HtmlOverlayFrameUploader(options.connection)
  }

  /** Follow the backend's targets: one window per target, none for the rest. */
  setTargets(targets: readonly HtmlOverlayTarget[]): void {
    const wanted = new Map<string, HtmlOverlayTarget>()
    for (const target of targets) {
      if (isHtmlOverlayId(target.id)) wanted.set(target.id, target)
    }
    for (const [id, overlay] of this.windows) {
      if (!wanted.has(id)) this.destroy(overlay)
    }
    for (const target of wanted.values()) {
      const overlay = this.windows.get(target.id)
      if (!overlay) {
        this.create(target)
      } else if (!sameTarget(overlay.target, target)) {
        this.retarget(overlay, target)
      }
    }
    if (this.windows.size === 0) this.uploader.close()
  }

  /** The backend connection changed or went away: the upload reopens on the
   * next frame, against whatever connection there is then. */
  connectionChanged(): void {
    this.uploader.close()
  }

  /** Paint every overlay again. A new backend holds no frames, and a page
   * that stands still would otherwise never send it one. */
  refresh(): void {
    for (const overlay of this.windows.values()) this.repaintSoon(overlay)
  }

  dispose(): void {
    for (const overlay of [...this.windows.values()]) this.destroy(overlay)
    this.uploader.close()
    if (this.blockedReportTimer) clearInterval(this.blockedReportTimer)
    this.blockedReportTimer = null
  }

  stats(): HtmlOverlayHostStats {
    const upload = this.uploader.stats()
    return {
      ...upload,
      framesDroppedBusy: upload.framesDroppedBusy + this.framesDroppedBusy,
      windows: this.windows.size,
      framesPainted: this.framesPainted,
      framesDroppedEarly: this.framesDroppedEarly,
      framesDroppedOversize: this.framesDroppedOversize,
      copyMs: Math.round(this.copyMs * 1000) / 1000,
      writeMs: Math.round(this.writeMs * 1000) / 1000,
      blockedRequests: this.blockedRequests
    }
  }

  private create(target: HtmlOverlayTarget): void {
    const id = target.id
    const bannersRoot = this.options.bannersRoot()
    if (!bannersRoot) {
      this.options.log('warn', `HTML overlay ${id} has no Banners folder to load from yet.`)
      return
    }
    const overlayRoot = join(bannersRoot, htmlOverlayFolderName(id))
    const displayScale = screen.getPrimaryDisplay().scaleFactor
    const geometry = htmlOverlayWindowGeometry(target, displayScale)
    const overlaySession = this.configureSession(id, overlayRoot)
    const window = new BrowserWindow({
      show: false,
      width: geometry.contentWidth,
      height: geometry.contentHeight,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      webPreferences: htmlOverlayWebPreferences(id, geometry.zoomFactor)
    })
    const overlay: OverlayWindow = {
      id,
      target,
      window,
      session: overlaySession,
      geometry,
      displayScale,
      sequence: 0n,
      lastSentMs: null,
      blockedRequests: 0,
      reportedBlockedRequests: 0,
      state: 'loading',
      repaintTimer: null
    }
    overlayWindows.add(window)
    this.windows.set(id, overlay)
    const contents = window.webContents
    // An overlay's sound never reaches the speakers (it is not in the mix).
    contents.setAudioMuted(true)
    contents.setFrameRate(htmlOverlayFrameRate(target.fps))
    // WebRTC is not a request the rule below sees: keep it off the network.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!htmlOverlayNavigationAllowed(id, url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!htmlOverlayNavigationAllowed(id, url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('did-finish-load', () => {
      if (this.windows.get(id) !== overlay) return
      // Zoom is kept per origin; say it again once the page is in.
      contents.setZoomFactor(overlay.geometry.zoomFactor)
      this.setState(overlay, 'live')
    })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is an aborted load (a navigation the rules cancelled).
      if (isMainFrame && code !== -3) {
        this.setState(overlay, 'failed', `the page did not load (${description || code})`)
      }
    })
    contents.on('render-process-gone', (_event, details) => {
      this.setState(overlay, 'failed', `the page closed unexpectedly (${details.reason})`)
    })
    contents.on('unresponsive', () => {
      this.setState(overlay, 'failed', 'the page stopped responding')
    })
    contents.on('responsive', () => {
      if (overlay.state === 'failed') this.setState(overlay, 'live')
    })
    contents.on('paint', (_event, _dirty, image) => {
      if (this.windows.get(id) !== overlay) return
      this.framesPainted += 1
      const reported = image.getSize()
      const nowMs = performance.now()
      const decision = htmlOverlayFrameDecision({
        width: reported.width,
        height: reported.height,
        nowMs,
        lastSentMs: overlay.lastSentMs,
        fps: overlay.target.fps,
        uploadBusy: this.uploader.busy
      })
      if (decision !== 'send') {
        if (decision === 'drop-early') this.framesDroppedEarly += 1
        if (decision === 'drop-busy') this.framesDroppedBusy += 1
        if (decision === 'drop-oversize') {
          this.framesDroppedOversize += 1
          return
        }
        // The dropped frame may be the page's last (an animation that just
        // ended, a page that stands still): ask for it again.
        this.repaintSoon(overlay)
        return
      }
      const copyStartedAt = performance.now()
      const bitmap = image.toBitmap()
      const copiedAt = performance.now()
      this.copyMs += copiedAt - copyStartedAt
      const size = htmlOverlayBitmapSize(reported, bitmap.length)
      if (!size) return
      this.followDisplayScale(overlay, size.width)
      overlay.sequence += 1n
      const outcome = this.uploader.send(
        { id, width: size.width, height: size.height, sequence: overlay.sequence },
        bitmap
      )
      this.writeMs += performance.now() - copiedAt
      if (outcome === 'sent') {
        overlay.lastSentMs = nowMs
        this.cancelRepaint(overlay)
      } else {
        this.repaintSoon(overlay)
      }
    })
    this.options.report({ id, state: 'loading' })
    void window.loadURL(htmlOverlayEntryUrl(id)).catch((error: unknown) => {
      if (this.windows.get(id) !== overlay) return
      this.setState(
        overlay,
        'failed',
        `the page did not load (${error instanceof Error ? error.message : String(error)})`
      )
    })
    this.ensureBlockedReportTimer()
    this.options.log(
      'info',
      `HTML overlay ${id}: page ${target.pageWidth}x${target.pageHeight}, frame ${geometry.frameWidth}x${geometry.frameHeight} at ${htmlOverlayFrameRate(target.fps)} fps.`
    )
  }

  /** The session an overlay's window runs in: its own, in memory, with every
   * rule from the policy applied before anything loads. */
  private configureSession(id: string, overlayRoot: string): Session {
    const configured = this.sessions.get(id)
    if (configured) return configured
    const overlaySession = electronSession.fromPartition(htmlOverlayPartition(id), { cache: false })
    this.sessions.set(id, overlaySession)
    overlaySession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(htmlOverlayPermissionAllowed())
    })
    overlaySession.setPermissionCheckHandler(() => htmlOverlayPermissionAllowed())
    overlaySession.setDevicePermissionHandler(() => htmlOverlayPermissionAllowed())
    overlaySession.setDisplayMediaRequestHandler(null)
    overlaySession.on('will-download', (event) => event.preventDefault())
    overlaySession.on('select-hid-device', (event) => event.preventDefault())
    overlaySession.on('select-serial-port', (event) => event.preventDefault())
    overlaySession.on('select-usb-device', (event) => event.preventDefault())
    // The fence (D5): every request that is not the overlay's own is
    // cancelled before it leaves.
    overlaySession.webRequest.onBeforeRequest((details, callback) => {
      const verdict = htmlOverlayRequestVerdict(id, details.url)
      if (!verdict.allow) this.countBlockedRequest(id)
      callback({ cancel: !verdict.allow })
    })
    // And nowhere for one to go if a path around that rule is ever found:
    // the session's only proxy is a closed port on this machine.
    void overlaySession
      .setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9' })
      .catch(() => {})
    overlaySession.protocol.handle(HTML_OVERLAY_SCHEME, async (request) => {
      const file = resolveHtmlOverlayFile(id, overlayRoot, request.url, fileSystem)
      if (!file) return new Response('Not found', { status: 404 })
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers()
      headers.set('Content-Type', htmlOverlayContentType(file))
      headers.set('Content-Security-Policy', HTML_OVERLAY_CONTENT_SECURITY_POLICY)
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    })
    return overlaySession
  }

  /** Ask the page to paint again one frame from now, once. */
  private repaintSoon(overlay: OverlayWindow): void {
    if (overlay.repaintTimer) return
    overlay.repaintTimer = setTimeout(
      () => {
        overlay.repaintTimer = null
        if (this.windows.get(overlay.id) !== overlay || overlay.window.isDestroyed()) return
        overlay.window.webContents.invalidate()
      },
      Math.ceil(1000 / htmlOverlayFrameRate(overlay.target.fps))
    )
  }

  private cancelRepaint(overlay: OverlayWindow): void {
    if (!overlay.repaintTimer) return
    clearTimeout(overlay.repaintTimer)
    overlay.repaintTimer = null
  }

  private retarget(overlay: OverlayWindow, target: HtmlOverlayTarget): void {
    overlay.target = target
    this.applyGeometry(overlay, htmlOverlayWindowGeometry(target, overlay.displayScale))
    overlay.window.webContents.setFrameRate(htmlOverlayFrameRate(target.fps))
  }

  private applyGeometry(overlay: OverlayWindow, geometry: HtmlOverlayWindowGeometry): void {
    overlay.geometry = geometry
    overlay.window.setContentSize(geometry.contentWidth, geometry.contentHeight)
    overlay.window.webContents.setZoomFactor(geometry.zoomFactor)
  }

  /** A paint is `content × display scale` pixels. When the first one says
   * the window sits on a display of another scale than the primary's, size
   * the window again for the scale it really has. */
  private followDisplayScale(overlay: OverlayWindow, paintedWidth: number): void {
    const scale = paintedWidth / overlay.geometry.contentWidth
    if (!Number.isFinite(scale) || scale < 1 || Math.abs(scale - overlay.displayScale) < 0.01) {
      return
    }
    overlay.displayScale = scale
    this.applyGeometry(overlay, htmlOverlayWindowGeometry(overlay.target, scale))
  }

  private setState(overlay: OverlayWindow, state: HtmlOverlayHostState, detail?: string): void {
    if (this.windows.get(overlay.id) !== overlay) return
    overlay.state = state
    overlay.reportedBlockedRequests = overlay.blockedRequests
    this.options.report({
      id: overlay.id,
      state,
      ...(detail ? { detail } : {}),
      ...(overlay.blockedRequests > 0 ? { blockedRequests: overlay.blockedRequests } : {})
    })
    if (state === 'failed') {
      this.options.log('warn', `HTML overlay ${overlay.id} stopped: ${detail ?? 'unknown reason'}.`)
    }
  }

  private countBlockedRequest(id: string): void {
    this.blockedRequests += 1
    const overlay = this.windows.get(id)
    if (overlay) overlay.blockedRequests += 1
  }

  /** A page that keeps asking for the network says so in the overlay's
   * status, a few times a minute at most. */
  private ensureBlockedReportTimer(): void {
    if (this.blockedReportTimer) return
    this.blockedReportTimer = setInterval(() => {
      for (const overlay of this.windows.values()) {
        if (overlay.blockedRequests !== overlay.reportedBlockedRequests) {
          this.options.log(
            'info',
            `HTML banner ${overlay.id}: ${overlay.blockedRequests} network requests blocked (the network is off for HTML banners).`
          )
          this.setState(overlay, overlay.state)
        }
      }
      if (this.windows.size === 0 && this.blockedReportTimer) {
        clearInterval(this.blockedReportTimer)
        this.blockedReportTimer = null
      }
    }, BLOCKED_REPORT_INTERVAL_MS)
    this.blockedReportTimer.unref?.()
  }

  private destroy(overlay: OverlayWindow): void {
    this.windows.delete(overlay.id)
    this.cancelRepaint(overlay)
    if (!overlay.window.isDestroyed()) overlay.window.destroy()
    // The session is in memory only; drop what the page stored anyway.
    void overlay.session.clearStorageData().catch(() => {})
  }
}

function sameTarget(a: HtmlOverlayTarget, b: HtmlOverlayTarget): boolean {
  return (
    a.pageWidth === b.pageWidth &&
    a.pageHeight === b.pageHeight &&
    a.frameWidth === b.frameWidth &&
    a.frameHeight === b.frameHeight &&
    a.fps === b.fps
  )
}
