import { CheckIcon, DisplayIcon, SearchIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { MediaCard } from '@/components/media-card'
import { AppIconImage } from '@/components/scene/app-icon'
import { SourcePermissionAlerts } from '@/components/sources/source-permission-alerts'
import { Button } from '@/components/ui/button'
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
import { useStudioCore } from '@/hooks/use-studio'
import type { Device } from '@/lib/backend'
import {
  addScenesLabel,
  captureChoices,
  searchAppChoices,
  windowCountLabel,
  type AppChoice
} from '@/lib/scene-app-picker'

/** What the picker is for: new scenes, or another app for one scene. */
export type NewSceneDialogMode =
  | { kind: 'new' }
  | { kind: 'change-app'; sceneName: string; bundleId?: string }

/**
 * New scene… (plan 210 D2): the open apps, each with a picture of its front
 * window and its icon. Several can be chosen, and each becomes a scene in the
 * current look. "Change app…" is the same picker choosing one.
 *
 * On Windows and Linux (D12) there are no app windows to choose: it offers
 * what Sources offers, a display or the portal's source, as one choice.
 */
export function NewSceneDialog({
  open,
  mode,
  onOpenChange,
  onChooseApps,
  onChooseCapture
}: {
  open: boolean
  mode: NewSceneDialogMode
  onOpenChange: (open: boolean) => void
  onChooseApps: (apps: AppChoice[]) => void
  onChooseCapture: (device: Device) => void
}): ReactElement {
  const { runtimeInfo } = useStudioCore()
  // App scenes are macOS only (D12): elsewhere the controls are absent.
  const apps = runtimeInfo?.platform === 'darwin'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-scene-dialog" size="lg">
        {open ? (
          apps ? (
            <AppPicker mode={mode} onCancel={() => onOpenChange(false)} onChoose={onChooseApps} />
          ) : (
            <CapturePicker onCancel={() => onOpenChange(false)} onChoose={onChooseCapture} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AppPicker({
  mode,
  onCancel,
  onChoose
}: {
  mode: NewSceneDialogMode
  onCancel: () => void
  onChoose: (apps: AppChoice[]) => void
}): ReactElement {
  const single = mode.kind === 'change-app'
  const { apps, loading, pictures, grantMissing, refresh } = useAppChoices(true)
  const icons = useAppIcons(apps.map((app) => app.bundleId))
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const shown = searchAppChoices(apps, query)
  const chosenApps = apps.filter((app) => chosen.includes(app.bundleId))
  const toggle = (bundleId: string): void =>
    setChosen((current) =>
      single
        ? [bundleId]
        : current.includes(bundleId)
          ? current.filter((id) => id !== bundleId)
          : [...current, bundleId]
    )
  const sameApp = single && chosen[0] !== undefined && chosen[0] === mode.bundleId
  const reason =
    chosenApps.length === 0
      ? single
        ? 'Choose an app.'
        : 'Choose at least one app.'
      : sameApp
        ? `“${mode.sceneName}” already shows this app.`
        : null

  return (
    <>
      <DialogHeader>
        <DialogTitle>{single ? 'Change app' : 'New scene'}</DialogTitle>
        <DialogDescription>
          {single
            ? `Choose the app “${mode.sceneName}” shows. It keeps its look and audio.`
            : 'Choose the apps you show. Each becomes a scene in your current look, showing its app’s front window.'}
        </DialogDescription>
      </DialogHeader>
      {!grantMissing && apps.length > 0 ? (
        <div className="relative shrink-0">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search apps"
            autoFocus
            className="pl-8"
            placeholder="Search apps…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
      <DialogBody className="min-h-56">
        {grantMissing ? (
          <SourcePermissionAlerts className="px-0 pt-0" only="screen-recording" />
        ) : loading && apps.length === 0 ? (
          <Empty>
            <Spinner aria-hidden />
            <EmptyDescription>Finding your open apps…</EmptyDescription>
          </Empty>
        ) : apps.length === 0 ? (
          <Empty data-testid="new-scene-empty">
            <EmptyTitle>No app windows found</EmptyTitle>
            <EmptyDescription>
              Open the apps you want to show, bring their windows up, then refresh.
            </EmptyDescription>
            <EmptyContent>
              <Button variant="outline" onClick={refresh}>
                Refresh
              </Button>
            </EmptyContent>
          </Empty>
        ) : shown.length === 0 ? (
          <Empty>
            <EmptyDescription>No open app matches “{query.trim()}”.</EmptyDescription>
          </Empty>
        ) : (
          <div
            aria-label="Open apps"
            className="grid gap-3 p-0.5 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]"
            role="group"
          >
            {shown.map((app) => (
              <AppCard
                key={app.bundleId}
                app={app}
                icon={icons.get(app.bundleId)}
                picture={pictures}
                selected={chosen.includes(app.bundleId)}
                onToggle={() => toggle(app.bundleId)}
              />
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <DisabledReason reason={reason}>
          <Button
            data-testid="new-scene-add"
            disabled={reason !== null}
            onClick={() => onChoose(chosenApps)}
          >
            {single ? 'Change app' : addScenesLabel(chosenApps.length)}
          </Button>
        </DisabledReason>
      </DialogFooter>
    </>
  )
}

/**
 * One app: its front window's picture, letterboxed in a 16:9 well (or its
 * icon there while there's no picture), then its icon and name, and how many
 * windows it has when there are several.
 */
function AppCard({
  app,
  icon,
  picture,
  selected,
  onToggle
}: {
  app: AppChoice
  icon: string | null | undefined
  /** S4 answered: a card without a picture is an app below macOS 14. */
  picture: boolean
  selected: boolean
  onToggle: () => void
}): ReactElement {
  const meta = windowCountLabel(app.windowCount) ?? app.frontWindowTitle
  return (
    <MediaCard asChild interactive={!selected} selected={selected}>
      <button
        aria-pressed={selected}
        className="flex flex-col gap-2 p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        data-app-choice={app.bundleId}
        type="button"
        onClick={onToggle}
      >
        <span className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-chip bg-inset">
          {picture && app.picture ? (
            <img alt="" className="size-full object-contain" draggable={false} src={app.picture} />
          ) : (
            <AppIconImage className="size-10" icon={icon} />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {app.picture ? <AppIconImage icon={icon} /> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{app.name}</span>
          {selected ? <CheckIcon aria-hidden className="size-4 shrink-0" weight="bold" /> : null}
        </span>
        <span className="min-h-4 truncate text-xs text-muted-foreground">{meta}</span>
      </button>
    </MediaCard>
  )
}

/** Windows and Linux: one display (or the portal's source) becomes a scene. */
function CapturePicker({
  onCancel,
  onChoose
}: {
  onCancel: () => void
  onChoose: (device: Device) => void
}): ReactElement {
  const { deviceList } = useStudioCore()
  const devices = captureChoices(deviceList.devices)
  const [chosenId, setChosenId] = useState<string | null>(null)
  const chosen = devices.find((device) => device.id === chosenId) ?? null
  return (
    <>
      <DialogHeader>
        <DialogTitle>New scene</DialogTitle>
        <DialogDescription>
          Choose what the scene shows. It becomes a scene in your current look.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {devices.length === 0 ? (
          <Empty>
            <EmptyTitle>No displays found</EmptyTitle>
            <EmptyDescription>Choose a screen in Sources, then come back.</EmptyDescription>
          </Empty>
        ) : (
          <GroupedList aria-label="Displays" role="radiogroup">
            {devices.map((device) => (
              <ListRow
                key={device.id}
                aria-checked={device.id === chosenId}
                as="button"
                icon={<DisplayIcon />}
                role="radio"
                selected={device.id === chosenId}
                title={device.name}
                onClick={() => setChosenId(device.id)}
              />
            ))}
          </GroupedList>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <DisabledReason reason={chosen ? null : 'Choose a display.'}>
          <Button disabled={!chosen} onClick={() => chosen && onChoose(chosen)}>
            {addScenesLabel(1)}
          </Button>
        </DisabledReason>
      </DialogFooter>
    </>
  )
}
