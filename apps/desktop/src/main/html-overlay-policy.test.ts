import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HTML_OVERLAY_MAX_FRAME_PIXELS } from '../shared/backend'
import {
  HTML_OVERLAY_CONTENT_SECURITY_POLICY,
  HTML_OVERLAY_ZOOM_MAX,
  HTML_OVERLAY_ZOOM_MIN,
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
  HTML_OVERLAY_PICK_CHOICES,
  htmlOverlayNoPictureDetail,
  htmlOverlayPickDialog,
  htmlOverlayPickNeedsChoice,
  isHtmlOverlayId,
  resolveHtmlOverlayFile,
  type HtmlOverlayFileSystem
} from './html-overlay-policy'

const BADGE = '0f9d1c2e-5b7a-4c3d-9e8f-a1b2c3d4e5f6'
const OTHER = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('an HTML overlay is addressed by its banner id (plan 232)', () => {
  it('accepts only a lower-case hyphenated UUID', () => {
    expect(isHtmlOverlayId(BADGE)).toBe(true)
    for (const value of [
      '',
      'badge',
      BADGE.toUpperCase(),
      `${BADGE}/..`,
      `../${BADGE}`,
      BADGE.replaceAll('-', ''),
      `${BADGE} `,
      null,
      42
    ]) {
      expect(isHtmlOverlayId(value), String(value)).toBe(false)
    }
  })

  it('names its folder, its entry page and its own in-memory session', () => {
    expect(htmlOverlayFolderName(BADGE)).toBe(`${BADGE}.overlay`)
    expect(htmlOverlayEntryUrl(BADGE)).toBe(`videorc-overlay://${BADGE}/index.html`)
    // No `persist:` prefix: nothing of the page is written to disk.
    expect(htmlOverlayPartition(BADGE)).toBe(`html-overlay:${BADGE}`)
    expect(htmlOverlayPartition(BADGE)).not.toMatch(/^persist:/)
    expect(htmlOverlayPartition(BADGE)).not.toBe(htmlOverlayPartition(OTHER))
  })
})

describe('the window an untrusted page runs in (D4)', () => {
  const preferences = htmlOverlayWebPreferences(BADGE, 0.75)

  it('is offscreen, sandboxed and isolated, with no Node anywhere', () => {
    expect(preferences).toMatchObject({
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
      devTools: false,
      navigateOnDragDrop: false,
      disableDialogs: true
    })
  })

  it('has no preload, so the page has no bridge to the app', () => {
    expect(Object.keys(preferences)).not.toContain('preload')
    expect(Object.keys(preferences)).not.toContain('additionalArguments')
  })

  it('keeps painting while hidden, in its own session, at the asked zoom', () => {
    expect(preferences.backgroundThrottling).toBe(false)
    expect(preferences.partition).toBe(htmlOverlayPartition(BADGE))
    expect(preferences.zoomFactor).toBe(0.75)
  })

  it('closes plugins, <base> and form posts, and leaves requests to the fence that counts them', () => {
    expect(HTML_OVERLAY_CONTENT_SECURITY_POLICY).toBe(
      "object-src 'none'; base-uri 'self'; form-action 'none'"
    )
    // Never a source list that lets the network in.
    expect(HTML_OVERLAY_CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/)
  })
})

