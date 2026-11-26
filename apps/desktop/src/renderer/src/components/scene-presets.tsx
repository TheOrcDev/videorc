import { DisplayIcon, MobileIcon } from '@/components/icons'
import { useEffect, type ReactElement, type ReactNode } from 'react'

import { KebabMenu } from '@/components/kebab-menu'

import { PanelSection } from '@/components/panel-section'
import { SceneGlyphIcon } from '@/components/scene/app-icon'
import { FollowFrontAppSwitch } from '@/components/scene/follow-front-app-switch'
import { changeScreenBlockedReason, useSceneDialogs } from '@/components/scene/scene-dialogs'
import {
  SCENES_READ_ONLY_REASON,
  ScenesLine,
  useSceneEntries,
  useSceneReorder
} from '@/components/scene/scene-entries'
import { SceneShortcutKeys } from '@/components/scene/scene-shortcut-keys'
import { SceneSwitchStatus } from '@/components/scene/scene-switch-status'
import { SceneCard, SceneGalleryReason } from '@/components/studio/scene-card'
import { SceneOnStreamFields } from '@/components/studio/scene-on-stream'
import { LayoutThumb } from '@/components/studio/scenes-gallery'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { useEditScene } from '@/hooks/use-edit-scene'
import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'
import { useStudioCore } from '@/hooks/use-studio'
import {
  layoutPresetOrientation,
  ORIENTATION_DEFAULT_PRESET,
  type LayoutOrientation
} from '@/lib/capture'
import { EDIT_SCENE_LABEL } from '@/lib/edit-scene'
import { SCENES_REQUEST_EVENT, takeScenesRequest } from '@/lib/scene-add-request'
import type { SceneVisual } from '@/lib/scene-presets'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

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
 * and on the Scene page; ⌘K's Add scene… opens it here, and Sources' Open
 * Scenes scrolls here. The cards read their scenes through `useSceneEntries`
 * and move through `useSceneReorder`, as the Scene page's rows do (S8). Each
 * card's still comes from `useScenePictures` (S5, D17): macOS only, never
 * while recording or live, and frozen while Hide screen holds.
 */
export function ScenesSection(): ReactElement {
  const studio = useStudioCore()
  const {
    savedScenes,
    activeSavedSceneId,
    sceneLibraryActions,
    sceneLibraryError,
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
  // The same entries and reorder as the Scene page's rows (D8).
  const { entries, icons, cameraReason } = useSceneEntries(dialogs.needsSources)
  const reorder = useSceneReorder({
    axis: 'horizontal',
    focusSelector: '[data-slot="scene-card-button"]'
  })
  const openDialog = dialogs.open

  // ⌘K's Add scene… (D14) opens the picker; Sources' Open Scenes brings the
  // section into view. Taken once at mount, or heard while mounted.
  useEffect(() => {
    const take = (): void => {
      const request = takeScenesRequest()
      if (request === 'add' && !readOnly) openDialog({ kind: 'add' })
      if (request === 'show')
        document
          .querySelector('[data-videorc-scenes]')
          ?.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'start' })
    }
    take()
    window.addEventListener(SCENES_REQUEST_EVENT, take)
    return () => window.removeEventListener(SCENES_REQUEST_EVENT, take)
  }, [openDialog, readOnly])

  // The scene on stream goes on in its own layout for the other orientation
  // (the preset only names it); the orientation⇄canvas coupling in
  // applyCameraPreset flips the output profile alongside it.
  const switchMode = (target: LayoutOrientation): void => {
    if (target === mode) return
    applyCameraPreset({ layoutPreset: ORIENTATION_DEFAULT_PRESET[target] }, { toOrientation: true })
  }

  return (
    <PanelSection
      action={
        <>
          {/* Plan 215 D4: the same Edit scene as the Scene page's and ⌘K's. */}
          <Button variant="ghost" onClick={editScene}>
            {EDIT_SCENE_LABEL}
          </Button>
          <DisabledReason reason={readOnly ? SCENES_READ_ONLY_REASON : null}>
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
      description={<ScenesLine config={settings.globalShortcuts} platform={platform} />}
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
        ref={reorder.containerRef}
        // Cards at least 160 px wide: a picture big enough to tell one app
        // from another, and "Screen + camera" on one line.
        className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]"
        data-videorc-saved-scenes=""
      >
        {entries.map((entry, index) => {
          const { scene } = entry
          const dropEdge = reorder.dropEdge(index)
          return (
            <div
              key={scene.id}
              className={cn(
                'relative grid min-w-0',
                reorder.dragging(scene.id) && 'opacity-40',
                dropEdge &&
                  'before:absolute before:inset-y-0 before:z-10 before:w-0.5 before:rounded-full before:bg-ring before:content-[""]',
                dropEdge === 'before' && 'before:-left-[5px]',
                dropEdge === 'after' && 'before:-right-[5px]'
              )}
              data-scene-drag={scene.id}
              {...reorder.dragProps(scene.id, index)}
              // ⌥← ⌥→ on the card, or on its reason while it can't go on.
              onKeyDown={reorder.onMoveKey(scene.id, index)}
            >
              {/* One SceneCard for every scene (plan 174 S3.3, B-20): the
                  selected look, its ring and its check say which one is on. */}
              <SceneCard
                data-saved-scene={scene.id}
                // Another scene's click takes a pending switch over (issue #1275).
                disabled={entry.disabled}
                disabledReason={entry.disabledReason}
                icon={
                  <SceneGlyphIcon
                    className={scene.visual.sources.app ? 'size-4' : undefined}
                    glyph={entry.glyph}
                    icons={icons}
                  />
                }
                keyShortcuts={reorder.keyShortcuts}
                keys={
                  <SceneShortcutKeys
                    config={settings.globalShortcuts}
                    platform={platform}
                    position={entry.position}
                    sceneId={scene.id}
                  />
                }
                label={scene.name}
                menu={
                  <KebabMenu
                    items={dialogs.menuItems(scene)}
                    label={`Actions for ${scene.name}`}
                    reveal="hover"
                  />
                }
                meta={entry.meta}
                selected={entry.onStream}
                thumb={
                  <SceneThumb
                    glyph={<SceneGlyphIcon className="size-6" glyph={entry.glyph} icons={icons} />}
                    picture={entry.picture}
                    visual={scene.visual}
                  />
                }
                onSelect={() => dialogs.select(scene)}
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
        reason={cameraReason}
      />
      <SceneOnStreamFields
        changeScreenReason={
          activeSavedSceneId ? changeScreenBlockedReason(studio, activeSavedSceneId) : null
        }
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

/**
 * A card's well (D7): the scene's layout for the studio's orientation, its
 * still in the screen area. 16:9 at the card's width; a 9:16 layout stands
 * at the height of a 4:3 well in the middle of it, so the 9:16 studio's cards
 * share one shape and their pictures stay big enough to read.
 */
function SceneThumb({
  visual,
  picture,
  glyph
}: {
  visual: SceneVisual
  picture: string | undefined
  glyph: ReactNode
}): ReactElement {
  const { layoutPreset, verticalScreenFraming } = visual.layout
  const thumb = (className?: string) => (
    <LayoutThumb
      className={className}
      framing={verticalScreenFraming}
      glyph={glyph}
      picture={picture}
      preset={layoutPreset}
    />
  )
  if (layoutPresetOrientation(layoutPreset) === 'horizontal') return thumb()
  return (
    <span
      className="flex aspect-[4/3] w-full items-center justify-center rounded-chip bg-inset py-1"
      data-slot="scene-thumb-vertical"
    >
      {thumb('h-full w-auto')}
    </span>
  )
}
