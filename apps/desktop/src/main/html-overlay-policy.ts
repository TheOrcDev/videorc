// HTML overlays (plan 231): the rules for a page Videorc did not write.
//
// An overlay is HTML and JavaScript the streamer got from somewhere. It
// renders in an offscreen window of its own, and everything it may and may
// not do is decided here, in pure functions the tests pin:
//   - what its window is allowed to be (D4): sandboxed, isolated, no Node,
//     no preload, so no path into the app's IPC;
//   - which requests go through (D5): its own folder, `data:` and `blob:`.
//     Nothing on the network, no other overlay, no file on disk. The host
//     backs the rule with a session whose only proxy is a closed port;
//   - where it may navigate (nowhere but its own pages) and what it may ask
//     for (nothing);
//   - which file a request names inside its folder;
//   - how large its window is for the frame the backend asked for;
//   - when a painted frame is sent.
// No electron and no fs imports: the host (`html-overlay-host.ts`) hands the
// filesystem in.

import { HTML_OVERLAY_MAX_FPS, HTML_OVERLAY_MAX_FRAME_PIXELS } from '../shared/backend'

/** The scheme an overlay's own files load from. It exists only in the
 * overlay's own session, never in the app's. */
export const HTML_OVERLAY_SCHEME = 'videorc-overlay'
/** The page every overlay starts at. */
export const HTML_OVERLAY_ENTRY_FILE = 'index.html'
/** `<banner id>.overlay` inside the backend-managed Banners folder. */
export const HTML_OVERLAY_FOLDER_SUFFIX = '.overlay'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A banner id as the backend writes it: a lower-case hyphenated UUID. It is
 * a host name and a folder name here, so nothing else is accepted. */
export function isHtmlOverlayId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function htmlOverlayFolderName(id: string): string {
  return `${id}${HTML_OVERLAY_FOLDER_SUFFIX}`
}

export function htmlOverlayOrigin(id: string): string {
  return `${HTML_OVERLAY_SCHEME}://${id}`
}

export function htmlOverlayEntryUrl(id: string): string {
  return `${htmlOverlayOrigin(id)}/${HTML_OVERLAY_ENTRY_FILE}`
}

/** One in-memory session per overlay (no `persist:` prefix): no cookies, no
 * cache, no storage shared with the app or with another overlay, and nothing
 * left on disk. */
export function htmlOverlayPartition(id: string): string {
  return `html-overlay:${id}`
}

// --- The window (D4) ---------------------------------------------------------

export interface HtmlOverlayWebPreferences {
  offscreen: true
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
  nodeIntegrationInWorker: false
  nodeIntegrationInSubFrames: false
  webSecurity: true
  allowRunningInsecureContent: false
  webviewTag: false
  plugins: false
  experimentalFeatures: false
  navigateOnDragDrop: false
  devTools: false
  spellcheck: false
  disableDialogs: true
  backgroundThrottling: false
  autoplayPolicy: 'no-user-gesture-required'
  partition: string
  zoomFactor: number
}

/**
 * What an overlay's window is. There is deliberately no `preload`: with the
 * sandbox and context isolation on and no preload script, the page has no
 * bridge to the app at all. `backgroundThrottling` is off because the window
 * is never visible and its animation must keep running.
 */
export function htmlOverlayWebPreferences(
  id: string,
  zoomFactor: number
): HtmlOverlayWebPreferences {
  return {
    offscreen: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    devTools: false,
    spellcheck: false,
    disableDialogs: true,
    backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required',
    partition: htmlOverlayPartition(id),
    zoomFactor
  }
}

/**
 * The Content-Security-Policy sent with every file an overlay loads: no
 * plugins, no `<base>` pointing elsewhere, no form posts. It deliberately
 * names no fetch sources: the network is closed by the request rule below
 * (and by the session's dead proxy), which also counts what it cancels so
 * the overlay's status can say a font or a script was blocked. A CSP that
 * blocked those first would hide them from that count.
 */
export const HTML_OVERLAY_CONTENT_SECURITY_POLICY = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

// --- Requests (D5) -----------------------------------------------------------

export type HtmlOverlayRequestRefusal =
  /** http, https, ws, wss, ftp: the network is off. */
  | 'network'
  /** A file on disk outside the overlay's scheme. */
  | 'file'
  /** Another overlay's folder. */
  | 'other-overlay'
  /** Any other scheme (the app's own asset scheme, chrome:, devtools:, …). */
  | 'scheme'
  | 'invalid'

export type HtmlOverlayRequestVerdict =
  | { allow: true }
  | { allow: false; reason: HtmlOverlayRequestRefusal }

