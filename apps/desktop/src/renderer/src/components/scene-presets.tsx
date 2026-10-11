import { layoutPresetOrientation } from '@/lib/capture'
import { useState, type ReactElement } from 'react'
import { useStudioCore } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { KebabMenu } from '@/components/kebab-menu'
import { DevicePicker } from '@/components/device-picker'
import { SceneCard } from '@/components/studio/scene-card'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import {
  sceneNameError,
  sceneSourceProblems,
  type SavedScene,
  type SceneVisual
} from '@/lib/scene-presets'

type DialogAction = { kind: 'save' | 'rename' | 'delete' | 'repair'; scene?: SavedScene }
export function ScenePresetControls({ toolbar = false }: { toolbar?: boolean }): ReactElement {
  const studio = useStudioCore()
  const {
    savedScenes,
    activeSavedSceneId,
    savedSceneModified,
    savedScenePendingId,
    canSaveScene,
    sceneLibraryError,
    deviceList
  } = studio
  const [action, setAction] = useState<DialogAction | null>(null)
  const [name, setName] = useState('')
  const [repair, setRepair] = useState<SceneVisual | null>(null)
  const [withoutBackground, setWithoutBackground] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = savedScenes.find((entry) => entry.id === activeSavedSceneId)
  const open = (next: DialogAction): void => {
    setAction(next)
    setName(next.scene?.name ?? '')
    setRepair(next.scene?.visual ?? null)
    setWithoutBackground(false)
    setError(null)
  }
  const submitName = (): void => {
    const invalid = sceneNameError(name, savedScenes, action?.scene?.id)
    if (invalid) {
      setError(invalid)
      return
    }
    const success =
      action?.kind === 'rename' && action.scene
        ? studio.renameSavedScene(action.scene.id, name)
        : studio.saveScene(name, action?.scene?.id)
    if (success) setAction(null)
    else setError("Couldn't save. Wait for pending edits or check available storage.")
  }
  const apply = async (scene: SavedScene, visual?: SceneVisual): Promise<void> => {
    setBusy(true)
    try {
      const success = await studio.applySavedScene(scene.id, visual)
      if (!success) {
        open({ kind: 'repair', scene })
        setError("The scene couldn't be applied. Check its sources and background, then try again.")
      } else setAction(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {toolbar ? (
        // The Scene page's section actions (plan 174 S3.9, C-23 and V-10):
        // "Update “{name}”" once the applied saved scene drifts, then Save
        // scene. The section's own description names the scene and its state.
        <>
          {active && savedSceneModified ? (
            <Button
              data-testid="scene-update-saved"
              disabled={!canSaveScene}
              variant="outline"
              onClick={() => open({ kind: 'save', scene: active })}
            >
              Update “{active.name}”…
            </Button>
          ) : null}
          <Button disabled={!canSaveScene} variant="ghost" onClick={() => open({ kind: 'save' })}>
            Save scene…
          </Button>
        </>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Saved scenes</span>
          <Button variant="ghost" disabled={!canSaveScene} onClick={() => open({ kind: 'save' })}>
            Save scene…
          </Button>
        </div>
      )}
      {!toolbar ? (
        <>
          {sceneLibraryError ? (
            <p role="status" className="text-sm text-muted-foreground">
              {sceneLibraryError}
            </p>
          ) : null}
          {!savedScenes.length ? (
            <p className="text-xs text-muted-foreground">
              Save your sources, framing and background together.
            </p>
          ) : null}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
            {savedScenes.map((scene) => {
              const problems = sceneSourceProblems(scene.visual, deviceList.devices)
              const selected = activeSavedSceneId === scene.id
              const orientationLocked =
                studio.isSessionActive &&
                layoutPresetOrientation(studio.captureConfig.layout.layoutPreset) !==
                  layoutPresetOrientation(scene.visual.layout.layoutPreset)
              // One SceneCard for every scene (plan 174 S3.3, B-20): the
              // selected look and its check replace "✓ Applied".
              return (
                <SceneCard
                  key={scene.id}
                  data-saved-scene={scene.id}
                  disabled={orientationLocked || busy || savedScenePendingId === scene.id}
                  disabledReason={
                    orientationLocked
                      ? 'Stop the recording or stream before switching orientation.'
                      : null
                  }
                  label={savedScenePendingId === scene.id ? 'Switching…' : scene.name}
                  menu={
                    <KebabMenu
                      label={`Actions for ${scene.name}`}
                      reveal="hover"
                      items={[
                        {
                          id: 'update',
                          label: 'Update saved scene…',
                          disabled: !selected || !canSaveScene,
                          onSelect: () => open({ kind: 'save', scene })
                        },
                        {
                          id: 'save-as',
                          label: 'Save as new scene…',
                          disabled: !canSaveScene,
                          onSelect: () => open({ kind: 'save' })
                        },
                        {
                          id: 'rename',
                          label: 'Rename…',
                          onSelect: () => open({ kind: 'rename', scene })
                        },
                        {
                          id: 'repair',
                          label: 'Resolve sources',
                          onSelect: () => open({ kind: 'repair', scene })
                        },
                        {
                          id: 'delete',
                          label: 'Delete',
                          destructive: true,
                          onSelect: () => open({ kind: 'delete', scene })
                        }
                      ]}
                    />
                  }
                  meta={
                    problems.length
                      ? 'Resolve sources'
                      : selected && savedSceneModified
                        ? 'Modified'
                        : undefined
                  }
                  selected={selected}
                  thumb={
                    <LayoutThumb
                      framing={scene.visual.layout.verticalScreenFraming}
                      preset={scene.visual.layout.layoutPreset}
                    />
                  }
                  onSelect={() =>
                    problems.length ? open({ kind: 'repair', scene }) : void apply(scene)
                  }
                />
              )
            })}
          </div>
        </>
      ) : null}
      {/* The delete is the model confirm (plan 174 S0.3): what is lost, in
          one sentence, behind the one recipe. */}
      <ConfirmDialog
        confirmLabel="Delete scene"
        description="Only the saved snapshot is deleted. Your current scene and recording continue."
        open={action?.kind === 'delete'}
        testId="scene-delete"
        title="Delete saved scene?"
        onCancel={() => setAction(null)}
        onConfirm={() => {
          if (action?.scene && studio.deleteSavedScene(action.scene.id)) setAction(null)
        }}
      />
      <Dialog
        open={action !== null && action.kind !== 'delete'}
        onOpenChange={(value) => {
          if (!value) setAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === 'repair'
                ? 'Resolve scene sources'
                : action?.kind === 'rename'
                  ? 'Rename scene'
                  : action?.scene
                    ? 'Update saved scene'
                    : 'Save scene'}
            </DialogTitle>
            <DialogDescription>
              {action?.kind === 'repair'
                ? 'Choose exact replacement sources. Repairs change the working scene; use Update to replace its saved snapshot.'
                : 'Save the visual setup. Audio, recording and streaming settings stay separate.'}
            </DialogDescription>
          </DialogHeader>
          {action?.kind === 'repair' && repair ? (
            <div className="flex flex-col gap-4">
              <DevicePicker
                kind="camera"
                label="Camera"
                noneLabel="Off"
                devices={deviceList.devices.filter((device) => device.kind === 'camera')}
                value={repair.sources.cameraId}
                onChange={(cameraId) =>
                  setRepair({ ...repair, sources: { ...repair.sources, cameraId } })
                }
              />
              <DevicePicker
                kind="capture"
                label="Screen / window"
                searchable
                groupByKind
                noneLabel="None"
                devices={deviceList.devices.filter(
                  (device) => device.kind === 'screen' || device.kind === 'window'
                )}
                value={repair.sources.windowId ?? repair.sources.screenId}
                onChange={(id) => {
                  const device = deviceList.devices.find((candidate) => candidate.id === id)
                  setRepair({
                    ...repair,
                    sources: {
                      ...repair.sources,
                      screenId: device?.kind === 'screen' ? id : undefined,
                      windowId: device?.kind === 'window' ? id : undefined,
                      testPattern: false
                    }
                  })
                }}
              />
              {repair.background ? (
                <Button
                  variant="outline"
                  aria-pressed={withoutBackground}
                  onClick={() => setWithoutBackground(!withoutBackground)}
                >
                  {withoutBackground ? 'Background omitted' : 'Apply without background'}
                </Button>
              ) : null}
            </div>
          ) : (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="scene-preset-name">Name</FieldLabel>
              <Input
                id="scene-preset-name"
                autoFocus
                maxLength={80}
                value={name}
                aria-invalid={Boolean(error)}
                aria-describedby="scene-preset-error"
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitName()
                }}
              />
              <FieldDescription id="scene-preset-error">
                {error ?? 'Names must be unique.'}
              </FieldDescription>
            </Field>
          )}
          {error && action?.kind === 'repair' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              Cancel
            </Button>
            {action?.kind === 'repair' ? (
              <Button
                disabled={
                  busy || !repair || sceneSourceProblems(repair, deviceList.devices).length > 0
                }
                onClick={() => {
                  if (action.scene && repair)
                    void apply(action.scene, {
                      ...repair,
                      background: withoutBackground ? null : repair.background
                    })
                }}
              >
                Apply scene
              </Button>
            ) : (
              <Button disabled={action?.kind === 'save' && !canSaveScene} onClick={submitName}>
                {action?.kind === 'rename' ? 'Rename' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
export default ScenePresetControls
