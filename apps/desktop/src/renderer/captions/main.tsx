import React, { useEffect, useState, type ReactElement } from 'react'
import ReactDOM from 'react-dom/client'

import { CaptionsReader } from '@/components/captions-reader'
import { AppErrorBoundary } from '@/components/error-boundary'
import type { CaptionWindowSnapshot } from '@/lib/backend'
import '@/styles.css'

// Long-lived second window: drop React's dev perf-track measures, which buffer
// outside the V8 heap and leak over time (see videorc-react-dev-perf-track-leak).
if (import.meta.env.DEV && localStorage.getItem('videorc.reactPerfTrack') !== '1') {
  const nativeMeasure = performance.measure.bind(performance)
  performance.measure = (
    name: string,
    startOrOptions?: string | PerformanceMeasureOptions,
    endMark?: string
  ): PerformanceMeasure => {
    const detail =
      typeof startOrOptions === 'object' && startOrOptions !== null ? startOrOptions.detail : null
    if (detail && typeof detail === 'object' && 'devtools' in detail) {
      return undefined as unknown as PerformanceMeasure
    }
    return nativeMeasure(name, startOrOptions, endMark)
  }
}

// The window's data comes from the main renderer through the main-process
// relay: seed from the cached caption lines, then follow live pushes.
function CaptionsWindowApp(): ReactElement {
  const [snapshot, setSnapshot] = useState<CaptionWindowSnapshot>({
    lines: [],
    status: { state: 'idle' },
    styleId: 'classic',
    position: 'bottom',
    textSize: 'm'
  })
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  useEffect(() => {
    void window.videorc
      ?.getCaptionSnapshot?.()
      .then((initial) => initial && setSnapshot(initial))
      .catch(() => {})
    void window.videorc
      ?.getCaptionsWindowState?.()
      .then((state) => state && setAlwaysOnTop(state.alwaysOnTop))
      .catch(() => {})
    const offSnapshot = window.videorc?.onCaptionSnapshot?.((next) => setSnapshot(next))
    const offState = window.videorc?.onCaptionsWindowState?.((state) =>
      setAlwaysOnTop(state.alwaysOnTop)
    )
    return () => {
      offSnapshot?.()
      offState?.()
    }
  }, [])
  return (
    <CaptionsReader
      lines={snapshot.lines}
      position={snapshot.position}
      status={snapshot.status}
      styleId={snapshot.styleId}
      textSize={snapshot.textSize}
      alwaysOnTop={alwaysOnTop}
      onToggleAlwaysOnTop={() => void window.videorc?.setCaptionsWindowAlwaysOnTop?.(!alwaysOnTop)}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <CaptionsWindowApp />
    </AppErrorBoundary>
  </React.StrictMode>
)
