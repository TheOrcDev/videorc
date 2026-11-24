import React from 'react'
import ReactDOM from 'react-dom/client'

import { AppErrorBoundary } from '@/components/app-error-boundary'
import { NotesWindow } from '@/components/notes-window'
import { WindowFrame } from '@/components/window-frame'
import { WindowProviders } from '@/components/window-providers'
import { hydrateUiSettingsBeforeFirstRender } from '@/lib/ui-settings-window'
import '@/styles.css'

// The recording-invisibility gate paints this window loud red; the sandboxed
// renderer cannot read env, so main passes the switch in the URL (plan 050 S4).
const smokeMarker = new URLSearchParams(window.location.search).get('smokeMarker') === '1'

function render(): void {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <WindowProviders window="notes">
          <WindowFrame>
            <NotesWindow smokeMarker={smokeMarker} />
          </WindowFrame>
        </WindowProviders>
      </AppErrorBoundary>
    </React.StrictMode>
  )
}

// Plan 220 S1.4a: the UI settings store (over main's relay) is in before the
// first render; past its deadline the window renders anyway.
void hydrateUiSettingsBeforeFirstRender().then(render, render)
