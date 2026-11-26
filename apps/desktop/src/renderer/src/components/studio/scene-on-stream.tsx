import { type ReactElement, type ReactNode } from 'react'

import { SectionLabel } from '@/components/section-label'
import { SourcePermissionAlerts } from '@/components/sources/source-permission-alerts'
import { ScreenFramingControl } from '@/components/studio/scenes-gallery'
import {
  ScreenHiddenChip,
  useScreenPrivacyControl,
  type ScreenPrivacyControl
} from '@/components/studio/screen-privacy-control'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import {
  LayoutChoice,
  VerticalStreamLayoutControl
} from '@/components/studio/vertical-stream-layout-control'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset, VerticalScreenFraming } from '@/lib/backend'
import {
  hasSelectedCameraSource,
  hasSelectedScreenSource,
  layoutPresetOrientation,
  simulcastArmed,
  sourceStandIn
} from '@/lib/capture'
import { layoutPresetLabel } from '@/lib/layout-labels'
import {
  landscapeFramingShows,
  layoutAsksForScreen,
  sceneLayoutCameraLine,
  sceneLayoutChoices,
  screenFieldWords
} from '@/lib/scene-section'
import { SCREEN_HIDDEN_LABEL, screenPrivacyActionLabel } from '@/lib/screen-privacy-view'
import { standInLine } from '@/lib/source-status'

// Plan 231 D8: under the cards, the scene on stream's own fields. This is
// the answer to "the relation between screen and scene": the Screen the
// scene shows (with Change screen… and Hide screen, which moved here from
// Studio's Sources rows), its Layout for the studio's mode, Fill or Fit, and
// with a vertical stream armed its 9:16 layout. Every edit saves into the
// scene on stream (D11). Part of the lazy Scenes chunk.

/**
 * The scene on stream's fields, under Studio's scene cards. `onChangeScreen`
 * opens Change screen… for the scene on stream; with `forLayout` it is D19:
 * a layout that draws a screen, chosen on a scene that shows none, asks for
 * the screen first, and Cancel keeps the old layout.
 */
