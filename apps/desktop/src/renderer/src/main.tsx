import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import { AppErrorBoundary } from './components/app-error-boundary'
import './styles.css'

// React's dev build logs every component render onto the performance timeline
// (measure entries carrying a detail.devtools payload) and never clears them.
// That buffer is renderer-process memory OUTSIDE the V8 heap, so a long-lived
// window leaks megabytes per minute invisibly to heap snapshots. Drop those
// entries before they buffer; set localStorage videorc.reactPerfTrack = '1'
// when you actually want React's tracks in a DevTools performance recording.
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
)
