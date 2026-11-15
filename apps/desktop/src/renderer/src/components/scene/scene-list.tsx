import { CheckIcon } from '@/components/icons'
import { useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'

import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { KebabMenu } from '@/components/kebab-menu'
import { SceneGlyphIcon } from '@/components/scene/app-icon'
import { useSceneDialogs } from '@/components/scene/scene-dialogs'
import { SceneSwitchPending } from '@/components/scene/scene-switch-status'
import { SceneShortcutKeys } from '@/components/scene/scene-shortcut-keys'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import type { GlobalShortcutsConfig } from '@/lib/backend'
import { useAppIcons } from '@/hooks/use-app-icons'
import { useStudioCore } from '@/hooks/use-studio'
import { EDIT_SCENE_LABEL } from '@/lib/edit-scene'
import {
  MOVE_SCENE_DOWN_ACCELERATOR,
  MOVE_SCENE_UP_ACCELERATOR,
  saveSceneBlockedReason,
  savedSceneBlockedReason,
  sceneGlyph,
  sceneMoveKeyStep,
  sceneShows
} from '@/lib/scene-list'
import type { SavedScene } from '@/lib/scene-presets'
import { shortcutAriaKeys } from '@/lib/platform'
import { cn } from '@/lib/utils'

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

/**
 * The Scene page's scene list (plan 231 D2): your scenes in their order, the
 * same list as Studio's. A click puts a scene on stream; the canvas below
 * edits the scene that's on, and it keeps those edits (D11). A layout is a
 * choice inside a scene, made in the Layout section below. "Follow the app
 * in front" lives in Studio's Scenes section, the home of scenes (D8).
 */
export function SceneList({
  onEditScene
}: {
  /** Plan 215 D4: the page's own Edit scene (the camera, the editor on). */
  onEditScene: () => void
}): ReactElement {
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
    scene,
    sceneEditMode
  } = studio
  const dialogs = useSceneDialogs()
  const platform = runtimeInfo?.platform
  const glyphs = new Map(
    savedScenes.map((entry) => [entry.id, sceneGlyph(entry, deviceList.devices)])
  )
  const icons = useAppIcons(
    [...glyphs.values()].flatMap((glyph) => (glyph.kind === 'app' ? [glyph.bundleId] : []))
  )
  const readOnly = sceneLibraryActions.readOnly
  const saveReason = saveSceneBlockedReason({
    readOnly,
    connected: wsStatus === 'connected' && scene !== null,
    canSave: canSaveScene
  })

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const draggingIndex = savedScenes.findIndex((entry) => entry.id === draggingId)
  const endDrag = (): void => {
    setDraggingId(null)
    setDropIndex(null)
  }

  const saveButton = (
    <DisabledReason reason={saveReason}>
      <Button
        data-testid="scene-save"
        disabled={saveReason !== null}
        variant="outline"
        onClick={() => dialogs.open({ kind: 'save' })}
      >
        Save scene…
      </Button>
    </DisabledReason>
  )

  return (
    <PanelSection
      action={
        <>
          {/* Plan 215 D4: the editor's door on its own page, until it's on.
              Hidden, never unmounted: the first grab on the stage is what
              turns the editor on, and a header that loses a button at that
              pointerdown rewraps its description, the pane scroll-anchors,
              and the stage ends the gesture on that scroll. */}
          <Button
            className={cn(sceneEditMode && 'invisible')}
            data-testid="scene-edit"
            disabled={sceneEditMode}
            variant="outline"
            onClick={onEditScene}
          >
            {EDIT_SCENE_LABEL}
          </Button>
          {saveButton}
          <DisabledReason reason={readOnly ? READ_ONLY_REASON : null}>
            <Button
              data-testid="scene-new"
              disabled={readOnly}
              onClick={() => dialogs.open({ kind: 'new' })}
            >
              New scene…
            </Button>
          </DisabledReason>
        </>
      }
      data-videorc-scene-list=""
      description="Click a scene to put it on stream. Drag your scenes to change their order."
      title="Scenes"
    >
      {sceneLibraryError ? (
        <p className="text-meta text-muted-foreground" role="status">
          {sceneLibraryError}
        </p>
      ) : null}
      {/* Plan 231 D2: a scene is always on stream, and every scene is in this list. */}
      <GroupedList aria-label="Scenes">
        {savedScenes.map((entry, index) => {
          const blocked = savedSceneBlockedReason({
            scene: entry,
            appState: savedSceneAppStates[entry.id],
            devices: deviceList.devices
          })
          return (
            <SavedSceneRow
              key={entry.id}
              active={activeSavedSceneId === entry.id}
              blocked={blocked}
              dropEdge={
                dropIndex === index && draggingIndex >= 0 && draggingIndex !== index
                  ? draggingIndex < index
                    ? 'bottom'
                    : 'top'
                  : null
              }
              dragging={draggingId === entry.id}
              icon={<SceneGlyphIcon glyph={glyphs.get(entry.id)!} icons={icons} />}
              menu={dialogs.menuItems(entry)}
              needsSources={!entry.visual.sources.app && dialogs.needsSources(entry)}
              switching={savedScenePendingId === entry.id}
              platform={platform}
              readOnly={readOnly}
              scene={entry}
              shortcutConfig={settings.globalShortcuts}
              position={index + 1}
              onDragEnd={endDrag}
              onDragEnter={() => {
                if (draggingId && draggingId !== entry.id) setDropIndex(index)
              }}
              onDragStart={() => setDraggingId(entry.id)}
              onDrop={() => {
                if (draggingId && draggingId !== entry.id)
                  sceneLibraryActions.move(draggingId, index)
                endDrag()
              }}
              onMove={(step) => sceneLibraryActions.move(entry.id, index + step)}
              onSelect={() => dialogs.select(entry)}
            />
          )
        })}
      </GroupedList>
      {dialogs.element}
    </PanelSection>
  )
}