describe('what an overlay may request (D5: the network is off)', () => {
  it('lets its own files, data: and its own blob: through', () => {
    for (const url of [
      `videorc-overlay://${BADGE}/index.html`,
      `videorc-overlay://${BADGE}/img/logo.png?v=2#top`,
      'data:image/png;base64,AAAA',
      `blob:videorc-overlay://${BADGE}/3f1c8e1a-9d2b-4f6a-8c11-0a1b2c3d4e5f`,
      'about:blank',
      'about:srcdoc'
    ]) {
      expect(htmlOverlayRequestVerdict(BADGE, url), url).toEqual({ allow: true })
    }
  })

  it('cancels every network request', () => {
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Inter',
      'http://example.com/pixel.gif',
      'http://127.0.0.1:8080/local',
      'http://localhost/api',
      'wss://chat.example.com/socket',
      'ws://127.0.0.1:9000',
      'ftp://example.com/file'
    ]) {
      expect(htmlOverlayRequestVerdict(BADGE, url), url).toEqual({
        allow: false,
        reason: 'network'
      })
    }
  })

  it('cancels files on disk, other overlays and every other scheme', () => {
    expect(htmlOverlayRequestVerdict(BADGE, 'file:///etc/passwd')).toEqual({
      allow: false,
      reason: 'file'
    })
    expect(htmlOverlayRequestVerdict(BADGE, `videorc-overlay://${OTHER}/index.html`)).toEqual({
      allow: false,
      reason: 'other-overlay'
    })
    // A port or a user name is not this overlay's origin.
    expect(htmlOverlayRequestVerdict(BADGE, `videorc-overlay://${BADGE}:81/index.html`)).toEqual({
      allow: false,
      reason: 'other-overlay'
    })
    expect(htmlOverlayRequestVerdict(BADGE, `videorc-overlay://x@${BADGE}/index.html`)).toEqual({
      allow: false,
      reason: 'other-overlay'
    })
    for (const url of [
      // The app's own assets (takeovers, banners, recordings) are not the page's.
      'videorc-asset://banner/secret.png',
      'videorc-asset://session-media/grant',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      `blob:videorc-overlay://${OTHER}/3f1c8e1a-9d2b-4f6a-8c11-0a1b2c3d4e5f`,
      'blob:https://example.com/3f1c8e1a-9d2b-4f6a-8c11-0a1b2c3d4e5f'
    ]) {
      expect(htmlOverlayRequestVerdict(BADGE, url), url).toEqual({ allow: false, reason: 'scheme' })
    }
    expect(htmlOverlayRequestVerdict(BADGE, 'not a url')).toEqual({
      allow: false,
      reason: 'invalid'
    })
  })

  it('navigates only between its own pages', () => {
    expect(htmlOverlayNavigationAllowed(BADGE, `videorc-overlay://${BADGE}/index.html`)).toBe(true)
    expect(htmlOverlayNavigationAllowed(BADGE, `videorc-overlay://${BADGE}/second.html`)).toBe(true)
    for (const url of [
      'https://example.com/',
      `videorc-overlay://${OTHER}/index.html`,
      'file:///Users/me/Desktop/index.html',
      'data:text/html,<p>hi</p>',
      'about:blank',
      'not a url'
    ]) {
      expect(htmlOverlayNavigationAllowed(BADGE, url), url).toBe(false)
    }
  })

  it('is refused every permission it asks for', () => {
    expect(htmlOverlayPermissionAllowed()).toBe(false)
  })
})

