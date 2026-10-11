import { MobileIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SceneCard, SceneGalleryReason } from '@/components/studio/scene-card'
import {
  LayoutThumb,
  ScreenFramingControl,
  VERTICAL_SCENES
} from '@/components/studio/scenes-gallery'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import {
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  simulcastArmed,
  simulcastLegPreset
} from '@/lib/capture'
import { sceneGalleryReason, type SceneSourceGap } from '@/lib/scene-presets'

/**
 * The vertical leg of a dual-orientation stream: pick its scene, choose how
 * the screen is framed, and decide whether it follows the horizontal program.
 * Every change is saved for the next session and, while live, lands on the
 * vertical leg only (the backend never touches the horizontal program for a
 * vertical scene transaction).
 *
 * Still a SCHEMATIC, not live pixels: the thumbnails are geometry truth (the
 * same honesty rule as the scenes gallery); live vertical pixels need the
 * preview host's surface-id split, deferred with the engine plan.
 */
export function VerticalLegMonitor(): ReactElement | null {
  const { captureConfig, isSessionActive, applySimulcastLeg } = useStudioCore()
  if (!simulcastArmed(captureConfig)) {
    return null
  }
  const hasCamera = Boolean(captureConfig.sources.cameraId)
  const hasScreen = Boolean(captureConfig.sources.screenId ?? captureConfig.sources.windowId)
  const streamingPreset = simulcastLegPreset(captureConfig)
  // Follow is steering the leg right now: the program's scene has a vertical
  // twin that differs from the scene the owner picked here.
  const followed =
    captureConfig.simulcastFollowsProgram && streamingPreset !== captureConfig.lastVerticalPreset
  const framing = captureConfig.simulcastScreenFraming
  // What each vertical scene needs that isn't chosen, said once under the
  // gallery (plan 174 S3.3, B-20), as the Scenes gallery does.
  const cards = VERTICAL_SCENES.map((scene) => {
    const gaps: SceneSourceGap[] = []
    if (layoutPresetNeedsCamera(scene.id) && !hasCamera)
      gaps.push({ source: 'camera', state: 'off' })
    if (layoutPresetNeedsScreen(scene.id) && !hasScreen)
      gaps.push({ source: 'screen', state: 'off' })
    return { scene, gaps }
  })
  const reason = sceneGalleryReason(cards.map(({ scene, gaps }) => ({ label: scene.label, gaps })))

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
          ? 'Changes here go live on the vertical stream only. Your horizontal stream is not touched.'
          : 'Goes live beside your horizontal stream when you start.'
      }
      icon={MobileIcon}
      title="Vertical stream"
    >
      <div
        className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(84px,1fr))]"
        data-slot="vertical-leg-scenes"
      >
        {cards.map(({ scene, gaps }) => {
          const streaming = streamingPreset === scene.id
          return (
            <SceneCard
              key={scene.id}
              data-scene-preset={scene.id}
              disabled={gaps.length > 0}
              label={scene.label}
              // The scene picked here, even while Follow streams its twin.
              pressed={captureConfig.lastVerticalPreset === scene.id}
              selected={streaming}
              size="sm"
              thumb={<LayoutThumb framing={framing} preset={scene.id} />}
              onSelect={() => applySimulcastLeg({ lastVerticalPreset: scene.id })}
            />
          )
        })}
      </div>
      <SceneGalleryReason reason={reason} />

      <ScreenFramingControl
        value={framing}
        onChange={(simulcastScreenFraming) => applySimulcastLeg({ simulcastScreenFraming })}
      />

      <div className="flex items-center justify-between gap-3" data-slot="vertical-leg-follow">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label className="text-sm font-medium" htmlFor="vertical-leg-follow">
            Follow horizontal scene
          </label>
          <span className="text-xs text-muted-foreground">
            {followed
              ? 'Following now: your horizontal scene has a vertical twin, so that is what streams.'
              : 'Camera only and Screen only switch the vertical stream to the matching scene.'}
          </span>
        </div>
        {/* A boolean is a Switch, not an On/Off button pair (plan 174 S1.7, B-29). */}
        <Switch
          checked={captureConfig.simulcastFollowsProgram}
          id="vertical-leg-follow"
          onCheckedChange={(simulcastFollowsProgram) =>
            applySimulcastLeg({ simulcastFollowsProgram })
          }
        />
      </div>
    </PanelSection>
  )
}
