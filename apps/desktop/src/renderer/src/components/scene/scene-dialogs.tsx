import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'

import { withGlobalShortcut } from '../../../../shared/global-shortcut-bindings'
import { globalShortcutEntries } from '../../../../shared/global-shortcuts'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { DevicePicker } from '@/components/device-picker'
import type { KebabMenuItem } from '@/components/kebab-menu'
import { ScenePickerDialog, type ScenePickerMode } from '@/components/scene/scene-picker-dialog'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { Alert, AlertTitle } from '@/components/ui/alert'
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
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset } from '@/lib/backend'
import {
  buildCaptureSources,
  hasSelectedCameraSource,
  layoutPresetOrientation
} from '@/lib/capture'
import { globalShortcutRegistration } from '@/lib/global-shortcuts'
import { globalShortcutTakenReason } from '@/lib/global-shortcut-owner'
import { newScenes, sceneShowingPick, type ScreenPick } from '@/lib/scene-app-picker'
import { duplicatedScene, sceneWithAudio, sceneWithFollow } from '@/lib/scene-list'
import {
  SCENE_GUEST_PLACEMENTS,
  SCENE_GUEST_PLACEMENT_LABELS,
  sceneGuestPlacement,
  sceneWithGuestRoles,
  type SceneGuestPlacement
} from '@/lib/scene-guest-roles'
import {
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  sceneSourceProblems,
  type SavedScene,
  type SceneVisual
} from '@/lib/scene-presets'
import { canDeleteScene, showsSources } from '@/lib/scenes'

/** One dialog at a time, for the scene list and the Studio gallery alike. */
export type SceneDialogRequest =
  | { kind: 'add' }
  /** `forLayout`: D19, the layout chosen on a scene that shows no screen. */
  | { kind: 'change-screen'; scene: SavedScene; forLayout?: LayoutPreset }
  | { kind: 'rename'; scene: SavedScene }
  | { kind: 'key'; scene: SavedScene }
  | { kind: 'guests'; scene: SavedScene }
  | { kind: 'delete'; scene: SavedScene }
  | { kind: 'repair'; scene: SavedScene; error?: string }

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

/** D19: the layout that waits for the screen Change screen… put on stream. */
type LayoutAfterScreen = {
  preset: LayoutPreset
  sceneId: string
  /** The capture that means the screen landed; null for an app's window, any capture. */
  captureId: string | null
  /** The layout on stream when it was asked: another layout chosen since wins. */
  layoutBefore: LayoutPreset
}

/**
 * Why Change screen… can't change a scene now, or null. Only the scene on
 * stream can be refused: its screen is the stream's (a Linux session can't
 * change screens mid-session, a switch in flight).
 */
export function changeScreenBlockedReason(
  studio: Pick<
    ReturnType<typeof useStudioCore>,
    'sceneLibraryActions' | 'activeSavedSceneId' | 'sourceSwitchReason'
  >,
  sceneId: string
): string | null {
  if (studio.sceneLibraryActions.readOnly) return READ_ONLY_REASON
  return sceneId === studio.activeSavedSceneId ? studio.sourceSwitchReason('capture') : null
}

/**
 * Add scene…, Change screen…, a scene's ⋯ actions and their dialogs, in one
 * place, so the Scene page's list and Studio's Scenes section say and do the
 * same (plan 210 S5, plan 231 S7). Nothing here toasts a success: the list
 * and the stage show it (owner call, 2026-07-16).
 */
