import { MobileIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { VerticalStreamLayoutControl } from '@/components/studio/vertical-stream-layout-control'
import { Badge } from '@/components/ui/badge'
import { useStudioCore } from '@/hooks/use-studio'
import { simulcastArmed } from '@/lib/capture'

/**
 * The vertical leg of a dual-orientation stream. It shows the scene on
 * stream in that scene's 9:16 layout (plan 231 D4), so this panel edits that
 * layout and its Fill or Fit. Every change is saved into the scene and,
 * while live, lands on the vertical leg only (the backend never touches the
 * horizontal program for a vertical scene transaction).
 *
 * Still a SCHEMATIC, not live pixels: the thumbnails are geometry truth (the
 * same honesty rule as the scenes gallery); live vertical pixels need the
 * preview host's surface-id split, deferred with the engine plan.
 */
export function VerticalLegMonitor(): ReactElement | null {
  const { captureConfig, isSessionActive } = useStudioCore()
  if (!simulcastArmed(captureConfig)) {
    return null
  }
  return (
    <PanelSection
      action={
        isSessionActive ? (
          <Badge variant="live">On air</Badge>
        ) : (
          <Badge variant="outline">Ready</Badge>
        )
      }
      description={
        isSessionActive
          ? "Changes here go live on the vertical stream only. Your horizontal stream isn't touched."
          : 'Goes live beside your horizontal stream when you start.'
      }
      icon={MobileIcon}
      title="Vertical stream"
    >
      <VerticalStreamLayoutControl />
    </PanelSection>
  )
}
