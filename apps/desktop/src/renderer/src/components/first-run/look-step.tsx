import type { ReactElement } from 'react'

import { LookPicture } from '@/components/first-run/look-picture'
import {
  FirstRunNextButton,
  FirstRunStepLayout,
  useFirstRunStepFrame
} from '@/components/first-run/setup-step-frame'
import { MediaCard } from '@/components/media-card'
import { SectionLabel } from '@/components/section-label'
import { SceneCard, SceneGalleryReason } from '@/components/studio/scene-card'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useFirstRunLook } from '@/hooks/use-first-run-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { CameraShape } from '@/lib/backend'
import { liveBackgroundSettings } from '@/lib/background-assets'
import type { LayoutOrientation } from '@/lib/capture'
import {
  LIVE_BACKGROUND_OFFERED,
  liveBackgroundEntry,
  liveBackgroundThumbnail
} from '@/lib/live-backgrounds'
import { cn } from '@/lib/utils'
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

/**
 * One background choice: its thumbnail on a media card, the selected one with
 * the brighter rim. The name is the button's name and its tooltip; the chosen
 * background's name is also written under the tiles.
 */
function BackgroundTile({
  id,
  label,
  src,
  selected,
  disabled,
  onSelect
}: {
  id: string
  label: string
  src: string | null
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): ReactElement {
  return (
    <MediaCard
      className={cn(disabled && 'opacity-50')}
      data-first-run-look-background-option={id}
      interactive={!selected && !disabled}
      selected={selected}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={label}
              aria-pressed={selected}
              className="flex w-full rounded-row p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              disabled={disabled}
              type="button"
              onClick={onSelect}
            />
          }
        >
          {src ? (
            <img
              alt=""
              className="aspect-video w-full rounded-chip object-cover"
              draggable={false}
              src={src}
            />
          ) : (
            <span className="flex aspect-video w-full items-center justify-center rounded-chip border border-border bg-inset text-meta text-muted-foreground">
              None
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </MediaCard>
  )
}

/**
 * Step 3, "Your look" (plan 207 S5, D5 to D8), at the `xl` width (the
 * skill's media size): the scene's picture and orientation beside the
 * camera's shape and the backgrounds, then the layouts in a full-width row.
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

  // Why some layouts can't be chosen, once, under the cards (the gallery's
  // line). A missing grant is fixed on the permissions step.
  const reasons = [
    ...new Set(
      look.options.flatMap((option) => (!option.available && option.reason ? [option.reason] : []))
    )
  ]
  const grantMissing = reasons.some((reason) => reason.startsWith('Allow '))

  return (
    <FirstRunStepLayout
      description="How you'll look in recordings and livestreams. Change it any time on the Scene page."
      primary={<FirstRunNextButton />}
    >
      <div
        className="flex flex-col gap-5"
        data-first-run-look-background={look.liveBackgroundId ?? 'none'}
        data-first-run-look-layout={look.layoutPreset}
        data-first-run-look-orientation={look.orientation}
        data-first-run-look-shape={look.cameraShape}
      >
        <div className="grid gap-5 sm:grid-cols-2">
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
              <div className="grid grid-cols-4 gap-1.5">
                <BackgroundTile
                  disabled={disabled}
                  id="none"
                  label="None"
                  selected={look.liveBackgroundId === null}
                  src={null}
                  onSelect={() => look.setBackground(null)}
                />
                {LIVE_BACKGROUND_OFFERED.map((entry) => (
                  <BackgroundTile
                    key={entry.id}
                    disabled={disabled}
                    id={entry.id}
                    label={entry.name}
                    selected={look.liveBackgroundId === entry.id}
                    src={liveBackgroundThumbnail(entry.id, LIVE_BACKGROUND_DEFAULT_LOOKS[entry.id])}
                    onSelect={() => look.setBackground(entry.id)}
                  />
                ))}
              </div>
              <p className="text-meta text-muted-foreground" data-first-run-look-background-name="">
                {look.liveBackgroundId
                  ? `${liveBackgroundEntry(look.liveBackgroundId).name}, moving behind you.`
                  : 'No background: your screen and camera fill the picture.'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel>Layout</SectionLabel>
          <div
            className={cn(
              'grid gap-2',
              look.orientation === 'vertical' ? 'grid-cols-6' : 'grid-cols-4'
            )}
          >
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
          <SceneGalleryReason
            action={
              grantMissing ? (
                <Button size="xs" variant="ghost" onClick={() => frame.goTo('permissions')}>
                  Back to permissions
                </Button>
              ) : undefined
            }
            reason={reasons.length > 0 ? reasons.join(' ') : null}
          />
        </div>
      </div>
    </FirstRunStepLayout>
  )
}
