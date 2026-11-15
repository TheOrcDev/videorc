import { DisplayIcon, MobileIcon } from '@/components/icons'
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement
} from 'react'

import { KebabMenu } from '@/components/kebab-menu'
import type { StudioLook } from '@/components/lcd-panel'
import { PanelSection } from '@/components/panel-section'
import { AppIconImage, SceneGlyphIcon } from '@/components/scene/app-icon'
import { FollowFrontAppSwitch } from '@/components/scene/follow-front-app-switch'
import { changeScreenBlockedReason, useSceneDialogs } from '@/components/scene/scene-dialogs'
import { SceneShortcutKeys } from '@/components/scene/scene-shortcut-keys'
import { SceneSwitchPending, SceneSwitchStatus } from '@/components/scene/scene-switch-status'
import { SceneCard, SceneGalleryReason } from '@/components/studio/scene-card'
import { SceneOnStreamFields } from '@/components/studio/scene-on-stream'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useAppIcons } from '@/hooks/use-app-icons'
import { useEditScene } from '@/hooks/use-edit-scene'
import { useStudioCore } from '@/hooks/use-studio'
import {
  layoutPresetOrientation,
  ORIENTATION_DEFAULT_PRESET,
  type LayoutOrientation
} from '@/lib/capture'
import { EDIT_SCENE_LABEL } from '@/lib/edit-scene'
import { ADD_SCENE_EVENT, takeAddSceneRequest } from '@/lib/scene-add-request'
import { shortcutAriaKeys } from '@/lib/platform'
import {
  MOVE_SCENE_LEFT_ACCELERATOR,
  MOVE_SCENE_RIGHT_ACCELERATOR,
  savedSceneBlockedReason,
  sceneGlyph,
  sceneMoveKeyStep
} from '@/lib/scene-list'
import { sceneCardsCameraGaps, sceneSlotKeysLine } from '@/lib/scene-section'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

const READ_ONLY_REASON = 'Update Videorc to change your scenes.'

const STUDIO_ORIENTATION_OPTIONS: SegmentedControlOption<LayoutOrientation>[] = [
  {
    value: 'horizontal',
    label: <DisplayIcon />,
    'aria-label': 'Horizontal studio (16:9)',
    tooltip: 'Horizontal · 16:9'
  },
  {
    value: 'vertical',
    label: <MobileIcon />,
    'aria-label': 'Vertical studio (9:16)',
    tooltip: 'Vertical · 9:16'
  }
]

/**
 * Studio's Scenes section, the home of scenes (plan 231 D8). The header: the
 * 16:9 / 9:16 toggle, "Follow the app in front" (macOS), Edit scene and Add
 * scene…. Then every scene as a card, in order, the same list in both modes
 * (D2, D4): each draws its layout for the studio's orientation with the
 * scene's picture in the screen area (D7), its app's icon, its name, its keys
 * and ⋯. A click puts one on stream; a drag or ⌥← ⌥→ moves one, and the keys
 * move with the positions (D5). Under the cards, the scene on stream's own
 * fields. A lazy chunk: the dialogs and fields stay out of the first paint.
 *
 * Add scene… and Change screen… (S7) are `useSceneDialogs`' picker, here
 * and on the Scene page; ⌘K's Add scene… opens it here. `pictures` takes
 * each scene's still (scene id → image URL, from `useScenePictures`, S5).
 */
