import { CheckIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { KebabMenu } from '@/components/kebab-menu'
import { SceneGlyphIcon } from '@/components/scene/app-icon'
import { useSceneDialogs } from '@/components/scene/scene-dialogs'
import {
  SCENES_READ_ONLY_REASON,
  ScenesLine,
  useSceneEntries,
  useSceneReorder,
  type SceneEntry
} from '@/components/scene/scene-entries'
import { SceneShortcutKeys } from '@/components/scene/scene-shortcut-keys'
import { SceneGalleryReason } from '@/components/studio/scene-card'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { useStudioCore } from '@/hooks/use-studio'
import { layoutPresetOrientation } from '@/lib/capture'
import { EDIT_SCENE_LABEL } from '@/lib/edit-scene'
import type { SceneVisual } from '@/lib/scene-presets'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The Scene page's scene list (plan 231 D8): the same list as Studio's Scenes
 * section, the home of scenes, as rows. Every scene in order, each with a
 * small picture of its layout and screen, the icon of what it shows, its
 * name, what it shows, its keys and ⋯. A click puts a scene on stream; a drag
 * or ⌥↑ ⌥↓ moves one, and the position keys move with the places (D5). Rows
 * and cards read their scenes through `useSceneEntries` and move through
 * `useSceneReorder`, so the two lists can't drift. The canvas below edits
 * the scene on stream, which keeps each edit (D11). "Follow the app in
 * front" lives in Studio's section.
 */
export function SceneList({
  onEditScene
}: {
  /** Plan 215 D4: the page's own Edit scene (the camera, the editor on). */
  onEditScene: () => void
}): ReactElement {
  const { sceneLibraryActions, sceneLibraryError, settings, runtimeInfo, sceneEditMode } =
    useStudioCore()
  const dialogs = useSceneDialogs()
  const platform = runtimeInfo?.platform
  const readOnly = sceneLibraryActions.readOnly
  const { entries, icons, cameraReason } = useSceneEntries(dialogs.needsSources)
  const reorder = useSceneReorder({
    axis: 'vertical',
    focusSelector: '[data-slot="list-row-button"]'
  })

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
            variant="ghost"
            onClick={onEditScene}
          >
            {EDIT_SCENE_LABEL}
          </Button>
          {/* Plan 231 D6: the same Add scene… as Studio's Scenes section. */}
          <DisabledReason reason={readOnly ? SCENES_READ_ONLY_REASON : null}>
            <Button
              data-testid="scene-new"
              disabled={readOnly}
              variant="outline"
              onClick={() => dialogs.open({ kind: 'add' })}
            >
              Add scene…
            </Button>
          </DisabledReason>
        </>
      }
      data-videorc-scene-list=""
      description={<ScenesLine config={settings.globalShortcuts} platform={platform} />}
      title="Scenes"
    >
      {sceneLibraryError ? (
        <p className="text-meta text-muted-foreground" role="status">
          {sceneLibraryError}
        </p>
      ) : null}
      {/* Plan 231 D2: a scene is always on stream, and every scene is in this list. */}
      <div ref={reorder.containerRef}>
        <GroupedList aria-label="Scenes">
          {entries.map((entry, index) => (
            <SceneRow
              key={entry.scene.id}
              dragProps={reorder.dragProps(entry.scene.id, index)}
              dragging={reorder.dragging(entry.scene.id)}
              dropEdge={reorder.dropEdge(index)}
              entry={entry}
              icon={<SceneGlyphIcon glyph={entry.glyph} icons={icons} />}
              keyShortcuts={reorder.keyShortcuts}
              keys={
                <SceneShortcutKeys
                  config={settings.globalShortcuts}
                  platform={platform}
                  position={entry.position}
                  sceneId={entry.scene.id}
                />
              }
              menu={dialogs.menuItems(entry.scene)}
              onMoveKey={reorder.onMoveKey(entry.scene.id, index)}
              onSelect={() => dialogs.select(entry.scene)}
            />
          ))}
        </GroupedList>
      </div>
      {/* Why some scenes can't be chosen, once, under the list (D9), as in Studio. */}
      <SceneGalleryReason
        action={
          <Button
            className="text-foreground"
            size="xs"
            variant="outline"
            onClick={() => openWorkspaceTab('sources')}
          >
            Open Sources
          </Button>
        }
        reason={cameraReason}
      />
      {dialogs.element}
    </PanelSection>
  )
}

