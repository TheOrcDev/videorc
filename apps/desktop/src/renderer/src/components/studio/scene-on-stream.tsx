import { HiddenIcon } from '@/components/icons'
import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react'

import {
  LCD_LIST_GROUP,
  LCD_LIST_ITEM,
  LCD_MESSAGE,
  LCD_VALUE_BUTTON,
  LcdPanel,
  LcdPanelAction,
  LcdPanelPressRow,
  LcdPanelRow,
  LcdPanelValue,
  LcdPixelChevron,
  LcdPopupScreen,
  type StudioLook
} from '@/components/lcd-panel'
import { SectionLabel } from '@/components/section-label'
import { SourcePermissionAlerts } from '@/components/sources/source-permission-alerts'
import { StatusBadge } from '@/components/status-badge'
import { ScreenFramingControl, VERTICAL_SCENES } from '@/components/studio/scenes-gallery'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import {
  editVerticalStreamLayout,
  LayoutChoice,
  VerticalStreamLayoutControl
} from '@/components/studio/vertical-stream-layout-control'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { LcdDisplaySeparator } from '@/components/ui/lcd-display'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
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
import {
  SCREEN_HIDDEN_LABEL,
  screenHideAccelerator,
  roomPrivacyLabel,
  screenPrivacyActionLabel,
  screenPrivacyDisabledReason
} from '@/lib/screen-privacy-view'
import { standInLine } from '@/lib/source-status'
import { toastUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'

// Plan 231 D8: under the cards, the scene on stream's own fields. This is
// the answer to "the relation between screen and scene": the Screen the
// scene shows (with Change screen… and Hide screen, which moved here from
// Studio's Sources rows), its Layout for the studio's mode, Fill or Fit, and
// with a vertical stream armed its 9:16 layout. Every edit saves into the
// scene on stream (D11). Part of the lazy Scenes chunk.

/** What both looks' Hide screen controls show and do (the line and the Retro LCD's row). */
export interface ScreenPrivacyControl {
  /** Plan 249: the room's own privacy state, while it says more than Hidden. */
  statusLabel?: string
  /** Plan 249: what the room confirmed, as the chip's tooltip. */
  observationDetail?: string
  hidden: boolean
  /** The bound key, absent when the streamer cleared it. */
  accelerator?: string
  platform?: string
  /** Why the action is off (a refused hide, Videorc offline), or null. */
  disabledReason: string | null
  toggle: () => void
}

/**
 * Plan 210 S8b: the one Studio Hide screen action, by the state it shows. A
 * failure says so; a refused hide is the hook's warning, and success is silent.
 */
export function useScreenPrivacyControl(): ScreenPrivacyControl {
  const {
    screenPrivacy: privacy,
    roomScreenPrivacy,
    hideScreen,
    showScreen,
    settings,
    runtimeInfo,
    wsStatus
  } = useStudioCore()
  // Plan 249: a room's screen share hides too; it holds whichever hid it.
  const hiddenNow = privacy.hidden || roomScreenPrivacy?.hidden === true
  return {
    statusLabel: roomPrivacyLabel(roomScreenPrivacy?.status),
    observationDetail: roomScreenPrivacy?.hidden
      ? `Source blocked: ${roomScreenPrivacy.sourceBlockedAt ?? 'unavailable'}. Applied frost observations: ${Object.keys(roomScreenPrivacy.observations).join(', ') || 'none'}. Other receivers remain unconfirmed.`
      : undefined,
    hidden: hiddenNow,
    accelerator: screenHideAccelerator(settings.globalShortcuts?.screenHideToggle),
    platform: runtimeInfo?.platform,
    disabledReason: screenPrivacyDisabledReason(
      { ...privacy, hidden: hiddenNow },
      wsStatus === 'connected'
    ),
    toggle: () => {
      const hidden = hiddenNow
      void (hidden ? showScreen() : hideScreen()).catch((error: unknown) =>
        toastUserError(
          error,
          { action: hidden ? 'show' : 'hide', object: 'your screen' },
          { id: 'screen-privacy' }
        )
      )
    }
  }
}

/**
 * The scene on stream's fields, under Studio's scene cards. `onChangeScreen`
 * opens Change screen… for the scene on stream; with `forLayout` it is D19:
 * a layout that draws a screen, chosen on a scene that shows none, asks for
 * the screen first, and Cancel keeps the old layout.
 */
export function SceneOnStreamFields({
  look = 'default',
  changeScreenReason = null,
  onChangeScreen
}: {
  look?: StudioLook
  /** Why Change screen… can't change the scene on stream now, or null. */
  changeScreenReason?: string | null
  onChangeScreen: (options?: { forLayout?: LayoutPreset }) => void
}): ReactElement | null {
  const studio = useStudioCore()
  const { sceneOnStream, captureConfig, applyCameraPreset, sceneLibraryActions, deviceList } =
    studio
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

  if (look === 'lcd') {
    const vertical = sceneOnStream.layouts.vertical
    const verticalChoices = VERTICAL_SCENES.map((scene) => ({
      value: scene.id,
      label: scene.label,
      disabled:
        (layoutPresetNeedsCamera(scene.id) && !hasCamera) ||
        (layoutPresetNeedsScreen(scene.id) && (sceneOnStream.shows.kind === 'none' || !hasScreen))
    }))
    const readOnly = sceneLibraryActions.readOnly
    return (
      <div className="flex flex-col gap-2" data-slot="scene-on-stream">
        <LcdPanel aria-label={`On stream: ${sceneOnStream.name}`}>
          <LcdPanelRow label="On stream">
            <LcdPanelValue data-testid="scene-on-stream-name">{sceneOnStream.name}</LcdPanelValue>
          </LcdPanelRow>
          <LcdDisplaySeparator />
          <LcdPanelRow label="Screen">
            <LcdPanelValue>{words}</LcdPanelValue>
            <DisabledReason reason={changeScreenReason}>
              <LcdPanelAction
                disabled={changeScreenReason !== null}
                onClick={() => onChangeScreen()}
              >
                Change screen…
              </LcdPanelAction>
            </DisabledReason>
          </LcdPanelRow>
          {note ? <p className={LCD_MESSAGE}>{note}</p> : null}
          <div aria-live="polite" className={cn(LCD_MESSAGE, 'empty:sr-only')}>
            <SourceSwitchStatus kind="capture" look="lcd" />
          </div>
          {standIn ? (
            <p className={LCD_MESSAGE} data-slot="source-stand-in">
              {standInLine(standIn)}
            </p>
          ) : null}
          <RetroScreenPrivacyRow control={privacy} />
          <LcdDisplaySeparator />
          <LcdChoicePicker
            choices={choices}
            label="Layout"
            placeholder={freeform ? 'Freeform' : undefined}
            value={freeform ? undefined : layout.layoutPreset}
            onChange={chooseLayout}
          />
          {cameraLine ? <p className={LCD_MESSAGE}>{cameraLine}</p> : null}
          {framing ? (
            <LcdChoicePicker
              choices={FRAMING_CHOICES}
              label="Framing"
              value={framing.value}
              onChange={framing.onChange}
            />
          ) : null}
          {verticalStream ? (
            <>
              <LcdDisplaySeparator />
              <LcdChoicePicker
                choices={verticalChoices}
                disabled={readOnly}
                label="Vertical stream"
                value={vertical.layoutPreset}
                onChange={(layoutPreset) => void editVerticalStreamLayout(studio, { layoutPreset })}
              />
              <LcdChoicePicker
                choices={FRAMING_CHOICES}
                disabled={readOnly}
                label="Vertical framing"
                value={vertical.verticalScreenFraming}
                onChange={(verticalScreenFraming) =>
                  void editVerticalStreamLayout(studio, { verticalScreenFraming })
                }
              />
            </>
          ) : null}
        </LcdPanel>
        <SourcePermissionAlerts className="px-0 pt-0" only="screen-recording" />
      </div>
    )
  }

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

const FRAMING_CHOICES: { value: VerticalScreenFraming; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' }
]

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
 * The Screen field's privacy chip. In a room (plan 249) it can say more than
 * Hidden, and what the room confirmed is its tooltip.
 */
function ScreenHiddenChip({ value, detail }: { value: string; detail?: string }): ReactElement {
  const chip = <StatusBadge icon={HiddenIcon} tone="warn" value={value} />
  return detail ? (
    <span className="flex" title={detail}>
      {chip}
    </span>
  ) : (
    chip
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

/**
 * Hide screen on the Retro LCD's scene screen (plan 210 S8b): a row that
 * covers something, like a takeover's. Off dim, On lit while the screen is
 * hidden, and its key on hover. Only a hide is ever refused, with its reason.
 */
export function RetroScreenPrivacyRow({
  control
}: {
  control: ScreenPrivacyControl
}): ReactElement {
  const { hidden, accelerator, platform, disabledReason, toggle } = control
  const row = (
    <LcdPanelPressRow
      disabled={disabledReason !== null}
      label={control.statusLabel ?? 'Hide screen'}
      pressed={hidden}
      onPressedChange={toggle}
    />
  )
  return disabledReason ? (
    <DisabledReason className="flex flex-col" reason={disabledReason}>
      {row}
    </DisabledReason>
  ) : (
    <ShortcutTooltip
      accelerator={accelerator}
      className="flex flex-col"
      label={screenPrivacyActionLabel(hidden)}
      platform={platform}
    >
      {row}
    </ShortcutTooltip>
  )
}

/**
 * A short list of choices on an LCD screen (the layout, Fill or Fit): the
 * value lit with a pixel chevron, and its list a small screen in the opaque
 * popup, as `LcdDevicePicker` draws a device's.
 */
function LcdChoicePicker<T extends string>({
  label,
  value,
  choices,
  placeholder,
  disabled = false,
  onChange
}: {
  label: string
  value: T | undefined
  choices: readonly { value: T; label: string; disabled?: boolean }[]
  /** What the value reads while no choice is the current one (Freeform). */
  placeholder?: string
  disabled?: boolean
  onChange: (value: T) => void
}): ReactElement {
  const id = useId()
  const popupId = `${id}-popup`
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const current = choices.find((choice) => choice.value === value)
  return (
    <LcdPanelRow htmlFor={id} label={label}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          id={id}
          render={
            <button
              aria-controls={open ? popupId : undefined}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-label={label}
              className={cn(LCD_VALUE_BUTTON, 'data-popup-open:bg-(--lcd-display-ink-unlit)')}
              data-slot="lcd-choice-trigger"
              role="combobox"
              type="button"
            />
          }
        >
          <span className="min-w-0 truncate">{current?.label ?? placeholder}</span>
          <LcdPixelChevron />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-60 gap-0 p-1"
          id={popupId}
          // The list takes focus: its keys move the highlight.
          initialFocus={listRef}
        >
          <LcdPopupScreen>
            <Command defaultValue={value} shouldFilter={false}>
              <CommandList label={label} ref={listRef}>
                <CommandGroup className={LCD_LIST_GROUP}>
                  {choices.map((choice) => (
                    <CommandItem
                      key={choice.value}
                      className={LCD_LIST_ITEM}
                      data-checked={choice.value === value}
                      disabled={choice.disabled && choice.value !== value}
                      value={choice.value}
                      onSelect={() => {
                        setOpen(false)
                        if (choice.value !== value) onChange(choice.value)
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </LcdPopupScreen>
        </PopoverContent>
      </Popover>
    </LcdPanelRow>
  )
}