export function ScenesSection({
  look = 'default',
  pictures
}: {
  look?: StudioLook
  pictures?: ReadonlyMap<string, string>
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
    captureConfig,
    applyCameraPreset,
    isSessionActive
  } = studio
  const dialogs = useSceneDialogs()
  const editScene = useEditScene()
  const platform = runtimeInfo?.platform
  const readOnly = sceneLibraryActions.readOnly
  const mode = layoutPresetOrientation(captureConfig.layout.layoutPreset)
  const glyphs = new Map(
    savedScenes.map((entry) => [entry.id, sceneGlyph(entry, deviceList.devices)])
  )
  const icons = useAppIcons([
    ...new Set([
      ...savedScenes.flatMap((entry) =>
        entry.visual.sources.app ? [entry.visual.sources.app.bundleId] : []
      ),
      ...[...glyphs.values()].flatMap((glyph) => (glyph.kind === 'app' ? [glyph.bundleId] : []))
    ])
  ])
  const camera = sceneCardsCameraGaps(savedScenes, deviceList.devices)
  const keys = sceneSlotKeysLine(settings.globalShortcuts, platform)
  const openDialog = dialogs.open

  // ⌘K's Add scene… (D14): taken once at mount, or heard while mounted.
  useEffect(() => {
    const take = (): void => {
      if (takeAddSceneRequest() && !readOnly) openDialog({ kind: 'add' })
    }
    take()
    window.addEventListener(ADD_SCENE_EVENT, take)
    return () => window.removeEventListener(ADD_SCENE_EVENT, take)
  }, [openDialog, readOnly])

  // The scene on stream goes on in its own layout for the other orientation
  // (the preset only names it); the orientation⇄canvas coupling in
  // applyCameraPreset flips the output profile alongside it.
  const switchMode = (target: LayoutOrientation): void => {
    if (target === mode) return
    applyCameraPreset({ layoutPreset: ORIENTATION_DEFAULT_PRESET[target] }, { toOrientation: true })
  }

  // Reorder (D8): the Scene page list's drag, across a grid of cards.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const draggingIndex = savedScenes.findIndex((entry) => entry.id === draggingId)
  const endDrag = (): void => {
    setDraggingId(null)
    setDropIndex(null)
  }
  // A card moved by its keys keeps the focus: React may move its node, and a
  // moved node loses focus, so it is found again by the scene's id.
  const gridRef = useRef<HTMLDivElement>(null)
  const refocusId = useRef<string | null>(null)
  useEffect(() => {
    const id = refocusId.current
    if (!id) return
    refocusId.current = null
    const card = [...(gridRef.current?.querySelectorAll('[data-saved-scene]') ?? [])].find(
      (entry) => entry.getAttribute('data-saved-scene') === id
    )
    card?.querySelector<HTMLButtonElement>('[data-slot="scene-card-button"]')?.focus()
  }, [savedScenes])
  const moveKeys = readOnly
    ? undefined
    : `${shortcutAriaKeys(MOVE_SCENE_LEFT_ACCELERATOR, platform)} ${shortcutAriaKeys(MOVE_SCENE_RIGHT_ACCELERATOR, platform)}`

  return (
    <PanelSection
      action={
        <>
          {/* Plan 215 D4: the same Edit scene as the Scene page's and ⌘K's. */}
          <Button variant="ghost" onClick={editScene}>
            {EDIT_SCENE_LABEL}
          </Button>
          <DisabledReason reason={readOnly ? READ_ONLY_REASON : null}>
            <Button
              data-testid="scene-add"
              disabled={readOnly}
              variant="outline"
              onClick={() => dialogs.open({ kind: 'add' })}
            >
              Add scene…
            </Button>
          </DisabledReason>
        </>
      }
      data-videorc-scenes=""
      description={
        keys ? (
          <>
            Each scene shows its own screen.{' '}
            <ShortcutKeys accelerator={keys.first} platform={platform} variant="text" /> to{' '}
            <ShortcutKeys accelerator={keys.last} platform={platform} variant="text" /> switch them
            from any app.
          </>
        ) : (
          "Each scene shows its own screen. A scene's key switches to it from any app."
        )
      }
      title="Scenes"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* The toggle changes the canvas orientation, and the encoder canvas
            is fixed at session start: disabled while live. A switch restarts
            the canvas, so arrows only move focus (manual). */}
        <DisabledReason
          reason={
            isSessionActive
              ? 'Locked while you’re recording or live. Stop to switch orientation.'
              : null
          }
        >
          <SegmentedControl
            activationMode="manual"
            aria-label="Studio orientation"
            disabled={isSessionActive}
            options={STUDIO_ORIENTATION_OPTIONS}
            size="sm"
            value={mode}
            onValueChange={switchMode}
          />
        </DisabledReason>
        {/* Plan 210 D12: macOS only, absent elsewhere. */}
        {platform === 'darwin' ? <FollowFrontAppSwitch /> : null}
      </div>
      {sceneLibraryError ? (
        <p className="text-sm text-muted-foreground" role="status">
          {sceneLibraryError}
        </p>
      ) : null}
      <div
        ref={gridRef}
        className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(90px,1fr))]"
        data-videorc-saved-scenes=""
      >
        {savedScenes.map((entry, index) => {
          const app = entry.visual.sources.app
          const pending = savedScenePendingId === entry.id
          const blocked = savedSceneBlockedReason({
            scene: entry,
            appState: savedSceneAppStates[entry.id],
            devices: deviceList.devices
          })
          const cameraBlocked = camera.blocked.has(entry.id)
          const dropEdge =
            dropIndex === index && draggingIndex >= 0 && draggingIndex !== index
              ? draggingIndex < index
                ? 'end'
                : 'start'
              : null
          const moveFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>): void => {
            if (readOnly) return
            const step = sceneMoveKeyStep(event, 'horizontal')
            if (step === null) return
            event.preventDefault()
            if (sceneLibraryActions.move(entry.id, index + step)) refocusId.current = entry.id
          }
          return (
            <div
              key={entry.id}
              className={cn(
                'relative grid min-w-0',
                draggingId === entry.id && 'opacity-40',
                dropEdge &&
                  'before:absolute before:inset-y-0 before:z-10 before:w-0.5 before:rounded-full before:bg-ring before:content-[""]',
                dropEdge === 'start' && 'before:-left-[5px]',
                dropEdge === 'end' && 'before:-right-[5px]'
              )}
              data-scene-drag={entry.id}
              draggable={!readOnly}
              onDragEnd={endDrag}
              onDragEnter={() => {
                if (draggingId && draggingId !== entry.id) setDropIndex(index)
              }}
              onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                event.dataTransfer.effectAllowed = 'move'
                setDraggingId(entry.id)
              }}
              onDrop={(event: DragEvent<HTMLDivElement>) => {
                event.preventDefault()
                if (draggingId && draggingId !== entry.id)
                  sceneLibraryActions.move(draggingId, index)
                endDrag()
              }}
            >
              {/* One SceneCard for every scene (plan 174 S3.3, B-20): the
                  selected look and its check say which one is on. */}
              <SceneCard
                data-saved-scene={entry.id}
                // Another scene's click takes a pending switch over (issue #1275).
                disabled={blocked !== null || cameraBlocked || pending}
                disabledReason={blocked ?? (cameraBlocked ? camera.reason : null)}
                icon={
                  app ? (
                    <AppIconImage className="size-4" icon={icons.get(app.bundleId)} />
                  ) : undefined
                }
                keyShortcuts={moveKeys}
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
                      (blocked ??
                      (!cameraBlocked && !app && dialogs.needsSources(entry)
                        ? 'Resolve sources'
                        : null))
                    )}
                    <SceneShortcutKeys
                      config={settings.globalShortcuts}
                      platform={platform}
                      position={index + 1}
                      sceneId={entry.id}
                    />
                  </span>
                }
                selected={activeSavedSceneId === entry.id}
                thumb={
                  <LayoutThumb
                    framing={entry.visual.layout.verticalScreenFraming}
                    glyph={
                      <SceneGlyphIcon
                        className="size-5"
                        glyph={glyphs.get(entry.id)!}
                        icons={icons}
                      />
                    }
                    picture={pictures?.get(entry.id)}
                    preset={entry.visual.layout.layoutPreset}
                  />
                }
                onKeyDown={moveFromKeyboard}
                onSelect={() => dialogs.select(entry)}
              />
            </div>
          )
        })}
      </div>
      {/* Issue #1275: what a slow switch is waiting for. */}
      <SceneSwitchStatus />
      {/* Why some scenes can't be chosen, once, under the cards (B-20). */}
      <SceneGalleryReason
        action={
          <Button size="xs" variant="ghost" onClick={() => openWorkspaceTab('sources')}>
            Open Sources
          </Button>
        }
        reason={camera.reason}
      />
      <SceneOnStreamFields
        changeScreenReason={
          activeSavedSceneId ? changeScreenBlockedReason(studio, activeSavedSceneId) : null
        }
        look={look}
        onChangeScreen={(options) => {
          const listed = savedScenes.find((entry) => entry.id === activeSavedSceneId)
          if (listed) dialogs.open({ kind: 'change-screen', scene: listed, ...options })
        }}
      />
      {dialogs.element}
    </PanelSection>
  )
}
export default ScenesSection
