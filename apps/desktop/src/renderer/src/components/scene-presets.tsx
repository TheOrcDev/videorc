import type { ReactElement } from 'react'

import { KebabMenu } from '@/components/kebab-menu'
import { AppIconImage } from '@/components/scene/app-icon'
import { useSceneDialogs } from '@/components/scene/scene-dialogs'
import { SceneSwitchPending } from '@/components/scene/scene-switch-status'
import { SceneShortcutKeys } from '@/components/scene/scene-shortcut-keys'
import { SceneCard } from '@/components/studio/scene-card'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { useAppIcons } from '@/hooks/use-app-icons'
import { useStudioCore } from '@/hooks/use-studio'
import { saveSceneBlockedReason, savedSceneBlockedReason } from '@/lib/scene-list'

/**
 * Studio's scenes (plan 231 D2): the Scenes gallery, in the library's order,
 * each drawn in its layout for the studio's orientation. A click puts one on
 * stream; a card made for an app wears the app's icon; ⋯ holds the same
 * actions as the Scene page's list. New scene… and Save scene… sit above
 * the cards until Add scene… replaces them (S7).
 * A lazy chunk: the dialogs it carries stay out of the Studio's first paint.
 */
export function ScenePresetControls(): ReactElement {
  const studio = useStudioCore()
  const {
    savedScenes,
    activeSavedSceneId,
    savedScenePendingId,
    savedSceneAppStates,
    sceneLibraryActions,
    sceneLibraryError,
    deviceList,
    settings,
    runtimeInfo,
    canSaveScene,
    wsStatus,
    scene
  } = studio
  const dialogs = useSceneDialogs()
  const icons = useAppIcons(
    savedScenes.flatMap((entry) =>
      entry.visual.sources.app ? [entry.visual.sources.app.bundleId] : []
    )
  )
  const saveReason = saveSceneBlockedReason({
    readOnly: sceneLibraryActions.readOnly,
    connected: wsStatus === 'connected' && scene !== null,
    canSave: canSaveScene
  })
  return (
    <div className="flex flex-col gap-2" data-videorc-saved-scenes="">
      <div className="flex min-h-7 items-center justify-end gap-2">
        <div className="flex items-center gap-1.5">
          <DisabledReason reason={saveReason}>
            <Button
              disabled={saveReason !== null}
              variant="ghost"
              onClick={() => dialogs.open({ kind: 'save' })}
            >
              Save scene…
            </Button>
          </DisabledReason>
          <DisabledReason
            reason={sceneLibraryActions.readOnly ? 'Update Videorc to change your scenes.' : null}
          >
            <Button
              disabled={sceneLibraryActions.readOnly}
              variant="ghost"
              onClick={() => dialogs.open({ kind: 'new' })}
            >
              New scene…
            </Button>
          </DisabledReason>
        </div>
      </div>
      {sceneLibraryError ? (
        <p className="text-sm text-muted-foreground" role="status">
          {sceneLibraryError}
        </p>
      ) : null}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
        {savedScenes.map((entry, index) => {
          const app = entry.visual.sources.app
          const selected = activeSavedSceneId === entry.id
          const pending = savedScenePendingId === entry.id
          const blocked = savedSceneBlockedReason({
            scene: entry,
            appState: savedSceneAppStates[entry.id],
            devices: deviceList.devices
          })
          // One SceneCard for every scene (plan 174 S3.3, B-20): the
          // selected look and its check say which one is on.
          return (
            <SceneCard
              key={entry.id}
              data-saved-scene={entry.id}
              // Another scene's click takes a pending switch over (issue #1275).
              disabled={blocked !== null || pending}
              disabledReason={blocked}
              icon={app ? <AppIconImage icon={icons.get(app.bundleId)} /> : undefined}
              label={entry.name}
              menu={
                <KebabMenu
                  items={dialogs.menuItems(entry)}
                  label={`Actions for ${entry.name}`}
                  reveal="hover"
                />
              }
              meta={
                <span className="flex flex-col gap-1">
                  {pending ? (
                    <SceneSwitchPending />
                  ) : (
                    (blocked ?? (!app && dialogs.needsSources(entry) ? 'Resolve sources' : null))
                  )}
                  <SceneShortcutKeys
                    sceneId={entry.id}
                    position={index + 1}
                    config={settings.globalShortcuts}
                    platform={runtimeInfo?.platform}
                  />
                </span>
              }
              selected={selected}
              thumb={
                <LayoutThumb
                  framing={entry.visual.layout.verticalScreenFraming}
                  preset={entry.visual.layout.layoutPreset}
                />
              }
              onSelect={() => dialogs.select(entry)}
            />
          )
        })}
      </div>
      {dialogs.element}
    </div>
  )
}
export default ScenePresetControls
