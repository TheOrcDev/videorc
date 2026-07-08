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
 * denied), a SOLID theme base takes its place — the transparent window must
 * never show other apps' windows through the coat (plan 021 F4).
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
    // No wallpaper (Automation denied, or the fetch hasn't landed yet): the
    // window itself is transparent, so rendering NOTHING let other apps'
    // windows bleed through the translucent coat — ghost browser text inside
    // panels on a fresh machine (external tester, 2026-07-06). The degraded
    // glass is a solid theme base, never see-through to whatever is behind.
    return (
      <div
        aria-hidden
        className="fixed inset-0 -z-10"
        data-glass-underlay-fallback
        style={{ background: 'var(--glass-fallback-base)' }}
      />
    )
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
          // Theme-driven (styles.css): dark mode DIMS the wallpaper into dark
          // smoke so the black glass reads black over ANY wallpaper — the
          // translucent coat alone can't do that (a bright wallpaper dominates
          // the mix). Light mode keeps the airy frost.
          filter: 'var(--glass-underlay-filter, blur(70px) saturate(1.4))',
          // Near-opaque: the window is transparent and backdrop blur cannot
          // see behind it, so whatever this lets through is UNBLURRED. The
          // token is a privacy dial — low values made text behind the app
          // readable through the glass (leak on screen-share/recordings).
          opacity: 'var(--glass-underlay-opacity, 1)'
        }}
      />
      <div className="absolute inset-0 bg-background" />
    </div>
  )
}
