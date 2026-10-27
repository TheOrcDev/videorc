import type { ReactElement } from 'react'

import { LookPicture } from '@/components/first-run/look-picture'
import {
  FirstRunNextButton,
  FirstRunStepLayout,
  useFirstRunStepFrame
} from '@/components/first-run/setup-step-frame'
import { SectionLabel } from '@/components/section-label'
import { SceneCard } from '@/components/studio/scene-card'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useFirstRunLook } from '@/hooks/use-first-run-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { CameraShape } from '@/lib/backend'
import { liveBackgroundSettings } from '@/lib/background-assets'
import type { LayoutOrientation } from '@/lib/capture'
import { LIVE_BACKGROUND_OFFERED, liveBackgroundThumbnail } from '@/lib/live-backgrounds'
import { LIVE_BACKGROUND_DEFAULT_LOOKS } from '../../../../shared/live-background-ids'

const ORIENTATION_OPTIONS: { value: LayoutOrientation; label: string }[] = [
  { value: 'horizontal', label: 'Horizontal 16:9' },
  { value: 'vertical', label: 'Vertical 9:16' }
]

const SHAPE_OPTIONS: { value: CameraShape; label: string }[] = [
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'circle', label: 'Circle' }
]

/** A background tile's picture: the thumbnail, or the plain canvas for None. */
function BackgroundThumb({ src }: { src: string | null }): ReactElement {
  return src ? (
    <img
      alt=""
      className="aspect-video w-full rounded-chip object-cover"
      draggable={false}
      src={src}
    />
  ) : (
    <div className="aspect-video w-full rounded-chip border border-border bg-inset" />
  )
}

/**
 * Step 3, "Your look" (plan 207 S5, D5 to D8): the scene's picture on the
 * left, the choices on the right, at the `xl` width (the skill's media size).
 * Orientation, the layout cards (a layout without its source says why), the
 * camera's shape where the layout draws it, and None or a live background in
 * its first look. Every choice writes the Studio's own state at once (S4) and
 * the picture is the confirmation: no toast. Nothing here opens a device.
 */
export function LookStep(): ReactElement {
  const { scene, captureConfig, runtimeInfo } = useStudioCore()
  const { registry } = useBackgroundAssets()
  const frame = useFirstRunStepFrame()
  const look = useFirstRunLook()
  const { sources, video, layout } = captureConfig
  const background = look.liveBackgroundId
    ? (() => {
        const settings = liveBackgroundSettings(registry, look.liveBackgroundId)
        return {
          id: look.liveBackgroundId,
          look: settings.look,
          motion: settings.motion,
          dimPercent: settings.dimPercent
        }
      })()
    : null
  const disabled = frame.leaving

  return (
    <FirstRunStepLayout
      description="How you'll look in recordings and livestreams. Change it any time on the Scene page."
      primary={<FirstRunNextButton />}
    >
      <div
        className="grid gap-5 md:grid-cols-2"
        data-first-run-look-background={look.liveBackgroundId ?? 'none'}
        data-first-run-look-layout={look.layoutPreset}
        data-first-run-look-orientation={look.orientation}
        data-first-run-look-shape={look.cameraShape}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <LookPicture
            aspect={video.width > 0 && video.height > 0 ? video.width / video.height : 16 / 9}
            background={background}
            cameraCornerRadiusPct={layout.cameraCornerRadiusPct}
            cameraShape={look.shapeApplies ? look.cameraShape : 'rectangle'}
            hardwareAccelerationDisabled={runtimeInfo?.hardwareAccelerationDisabled}
            names={{
              camera: sources.cameraName,
              screen: sources.screenName ?? sources.windowName
            }}
            scene={scene}
          />
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Orientation</SectionLabel>
            <SegmentedControl
              aria-label="Orientation"
              disabled={disabled}
              options={ORIENTATION_OPTIONS}
              value={look.orientation}
              onValueChange={look.setOrientation}
            />
            <p className="text-meta text-muted-foreground">
              Vertical is for Shorts, Reels and TikTok.
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Layout</SectionLabel>
            <div className="grid grid-cols-3 gap-2">
              {look.options.map((option) => (
                <SceneCard
                  key={option.preset}
                  data-first-run-look-option={option.preset}
                  disabled={disabled || !option.available}
                  disabledReason={option.reason}
                  label={option.label}
                  selected={option.preset === look.layoutPreset}
                  size="sm"
                  thumb={
                    <LayoutThumb framing={layout.verticalScreenFraming} preset={option.preset} />
                  }
                  onSelect={() => look.setLayout(option.preset)}
                />
              ))}
            </div>
          </div>

          {look.shapeApplies ? (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Camera shape</SectionLabel>
              <SegmentedControl
                aria-label="Camera shape"
                disabled={disabled}
                options={SHAPE_OPTIONS}
                value={look.cameraShape}
                onValueChange={look.setShape}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <SectionLabel>Background</SectionLabel>
            <div className="grid grid-cols-4 gap-2">
              <SceneCard
                data-first-run-look-background-option="none"
                disabled={disabled}
                label="None"
                selected={look.liveBackgroundId === null}
                size="sm"
                thumb={<BackgroundThumb src={null} />}
                onSelect={() => look.setBackground(null)}
              />
              {LIVE_BACKGROUND_OFFERED.map((entry) => (
                <SceneCard
                  key={entry.id}
                  data-first-run-look-background-option={entry.id}
                  disabled={disabled}
                  label={entry.name}
                  selected={look.liveBackgroundId === entry.id}
                  size="sm"
                  thumb={
                    <BackgroundThumb
                      src={liveBackgroundThumbnail(
                        entry.id,
                        LIVE_BACKGROUND_DEFAULT_LOOKS[entry.id]
                      )}
                    />
                  }
                  onSelect={() => look.setBackground(entry.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </FirstRunStepLayout>
  )
}