export function SceneOnStreamFields({
  changeScreenReason = null,
  onChangeScreen
}: {
  /** Why Change screen… can't change the scene on stream now, or null. */
  changeScreenReason?: string | null
  onChangeScreen: (options?: { forLayout?: LayoutPreset }) => void
}): ReactElement | null {
  const studio = useStudioCore()
  const { sceneOnStream, captureConfig, applyCameraPreset, deviceList } = studio
  const privacy = useScreenPrivacyControl()
  const { sources } = captureConfig
  const standIn = sourceStandIn(sources, 'capture', deviceList.devices)

  if (!sceneOnStream) return null
  const layout = captureConfig.layout
  const orientation = layoutPresetOrientation(layout.layoutPreset)
  const freeform = layout.arrangementMode === 'freeform'
  const { words, note } = screenFieldWords(sceneOnStream.shows, layout)
  const hasCamera = hasSelectedCameraSource(sources)
  const hasScreen = hasSelectedScreenSource(sources)
  const choices = sceneLayoutChoices(orientation, hasCamera)
  const cameraLine = sceneLayoutCameraLine(choices)
  const layoutName = freeform ? 'Freeform' : layoutPresetLabel(layout.layoutPreset)
  const chooseLayout = (preset: LayoutPreset): void => {
    if (layoutAsksForScreen(sceneOnStream.shows, preset)) {
      onChangeScreen({ forLayout: preset })
      return
    }
    applyCameraPreset({ layoutPreset: preset })
  }
  const framing =
    orientation === 'vertical'
      ? {
          orientation: 'vertical' as const,
          value: layout.verticalScreenFraming,
          onChange: (verticalScreenFraming: VerticalScreenFraming) =>
            applyCameraPreset({ verticalScreenFraming })
        }
      : hasScreen && landscapeFramingShows(layout)
        ? {
            orientation: 'horizontal' as const,
            value: layout.horizontalScreenFraming,
            onChange: (horizontalScreenFraming: VerticalScreenFraming) =>
              applyCameraPreset({ horizontalScreenFraming })
          }
        : null
  // D8: with a vertical stream armed beside a 16:9 studio, the scene's 9:16 layout too.
  const verticalStream = orientation === 'horizontal' && simulcastArmed(captureConfig)
  const changeScreenButton = (
    <Button
      data-testid="scene-change-screen"
      disabled={changeScreenReason !== null}
      variant="outline"
      onClick={() => onChangeScreen()}
    >
      Change screen…
    </Button>
  )

  return (
    // A nested section under the cards (the design skill's rhythm): a
    // hairline, 16 px, the heading, then the fields.
    <div
      className="@container/scene-fields mt-1 flex flex-col gap-3 border-t border-border pt-4"
      data-scene-on-stream={sceneOnStream.id}
      data-slot="scene-on-stream"
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3
          className="flex min-w-0 items-baseline gap-1 text-section text-foreground"
          data-slot="scene-on-stream-name"
        >
          <span className="shrink-0 text-muted-foreground">On stream:</span>{' '}
          <span className="min-w-0 truncate">{sceneOnStream.name}</span>
        </h3>
        <p className="text-meta text-muted-foreground">Changes here save into this scene.</p>
      </header>
      <SceneField
        // The words say what the scene shows; the buttons say what they do.
        control={
          <>
            <HideScreenButton control={privacy} />
            {changeScreenReason ? (
              <DisabledReason reason={changeScreenReason}>{changeScreenButton}</DisabledReason>
            ) : (
              changeScreenButton
            )}
          </>
        }
        field="screen"
        description={words}
        label="Screen"
        // While it holds, the chip says so beside the field's name; nothing toasts.
        status={
          privacy.hidden || privacy.statusLabel ? (
            <ScreenHiddenChip
              detail={privacy.observationDetail}
              value={privacy.statusLabel ?? SCREEN_HIDDEN_LABEL}
            />
          ) : null
        }
        note={note}
      >
        <div className="text-xs text-muted-foreground empty:hidden">
          <SourceSwitchStatus kind="capture" />
        </div>
        {standIn ? (
          <p className="text-xs text-muted-foreground" data-slot="source-stand-in">
            {standInLine(standIn)}
          </p>
        ) : null}
        <SourcePermissionAlerts className="px-0 pt-0" only="screen-recording" />
      </SceneField>
      <SceneField
        control={
          // One Select in both orientations (and for the Vertical stream):
          // each layout's diagram and name, the chosen one in the trigger.
          <Select
            items={choices}
            value={freeform ? null : layout.layoutPreset}
            onValueChange={(preset) => {
              if (preset && (freeform || preset !== layout.layoutPreset)) chooseLayout(preset)
            }}
          >
            <SelectTrigger
              aria-label="Layout"
              className="w-48 shrink-0"
              data-videorc-scene-layout={layout.layoutPreset}
            >
              <SelectValue>
                {freeform ? (
                  layoutName
                ) : (
                  <LayoutChoice
                    framing={layout.verticalScreenFraming}
                    inTrigger
                    label={layoutName}
                    preset={layout.layoutPreset}
                  />
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((choice) => (
                  <SelectItem
                    key={choice.value}
                    data-scene-layout={choice.value}
                    disabled={choice.disabled && choice.value !== layout.layoutPreset}
                    value={choice.value}
                  >
                    <LayoutChoice
                      framing={layout.verticalScreenFraming}
                      label={choice.label}
                      preset={choice.value}
                    />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        }
        field="layout"
        description={`Each scene keeps its own ${orientation === 'vertical' ? '9:16' : '16:9'} layout.`}
        label="Layout"
      >
        {cameraLine ? <p className="text-xs text-muted-foreground">{cameraLine}</p> : null}
      </SceneField>
      {framing ? (
        <ScreenFramingControl
          label="Framing"
          orientation={framing.orientation}
          value={framing.value}
          onChange={framing.onChange}
        />
      ) : null}
      {verticalStream ? (
        <div className="mt-1 flex flex-col gap-3 border-t border-border pt-4">
          <SectionLabel>Vertical stream</SectionLabel>
          <VerticalStreamLayoutControl framingLabel="Framing" />
        </div>
      ) : null}
    </div>
  )
}

/** One field: its name and value on the left, its control on the right, its lines under them. */
function SceneField({
  field,
  label,
  status,
  description,
  note,
  control,
  children
}: {
  /** Its hook for tests and probes: `data-slot="scene-{field}-field"`. */
  field: 'screen' | 'layout'
  label: string
  /** A status chip beside the name ("Screen hidden"). */
  status?: ReactNode
  description: ReactNode
  /** A second line under the value ("Not shown in Camera only"). */
  note?: string | null
  control: ReactNode
  children?: ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col gap-2" data-slot={`scene-${field}-field`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{label}</span>
            {status}
          </span>
          <span className="line-clamp-2 text-xs break-words text-muted-foreground">
            {description}
          </span>
          {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {children}
    </div>
  )
}

/**
 * Hide screen beside Change screen…, on the Screen field's row (plan 210 D9;
 * plan 231 D8 moved it here from Studio's Screen row): never beside Record
 * and Go Live (owner, 2026-10-12). It reads Show screen in the same place
 * while hidden. Its key rides inside it while the row has room, as the
 * Preview's buttons carry theirs, and always in its tooltip. It shows with or
 * without a screen in the scene, because hiding is allowed either way. No
 * toast: the chip and the Preview say it.
 */
export function HideScreenButton({ control }: { control: ScreenPrivacyControl }): ReactElement {
  const { hidden, accelerator, platform, disabledReason, toggle } = control
  const label = screenPrivacyActionLabel(hidden)
  const button = (
    <Button
      data-videorc-screen-privacy=""
      disabled={disabledReason !== null}
      variant="outline"
      onClick={toggle}
    >
      {label}
      {accelerator ? (
        <ShortcutKeys
          accelerator={accelerator}
          className="ml-1 hidden @lg/scene-fields:inline-flex"
          platform={platform}
        />
      ) : null}
    </Button>
  )
  return (
    <span className="flex" data-hidden={hidden || undefined} data-slot="screen-privacy">
      {disabledReason ? (
        <DisabledReason reason={disabledReason}>{button}</DisabledReason>
      ) : (
        <ShortcutTooltip accelerator={accelerator} label={label} platform={platform}>
          {button}
        </ShortcutTooltip>
      )}
    </span>
  )
}