describe('the file a request names', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

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

  /** A Banners folder with this overlay's folder, another overlay's, and a file beside them. */
  function bannersFolder(): { banners: string; root: string } {
    const banners = mkdtempSync(join(tmpdir(), 'videorc-html-overlay-policy-'))
    directories.push(banners)
    const root = join(banners, htmlOverlayFolderName(BADGE))
    mkdirSync(join(root, 'img'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html>')
    writeFileSync(join(root, 'img', 'logo.png'), 'png')
    writeFileSync(join(root, '.hidden'), 'dot')
    mkdirSync(join(banners, htmlOverlayFolderName(OTHER)))
    writeFileSync(join(banners, htmlOverlayFolderName(OTHER), 'index.html'), 'other')
    writeFileSync(join(banners, 'sponsor.png'), 'another banner')
    return { banners, root }
  }

  const resolve = (root: string, path: string, id = BADGE): string | null =>
    resolveHtmlOverlayFile(id, root, `videorc-overlay://${BADGE}${path}`, fileSystem)

  it('finds the entry page and files in subfolders', () => {
    const { root } = bannersFolder()
    const real = realpathSync(root)
    expect(resolve(root, '/index.html')).toBe(join(real, 'index.html'))
    expect(resolve(root, '/')).toBe(join(real, 'index.html'))
    expect(resolve(root, '/img/logo.png')).toBe(join(real, 'img', 'logo.png'))
    expect(resolve(root, '/img/logo.png?v=3#x')).toBe(join(real, 'img', 'logo.png'))
  })

  it('never leaves the overlay folder', () => {
    const { root } = bannersFolder()
    for (const path of [
      '/../sponsor.png',
      '/img/../../sponsor.png',
      '/%2e%2e/sponsor.png',
      '/img/%2e%2e%2f%2e%2e%2fsponsor.png',
      `/..%2f${htmlOverlayFolderName(OTHER)}/index.html`,
      '/..\\sponsor.png',
      '/img\\..\\..\\sponsor.png',
      '//etc/passwd',
      '/C:/Windows/win.ini',
      '/.hidden',
      '/img/',
      '/missing.html',
      '/index.html%00.png',
      '/%E0%A4%A'
    ]) {
      expect(resolve(root, path), path).toBeNull()
    }
  })

  it('refuses another overlay, a folder and an id that is not one', () => {
    const { banners, root } = bannersFolder()
    expect(
      resolveHtmlOverlayFile(BADGE, root, `videorc-overlay://${OTHER}/index.html`, fileSystem)
    ).toBeNull()
    expect(resolve(root, '/img')).toBeNull()
    expect(resolve(banners, '/index.html', '../x')).toBeNull()
    expect(
      resolveHtmlOverlayFile(BADGE, root, 'https://example.com/index.html', fileSystem)
    ).toBeNull()
    // A folder that is not there resolves nothing.
    expect(resolve(join(banners, 'gone.overlay'), '/index.html')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a link, even one inside the folder', () => {
    const { banners, root } = bannersFolder()
    symlinkSync(join(banners, 'sponsor.png'), join(root, 'link.png'))
    symlinkSync(join(root, 'index.html'), join(root, 'inner-link.html'))
    symlinkSync(banners, join(root, 'up'))
    expect(resolve(root, '/link.png')).toBeNull()
    expect(resolve(root, '/inner-link.html')).toBeNull()
    expect(resolve(root, '/up/sponsor.png')).toBeNull()
  })

  it('serves a file as what its extension says, and anything else as bytes', () => {
    expect(htmlOverlayContentType('/a/index.html')).toBe('text/html; charset=utf-8')
    expect(htmlOverlayContentType('/a/STYLE.CSS')).toBe('text/css; charset=utf-8')
    expect(htmlOverlayContentType('/a/app.mjs')).toBe('text/javascript; charset=utf-8')
    expect(htmlOverlayContentType('/a/font.woff2')).toBe('font/woff2')
    expect(htmlOverlayContentType('/a/logo.svg')).toBe('image/svg+xml')
    expect(htmlOverlayContentType('/a/tool.exe')).toBe('application/octet-stream')
    expect(htmlOverlayContentType('/a/noextension')).toBe('application/octet-stream')
  })
})

describe('the window for a target', () => {
  const badge = { pageWidth: 640, pageHeight: 360, frameWidth: 480, frameHeight: 270 }

  it('paints the asked frame while the page still sees its own size', () => {
    // Retina: 240 x 135 DIP paints 480 x 270 px; 240 / 0.375 is a 640 px viewport.
    expect(htmlOverlayWindowGeometry(badge, 2)).toEqual({
      contentWidth: 240,
      contentHeight: 135,
      zoomFactor: 0.375,
      frameWidth: 480,
      frameHeight: 270
    })
    // A 1x display: the window is the frame.
    expect(htmlOverlayWindowGeometry(badge, 1)).toEqual({
      contentWidth: 480,
      contentHeight: 270,
      zoomFactor: 0.75,
      frameWidth: 480,
      frameHeight: 270
    })
  })

  it('keeps the page viewport at every scale and size', () => {
    for (const scale of [1, 1.5, 2, 3]) {
      for (const target of [
        badge,
        { pageWidth: 1920, pageHeight: 1080, frameWidth: 1920, frameHeight: 1080 },
        { pageWidth: 1920, pageHeight: 1080, frameWidth: 864, frameHeight: 486 },
        { pageWidth: 600, pageHeight: 200, frameWidth: 1152, frameHeight: 384 }
      ]) {
        const geometry = htmlOverlayWindowGeometry(target, scale)
        // The CSS viewport is the content size over the zoom: the page size, within a pixel.
        expect(
          Math.abs(geometry.contentWidth / geometry.zoomFactor - target.pageWidth),
          JSON.stringify({ scale, target })
        ).toBeLessThanOrEqual(1 / geometry.zoomFactor)
        expect(geometry.frameWidth).toBe(Math.round(geometry.contentWidth * scale))
        expect(geometry.frameWidth * geometry.frameHeight).toBeLessThanOrEqual(
          HTML_OVERLAY_MAX_FRAME_PIXELS
        )
        // Never smaller than asked (the compositor scales down, never up, a
        // pixel or two at most), unless the cap or the zoom range stops it.
        expect(geometry.frameWidth).toBeGreaterThanOrEqual(
          Math.min(target.frameWidth, geometry.frameWidth)
        )
      }
    }
  })

  it("clamps the zoom to Chromium's range and lets the compositor scale the rest", () => {
    // A full 4K page drawn tiny: the page cannot be zoomed below a quarter.
    const tiny = htmlOverlayWindowGeometry(
      { pageWidth: 1920, pageHeight: 1080, frameWidth: 96, frameHeight: 54 },
      1
    )
    expect(tiny.zoomFactor).toBe(HTML_OVERLAY_ZOOM_MIN)
    expect([tiny.frameWidth, tiny.frameHeight]).toEqual([480, 270])
    // A tiny page drawn huge: not above five.
    const huge = htmlOverlayWindowGeometry(
      { pageWidth: 64, pageHeight: 64, frameWidth: 1000, frameHeight: 1000 },
      1
    )
    expect(huge.zoomFactor).toBe(HTML_OVERLAY_ZOOM_MAX)
    expect([huge.frameWidth, huge.frameHeight]).toEqual([320, 320])
  })

  it('never asks for a frame over the cap', () => {
    // The largest page at the smallest zoom on a 3x display would be 2880 x 1620.
    const geometry = htmlOverlayWindowGeometry(
      { pageWidth: 3840, pageHeight: 2160, frameWidth: 384, frameHeight: 216 },
      3
    )
    expect(geometry.frameWidth * geometry.frameHeight).toBeLessThanOrEqual(
      HTML_OVERLAY_MAX_FRAME_PIXELS
    )
  })

  it('reads a paint on a fractional display scale (Windows 125 %, 150 %; Wayland 1.25)', () => {
    // Plan 232 S11: Chromium rounds each side on its own, up or down.
    // 341 x 191 DIP at 1.25 is 426.25 x 238.75: a 427 x 239 bitmap.
    expect(htmlOverlayBitmapSize({ width: 341, height: 191 }, 427 * 239 * 4)).toEqual({
      width: 427,
      height: 239
    })
    // ... or a 426 x 238 one.
    expect(htmlOverlayBitmapSize({ width: 341, height: 191 }, 426 * 238 * 4)).toEqual({
      width: 426,
      height: 238
    })
    // One side rounded up and the other down.
    expect(htmlOverlayBitmapSize({ width: 341, height: 191 }, 427 * 238 * 4)).toEqual({
      width: 427,
      height: 238
    })
    // 150 %: 333 x 187 DIP is 499.5 x 280.5.
    expect(htmlOverlayBitmapSize({ width: 333, height: 187 }, 500 * 281 * 4)).toEqual({
      width: 500,
      height: 281
    })
    // The window geometry at those scales asks for frames those paints match.
    for (const scale of [1.25, 1.5, 1.75]) {
      const geometry = htmlOverlayWindowGeometry(
        { pageWidth: 640, pageHeight: 360, frameWidth: 960, frameHeight: 540 },
        scale
      )
      expect(
        htmlOverlayBitmapSize(
          { width: geometry.contentWidth, height: geometry.contentHeight },
          geometry.frameWidth * geometry.frameHeight * 4
        ),
        String(scale)
      ).toEqual({ width: geometry.frameWidth, height: geometry.frameHeight })
    }
  })

  it('treats a display scale it cannot use as 1', () => {
    for (const scale of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(htmlOverlayWindowGeometry(badge, scale), String(scale)).toEqual(
        htmlOverlayWindowGeometry(badge, 1)
      )
    }
  })

  it('reads the pixel size of a paint from its bytes', () => {
    // The image reports pixels.
    expect(htmlOverlayBitmapSize({ width: 480, height: 270 }, 480 * 270 * 4)).toEqual({
      width: 480,
      height: 270
    })
    // The image reports DIP and carries a 2x bitmap.
    expect(htmlOverlayBitmapSize({ width: 240, height: 135 }, 480 * 270 * 4)).toEqual({
      width: 480,
      height: 270
    })
    // Not the same picture.
    expect(htmlOverlayBitmapSize({ width: 240, height: 135 }, 12345)).toBeNull()
    expect(htmlOverlayBitmapSize({ width: 240, height: 135 }, 480 * 271 * 4 + 1)).toBeNull()
    expect(htmlOverlayBitmapSize({ width: 0, height: 135 }, 0)).toBeNull()
  })
})

describe('when a painted frame is sent (D7)', () => {
  const frame = {
    width: 480,
    height: 270,
    nowMs: 1000,
    lastSentMs: null as number | null,
    fps: 30,
    uploadBusy: false
  }

  it('paints at the target rate, never above 30', () => {
    expect(htmlOverlayFrameRate(30)).toBe(30)
    expect(htmlOverlayFrameRate(60)).toBe(30)
    expect(htmlOverlayFrameRate(24)).toBe(24)
    expect(htmlOverlayFrameRate(0)).toBe(1)
    expect(htmlOverlayFrameRate(Number.NaN)).toBe(30)
  })

  it('sends the first frame and frames a frame apart', () => {
    expect(htmlOverlayFrameDecision(frame)).toBe('send')
    expect(htmlOverlayFrameDecision({ ...frame, lastSentMs: 1000 - 33.4 })).toBe('send')
    // A timer that fires a little early is still the next frame.
    expect(htmlOverlayFrameDecision({ ...frame, lastSentMs: 1000 - 26 })).toBe('send')
  })

  it('drops a frame painted sooner than the rate allows', () => {
    expect(htmlOverlayFrameDecision({ ...frame, lastSentMs: 1000 - 10 })).toBe('drop-early')
    // At 15 fps a frame 40 ms after the last is early; at 30 it is not.
    expect(htmlOverlayFrameDecision({ ...frame, fps: 15, lastSentMs: 1000 - 40 })).toBe(
      'drop-early'
    )
    expect(htmlOverlayFrameDecision({ ...frame, fps: 30, lastSentMs: 1000 - 40 })).toBe('send')
  })

  it('drops a frame while the upload still holds the last one: latest wins', () => {
    expect(htmlOverlayFrameDecision({ ...frame, uploadBusy: true })).toBe('drop-busy')
    expect(htmlOverlayFrameDecision({ ...frame, uploadBusy: true, lastSentMs: 0 })).toBe(
      'drop-busy'
    )
  })

  it('never sends a frame over the cap', () => {
    expect(htmlOverlayFrameDecision({ ...frame, width: 1920, height: 1080 })).toBe('send')
    expect(htmlOverlayFrameDecision({ ...frame, width: 1922, height: 1080 })).toBe('drop-oversize')
    expect(
      htmlOverlayFrameDecision({ ...frame, width: 3840, height: 2160, uploadBusy: true })
    ).toBe('drop-oversize')
  })
})

describe('Import HTML… on every platform (plan 232 S11)', () => {
  it('asks file or folder first off macOS, where one dialog cannot take both', () => {
    expect(htmlOverlayPickNeedsChoice('darwin')).toBe(false)
    expect(htmlOverlayPickNeedsChoice('win32')).toBe(true)
    expect(htmlOverlayPickNeedsChoice('linux')).toBe(true)
  })

  it('opens the dialog each choice needs', () => {
    expect(htmlOverlayPickDialog('file-or-folder').properties).toEqual([
      'openFile',
      'openDirectory'
    ])
    const file = htmlOverlayPickDialog('file')
    expect(file.properties).toEqual(['openFile'])
    expect(file.filters).toEqual([{ name: 'HTML', extensions: ['html', 'htm'] }])
    const folder = htmlOverlayPickDialog('folder')
    expect(folder.properties).toEqual(['openDirectory'])
    expect(folder.filters).toBeUndefined()
  })

  it('offers a folder first, then a file, and cancels last', () => {
    expect(HTML_OVERLAY_PICK_CHOICES.map((choice) => choice.kind)).toEqual(['folder', 'file', null])
    expect(HTML_OVERLAY_PICK_CHOICES.at(-1)?.label).toBe('Cancel')
  })
})

describe('a page that never paints (plan 232 S11)', () => {
  it('says so plainly, and on Wayland names the way out', () => {
    for (const input of [
      { platform: 'darwin' as const, ozonePlatform: '' },
      { platform: 'win32' as const, ozonePlatform: '' },
      { platform: 'linux' as const, ozonePlatform: 'x11' },
      { platform: 'linux' as const, ozonePlatform: '' }
    ]) {
      expect(htmlOverlayNoPictureDetail(input), JSON.stringify(input)).toBe(
        'the page loaded but drew no picture'
      )
    }
    const wayland = htmlOverlayNoPictureDetail({ platform: 'linux', ozonePlatform: ' Wayland ' })
    expect(wayland).toContain('the page loaded but drew no picture')
    expect(wayland).toContain('Wayland session')
    expect(wayland).toContain('--ozone-platform=x11')
  })
})
