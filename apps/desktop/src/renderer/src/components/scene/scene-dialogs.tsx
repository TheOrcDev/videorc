import { useState, useSyncExternalStore, type ReactElement } from 'react'

import { withGlobalShortcut } from '../../../../shared/global-shortcut-bindings'
import { globalShortcutEntries } from '../../../../shared/global-shortcuts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DevicePicker } from '@/components/device-picker'
import type { KebabMenuItem } from '@/components/kebab-menu'
import { NewSceneDialog } from '@/components/scene/new-scene-dialog'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useStudioCore } from '@/hooks/use-studio'
import type { Device } from '@/lib/backend'
import { globalShortcutRegistration } from '@/lib/global-shortcuts'
import { globalShortcutTakenReason } from '@/lib/global-shortcut-owner'
import { newAppScenes, newCaptureScene, type AppChoice } from '@/lib/scene-app-picker'
import {
  duplicatedScene,
  sceneWithApp,
  sceneWithAudio,
  sceneWithFollow,
  suggestedSceneName
} from '@/lib/scene-list'
import {
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  sceneSourceProblems,
  type SavedScene,
  type SceneVisual
} from '@/lib/scene-presets'

/** One dialog at a time, for the scene list and the Studio gallery alike. */
export type SceneDialogRequest =
  | { kind: 'new' }
  | { kind: 'change-app'; scene: SavedScene }
  | { kind: 'save' }
  | { kind: 'rename'; scene: SavedScene }
  | { kind: 'key'; scene: SavedScene }
  | { kind: 'delete'; scene: SavedScene }
  | { kind: 'repair'; scene: SavedScene; error?: string }

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

/**
 * Plan 210 S5: New scene…, Save scene…, a saved scene's ⋯ actions and their
 * dialogs, in one place, so the Scene page's list and the Studio gallery say
 * and do the same. Nothing here toasts a success: the list and the stage
 * show it (owner call, 2026-07-16).
 */