const ALLOW: HtmlOverlayRequestVerdict = { allow: true }
const refuse = (reason: HtmlOverlayRequestRefusal): HtmlOverlayRequestVerdict => ({
  allow: false,
  reason
})

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:'])

/**
 * Whether overlay `overlayId` may make the request `rawUrl`. Its own files,
 * `data:` URLs and `blob:` URLs it made itself go through. Everything else
 * is cancelled: the network (D5), files on disk, another overlay's folder,
 * the app's own schemes.
 */
export function htmlOverlayRequestVerdict(
  overlayId: string,
  rawUrl: string
): HtmlOverlayRequestVerdict {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return refuse('invalid')
  }
  if (url.protocol === `${HTML_OVERLAY_SCHEME}:`) {
    return url.hostname === overlayId && url.port === '' && url.username === ''
      ? ALLOW
      : refuse('other-overlay')
  }
  if (url.protocol === 'data:') return ALLOW
  if (url.protocol === 'blob:') {
    // `blob:videorc-overlay://<id>/<uuid>`: only a blob this overlay made.
    return rawUrl.startsWith(`blob:${htmlOverlayOrigin(overlayId)}/`) ? ALLOW : refuse('scheme')
  }
  if (rawUrl === 'about:blank' || rawUrl === 'about:srcdoc') return ALLOW
  if (NETWORK_PROTOCOLS.has(url.protocol)) return refuse('network')
  if (url.protocol === 'file:') return refuse('file')
  return refuse('scheme')
}

/** An overlay's window navigates only between its own pages. */
export function htmlOverlayNavigationAllowed(overlayId: string, rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  return url.protocol === `${HTML_OVERLAY_SCHEME}:` && url.hostname === overlayId
}

/**
 * Every permission an overlay asks for is refused: camera, microphone,
 * screen, location, notifications, clipboard, MIDI, USB, HID, serial,
 * Bluetooth, fullscreen, pointer lock, downloads, opening links. The answer
 * never depends on the permission, the origin or the details.
 */
export function htmlOverlayPermissionAllowed(): false {
  return false
}

// --- Files -------------------------------------------------------------------

export interface HtmlOverlayFileSystem {
  /** `fs.lstatSync`, or `null` when the path does not exist. */
  lstat: (path: string) => { isFile: () => boolean; isSymbolicLink: () => boolean } | null
  /** `fs.realpathSync`, or `null` when it cannot be resolved. */
  realpath: (path: string) => string | null
  /** `path.sep` and `path.join` of the platform. */
  sep: string
  join: (...parts: string[]) => string
}

/**
 * The file a request names, or `null`. `overlayRoot` is the overlay's own
 * folder (`Banners/<id>.overlay`). The request must be this overlay's, its
 * path must stay inside the folder segment by segment (no `..`, no empty or
 * hidden segment, no backslash, no NUL), and the file must be a regular file
 * that is not a link and whose real path is still inside the folder's real
 * path. `/` is the entry page.
 */