/**
 * One saved scene: its app's icon (or a glyph), its name, what it shows,
 * "Follows" while it follows its app, its key, and ⋯. The name is the row's
 * button, stretched over it; ⌥↑ and ⌥↓ move a focused row, and a drag moves
 * it with the pointer.
 */
function SavedSceneRow({
  scene,
  active,
  blocked,
  needsSources,
  switching,
  readOnly,
  shortcutConfig,
  position,
  platform,
  icon,
  menu,
  dragging,
  dropEdge,
  onSelect,
  onMove,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop
}: {
  scene: SavedScene
  active: boolean
  /** Why it can't go on stream now ("Figma isn't open"), or null. */
  blocked: string | null
  needsSources: boolean
  /** This scene is going on stream. Another row's click takes it over (issue #1275). */
  switching: boolean
  readOnly: boolean
  shortcutConfig: GlobalShortcutsConfig | undefined
  position: number
  platform: string | undefined
  icon: ReactElement
  menu: ReturnType<ReturnType<typeof useSceneDialogs>['menuItems']>
  dragging: boolean
  dropEdge: 'top' | 'bottom' | null
  onSelect: () => void
  onMove: (step: -1 | 1) => void
  onDragStart: () => void
  onDragEnter: () => void
  onDragEnd: () => void
  onDrop: () => void
}): ReactElement {
  const app = scene.visual.sources.app
  const moveFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (readOnly) return
    const step = sceneMoveKeyStep(event)
    if (step === null) return
    event.preventDefault()
    onMove(step)
  }
  return (
    <ListRow
      className={cn(
        'group/kebab-host relative',
        dragging && 'opacity-40',
        dropEdge &&
          'before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:bg-ring before:content-[""]',
        dropEdge === 'top' && 'before:top-0',
        dropEdge === 'bottom' && 'before:bottom-0'
      )}
      context={
        switching ? (
          <SceneSwitchPending />
        ) : (
          (blocked ?? (needsSources ? 'Resolve sources' : sceneShows(scene)))
        )
      }
      data-saved-scene={scene.id}
      draggable={!readOnly}
      icon={icon}
      interactive={!blocked}
      selected={active}
      title={
        <DisabledReason reason={blocked}>
          <ListRowButton
            aria-current={active || undefined}
            aria-keyshortcuts={
              readOnly
                ? undefined
                : `${shortcutAriaKeys(MOVE_SCENE_UP_ACCELERATOR, platform)} ${shortcutAriaKeys(MOVE_SCENE_DOWN_ACCELERATOR, platform)}`
            }
            className="disabled:text-muted-foreground"
            disabled={blocked !== null || switching}
            onClick={onSelect}
            onKeyDown={moveFromKeyboard}
          >
            {scene.name}
          </ListRowButton>
        </DisabledReason>
      }
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        onDrop()
      }}
    >
      {app?.follows ? <Badge variant="outline">Follows</Badge> : null}
      <SceneShortcutKeys
        sceneId={scene.id}
        position={position}
        config={shortcutConfig}
        platform={platform}
      />
      {active ? <CheckIcon aria-label="On stream" className="size-4" weight="bold" /> : null}
      <KebabMenu
        className="relative z-10"
        items={menu}
        label={`Actions for ${scene.name}`}
        reveal="hover"
      />
    </ListRow>
  )
}
