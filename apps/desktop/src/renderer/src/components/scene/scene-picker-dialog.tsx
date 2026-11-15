import {
  CameraIcon,
  CheckIcon,
  ChevronRightIcon,
  DisplayIcon,
  SearchIcon
} from '@/components/icons'
import { useId, useState, type ReactElement, type ReactNode } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { MediaCard } from '@/components/media-card'
import { AppIconImage } from '@/components/scene/app-icon'
import { SectionLabel } from '@/components/section-label'
import { SourcePermissionAlerts } from '@/components/sources/source-permission-alerts'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAppChoices } from '@/hooks/use-app-choices'
import { useAppIcons } from '@/hooks/use-app-icons'
import { scenePictureTargetKey, useScenePictures } from '@/hooks/use-scene-pictures'
import { useStudioCore } from '@/hooks/use-studio'
import type { Device, LayoutPreset } from '@/lib/backend'
import { capturePickerDevices, hasSelectedCameraSource } from '@/lib/capture'
import { formatResolution } from '@/lib/format-video'
import { layoutPresetLabel } from '@/lib/layout-labels'
import {
  addScenesLabel,
  displayChoices,
  matchesSearch,
  pickKey,
  showsPick,
  windowChoices,
  windowCountLabel,
  windowLabel,
  type AppChoice,
  type DisplayChoice,
  type ScreenPick
} from '@/lib/scene-app-picker'
import { layoutShowsScreen, type Scene } from '@/lib/scenes'

/** What the picker is for: new scenes, or what one scene shows. */
export type ScenePickerMode =
  | { kind: 'add' }
  | {
      kind: 'change'
      /** The scene as stored: its screen and both layouts. */
      scene: Scene
      /** It's on stream, so the stream changes with it (D2). */
      onStream: boolean
      /** D19: the layout that needs a screen first. No screen isn't offered then. */
      forLayout?: LayoutPreset
    }

/**
 * Add scene… and Change screen… (plan 231 D6): one picker for what a scene
 * shows. Apps (macOS: each app's icon, a picture of its front window and its
 * window count), Displays (with a picture slot the scene pictures fill) and
 * the camera. Add scene… takes several, each a new scene; Change screen…
 * takes one, and offers "A specific window" under Apps and No screen.
 * Windows and Linux offer the displays and the camera (plan 210 D12).
 */