export function useSceneDialogs(): {
  open: (request: SceneDialogRequest) => void
  /** Put a saved scene on stream; one whose sources are gone asks for new ones. */
  select: (scene: SavedScene) => void
  /** Whether a scene needs its sources chosen again before it can go on. */
  needsSources: (scene: SavedScene) => boolean
  menuItems: (scene: SavedScene) => KebabMenuItem[]
  busy: boolean
  element: ReactElement
} {
  const studio = useStudioCore()
  const { savedScenes, sceneLibraryActions, deviceList } = studio
  const [request, setRequest] = useState<SceneDialogRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const now = (): string => new Date().toISOString()
  const close = (): void => setRequest(null)

  const needsSources = (scene: SavedScene): boolean => {
    const rememberedApp = studio.savedSceneWindowApps?.[scene.id]
    return (
      sceneSourceProblems(
        rememberedApp
          ? {
              ...scene.visual,
              sources: {
                ...scene.visual.sources,
                app: { bundleId: rememberedApp, name: scene.name, follows: false }
              }
            }
          : scene.visual,
        deviceList.devices
      ).length > 0
    )
  }

  const apply = async (scene: SavedScene, repaired?: SceneVisual): Promise<boolean> => {
    setBusy(true)
    try {
      const result = await studio.applySavedSceneResult(scene.id, repaired)
      // A refusal in words ("Figma isn't open") is already a warning toast.
      if (!result.ok && !result.reason) {
        setRequest({
          kind: 'repair',
          scene,
          error: "The scene couldn't be put on stream. Check its sources and background."
        })
      }
      return result.ok
    } finally {
      setBusy(false)
    }
  }

  const select = (scene: SavedScene): void => {
    if (needsSources(scene)) setRequest({ kind: 'repair', scene })
    else void apply(scene)
  }

  const chooseApps = (apps: AppChoice[]): void => {
    if (request?.kind === 'change-app') {
      const choice = apps[0]
      if (!choice) return
      const scene = sceneWithApp(request.scene, choice, savedScenes, now())
      if (!sceneLibraryActions.replace(scene)) return
      close()
      // The scene on stream shows its new app at once.
      if (studio.activeSavedSceneId === scene.id) void apply(scene, scene.visual)
      return
    }
    const scenes = newAppScenes(apps, sceneLibraryActions.workingVisual, savedScenes)
    if (sceneLibraryActions.insert(scenes)) close()
  }

  const chooseCapture = (device: Device): void => {
    const scene = newCaptureScene(device, sceneLibraryActions.workingVisual, savedScenes, {
      id: crypto.randomUUID(),
      now: now()
    })
    if (sceneLibraryActions.insert([scene])) close()
  }

  const menuItems = (scene: SavedScene): KebabMenuItem[] => {
    const app = scene.visual.sources.app
    const readOnly = sceneLibraryActions.readOnly
    const writes = { disabled: readOnly, disabledReason: readOnly ? READ_ONLY_REASON : null }
    const audioKept =
      scene.audio !== undefined &&
      JSON.stringify(scene.audio) ===
        JSON.stringify(normalizeSceneAudio(sceneLibraryActions.workingAudio))
    return [
      {
        id: 'rename',
        label: 'Rename…',
        group: 'edit',
        ...writes,
        onSelect: () => setRequest({ kind: 'rename', scene })
      },
      {
        id: 'key',
        label: 'Set key…',
        group: 'edit',
        onSelect: () => setRequest({ kind: 'key', scene })
      },
      ...(app
        ? [
            {
              id: 'change-app',
              label: 'Change app…',
              group: 'edit',
              ...writes,
              onSelect: () => setRequest({ kind: 'change-app', scene })
            }
          ]
        : []),
      {
        id: 'duplicate',
        label: 'Duplicate',
        group: 'edit',
        ...writes,
        onSelect: () => {
          sceneLibraryActions.insert(
            [duplicatedScene(scene, savedScenes, { id: crypto.randomUUID(), now: now() })],
            scene.id
          )
        }
      },
      {
        id: 'audio',
        label: 'Save audio to scene',
        group: 'keeps',
        disabled: readOnly || audioKept,
        disabledReason: readOnly
          ? READ_ONLY_REASON
          : audioKept
            ? 'The scene already keeps this microphone and System audio.'
            : null,
        onSelect: () =>
          sceneLibraryActions.replace(
            sceneWithAudio(scene, sceneLibraryActions.workingAudio, now())
          )
      },
      ...(app
        ? [
            {
              id: 'follow',
              label: app.follows ? 'Stop following' : 'Follow the app',
              group: 'keeps',
              ...writes,
              onSelect: () =>
                sceneLibraryActions.replace(sceneWithFollow(scene, !app.follows, now()))
            }
          ]
        : []),
      {
        id: 'delete',
        label: 'Delete',
        destructive: true,
        ...writes,
        onSelect: () => setRequest({ kind: 'delete', scene })
      }
    ]
  }

  const element = (
    <>
      <NewSceneDialog
        mode={
          request?.kind === 'change-app'
            ? {
                kind: 'change-app',
                sceneName: request.scene.name,
                bundleId: request.scene.visual.sources.app?.bundleId
              }
            : { kind: 'new' }
        }
        open={request?.kind === 'new' || request?.kind === 'change-app'}
        onChooseApps={chooseApps}
        onChooseCapture={chooseCapture}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      />
      {request?.kind === 'save' || request?.kind === 'rename' ? (
        <SceneNameDialog
          key={request.kind === 'rename' ? `rename-${request.scene.id}` : 'save'}
          canSave={request.kind === 'rename' || studio.canSaveScene}
          exceptId={request.kind === 'rename' ? request.scene.id : undefined}
          initialName={
            request.kind === 'rename'
              ? request.scene.name
              : suggestedSceneName(
                  sceneLibraryActions.workingVisual,
                  deviceList.devices,
                  savedScenes
                )
          }
          kind={request.kind}
          scenes={savedScenes}
          onClose={close}
          onSubmit={(name) =>
            request.kind === 'rename'
              ? studio.renameSavedScene(request.scene.id, name)
              : studio.saveScene(name)
          }
        />
      ) : null}
      {request?.kind === 'key' ? (
        <SceneKeyDialog key={request.scene.id} scene={request.scene} onClose={close} />
      ) : null}
      {request?.kind === 'repair' ? (
        <SceneRepairDialog
          key={request.scene.id}
          busy={busy}
          error={request.error ?? null}
          scene={request.scene}
          onApply={async (visual) => {
            if (!(await apply(request.scene, visual))) return
            // The streamer chose these sources for the scene: it keeps them.
            sceneLibraryActions.replace({
              ...request.scene,
              updatedAt: now(),
              visual: normalizeSceneVisual(visual)
            })
            close()
          }}
          onClose={close}
        />
      ) : null}
      {/* The model confirm (plan 174 S0.3): what is lost, in one sentence. */}
      <ConfirmDialog
        confirmLabel="Delete scene"
        description={
          request?.kind === 'delete'
            ? `“${request.scene.name}” and its key are deleted. What’s on stream stays as it is.`
            : ''
        }
        open={request?.kind === 'delete'}
        testId="scene-delete"
        title="Delete scene?"
        onCancel={close}
        onConfirm={() => {
          if (request?.kind === 'delete' && studio.deleteSavedScene(request.scene.id)) close()
        }}
      />
    </>
  )

  return { open: setRequest, select, needsSources, menuItems, busy, element }
}

