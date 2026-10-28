import { CheckIcon, LayoutIcon } from '@/components/icons'
import { useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'

import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { KebabMenu } from '@/components/kebab-menu'
import { SceneGlyphIcon } from '@/components/scene/app-icon'
import { useSceneDialogs } from '@/components/scene/scene-dialogs'
import { SectionLabel } from '@/components/section-label'
import { SceneGalleryReason } from '@/components/studio/scene-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useAppIcons } from '@/hooks/use-app-icons'
import { useStudioCore } from '@/hooks/use-studio'
import type { LayoutPreset } from '@/lib/backend'
import { layoutPresetOrientation } from '@/lib/capture'
import { BUILTIN_LAYOUTS } from '@/lib/layout-framing-memory'
import { layoutPresetLabel } from '@/lib/layout-labels'
import {
  MOVE_SCENE_DOWN_ACCELERATOR,
  MOVE_SCENE_UP_ACCELERATOR,
  saveSceneBlockedReason,
  savedSceneBlockedReason,
  sceneGlyph,
  sceneListActive,
  sceneMoveKeyStep,
  sceneShows
} from '@/lib/scene-list'
import {
  sceneGalleryReason,
  sceneSourceGaps,
  visualSources,
  type SavedScene
} from '@/lib/scene-presets'
import { shortcutAriaKeys } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

/**
 * The Scene page's scene list (plan 210 D6): what's on stream, your saved
 * scenes in their order, then the current orientation's layouts. A click
 * puts a scene on stream, as in Studio; the canvas below edits the scene
 * that's on, and a saved scene keeps those edits (D3).
 */
export function SceneList(): ReactElement {
  const studio = useStudioCore()
  const {
    savedScenes,
    activeSavedSceneId,
    savedScenePendingId,
    savedSceneAppStates,
    sceneLibraryActions,
    sceneLibraryError,
    captureConfig,
    deviceList,
    settings,
    runtimeInfo,
    isSessionActive,
    layoutSwitchPending,
    applyCameraPreset,
    canSaveScene,
    wsStatus,
    scene
  } = studio
  const dialogs = useSceneDialogs()
  const platform = runtimeInfo?.platform
  const orientation = layoutPresetOrientation(captureConfig.layout.layoutPreset)
  const active = sceneListActive({
    activeSavedSceneId,
    origin: sceneLibraryActions.workingOrigin,
    layout: captureConfig.layout
  })
  const working = { visual: sceneLibraryActions.workingVisual }
  const workingGlyph = sceneGlyph(working, deviceList.devices)
  const glyphs = new Map(
    savedScenes.map((entry) => [entry.id, sceneGlyph(entry, deviceList.devices)])
  )
  const icons = useAppIcons(
    [...glyphs.values(), workingGlyph].flatMap((glyph) =>
      glyph.kind === 'app' ? [glyph.bundleId] : []
    )
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

  // Built-in layouts keep today's behaviour: the current sources in that
  // arrangement, leaving any saved scene (plan 210 D6).
  const layouts = BUILTIN_LAYOUTS.filter(
    ({ id }) => layoutPresetOrientation(id) === orientation
  ).map(({ id }) => ({
    id,
    label: layoutPresetLabel(id),
    gaps: sceneSourceGaps(
      {
        layout: { ...captureConfig.layout, layoutPreset: id, arrangementMode: 'preset' },
        sources: visualSources(captureConfig.sources),
        background: null
      },
      deviceList.devices
    )
  }))
  const layoutReason = sceneGalleryReason(layouts)

  const saveButton = (size?: 'xs'): ReactElement => (
    <DisabledReason reason={saveReason}>
      <Button
        data-testid="scene-save"
        disabled={saveReason !== null}
        size={size}
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
          {saveButton()}
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
      {active.kind === 'unsaved' ? (
        <GroupedList aria-label="On stream">
          <ListRow
            data-unsaved-scene=""
            icon={<SceneGlyphIcon glyph={workingGlyph} icons={icons} />}
            context={sceneShows(working)}
            selected
            title="Unsaved scene"
          >
            {saveButton('xs')}
            <CheckIcon aria-label="On stream" className="size-4" weight="bold" />
          </ListRow>
        </GroupedList>
      ) : null}
      {savedScenes.length > 0 ? (
        <GroupedList aria-label="Saved scenes" label="Saved scenes">
          {savedScenes.map((entry, index) => {
            const blocked = savedSceneBlockedReason({
              scene: entry,
              appState: savedSceneAppStates[entry.id],
              sessionActive: isSessionActive,
              orientation
            })
            return (
              <SavedSceneRow
                key={entry.id}
                active={active.kind === 'saved' && active.id === entry.id}
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
                busy={dialogs.busy}
                switching={savedScenePendingId === entry.id}
                platform={platform}
                readOnly={readOnly}
                scene={entry}
                shortcut={settings.globalShortcuts?.scenes?.[entry.id]}
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
      ) : (
        <div className="flex flex-col gap-1.5">
          <SectionLabel className="px-1">Saved scenes</SectionLabel>
          <Empty className="rounded-row border border-border bg-inset py-5">
            <EmptyTitle>No saved scenes yet</EmptyTitle>
            <EmptyDescription>
              {platform === 'darwin'
                ? 'New scene… makes one for each app you show.'
                : 'New scene… makes one for a display.'}
            </EmptyDescription>
          </Empty>
        </div>
      )}
      <GroupedList aria-label="Layouts" label="Layouts">
        {layouts.map((layout) => (
          <LayoutRow
            key={layout.id}
            active={active.kind === 'layout' && active.preset === layout.id}
            blockedReason={layout.gaps.length > 0 ? layoutReason : null}
            label={layoutSwitchPending === layout.id ? 'Switching…' : layout.label}
            platform={platform}
            preset={layout.id}
            shortcut={settings.globalShortcuts?.layouts?.[layout.id]}
            onSelect={() => applyCameraPreset({ layoutPreset: layout.id })}
          />
        ))}
      </GroupedList>
      {/* Why some layouts can't be chosen, once, under the list (B-20). */}
      <SceneGalleryReason
        action={
          <Button size="xs" variant="ghost" onClick={() => openWorkspaceTab('sources')}>
            Open Sources
          </Button>
        }
        reason={layoutReason}
      />
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
  busy,
  switching,
  readOnly,
  shortcut,
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
  /** Another scene is going on stream: rows wait for it. */
  busy: boolean
  /** This scene is going on stream. */
  switching: boolean
  readOnly: boolean
  shortcut: string | undefined
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
        switching
          ? 'Switching…'
          : (blocked ?? (needsSources ? 'Resolve sources' : sceneShows(scene)))
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
            disabled={blocked !== null || busy || switching}
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
      {shortcut ? <ShortcutKeys accelerator={shortcut} platform={platform} /> : null}
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

/** A built-in layout: the current sources in that arrangement. */
function LayoutRow({
  preset,
  label,
  active,
  blockedReason,
  shortcut,
  platform,
  onSelect
}: {
  preset: LayoutPreset
  label: string
  active: boolean
  blockedReason: string | null
  shortcut: string | undefined
  platform: string | undefined
  onSelect: () => void
}): ReactElement {
  return (
    <ListRow
      className="relative"
      data-scene-preset={preset}
      icon={<LayoutIcon aria-hidden className="text-muted-foreground" />}
      interactive={!blockedReason}
      selected={active}
      title={
        <DisabledReason reason={blockedReason}>
          <ListRowButton
            aria-current={active || undefined}
            className="disabled:text-muted-foreground"
            disabled={blockedReason !== null}
            onClick={onSelect}
          >
            {label}
          </ListRowButton>
        </DisabledReason>
      }
    >
      {shortcut ? <ShortcutKeys accelerator={shortcut} platform={platform} /> : null}
      {active ? <CheckIcon aria-label="On stream" className="size-4" weight="bold" /> : null}
    </ListRow>
  )
}