export function useSceneDialogs(): {
  open: (request: SceneDialogRequest) => void
  /** Put a scene on stream; one whose sources are gone asks for new ones. */
  select: (scene: SavedScene) => void
  /** Whether a scene needs its sources chosen again before it can go on. */
  needsSources: (scene: SavedScene) => boolean
  menuItems: (scene: SavedScene) => KebabMenuItem[]
  busy: boolean
  element: ReactElement
} {
  const studio = useStudioCore()
  const { savedScenes, sceneLibraryActions, deviceList, captureConfig, applyCameraPreset } = studio
  const [request, setRequest] = useState<SceneDialogRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [afterScreen, setAfterScreen] = useState<LayoutAfterScreen | null>(null)
  const now = (): string => new Date().toISOString()
  const close = (): void => setRequest(null)

  // D19: the layout goes on once the stream shows the screen chosen for it,
  // never on the screen before. Cancel never gets here: the layout stays.
  const sceneOnStreamId = studio.sceneOnStream?.id
  const layoutOnStream = captureConfig.layout.layoutPreset
  const capturing = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  useEffect(() => {
    if (!afterScreen) return
    if (sceneOnStreamId !== afterScreen.sceneId || layoutOnStream !== afterScreen.layoutBefore) {
      setAfterScreen(null)
      return
    }
    if (afterScreen.captureId ? capturing !== afterScreen.captureId : !capturing) return
    setAfterScreen(null)
    applyCameraPreset({ layoutPreset: afterScreen.preset })
  }, [afterScreen, capturing, sceneOnStreamId, layoutOnStream, applyCameraPreset])

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
      // A refusal in words ("Figma isn't open") is already a warning toast,
      // and a switch a newer click took over didn't fail (issue #1275).
      if (!result.ok && !result.reason && !result.superseded) {
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

  /**
   * Add scene… (D6): each pick a scene in the look of the scene on stream, at
   * the end of the list with its position key (D5). What's on stream stays:
   * nothing is applied and the scene on stream doesn't change.
   */
  const addScenes = (picks: readonly ScreenPick[]): void => {
    const template = studio.sceneOnStream
    if (!template || picks.length === 0) return
    const { scenes, windowHints } = newScenes(picks, template, savedScenes, {
      cameraOn: hasSelectedCameraSource(captureConfig.sources),
      id: () => crypto.randomUUID(),
      now
    })
    if (sceneLibraryActions.add(scenes, windowHints)) close()
  }

  /**
   * Change screen… (D6): the scene shows the pick. On the scene on stream the
   * stream changes with it (D2), through the same paths as a Screen pick and
   * a scene switch; any other scene changes alone.
   */
  const changeScreen = (pick: ScreenPick): void => {
    if (request?.kind !== 'change-screen') return
    const { scene: listed, forLayout } = request
    const stored = sceneLibraryActions.stored(listed.id)
    if (!stored) return
    const next = sceneShowingPick(stored, pick, savedScenes, now())
    const windowHint = pick.kind === 'app' ? pick.app.frontWindowId : undefined
    if (listed.id !== studio.activeSavedSceneId) {
      if (sceneLibraryActions.edit(next, windowHint)) close()
      return
    }
    close()
    const after = (captureId: string | null): LayoutAfterScreen | null =>
      forLayout
        ? { preset: forLayout, sceneId: listed.id, captureId, layoutBefore: layoutOnStream }
        : null
    if (pick.kind === 'display' || pick.kind === 'window') {
      // The Screen pick of D2. The scene shows it from now on, written here
      // too and not only once a recording confirms the switch: D19's layout
      // goes on after it, and a scene that shows none would refuse it.
      if (!sceneLibraryActions.edit(next, windowHint)) return
      setAfterScreen(after(pick.device.id))
      void studio
        .switchSourceDeviceLive(
          'capture',
          buildCaptureSources(captureConfig.sources, [pick.device], pick.device.id)
        )
        .catch(() => setAfterScreen(null))
      return
    }
    if (!sceneLibraryActions.edit(next, windowHint)) return
    if (pick.kind === 'none') {
      // This is an explicit stop, unlike switching to a no-screen scene (D18).
      const layout = next.layouts[layoutPresetOrientation(layoutOnStream)]
      void studio
        .switchSourceDeviceLive(
          'capture',
          buildCaptureSources(captureConfig.sources, deviceList.devices, undefined)
        )
        .then(() => {
          if (layout.layoutPreset !== layoutOnStream)
            applyCameraPreset({ layoutPreset: layout.layoutPreset })
        })
      return
    }
    // An app: the scene goes on again with the app's front window, then the
    // layout D19 asked for.
    const visual: SceneVisual = {
      ...listed.visual,
      sources: { ...listed.visual.sources, ...showsSources(next.shows), windowId: windowHint }
    }
    void apply({ ...listed, name: next.name, visual }, visual).then((ok) => {
      if (ok) setAfterScreen(after(null))
    })
  }

  // D16: the scene a switch is putting on stream can't go while it switches.
  const deleteVerdict = (scene: SavedScene): ReturnType<typeof canDeleteScene> =>
    canDeleteScene({
      scenes: savedScenes,
      id: scene.id,
      onStreamId: studio.activeSavedSceneId ?? '',
      sessionActive: studio.isSessionActive,
      goingOn: studio.savedScenePendingId === scene.id
    })
  /** What deleting says it does: the scene before it goes on stream when it was on (D16). */
  const deleteDescription = (scene: SavedScene): string => {
    const verdict = deleteVerdict(scene)
    const next =
      verdict.allowed && verdict.switchToId
        ? savedScenes.find((entry) => entry.id === verdict.switchToId)
        : undefined
    return next
      ? `“${scene.name}” and its key are deleted. “${next.name}” goes on stream.`
      : `“${scene.name}” and its key are deleted. What’s on stream stays as it is.`
  }

  /**
   * The ⋯ menu (D11): Rename…, Change screen…, Set key…; Follow or Stop
   * following (app scenes) and Save audio to scene; Duplicate; Delete.
   */
  const menuItems = (scene: SavedScene): KebabMenuItem[] => {
    const app = scene.visual.sources.app
    const readOnly = sceneLibraryActions.readOnly
    const writes = { disabled: readOnly, disabledReason: readOnly ? READ_ONLY_REASON : null }
    const deletion = deleteVerdict(scene)
    const screenReason = changeScreenBlockedReason(studio, scene.id)
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
        id: 'screen',
        label: 'Change screen…',
        group: 'edit',
        disabled: screenReason !== null,
        disabledReason: screenReason,
        onSelect: () => setRequest({ kind: 'change-screen', scene })
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
      // Plan 249 S12 (D7): where a talk show's guests go while this scene is
      // on the room program.
      {
        id: 'guests',
        label: 'Guests in the room…',
        group: 'keeps',
        ...writes,
        onSelect: () => setRequest({ kind: 'guests', scene })
      },
      {
        id: 'duplicate',
        label: 'Duplicate',
        group: 'copy',
        ...writes,
        // Another one like this, at the end (D5, D6).
        onSelect: () => {
          const stored = sceneLibraryActions.stored(scene.id)
          if (stored)
            sceneLibraryActions.add([
              duplicatedScene(stored, savedScenes, { id: crypto.randomUUID(), now: now() })
            ])
        }
      },
      {
        id: 'delete',
        label: 'Delete',
        destructive: true,
        // Plan 231 D16: the last scene stays, and so does the scene on stream
        // while recording or live.
        disabled: readOnly || !deletion.allowed,
        disabledReason: readOnly ? READ_ONLY_REASON : deletion.allowed ? null : deletion.reason,
        onSelect: () => setRequest({ kind: 'delete', scene })
      }
    ]
  }

  const changing = request?.kind === 'change-screen' ? request : null
  const changingStored = changing ? sceneLibraryActions.stored(changing.scene.id) : undefined
  const pickerMode: ScenePickerMode | null =
    request?.kind === 'add'
      ? { kind: 'add' }
      : changing && changingStored
        ? {
            kind: 'change',
            scene: changingStored,
            onStream: changing.scene.id === studio.activeSavedSceneId,
            forLayout: changing.forLayout
          }
        : null

  const element = (
    <>
      <ScenePickerDialog
        mode={pickerMode ?? { kind: 'add' }}
        open={pickerMode !== null}
        onAdd={addScenes}
        onChange={changeScreen}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      />
      {request?.kind === 'rename' ? (
        <RenameSceneDialog
          key={request.scene.id}
          scene={request.scene}
          scenes={savedScenes}
          onClose={close}
          onSubmit={(name) => studio.renameSavedScene(request.scene.id, name)}
        />
      ) : null}
      {request?.kind === 'key' ? (
        <SceneKeyDialog key={request.scene.id} scene={request.scene} onClose={close} />
      ) : null}
      {request?.kind === 'guests' ? (
        <SceneGuestsDialog
          key={request.scene.id}
          scene={request.scene}
          onClose={close}
          onSave={(placement) =>
            sceneLibraryActions.replace(sceneWithGuestRoles(request.scene, placement, now()))
          }
        />
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
        description={request?.kind === 'delete' ? deleteDescription(request.scene) : ''}
        open={request?.kind === 'delete'}
        testId="scene-delete"
        title="Delete scene?"
        onCancel={close}
        onConfirm={() => {
          if (request?.kind !== 'delete') return
          void studio.deleteSavedScene(request.scene.id).then((deleted) => {
            if (deleted) close()
          })
        }}
      />
    </>
  )

  return { open: setRequest, select, needsSources, menuItems, busy, element }
}

/**
 * Guests in the room… (plan 249 S12, D7): where a talk show's guests go
 * while this scene is on the room program. Saved with the scene; its own
 * layout is unchanged, and no guest is ever taken off the stage.
 */
function SceneGuestsDialog({
  scene,
  onSave,
  onClose
}: {
  scene: SavedScene
  onSave: (placement: SceneGuestPlacement) => boolean
  onClose: () => void
}): ReactElement {
  const [placement, setPlacement] = useState<SceneGuestPlacement>(() => sceneGuestPlacement(scene))
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Guests in the room</DialogTitle>
          <DialogDescription>
            Where guests go while “{scene.name}” is on a talk show’s program. The scene keeps its
            own layout.
          </DialogDescription>
        </DialogHeader>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel id="scene-guests-label">Guests</FieldLabel>
          <SegmentedControl
            aria-labelledby="scene-guests-label"
            className="w-fit"
            id="scene-guests"
            options={SCENE_GUEST_PLACEMENTS.map((value) => ({
              value,
              label: SCENE_GUEST_PLACEMENT_LABELS[value]
            }))}
            size="sm"
            value={placement}
            onValueChange={(value) => {
              setPlacement(value)
              setError(null)
            }}
          />
          <FieldDescription>
            {error ??
              (placement === 'over'
                ? 'The scene fills the frame; guests sit in small boxes along its bottom edge.'
                : placement === 'below'
                  ? 'The scene sits above; guests share a band along the bottom.'
                  : 'The scene sits to one side; guests share the rest of the frame.')}
          </FieldDescription>
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (onSave(placement)) onClose()
              else setError("Couldn't save. Check your free space, then try again.")
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Rename…: one name, unique, 1 to 80 characters. */
function RenameSceneDialog({
  scene,
  scenes,
  onSubmit,
  onClose
}: {
  scene: SavedScene
  scenes: readonly SavedScene[]
  onSubmit: (name: string) => boolean
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(scene.name)
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    const invalid = sceneNameError(name, scenes, scene.id)
    if (invalid) {
      setError(invalid)
      return
    }
    if (onSubmit(name)) onClose()
    else setError("Couldn't rename the scene. Check your free space, then try again.")
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Rename scene</DialogTitle>
          <DialogDescription className="sr-only">Give the scene a new name.</DialogDescription>
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
          <Button onClick={submit}>Rename</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The Set key dialog's description. Under Wayland (`globalShortcutsUnavailable`
 * set by main) no global key is registered at all, so it says the key won't work
 * here instead of promising it works from any app.
 */
export function sceneKeyDescription(
  sceneName: string,
  globalShortcutsUnavailable?: string | null
): string {
  return globalShortcutsUnavailable
    ? `This Wayland session can't hear keys while Videorc is in the background, so a key for “${sceneName}” won't work here. Click the field and press the keys.`
    : `Puts “${sceneName}” on stream from any app. Click the field and press the keys.`
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
            {sceneKeyDescription(scene.name, runtimeInfo?.globalShortcutsUnavailable)}
          </DialogDescription>
        </DialogHeader>
        {runtimeInfo?.globalShortcutsUnavailable ? (
          <Alert data-testid="scene-key-unavailable" variant="warning">
            <AlertTitle>{runtimeInfo.globalShortcutsUnavailable}</AlertTitle>
          </Alert>
        ) : null}
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
                  screenUuid: device?.kind === 'screen' ? device.displayUuid : undefined,
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
