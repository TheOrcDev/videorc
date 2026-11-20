import React, { useEffect, useState, type ReactElement } from 'react'
import ReactDOM from 'react-dom/client'

import { SceneHudChip } from '@/components/scene-hud-chip'
import { HIDDEN_SCENE_HUD, SceneHudTimeline, type SceneHudView } from '@/lib/scene-hud-timeline'
import type { SceneHudPresentation } from '../../shared/scene-hud'
import '@/styles.css'

// The key HUD's window (plan 231 D20): click-through and transparent, so the
// page paints nothing but the chip. Main sends each switch; the window keeps
// its own clock, so a second switch replaces the chip and starts it again.
document.documentElement.classList.add('bg-transparent')
document.body.classList.add('bg-transparent', 'overflow-hidden')

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function SceneHudWindow(): ReactElement | null {
  const [view, setView] = useState<SceneHudView<SceneHudPresentation>>(HIDDEN_SCENE_HUD)
  useEffect(() => {
    const timeline = new SceneHudTimeline<SceneHudPresentation>(setView)
    const off = window.videorc?.onSceneHudPresent?.((presentation) =>
      timeline.present(presentation, {
        reducedMotion: reducedMotion.matches,
        holdMs: presentation.holdMs
      })
    )
    return () => {
      off?.()
      timeline.dispose()
    }
  }, [])
  if (!view.item) return null
  return (
    // Room for the popup tier's drop on every side, centred at the top.
    <div className="flex justify-center px-12 pt-3">
      <SceneHudChip fadeMs={view.fadeMs} phase={view.phase} presentation={view.item} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SceneHudWindow />
  </React.StrictMode>
)
