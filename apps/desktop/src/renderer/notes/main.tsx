import React from 'react'
import ReactDOM from 'react-dom/client'

import { AppErrorBoundary } from '@/components/error-boundary'
import { NotesWindow } from '@/components/notes-window'
import { WindowFrame } from '@/components/window-frame'
import '@/styles.css'

// The recording-invisibility gate paints this window loud red; the sandboxed
// renderer cannot read env, so main passes the switch in the URL (plan 050 S4).
const smokeMarker = new URLSearchParams(window.location.search).get('smokeMarker') === '1'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <WindowFrame>
        <NotesWindow smokeMarker={smokeMarker} />
      </WindowFrame>
    </AppErrorBoundary>
  </React.StrictMode>
)