export function ScenePickerDialog({
  open,
  mode,
  onOpenChange,
  onAdd,
  onChange
}: {
  open: boolean
  mode: ScenePickerMode
  onOpenChange: (open: boolean) => void
  onAdd: (picks: ScreenPick[]) => void
  onChange: (pick: ScreenPick) => void
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={mode.kind === 'add' ? 'add-scene-dialog' : 'change-screen-dialog'}
        size="lg"
      >
        {open ? (
          <Picker
            mode={mode}
            onAdd={onAdd}
            onCancel={() => onOpenChange(false)}
            onChange={onChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Picker({
  mode,
  onCancel,
  onAdd,
  onChange
}: {
  mode: ScenePickerMode
  onCancel: () => void
  onAdd: (picks: ScreenPick[]) => void
  onChange: (pick: ScreenPick) => void
}): ReactElement {
  const { runtimeInfo, deviceList, captureConfig, screenPrivacy, isSessionActive } = useStudioCore()
  const platform = runtimeInfo?.platform
  // App scenes are macOS only (plan 210 D12): elsewhere the Apps group is absent.
  const mac = platform === 'darwin'
  const change = mode.kind === 'change' ? mode : null
  const apps = useAppChoices(mac)
  const windows = change && mac ? windowChoices(deviceList.devices, apps.selfBundleIds) : []
  // D7, D17: a still of each display while the picker is open (macOS; never
  // while recording or live, frozen while Hide screen holds).
  const displayList = displayChoices(deviceList.devices, platform)
  const displayStills = useScenePictures({
    targets: displayList.map(({ device }) => ({ kind: 'display', screenId: device.id })),
    hidden: screenPrivacy.hidden,
    busy: isSessionActive
  })
  const displays = displayList.map(
    (choice): DisplayChoice => ({
      ...choice,
      picture:
        displayStills.get(scenePictureTargetKey({ kind: 'display', screenId: choice.device.id })) ??
        choice.picture
    })
  )
  const icons = useAppIcons([
    ...new Set([
      ...apps.apps.map((app) => app.bundleId),
      ...windows.map((device) => device.app!.bundleId)
    ])
  ])
  const captureDevices = capturePickerDevices(deviceList.devices)
  const grantMissing =
    captureDevices.length > 0 &&
    captureDevices.every((device) => device.status === 'permission-required')
  const [query, setQuery] = useState('')

  const appPicks = apps.apps.map((app): ScreenPick => ({ kind: 'app', app }))
  const windowPicks = windows.map((device): ScreenPick => ({ kind: 'window', device }))
  const displayPicks = displays.map(({ device }): ScreenPick => ({ kind: 'display', device }))
  const noScreen: ScreenPick | null = change?.forLayout ? null : { kind: 'none' }
  const every = [...appPicks, ...windowPicks, ...displayPicks, ...(noScreen ? [noScreen] : [])]
  // Change screen… starts on what the scene shows now, when it's listed.
  const current = change ? every.find((pick) => showsPick(change.scene.shows, pick)) : undefined
  const [chosen, setChosen] = useState<string[]>(() =>
    current && !change?.forLayout ? [pickKey(current)] : []
  )
  const toggle = (pick: ScreenPick): void => {
    const key = pickKey(pick)
    setChosen((keys) =>
      change ? [key] : keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key]
    )
  }
  const isChosen = (pick: ScreenPick): boolean => chosen.includes(pickKey(pick))
  const chosenPicks = every.filter(isChosen)

  const cameraName = hasSelectedCameraSource(captureConfig.sources)
    ? (captureConfig.sources.cameraName ?? 'Your camera')
    : null
  const shownApps = apps.apps.filter((app) =>
    matchesSearch([app.name, app.frontWindowTitle], query)
  )
  const shownWindows = windows.filter((device) =>
    matchesSearch([windowLabel(device), device.app?.name], query)
  )
  const shownDisplays = displays.filter(({ device }) => matchesSearch([device.name], query))
  const noScreenTitle = change ? 'No screen' : 'Camera only'
  const showNoScreen = noScreen !== null && matchesSearch([noScreenTitle, 'camera'], query)
  const nothingShown =
    query.trim() !== '' &&
    shownApps.length === 0 &&
    shownWindows.length === 0 &&
    shownDisplays.length === 0 &&
    !showNoScreen

  const reason = change
    ? chosenPicks.length === 0
      ? `Choose what “${change.scene.name}” shows.`
      : current && pickKey(current) === pickKey(chosenPicks[0]!)
        ? `“${change.scene.name}” already shows this.`
        : null
    : chosenPicks.length === 0
      ? 'Choose at least one.'
      : null
  // A screen chosen for a scene whose layout draws none: the layout says so.
  const hiddenByLayout =
    change && !change.forLayout && chosenPicks[0] && chosenPicks[0].kind !== 'none'
      ? hiddenScreenLine(change.scene, captureConfig.layout.layoutPreset)
      : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>{change ? 'Change screen' : 'Add scene'}</DialogTitle>
        <DialogDescription>{pickerDescription(mode)}</DialogDescription>
      </DialogHeader>
      {mac && !grantMissing && apps.apps.length > 0 ? (
        <div className="relative shrink-0">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={change ? 'Search apps, windows and displays' : 'Search apps and displays'}
            autoFocus
            className="pl-8"
            placeholder={
              change ? 'Search apps, windows and displays…' : 'Search apps and displays…'
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
      <DialogBody className="flex min-h-56 flex-col gap-4">
        {grantMissing ? (
          <SourcePermissionAlerts className="px-0 pt-0" only="screen-recording" />
        ) : null}
        {nothingShown ? (
          <Empty>
            <EmptyDescription>Nothing matches “{query.trim()}”.</EmptyDescription>
          </Empty>
        ) : null}
        {mac && !grantMissing && (shownApps.length > 0 || !query.trim()) ? (
          <PickerGroup label="Apps">
            {apps.loading && apps.apps.length === 0 ? (
              <Empty>
                <Spinner aria-hidden />
                <EmptyDescription>Finding your open apps…</EmptyDescription>
              </Empty>
            ) : apps.apps.length === 0 ? (
              <Empty data-testid="scene-picker-no-apps">
                <EmptyTitle>No app windows found</EmptyTitle>
                <EmptyDescription>
                  Open the apps you want to show, bring their windows up, then refresh.
                </EmptyDescription>
                <EmptyContent>
                  <Button variant="outline" onClick={apps.refresh}>
                    Refresh
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <PickerGrid label="Open apps">
                {shownApps.map((app) => (
                  <AppCard
                    key={app.bundleId}
                    app={app}
                    icon={icons.get(app.bundleId)}
                    pictures={apps.pictures}
                    selected={isChosen({ kind: 'app', app })}
                    onToggle={() => toggle({ kind: 'app', app })}
                  />
                ))}
              </PickerGrid>
            )}
          </PickerGroup>
        ) : null}
        {change && mac && !grantMissing && (shownWindows.length > 0 || !query.trim()) ? (
          <SpecificWindow
            chosen={isChosen}
            defaultOpen={change.scene.shows.kind === 'window' || query.trim() !== ''}
            icons={icons}
            windows={shownWindows}
            onToggle={toggle}
          />
        ) : null}
        {!grantMissing && (shownDisplays.length > 0 || !query.trim()) ? (
          <PickerGroup label="Displays">
            {displays.length === 0 ? (
              <Empty>
                <EmptyTitle>No displays found</EmptyTitle>
                <EmptyDescription>Connect a display, or check Sources.</EmptyDescription>
              </Empty>
            ) : (
              <PickerGrid label="Displays">
                {shownDisplays.map((choice) => (
                  <DisplayCard
                    key={choice.device.id}
                    choice={choice}
                    selected={isChosen({ kind: 'display', device: choice.device })}
                    onToggle={() => toggle({ kind: 'display', device: choice.device })}
                  />
                ))}
              </PickerGrid>
            )}
          </PickerGroup>
        ) : null}
        {noScreen && showNoScreen ? (
          <PickerGroup label="Camera">
            <PickerGrid label="Camera">
              <PickCard
                data-pick="none"
                icon={null}
                meta={
                  change
                    ? layoutShowsScreen(change.scene.layouts.horizontal) ||
                      layoutShowsScreen(change.scene.layouts.vertical)
                      ? 'Puts the scene on Camera only'
                      : 'Shows your camera only'
                    : (cameraName ?? 'Camera is off')
                }
                selected={isChosen(noScreen)}
                title={noScreenTitle}
                well={<CameraIcon aria-hidden className="size-8 text-muted-foreground" />}
                onToggle={() => toggle(noScreen)}
              />
            </PickerGrid>
          </PickerGroup>
        ) : null}
      </DialogBody>
      {hiddenByLayout ? (
        <p
          className="shrink-0 text-meta text-muted-foreground"
          data-slot="scene-picker-layout-note"
        >
          {hiddenByLayout}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <DisabledReason reason={reason}>
          <Button
            data-testid={change ? 'change-screen-apply' : 'new-scene-add'}
            disabled={reason !== null}
            onClick={() => (change ? onChange(chosenPicks[0]!) : onAdd(chosenPicks))}
          >
            {change ? 'Change screen' : addScenesLabel(chosenPicks.length)}
          </Button>
        </DisabledReason>
      </DialogFooter>
    </>
  )
}

function pickerDescription(mode: ScenePickerMode): string {
  if (mode.kind === 'add')
    return 'Each choice becomes a scene in the look of the scene on stream, at the end of your scenes. What’s on stream stays as it is.'
  if (mode.forLayout)
    return `${layoutPresetLabel(mode.forLayout)} shows a screen, and “${mode.scene.name}” shows none yet. Choose the screen it shows.`
  return mode.onStream
    ? `Choose what “${mode.scene.name}” shows. It’s on stream, so the stream changes too.`
    : `Choose what “${mode.scene.name}” shows. It keeps its layout, keys and audio.`
}

/**
 * A screen chosen for a scene whose layout in the studio's orientation draws
 * none ("Camera only" keeps it, but doesn't show it), or null.
 */
function hiddenScreenLine(scene: Scene, studioPreset: LayoutPreset): string | null {
  const layout = studioPreset.startsWith('vertical-')
    ? scene.layouts.vertical
    : scene.layouts.horizontal
  if (layoutShowsScreen(layout)) return null
  return `“${scene.name}” uses ${layoutPresetLabel(layout.layoutPreset)}, which shows no screen. Change its layout to show it.`
}

/** One group of choices: its name over its cards. */
function PickerGroup({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2" data-picker-group={label}>
      <SectionLabel as="h3" className="px-0.5" id={id}>
        {label}
      </SectionLabel>
      {children}
    </section>
  )
}

function PickerGrid({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div
      aria-label={label}
      className="grid gap-3 p-0.5 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]"
      role="group"
    >
      {children}
    </div>
  )
}

/**
 * One choice as a card: a picture (or a glyph) in a 16:9 well, then its
 * icon and name, then one quiet line. A pressed card is chosen.
 */
function PickCard({
  well,
  icon,
  title,
  meta,
  selected,
  onToggle,
  ...data
}: {
  well: ReactNode
  icon: ReactNode
  title: string
  meta: ReactNode
  selected: boolean
  onToggle: () => void
  [data: `data-${string}`]: string | undefined
}): ReactElement {
  return (
    <MediaCard
      interactive={!selected}
      render={
        <button
          aria-pressed={selected}
          className="flex flex-col gap-2 p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          type="button"
          onClick={onToggle}
          {...data}
        />
      }
      selected={selected}
    >
      <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-chip bg-inset">
        {well}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {selected ? <CheckIcon aria-hidden className="size-4 shrink-0" weight="bold" /> : null}
      </span>
      <span className="min-h-4 truncate text-xs text-muted-foreground">{meta}</span>
    </MediaCard>
  )
}

/**
 * An app: its front window's picture, letterboxed in the well (or its icon
 * there while there's no picture), its icon and name, and how many windows
 * it has when there are several ("Chrome · 3 windows", D6).
 */
function AppCard({
  app,
  icon,
  pictures,
  selected,
  onToggle
}: {
  app: AppChoice
  icon: string | null | undefined
  /** False while the pictures request hasn't answered, or below macOS 14. */
  pictures: boolean
  selected: boolean
  onToggle: () => void
}): ReactElement {
  const picture = pictures ? app.picture : undefined
  return (
    <PickCard
      data-app-choice={app.bundleId}
      data-pick={pickKey({ kind: 'app', app })}
      icon={picture ? <AppIconImage icon={icon} /> : null}
      meta={windowCountLabel(app.windowCount) ?? app.frontWindowTitle}
      selected={selected}
      title={app.name}
      well={
        picture ? (
          <img alt="" className="size-full object-contain" draggable={false} src={picture} />
        ) : (
          <AppIconImage className="size-10" icon={icon} />
        )
      }
      onToggle={onToggle}
    />
  )
}

/** A display: its picture when the scene pictures have one (S5), else its glyph. */
function DisplayCard({
  choice,
  selected,
  onToggle
}: {
  choice: DisplayChoice
  selected: boolean
  onToggle: () => void
}): ReactElement {
  const { device, picture } = choice
  const size =
    device.width && device.height
      ? formatResolution({ width: device.width, height: device.height })
      : null
  // macOS names a display with its size ("Built-in Retina Display · 3024 × 1964"):
  // the card's name is the display's, and its size the line under it.
  const suffix = size ? ` · ${size}` : null
  const name =
    suffix && device.name.endsWith(suffix) ? device.name.slice(0, -suffix.length) : device.name
  return (
    <PickCard
      data-display-choice={device.id}
      data-pick={pickKey({ kind: 'display', device })}
      icon={null}
      meta={size}
      selected={selected}
      title={name}
      well={
        // A quiet still of the whole display, the same in both themes.
        picture ? (
          <img alt="" className="size-full object-cover" draggable={false} src={picture} />
        ) : (
          <DisplayIcon aria-hidden className="size-8 text-muted-foreground" />
        )
      }
      onToggle={onToggle}
    />
  )
}

/**
 * "A specific window" under Apps (D6): plan 210's fixed window. An app scene
 * follows whichever of the app's windows is in front; this keeps one window.
 */
function SpecificWindow({
  windows,
  icons,
  defaultOpen,
  chosen,
  onToggle
}: {
  windows: readonly Device[]
  icons: ReadonlyMap<string, string | null>
  defaultOpen: boolean
  chosen: (pick: ScreenPick) => boolean
  onToggle: (pick: ScreenPick) => void
}): ReactElement {
  return (
    <Collapsible
      className="group/windows -mt-2 flex flex-col"
      data-picker-group="A specific window"
      defaultOpen={defaultOpen}
    >
      <CollapsibleTrigger
        render={<Button className="-ml-2 self-start" size="xs" type="button" variant="ghost" />}
      >
        <ChevronRightIcon
          className="transition-transform duration-150 group-data-open/windows:rotate-90"
          data-icon="inline-start"
        />
        A specific window
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-2">
        <p className="text-meta text-muted-foreground">
          The scene keeps this one window, whichever window of its app is in front.
        </p>
        {windows.length === 0 ? (
          <p className="text-meta text-muted-foreground">No app windows found.</p>
        ) : (
          <GroupedList aria-label="Windows">
            {windows.map((device) => (
              <WindowRow
                key={device.id}
                device={device}
                icon={icons.get(device.app!.bundleId)}
                selected={chosen({ kind: 'window', device })}
                onToggle={() => onToggle({ kind: 'window', device })}
              />
            ))}
          </GroupedList>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One window: its app's icon, its title and its app, chosen like a card. */
function WindowRow({
  device,
  icon,
  selected,
  onToggle
}: {
  device: Device
  icon: string | null | undefined
  selected: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <ListRow
      aria-pressed={selected}
      as="button"
      context={device.app?.name}
      data-pick={pickKey({ kind: 'window', device })}
      data-window-choice={device.id}
      icon={<AppIconImage icon={icon} />}
      meta={selected ? <CheckIcon aria-hidden className="size-4" weight="bold" /> : null}
      selected={selected}
      title={windowLabel(device)}
      onClick={onToggle}
    />
  )
}