/**
 * One scene: a small picture of its layout with its still in the screen area
 * (D7), the icon of what it shows, its name, what it shows (or why it can't
 * go on), "Follows" while it follows its app, its keys, the check while it's
 * on stream, and ⋯. The name is the row's button, stretched over it.
 */
function SceneRow({
  entry,
  icon,
  keys,
  menu,
  keyShortcuts,
  dragging,
  dropEdge,
  dragProps,
  onSelect,
  onMoveKey
}: {
  entry: SceneEntry
  icon: ReactElement
  keys: ReactElement
  menu: ReturnType<ReturnType<typeof useSceneDialogs>['menuItems']>
  keyShortcuts: string | undefined
  dragging: boolean
  dropEdge: ReturnType<ReturnType<typeof useSceneReorder>['dropEdge']>
  dragProps: ReturnType<ReturnType<typeof useSceneReorder>['dragProps']>
  onSelect: () => void
  onMoveKey: ReturnType<ReturnType<typeof useSceneReorder>['onMoveKey']>
}): ReactElement {
  const { scene, disabled, onStream } = entry
  return (
    <ListRow
      className={cn(
        'group/kebab-host relative',
        dragging && 'opacity-40',
        dropEdge &&
          'before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:bg-ring before:content-[""]',
        dropEdge === 'before' && 'before:top-0',
        dropEdge === 'after' && 'before:bottom-0'
      )}
      context={entry.meta}
      data-saved-scene={scene.id}
      icon={<span className={cn('flex', disabled && 'opacity-50')}>{icon}</span>}
      interactive={!disabled}
      leading={<SceneRowThumb disabled={disabled} picture={entry.picture} visual={scene.visual} />}
      selected={onStream}
      title={
        <DisabledReason reason={disabled ? entry.disabledReason : null}>
          <ListRowButton
            aria-current={onStream || undefined}
            aria-keyshortcuts={keyShortcuts}
            className="disabled:text-muted-foreground"
            disabled={disabled}
            onClick={onSelect}
          >
            {scene.name}
          </ListRowButton>
        </DisabledReason>
      }
      {...dragProps}
      // ⌥↑ ⌥↓ on the row's name, or on its reason while it can't go on.
      onKeyDown={onMoveKey}
    >
      {scene.visual.sources.app?.follows ? <Badge variant="outline">Follows</Badge> : null}
      {keys}
      {onStream ? <CheckIcon aria-label="On stream" className="size-4" weight="bold" /> : null}
      <KebabMenu
        className="relative z-10"
        items={menu}
        label={`Actions for ${scene.name}`}
        reveal="hover"
      />
    </ListRow>
  )
}

/**
 * The row's picture (D7): the scene's layout for the studio's orientation at
 * icon size, with its still in the screen area, the same picture as its card
 * in Studio. A 9:16 layout stands upright in the same 16:9 box, so the names
 * line up.
 */
function SceneRowThumb({
  visual,
  picture,
  disabled
}: {
  visual: SceneVisual
  picture: string | undefined
  disabled: boolean
}): ReactElement {
  const { layoutPreset, verticalScreenFraming } = visual.layout
  const vertical = layoutPresetOrientation(layoutPreset) === 'vertical'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex aspect-video h-6 shrink-0 items-center justify-center',
        disabled && 'opacity-50'
      )}
      data-slot="scene-row-thumb"
    >
      <LayoutThumb
        className={vertical ? 'h-full w-auto' : undefined}
        compact
        framing={verticalScreenFraming}
        picture={picture}
        preset={layoutPreset}
      />
    </span>
  )
}
