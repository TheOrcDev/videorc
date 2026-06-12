import { useEffect, useState, type ReactElement } from 'react'

import type { GlassWallpaperState } from '@/lib/backend'

type GlassGeometry = Pick<GlassWallpaperState, 'window' | 'display'>

/**
 * The glassmorphism frost. Real window-backdrop blur is unreachable here
 * (Electron's vibrancy material renders opaque on current macOS, and CSS
 * backdrop-filter cannot see behind the window), so this renders the user's
 * actual wallpaper — blurred hard — as the app's own bottom layer, offset so
 * it stays pixel-aligned with where the window sits on the display. The
 * theme's translucent background coat then tints it exactly like the
 * reference glass. When no wallpaper is available (Automation permission
 * denied), rendering nothing leaves the plain translucent glass.
 */
export function GlassWallpaperUnderlay(): ReactElement | null {
  const [image, setImage] = useState<string | null>(null)
  const [geometry, setGeometry] = useState<GlassGeometry | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.videorc?.getGlassWallpaper?.().then((state) => {
      if (state && !cancelled) {
        setImage(state.imageDataUrl)
        setGeometry({ window: state.window, display: state.display })
      }
    })
    const offWallpaper = window.videorc?.onGlassWallpaper?.((state) => {
      setImage(state.imageDataUrl)
      setGeometry({ window: state.window, display: state.display })
    })
    const offGeometry = window.videorc?.onGlassGeometry?.(setGeometry)
    return () => {
      cancelled = true
      offWallpaper?.()
      offGeometry?.()
    }
  }, [])

  if (!image || !geometry) {
    return null
  }

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden" data-glass-underlay>
      <img
        alt=""
        src={image}
        style={{
          position: 'absolute',
          left: geometry.display.x - geometry.window.x,
          top: geometry.display.y - geometry.window.y,
          width: geometry.display.width,
          height: geometry.display.height,
          maxWidth: 'none',
          objectFit: 'cover',
          // The overscan hides the blur's faded edges when the window sits
          // near the display border.
          transform: 'scale(1.15)',
          filter: 'blur(70px) saturate(1.4)'
        }}
      />
      <div className="absolute inset-0 bg-background" />
    </div>
  )
}
