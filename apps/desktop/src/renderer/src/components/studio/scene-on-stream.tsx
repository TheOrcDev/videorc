import { HiddenIcon } from '@/components/icons'
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'

import { DevicePicker } from '@/components/device-picker'
import { LcdDevicePicker } from '@/components/lcd-device-picker'
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
import {
  LayoutThumb,
  ScreenFramingControl,
  VERTICAL_SCENES
} from '@/components/studio/scenes-gallery'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import {
  editVerticalStreamLayout,
  LayoutChoice,
  VerticalStreamLayoutControl
} from '@/components/studio/vertical-stream-layout-control'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { LcdDisplaySeparator } from '@/components/ui/lcd-display'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
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
  buildCaptureSources,
  capturePickerDevices,
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
  screenPrivacyActionLabel,
  screenPrivacyDisabledReason
} from '@/lib/screen-privacy-view'
import { standInLine } from '@/lib/source-status'
import { toastUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'

// Plan 231 D8: under the cards, the scene on stream's own fields. This is
// the answer to "the relation between screen and scene": the Screen the
// scene shows (with Change… and Hide screen, which moved here from Studio's
// Sources rows), its Layout for the studio's mode, Fill or Fit, and with a
// vertical stream armed its 9:16 layout. Every edit saves into the scene on
// stream (D11). Part of the lazy Scenes chunk.

/** What both looks' Hide screen controls show and do (the line and the Retro LCD's row). */
export interface ScreenPrivacyControl {
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
    hideScreen,
    showScreen,
    settings,
    runtimeInfo,
    wsStatus
  } = useStudioCore()
  return {
    hidden: privacy.hidden,
    accelerator: screenHideAccelerator(settings.globalShortcuts?.screenHideToggle),
    platform: runtimeInfo?.platform,
    disabledReason: screenPrivacyDisabledReason(privacy, wsStatus === 'connected'),
    toggle: () => {
      const hidden = privacy.hidden
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

/** The screen picker's state: the same list and words as Sources' Screen. */
function useScreenPicker() {
  const {
    captureConfig,
    deviceList,
    selectedCaptureDevice,
    allowCaptureNone,
    sourceSwitchReason,
    switchSourceDeviceLive,
    wsStatus
  } = useStudioCore()
  const devices = capturePickerDevices(deviceList.devices)
  const { sources } = captureConfig
  return {
    devices,
    value: sources.screenId ?? sources.windowId ?? sources.wantedWindowId ?? sources.wantedScreenId,
    selectedDevice: selectedCaptureDevice,
    selectedName:
      sources.screenName ??
      sources.windowName ??
      sources.wantedWindowName ??
      sources.wantedScreenName,
    noneLabel: allowCaptureNone ? 'None' : undefined,
    discoveryPending: wsStatus !== 'connected',
    disabled: Boolean(sourceSwitchReason('capture')),
    standIn: sourceStandIn(sources, 'capture', deviceList.devices),
    // Plan 231 D2: a Screen pick changes the screen of the scene on stream.
    choose: (captureId: string | undefined): Promise<void> =>
      switchSourceDeviceLive('capture', buildCaptureSources(sources, devices, captureId))
  }
}

/**
 * The scene on stream's fields, under Studio's scene cards. `onChangeScreen`
 * is the seam for S7's Change screen…: without it, Change… opens the screen
 * picker Sources uses.
 */
export function SceneOnStreamFields({
  look = 'default',
  onChangeScreen
}: {
  look?: StudioLook
  onChangeScreen?: () => void
}): ReactElement | null {
  const studio = useStudioCore()
  const { sceneOnStream, captureConfig, applyCameraPreset, sceneLibraryActions } = studio
  const picker = useScreenPicker()
  const privacy = useScreenPrivacyControl()
  // D19, the simple version: a layout that draws a screen on a scene that
  // shows none asks for the screen first, and Cancel keeps the old layout.
  const [askScreenFor, setAskScreenFor] = useState<LayoutPreset | null>(null)
  const [afterScreen, setAfterScreen] = useState<{
    preset: LayoutPreset
    sceneId: string
    captureId: string
  } | null>(null)
  const { sources } = captureConfig
  const capturing = sources.screenId ?? sources.windowId
  useEffect(() => {
    if (!afterScreen) return
    // Another scene went on stream: the layout was for the one before.
    if (sceneOnStream?.id !== afterScreen.sceneId) {
      setAfterScreen(null)
      return
    }
    if (capturing !== afterScreen.captureId) return
    setAfterScreen(null)
    applyCameraPreset({ layoutPreset: afterScreen.preset })
  }, [afterScreen, capturing, sceneOnStream?.id, applyCameraPreset])

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
    setAfterScreen(null)
    if (layoutAsksForScreen(sceneOnStream.shows, preset)) {
      setAskScreenFor(preset)
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
  const dialog = askScreenFor ? (
    <SceneScreenDialog
      devices={picker.devices}
      discoveryPending={picker.discoveryPending}
      layoutLabel={layoutPresetLabel(askScreenFor)}
      sceneName={sceneOnStream.name}
      onCancel={() => setAskScreenFor(null)}
      onChoose={(captureId) => {
        const preset = askScreenFor
        setAskScreenFor(null)
        setAfterScreen({ preset, sceneId: sceneOnStream.id, captureId })
        void picker.choose(captureId).catch(() => setAfterScreen(null))
      }}
    />
  ) : null

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
          {onChangeScreen ? (
            <LcdPanelRow label="Screen">
              <LcdPanelValue>{words}</LcdPanelValue>
              <LcdPanelAction onClick={onChangeScreen}>Change screen…</LcdPanelAction>
            </LcdPanelRow>
          ) : (
            // On a screen a value is its own dropdown: the words open the list.
            <LcdDevicePicker
              devices={picker.devices}
              disabled={picker.disabled}
              discoveryPending={picker.discoveryPending}
              groupByKind
              kind="capture"
              label="Screen"
              noneLabel={picker.noneLabel}
              selectedDevice={picker.selectedDevice}
              selectedName={picker.selectedName}
              selectionLabel={words}
              value={picker.value}
              onChange={(captureId) => void picker.choose(captureId)}
            />
          )}
          {note ? <p className={LCD_MESSAGE}>{note}</p> : null}
          <div aria-live="polite" className={cn(LCD_MESSAGE, 'empty:sr-only')}>
            <SourceSwitchStatus kind="capture" look="lcd" />
          </div>
          {picker.standIn ? (
            <p className={LCD_MESSAGE} data-slot="source-stand-in">
              {standInLine(picker.standIn)}
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
        {dialog}
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-3 border-t border-border pt-3"
      data-scene-on-stream={sceneOnStream.id}
      data-slot="scene-on-stream"
    >
      <p
        className="flex min-w-0 items-baseline gap-1 text-meta text-muted-foreground"
        data-slot="scene-on-stream-name"
      >
        <span className="shrink-0">On stream:</span>{' '}
        <span className="min-w-0 truncate font-medium text-foreground">{sceneOnStream.name}</span>
      </p>
      <SceneField
        control={
          onChangeScreen ? (
            <Button variant="outline" onClick={onChangeScreen}>
              Change screen…
            </Button>
          ) : (
            // The screen picker Sources uses (S7 replaces it with Change
            // screen…). The words say what the scene shows, so the trigger
            // only says what it does.
            <DevicePicker
              devices={picker.devices}
              disabled={picker.disabled}
              discoveryPending={picker.discoveryPending}
              groupByKind
              kind="capture"
              label="Change screen"
              labelHidden
              noneLabel={picker.noneLabel}
              selectedDevice={picker.selectedDevice}
              selectedName={picker.selectedName}
              selectionLabel="Change…"
              value={picker.value}
              onChange={(captureId) => void picker.choose(captureId)}
            />
          )
        }
        field="screen"
        description={words}
        label="Screen"
        note={note}
      >
        <div className="text-xs text-muted-foreground empty:hidden">
          <SourceSwitchStatus kind="capture" />
        </div>
        {picker.standIn ? (
          <p className="text-xs text-muted-foreground" data-slot="source-stand-in">
            {standInLine(picker.standIn)}
          </p>
        ) : null}
        <ScreenPrivacyLine control={privacy} />
        <SourcePermissionAlerts className="px-0 pt-0" only="screen-recording" />
      </SceneField>
      <SceneField
        control={
          orientation === 'vertical' ? (
            <Select
              items={choices}
              value={layout.layoutPreset}
              onValueChange={(preset) => {
                if (preset && preset !== layout.layoutPreset) chooseLayout(preset)
              }}
            >
              <SelectTrigger
                aria-label="Layout"
                className="w-44 shrink-0"
                data-videorc-scene-layout={layout.layoutPreset}
              >
                <SelectValue>{layoutName}</SelectValue>
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
          ) : (
            // Four choices: the segmented control (plan 174 D13), each a
            // diagram named by its tooltip. A switch applies live, so arrows
            // only move focus (manual).
            <SegmentedControl<LayoutPreset>
              activationMode="manual"
              aria-label="Layout"
              data-videorc-scene-layout={layout.layoutPreset}
              options={choices.map((choice) => ({
                value: choice.value,
                label: (
                  <span aria-hidden className="block w-7">
                    <LayoutThumb compact preset={choice.value} />
                  </span>
                ),
                'aria-label': choice.label,
                tooltip: choice.label,
                disabled: choice.disabled && choice.value !== layout.layoutPreset,
                'data-scene-layout': choice.value
              }))}
              size="sm"
              value={freeform ? null : layout.layoutPreset}
              onValueChange={chooseLayout}
            />
          )
        }
        field="layout"
        description={
          orientation === 'vertical' ? 'Each scene keeps its own 9:16 layout.' : layoutName
        }
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
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <SectionLabel>Vertical stream</SectionLabel>
          <VerticalStreamLayoutControl framingLabel="Framing" />
        </div>
      ) : null}
      {dialog}
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
  description,
  note,
  control,
  children
}: {
  /** Its hook for tests and probes: `data-slot="scene-{field}-field"`. */
  field: 'screen' | 'layout'
  label: string
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
          <span className="text-sm font-medium">{label}</span>
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
 * Hide screen under the scene's Screen (plan 210 D9; plan 231 D8 moved it
 * here from Studio's Screen row): a 24 px button with its key, never beside
 * Record and Go Live (owner, 2026-10-12). It stays at the right edge in both
 * states, so Show screen is where Hide screen was. While hidden the chip says
 * so; it shows with or without a screen in the scene, because hiding is
 * allowed either way. No toast: the chip and the Preview say it.
 */
export function ScreenPrivacyLine({ control }: { control: ScreenPrivacyControl }): ReactElement {
  const { hidden, accelerator, platform, disabledReason, toggle } = control
  const label = screenPrivacyActionLabel(hidden)
  const button = (
    <Button
      data-videorc-screen-privacy=""
      disabled={disabledReason !== null}
      size="xs"
      variant="outline"
      onClick={toggle}
    >
      {label}
    </Button>
  )
  return (
    <div
      className="flex min-h-7 items-center gap-2"
      data-hidden={hidden || undefined}
      data-slot="screen-privacy"
    >
      {hidden ? <StatusBadge icon={HiddenIcon} tone="warn" value={SCREEN_HIDDEN_LABEL} /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* The key teaches itself while there is room; while hidden the chip
            takes that room, and the tooltip keeps the key. */}
        {accelerator && !hidden ? (
          <ShortcutKeys accelerator={accelerator} platform={platform} />
        ) : null}
        {disabledReason ? (
          <DisabledReason reason={disabledReason}>{button}</DisabledReason>
        ) : (
          <ShortcutTooltip accelerator={accelerator} label={label} platform={platform}>
            {button}
          </ShortcutTooltip>
        )}
      </div>
    </div>
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
      label="Hide screen"
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

/**
 * D19, the simple version (S7 polishes it): the scene on stream shows no
 * screen, and the layout chosen draws one. Choose the screen first; Cancel
 * keeps the old layout.
 */
function SceneScreenDialog({
  sceneName,
  layoutLabel,
  devices,
  discoveryPending,
  onCancel,
  onChoose
}: {
  sceneName: string
  layoutLabel: string
  devices: ReturnType<typeof capturePickerDevices>
  discoveryPending: boolean
  onCancel: () => void
  onChoose: (captureId: string) => void
}): ReactElement {
  const [choice, setChoice] = useState<string | undefined>()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent data-testid="scene-screen-dialog" size="sm">
        <DialogHeader>
          <DialogTitle>Choose a screen</DialogTitle>
          <DialogDescription>
            {layoutLabel} shows a screen, and “{sceneName}” shows none yet. The scene keeps the
            screen you choose.
          </DialogDescription>
        </DialogHeader>
        <DevicePicker
          devices={devices}
          discoveryPending={discoveryPending}
          groupByKind
          kind="capture"
          label="Screen"
          searchable
          value={choice}
          onChange={setChoice}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!choice} onClick={() => choice && onChoose(choice)}>
            Use this screen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