export function resolveHtmlOverlayFile(
  overlayId: string,
  overlayRoot: string,
  rawUrl: string,
  fs: HtmlOverlayFileSystem
): string | null {
  if (!isHtmlOverlayId(overlayId) || !htmlOverlayRequestVerdict(overlayId, rawUrl).allow) {
    return null
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${HTML_OVERLAY_SCHEME}:`) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const segments =
    pathname === '/' || pathname === ''
      ? [HTML_OVERLAY_ENTRY_FILE]
      : pathname.replace(/^\//, '').split('/')
  for (const segment of segments) {
    if (
      segment === '' ||
      segment.startsWith('.') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      segment.includes(':')
    ) {
      return null
    }
  }
  const root = fs.realpath(overlayRoot)
  if (!root) return null
  const candidate = fs.join(overlayRoot, ...segments)
  const stats = fs.lstat(candidate)
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null
  const real = fs.realpath(candidate)
  if (!real || !real.startsWith(root.endsWith(fs.sep) ? root : root + fs.sep)) return null
  return real
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  wasm: 'application/wasm'
}

/** The type a file is served with, by its extension. An unknown extension is
 * bytes: the page cannot make the browser run it as a script or a page. */
export function htmlOverlayContentType(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

// --- Geometry ----------------------------------------------------------------

/** Chromium's zoom factor range. */
export const HTML_OVERLAY_ZOOM_MIN = 0.25
export const HTML_OVERLAY_ZOOM_MAX = 5

export interface HtmlOverlayPageTarget {
  pageWidth: number
  pageHeight: number
  frameWidth: number
  frameHeight: number
}

export interface HtmlOverlayWindowGeometry {
  /** The window's content size, in DIP. */
  contentWidth: number
  contentHeight: number
  /** Page zoom: the CSS viewport is the content size divided by this. */
  zoomFactor: number
  /** The pixels a paint will carry: content size × display scale. */
  frameWidth: number
  frameHeight: number
}

/**
 * The window for a target on a display of scale `displayScale`. An offscreen
 * window paints `DIP × scale` pixels and lays the page out at `DIP ÷ zoom`
 * CSS pixels, so a window of `frame ÷ scale` DIP zoomed by
 * `frame ÷ (scale × page)` paints the frame the backend asked for while the
 * page still sees its own size.
 *
 * The zoom is clamped to Chromium's range; past it the window keeps the
 * page's size at the nearest zoom, and the compositor scales the frame the
 * rest of the way. A frame that would pass the cap is shrunk to it.
 */
export function htmlOverlayWindowGeometry(
  target: HtmlOverlayPageTarget,
  displayScale: number
): HtmlOverlayWindowGeometry {
  const scale = Number.isFinite(displayScale) && displayScale >= 1 ? Math.min(displayScale, 4) : 1
  const pageWidth = Math.max(1, Math.round(target.pageWidth))
  const pageHeight = Math.max(1, Math.round(target.pageHeight))
  const wantedZoom = Math.max(1, target.frameWidth) / (scale * pageWidth)
  let zoomFactor = Math.min(HTML_OVERLAY_ZOOM_MAX, Math.max(HTML_OVERLAY_ZOOM_MIN, wantedZoom))
  let contentWidth = Math.max(1, Math.ceil(pageWidth * zoomFactor - 1e-6))
  let contentHeight = Math.max(1, Math.ceil(pageHeight * zoomFactor - 1e-6))
  const pixels = (width: number, height: number): number => width * scale * (height * scale)
  if (pixels(contentWidth, contentHeight) > HTML_OVERLAY_MAX_FRAME_PIXELS) {
    const shrink = Math.sqrt(HTML_OVERLAY_MAX_FRAME_PIXELS / pixels(contentWidth, contentHeight))
    contentWidth = Math.max(1, Math.floor(contentWidth * shrink))
    contentHeight = Math.max(1, Math.floor(contentHeight * shrink))
    zoomFactor = Math.max(HTML_OVERLAY_ZOOM_MIN, contentWidth / pageWidth)
  }
  return {
    contentWidth,
    contentHeight,
    zoomFactor,
    frameWidth: Math.round(contentWidth * scale),
    frameHeight: Math.round(contentHeight * scale)
  }
}

/**
 * The pixel size of a painted bitmap. `size` is what the image reports and
 * `byteLength` what `toBitmap()` returned: on some displays the image
 * reports DIP and carries a denser bitmap, so the bytes decide. `null` when
 * the two cannot be the same picture.
 */
export function htmlOverlayBitmapSize(
  size: { width: number; height: number },
  byteLength: number
): { width: number; height: number } | null {
  const { width, height } = size
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null
  }
  if (byteLength === width * height * 4) return { width, height }
  const density = Math.sqrt(byteLength / (width * height * 4))
  const dense = { width: Math.round(width * density), height: Math.round(height * density) }
  return dense.width * dense.height * 4 === byteLength ? dense : null
}

// --- Pacing (D7) -------------------------------------------------------------

/** The rate an overlay's window paints at: the target's, 1 to 30. */
export function htmlOverlayFrameRate(fps: number): number {
  if (!Number.isFinite(fps)) return HTML_OVERLAY_MAX_FPS
  return Math.min(HTML_OVERLAY_MAX_FPS, Math.max(1, Math.round(fps)))
}

export type HtmlOverlayFrameDecision =
  | 'send'
  /** The socket still holds the last frame: latest wins, this one is dropped. */
  | 'drop-busy'
  /** Painted sooner than the rate allows. */
  | 'drop-early'
  /** Larger than the cap: the backend would throw it away. */
  | 'drop-oversize'

/**
 * Whether a painted frame is sent. Never while the upload still holds the
 * previous frame (so a slow backend costs frames, never memory or latency),
 * never faster than the target rate (a frame is early when less than three
 * quarters of the frame interval has passed since the last one sent), and
 * never over the cap.
 */
export function htmlOverlayFrameDecision(frame: {
  width: number
  height: number
  nowMs: number
  lastSentMs: number | null
  fps: number
  uploadBusy: boolean
}): HtmlOverlayFrameDecision {
  if (frame.width * frame.height > HTML_OVERLAY_MAX_FRAME_PIXELS) return 'drop-oversize'
  if (frame.uploadBusy) return 'drop-busy'
  if (frame.lastSentMs !== null) {
    const interval = 1000 / htmlOverlayFrameRate(frame.fps)
    if (frame.nowMs - frame.lastSentMs < interval * 0.75) return 'drop-early'
  }
  return 'send'
}
