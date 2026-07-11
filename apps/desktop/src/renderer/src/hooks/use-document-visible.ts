import { useEffect, useState } from 'react'

/**
 * Tracks document visibility so always-on visuals (mic meters, visualizers)
 * can release their streams and rAF loops while the window is hidden or
 * minimized — the idle-CPU discipline the native preview's frame-polling
 * suppression follows.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const update = (): void => {
      setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return visible
}