/** Save scene… and Rename…: one name, unique, 1 to 80 characters. */
function SceneNameDialog({
  kind,
  initialName,
  scenes,
  exceptId,
  canSave,
  onSubmit,
  onClose
}: {
  kind: 'save' | 'rename'
  initialName: string
  scenes: readonly SavedScene[]
  exceptId?: string
  canSave: boolean
  onSubmit: (name: string) => boolean
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(initialName)
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    const invalid = sceneNameError(name, scenes, exceptId)
    if (invalid) {
      setError(invalid)
      return
    }
    if (onSubmit(name)) onClose()
    else setError("Couldn't save. Wait for the scene to finish changing, or check your free space.")
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size={kind === 'rename' ? 'sm' : 'md'}>
        <DialogHeader>
          <DialogTitle>{kind === 'rename' ? 'Rename scene' : 'Save scene'}</DialogTitle>
          {kind === 'save' ? (
            <DialogDescription>
              Saves your screen, camera, microphone, system audio, framing and background. Levels,
              recording and streaming settings stay separate.
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Give the scene a new name.</DialogDescription>
          )}
        </DialogHeader>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="scene-preset-name">Name</FieldLabel>
          <Input
            id="scene-preset-name"
            autoFocus
            aria-describedby="scene-preset-error"
            aria-invalid={Boolean(error)}
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          <FieldDescription id="scene-preset-error">
            {error ?? 'Names must be unique.'}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {kind === 'rename' ? 'Rename' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Set key…: the scene's global key, recorded like every key in Settings →
 * Shortcuts (plan 210 D7). There are no default keys.
 */
function SceneKeyDialog({
  scene,
  onClose
}: {
  scene: SavedScene
  onClose: () => void
}): ReactElement {
  const { settings, setSettings, runtimeInfo, savedScenes } = useStudioCore()
  const registration = useSyncExternalStore(
    globalShortcutRegistration.subscribe,
    globalShortcutRegistration.getSnapshot
  )
  const action = `scene:${scene.id}` as const
  const value = globalShortcutEntries(settings.globalShortcuts ?? {}).find(
    ([id]) => id === action
  )?.[1]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Set key</DialogTitle>
          <DialogDescription>
            Puts “{scene.name}” on stream from any app. Click the field and press the keys.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup variant="grouped">
          <ShortcutRecorderField
            id={`scene-key-${scene.id}`}
            label="Key"
            platform={runtimeInfo?.platform}
            registrationFailed={registration[action] === false}
            validate={(accelerator) =>
              globalShortcutTakenReason({
                config: settings.globalShortcuts ?? {},
                accelerator,
                action,
                platform: runtimeInfo?.platform,
                scenes: savedScenes
              })
            }
            value={value}
            onChange={(accelerator) =>
              setSettings((current) => ({
                ...current,
                globalShortcuts: withGlobalShortcut(current.globalShortcuts, action, accelerator)
              }))
            }
          />
        </FieldGroup>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A scene whose screen, window or camera is gone: choose ones connected now,
 * and the scene keeps them. An app's scene never lands here: it waits for its
 * app's next window instead (S2).
 */
function SceneRepairDialog({
  scene,
  busy,
  error,
  onApply,
  onClose
}: {
  scene: SavedScene
  busy: boolean
  error: string | null
  onApply: (visual: SceneVisual) => Promise<void>
  onClose: () => void
}): ReactElement {
  const { deviceList } = useStudioCore()
  const [repair, setRepair] = useState<SceneVisual>(scene.visual)
  const [withoutBackground, setWithoutBackground] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve scene sources</DialogTitle>
          <DialogDescription>
            Choose sources that are connected now. “{scene.name}” keeps them.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <DevicePicker
            devices={deviceList.devices.filter((device) => device.kind === 'camera')}
            kind="camera"
            label="Camera"
            noneLabel="Off"
            value={repair.sources.cameraId}
            onChange={(cameraId) =>
              setRepair({ ...repair, sources: { ...repair.sources, cameraId } })
            }
          />
          <DevicePicker
            devices={deviceList.devices.filter(
              (device) => device.kind === 'screen' || device.kind === 'window'
            )}
            groupByKind
            kind="capture"
            label="Screen / window"
            noneLabel="None"
            searchable
            value={repair.sources.windowId ?? repair.sources.screenId}
            onChange={(id) => {
              const device = deviceList.devices.find((candidate) => candidate.id === id)
              setRepair({
                ...repair,
                sources: {
                  ...repair.sources,
                  screenId: device?.kind === 'screen' ? id : undefined,
                  screenName: device?.kind === 'screen' ? device.name : undefined,
                  windowId: device?.kind === 'window' ? id : undefined,
                  windowName: device?.kind === 'window' ? device.name : undefined,
                  testPattern: false
                }
              })
            }}
          />
          {repair.background ? (
            <Button
              aria-pressed={withoutBackground}
              variant="outline"
              onClick={() => setWithoutBackground(!withoutBackground)}
            >
              {withoutBackground ? 'Background omitted' : 'Apply without background'}
            </Button>
          ) : null}
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground" role="status">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || sceneSourceProblems(repair, deviceList.devices).length > 0}
            onClick={() =>
              void onApply({ ...repair, background: withoutBackground ? null : repair.background })
            }
          >
            Apply scene
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
