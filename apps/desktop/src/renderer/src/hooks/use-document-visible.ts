import { useEffect, useState } from 'react'

/**
 * Whether this window is actually on screen.
 *
 * NOT just `document.visibilityState`. The main window runs with Electron's
 * `backgroundThrottling` disabled (and, on macOS, occlusion backgrounding
 * switched off), and that option also freezes the Page Visibility API: the
 * document reports `visible` while the window is minimised or hidden, and no
 * `visibilitychange` ever fires. A hook that trusted the DOM alone was
 * therefore a constant `true` in production — fine while it only throttled
 * animation, dangerous once the microphone meter depended on it to release
 * the device.
 *
 * Main publishes the truth on `window:visible`; the DOM signal stays as the
 * fallback for contexts without the bridge (aux windows, tests), and either
 * source reporting hidden hides.
 */
export function useDocumentVisible(): boolean {
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )
  const [windowVisible, setWindowVisible] = useState(true)

  useEffect(() => {
    const update = (): void => {
      setDocumentVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', update)
    const off = window.videorc?.onWindowVisible?.((visible) => setWindowVisible(visible))
    return () => {
      document.removeEventListener('visibilitychange', update)
      off?.()
    }
  }, [])

  return documentVisible && windowVisible
}
