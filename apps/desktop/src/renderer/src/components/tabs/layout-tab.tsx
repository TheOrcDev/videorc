import ScenePresetControls from '@/components/scene-presets'
import {
  AdjustIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  DisplayIcon,
  LayoutIcon,
  MobileIcon
} from '@/components/icons'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { dockHiddenDisplay } from '@/components/preview-stage'
import { BannerInspector, SceneBannersSection } from '@/components/scene/banner-inspector'
import { CameraResetButton } from '@/components/scene/camera-reset-button'
import {
  BannerEdits,
  OverlayEdits,
  bannerStageId,
  bannerStageItems,
  overlayEditsBlockedReason,
  overlayStageId,
  overlayStageItems,
  withOverlayRect,
  type StageItemDraft
} from '@/components/scene/overlay-stage'
import { SceneStage, type StagePhase } from '@/components/scene/scene-stage'
import { stageUndoControl } from '@/components/scene/stage-undo-control'
import { SourceTransformFields } from '@/components/scene/source-transform-fields'
import { PowerSlider } from '@/components/power-slider'
import { ScreenFramingControl } from '@/components/studio/scenes-gallery'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Field, FieldContent, FieldLabel, FieldSet, SettingsRow } from '@/components/ui/field'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { useDockSlotReporter } from '@/hooks/use-dock-slot'
import { useStudioBanners, useStudioCore } from '@/hooks/use-studio'
import { BANNER_MAX_SHOWN } from '@/lib/backend'
import type {
  CameraAspect,
  CameraCorner,
  CameraFit,
  CameraShape,
  CameraSize,
  LayoutPreset,
  OverlayItem,
  OverlayOrientation,
  OverlaySnap,
  SceneSource,
  SideBySideCameraSide,
  SideBySideSplit
} from '@/lib/backend'
import {
  hasSelectedCameraSource,
  hasSelectedScreenSource,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation,
  simulcastLegLiveRequest,
  studioModeTogglePreset,
  type LayoutOrientation
} from '@/lib/capture'
import { bannerSnapRect } from '@/lib/banner-place'
import { BANNER_SHOWN_LIMIT_REASON, bannerOrderAfterMove } from '@/lib/banners'
import { bannerSizeAdvice } from '@/lib/banner-size'
import { rememberFocus } from '@/lib/focus-retention'
import { freeformEntryOverrides, peekLayoutUndo, rememberedFreeform } from '@/lib/freeform-memory'
import { isLayoutUndoShortcut, layoutUndoShortcutBlocked } from '@/lib/layout-undo-shortcut'
import {
  OVERLAY_ITEM_LABELS,
  OVERLAY_SNAPS,
  OVERLAY_SNAP_LABELS,
  overlayOrientationForCanvas,
  overlaySnapRect
} from '@/lib/overlay-layout'
import { LAYOUT_PRESET_LABELS } from '@/lib/layout-labels'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { effectiveCameraMaskShape } from '../../../../shared/native-preview-proof-geometry'

// The two real-world screen colors; the protocol takes any #RRGGBB so a
// custom picker later needs no wire change.
const CHROMA_KEY_GREEN = '#00FF00'
const CHROMA_KEY_BLUE = '#0000FF'

// What a running recording or livestream locks on this page (plan 174, C-22):
// where a source sits and whether it shows. The layout, the camera's frame and
// its lens still change live, so the copy names only what is locked.
export const SCENE_POSITION_LOCK_REASON =
  "Position and size are locked while you're recording or live."
export const SCENE_VISIBILITY_LOCK_REASON = "Visibility is locked while you're recording or live."
const ORIENTATION_LOCK_REASON =
  "The canvas is fixed while you're recording or live. Stop to switch orientation."

// Mode-scoped like the Scenes gallery: the tab edits the current
// orientation's scenes; the orientation control in the Layout header switches
// modes (plan 174, C-23). Names come from the one layout table (S1.4, V-X3).
const HORIZONTAL_LAYOUT_TAB_PRESETS = [
  { id: 'screen-camera', label: LAYOUT_PRESET_LABELS['screen-camera'], enabled: true },
  { id: 'screen-only', label: LAYOUT_PRESET_LABELS['screen-only'], enabled: true },
  { id: 'camera-only', label: LAYOUT_PRESET_LABELS['camera-only'], enabled: true },
  { id: 'side-by-side', label: LAYOUT_PRESET_LABELS['side-by-side'], enabled: true }
] as const

const VERTICAL_LAYOUT_TAB_PRESETS = [
  { id: 'vertical-camera-top', label: LAYOUT_PRESET_LABELS['vertical-camera-top'], enabled: true },
  {
    id: 'vertical-camera-bottom',
    label: LAYOUT_PRESET_LABELS['vertical-camera-bottom'],
    enabled: true
  },
  { id: 'vertical-split', label: LAYOUT_PRESET_LABELS['vertical-split'], enabled: true },
  {
    id: 'vertical-screen-camera',
    label: LAYOUT_PRESET_LABELS['vertical-screen-camera'],
    enabled: true
  },
  {
    id: 'vertical-screen-only',
    label: LAYOUT_PRESET_LABELS['vertical-screen-only'],
    enabled: true
  },
  { id: 'vertical-camera-only', label: LAYOUT_PRESET_LABELS['vertical-camera-only'], enabled: true }
] as const

const SCENE_ORIENTATION_OPTIONS: SegmentedControlOption<LayoutOrientation>[] = [
  {
    value: 'horizontal',
    label: <DisplayIcon />,
    'aria-label': 'Horizontal (16:9)',
    tooltip: 'Horizontal · 16:9'
  },
  {
    value: 'vertical',
    label: <MobileIcon />,
    'aria-label': 'Vertical (9:16)',
    tooltip: 'Vertical · 9:16'
  }
]

const OVERLAY_ORIENTATION_OPTIONS: SegmentedControlOption<OverlayOrientation>[] = [
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'vertical', label: 'Vertical' }
]

const SIDE_BY_SIDE_SPLIT_OPTIONS: SegmentedControlOption<SideBySideSplit>[] = [
  { value: '50-50', label: '50/50' },
  { value: '60-40', label: '60/40' },
  { value: '70-30', label: '70/30' }
]

const CAMERA_SIDE_OPTIONS: SegmentedControlOption<SideBySideCameraSide>[] = [
  { value: 'left', label: 'Camera left' },
  { value: 'right', label: 'Camera right' }
]

// Full words, named once like the overlay snaps (plan 174, C-16).
const CAMERA_CORNER_OPTIONS: SegmentedControlOption<CameraCorner>[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
]

const CAMERA_SIZE_OPTIONS: SegmentedControlOption<CameraSize>[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
]

const CAMERA_SHAPE_OPTIONS: SegmentedControlOption<CameraShape>[] = [
  { value: 'rectangle', label: 'Rectangle', 'data-videorc-camera-shape': 'rectangle' },
  { value: 'rounded', label: 'Rounded', 'data-videorc-camera-shape': 'rounded' },
  { value: 'circle', label: 'Circle', 'data-videorc-camera-shape': 'circle' }
]

// "Original" keeps the camera's own aspect, whatever it is: a portrait phone
// camera is not "Wide".
const CAMERA_ASPECT_OPTIONS: SegmentedControlOption<CameraAspect>[] = [
  { value: 'source', label: 'Original', 'data-videorc-camera-aspect': 'source' },
  { value: 'square', label: 'Square', 'data-videorc-camera-aspect': 'square' },
  { value: 'portrait', label: 'Portrait', 'data-videorc-camera-aspect': 'portrait' }
]

const CAMERA_FIT_OPTIONS: SegmentedControlOption<CameraFit>[] = [
  { value: 'fill', label: 'Fill crop' },
  { value: 'fit', label: 'Fit frame' }
]

const CHROMA_KEY_COLOR_OPTIONS: SegmentedControlOption<'green' | 'blue'>[] = [
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' }
]

function OpenSourcesLink(): ReactElement {
  return (
    <Button
      className="h-auto p-0 text-xs font-normal"
      size="xs"
      variant="link"
      onClick={() => openWorkspaceTab('sources')}
    >
      Open Sources
    </Button>
  )
}

export function LayoutTab(): ReactElement {
  const {
    captureConfig,
    patchLayout,
    applyLayoutPatch,
    undoLayoutPatch,
    previewWindow,
    togglePreviewWindow,
    openPreviewWindow,
    setPreviewWindowMode,
    nativePreviewSurfaceEnabled,
    runtimeInfo,
    scene,
    sceneEditMode,
    setSceneGesturePending,
    selectedSceneSourceId,
    setSceneEditMode,
    setSelectedSceneSourceId,
    resetSceneSource,
    nudgeSceneSource,
    setSceneSourceTransform,
    setSceneEditorDraft,
    clearSceneEditorDraft,
    applyCameraPreset,
    setSceneSourceVisible,
    isSessionActive,
    layoutSwitchPending,
    savedScenePendingId,
    savedScenes,
    activeSavedSceneId,
    savedSceneModified,
    settings,
    setSettings,
    overlayLayout,
    setOverlayLayout,
    reportError,
    wsStatus
  } = useStudioCore()
  // The stage's phase (plan 174, C-5): only a pointer gesture takes the
  // inspector out of play (`inert`); a commit still landing leaves every
  // control enabled and focused, and `runPreciseEdit` drops the input instead.
  const [stagePhase, setStagePhase] = useState<StagePhase>('idle')
  const stageDragging = stagePhase === 'dragging'
  const stageBusy = stagePhase !== 'idle'
  // Overlay items on the canvas (plan 164, D15). One selection on the stage:
  // picking an item clears the source selection and the other way round.
  const [selectedOverlayItem, setSelectedOverlayItem] = useState<OverlayItem | null>(null)
  const [, redrawOverlays] = useReducer((value: number) => value + 1, 0)
  const overlayEditsRef = useRef<OverlayEdits | null>(null)
  if (!overlayEditsRef.current)
    overlayEditsRef.current = new OverlayEdits(setOverlayLayout, redrawOverlays, reportError)
  const overlayEdits = overlayEditsRef.current
  overlayEdits.configure(setOverlayLayout, reportError)
  // Banners (plan 186): the one set, placed here like the overlay items. The
  // selection lives in the Studio, so Assets → Place on Scene arrives with
  // its banner selected on the stage.
  const {
    banners,
    bannersLoaded,
    bannersOffline,
    selectedBannerId,
    selectBanner,
    updateBanner,
    reorderBanners,
    showBanner,
    hideBanner
  } = useStudioBanners()
  const selectedBanner = banners.find((banner) => banner.id === selectedBannerId) ?? null
  const bannerEditsRef = useRef<BannerEdits | null>(null)
  if (!bannerEditsRef.current)
    bannerEditsRef.current = new BannerEdits(updateBanner, redrawOverlays)
  const bannerEdits = bannerEditsRef.current
  bannerEdits.configure(updateBanner)
  useLayoutEffect(() => {
    bannerEdits.observe(banners)
  }, [bannerEdits, banners])
  // Plan 174, C-6: overlay changes need the backend; without it the controls
  // are off with one reason, and every failed change is reported.
  const overlayBlockedReason = overlayEditsBlockedReason(wsStatus)
  useLayoutEffect(() => {
    overlayEdits.observe(overlayLayout)
  }, [overlayEdits, overlayLayout])
  // Orientation (D15): the primary canvas places the item's horizontal rect
  // (or its vertical one for a vertical scene); with a vertical stream armed
  // the toggle shows that stream's rects over a greyed 9:16 canvas.
  const verticalLeg = simulcastLegLiveRequest(captureConfig)
  const primaryOrientation = overlayOrientationForCanvas(
    captureConfig.video.width,
    captureConfig.video.height
  )
  const [orientationChoice, setOrientationChoice] = useState<OverlayOrientation>('horizontal')
  const verticalView = Boolean(verticalLeg) && orientationChoice === 'vertical'
  const overlayOrientation: OverlayOrientation = verticalView ? 'vertical' : primaryOrientation
  const verticalLegArmed = Boolean(verticalLeg)
  useEffect(() => {
    if (!verticalLegArmed) setOrientationChoice('horizontal')
  }, [verticalLegArmed])
  // The stage canvas's shape (width / height): the Output, or the vertical
  // stream's 9:16 while the stage shows it. A banner's rect converts its
  // image's aspect into these canvas units.
  const stageAspect =
    verticalView && verticalLeg?.video
      ? verticalLeg.video.width / Math.max(1, verticalLeg.video.height)
      : verticalView
        ? 9 / 16
        : captureConfig.video.width / Math.max(1, captureConfig.video.height)
  const handleStagePhaseChange = useCallback(
    (phase: StagePhase) => {
      setStagePhase(phase)
      setSceneGesturePending(phase !== 'idle')
    },
    [setSceneGesturePending]
  )
  const sceneSwitchPending = layoutSwitchPending !== null || savedScenePendingId !== null
  const [preciseEditPending, setPreciseEditPending] = useState(false)
  const preciseEditPendingRef = useRef(false)
  // One precise edit at a time: input while one commits is dropped, never
  // queued, and the control that asked keeps the keyboard (C-5).
  const runPreciseEdit = (operation: () => Promise<unknown>): void => {
    if (stageBusy || preciseEditPendingRef.current || sceneSwitchPending) return
    const restoreFocus = rememberFocus()
    preciseEditPendingRef.current = true
    setPreciseEditPending(true)
    void operation().finally(() => {
      preciseEditPendingRef.current = false
      setPreciseEditPending(false)
      restoreFocus()
    })
  }
  const [aspectPreferences, setAspectPreferences] = useState<Record<string, boolean>>({})
  const aspectLocked = selectedSceneSourceId
    ? (aspectPreferences[selectedSceneSourceId] ?? true)
    : true
  const setAspectLocked = (locked: boolean): void => {
    if (selectedSceneSourceId)
      setAspectPreferences((current) => ({ ...current, [selectedSceneSourceId]: locked }))
  }
  const layout = captureConfig.layout
  const orientation = layoutPresetOrientation(layout.layoutPreset)
  // One selection on the stage: a banner wins over a source left selected
  // from before (Assets → Place on Scene selects only the banner).
  const selectedSource = selectedBanner
    ? undefined
    : scene?.sources.find((source) => source.id === selectedSceneSourceId)
  // SC2: the inspector follows the stage selection; default to the camera
  // (the thing people usually frame) so the panel is never empty.
  useEffect(() => {
    if (
      selectedSceneSourceId ||
      selectedOverlayItem ||
      selectedBannerId ||
      !scene?.sources.length
    ) {
      return
    }
    const camera = scene.sources.find((source) => source.kind === 'camera')
    setSelectedSceneSourceId((camera ?? scene.sources[0]).id)
  }, [
    scene,
    selectedBannerId,
    selectedOverlayItem,
    selectedSceneSourceId,
    setSelectedSceneSourceId
  ])
  // A banner selected from elsewhere (Assets → Place on Scene) takes the
  // stage's one selection.
  useEffect(() => {
    if (!selectedBannerId) return
    setSelectedOverlayItem(null)
    setSelectedSceneSourceId(null)
  }, [selectedBannerId, setSelectedSceneSourceId])
  const selectStageBanner = (id: string): void => {
    selectBanner(id)
    setSelectedOverlayItem(null)
    setSelectedSceneSourceId(null)
  }
  const shownBannerCount = banners.filter((banner) => banner.shown).length
  const bannerShowLimitReason =
    shownBannerCount >= BANNER_MAX_SHOWN ? BANNER_SHOWN_LIMIT_REASON : null
  const setBannerShown = (id: string, shown: boolean): void => {
    void (shown ? showBanner(id) : hideBanner(id))
  }
  const moveSelectedBanner = (targetIndex: number): void => {
    if (!selectedBanner) return
    const ids = bannerOrderAfterMove(banners, selectedBanner.id, targetIndex)
    if (ids) void reorderBanners(ids)
  }
  const stageDrafts = [
    overlayEdits.stageDraft(overlayOrientation),
    bannerEdits.stageDraft(overlayOrientation)
  ].filter((draft): draft is StageItemDraft => draft !== null)
  const selectedOverlayLayout = selectedOverlayItem ? overlayLayout[selectedOverlayItem] : null
  const patchSelectedOverlay = (
    patch: Partial<{ showOnStream: boolean; showInRecording: boolean }>
  ): void => {
    if (!selectedOverlayItem) return
    void setOverlayLayout({
      ...overlayLayout,
      [selectedOverlayItem]: { ...overlayLayout[selectedOverlayItem], ...patch }
    }).catch(reportError)
  }
  const snapSelectedOverlay = (snap: OverlaySnap): void => {
    if (!selectedOverlayItem) return
    void setOverlayLayout(
      withOverlayRect(
        overlayLayout,
        selectedOverlayItem,
        overlayOrientation,
        overlaySnapRect(selectedOverlayItem, overlayOrientation, snap)
      )
    ).catch(reportError)
  }
  const hasCamera = hasSelectedCameraSource(captureConfig.sources)
  const hasScreen = hasSelectedScreenSource(captureConfig.sources)
  const isCameraOnly = layout.layoutPreset === 'camera-only'
  const isVerticalCameraOnly = layout.layoutPreset === 'vertical-camera-only'
  const isSideBySide = layout.layoutPreset === 'side-by-side'
  // The stacked vertical scenes have fixed bands, so no corner, size or
  // shape; the vertical Screen + camera is a true inset scene and keeps every
  // overlay control, exactly like its landscape twin.
  const isVerticalStack =
    layout.layoutPreset === 'vertical-camera-top' ||
    layout.layoutPreset === 'vertical-camera-bottom' ||
    layout.layoutPreset === 'vertical-split'
  const showOverlayControls =
    layout.layoutPreset === 'screen-camera' || layout.layoutPreset === 'vertical-screen-camera'
  const isFreeform = layout.arrangementMode === 'freeform'
  // Corner/size/margin place the camera inside a preset scene; in freeform the
  // stage and the numeric fields own position and size instead.
  const showCameraCornerControls = showOverlayControls && !isFreeform
  // The mask (shape/radius/aspect) and the precise fields apply wherever the
  // camera is a user-owned bubble: the inset scenes and freeform.
  const showCameraBubbleControls = showOverlayControls || isFreeform

  // Entering freeform restores the arrangement a preset last replaced in this
  // orientation (plan 174, C-4); a source with no memory is seeded from the
  // committed scene, so nothing else visibly moves.
  const enterFreeform = (): void => {
    if (!scene) {
      return
    }
    const sourceTransformOverrides = freeformEntryOverrides(
      rememberedFreeform(),
      orientation,
      scene.sources
    )
    applyCameraPreset({ arrangementMode: 'freeform', sourceTransformOverrides })
  }
  // The orientation control re-enters each mode where it was left; the
  // orientation ⇄ canvas coupling in applyCameraPreset flips the output
  // profile alongside it (the Studio gallery's control, brought here: C-23).
  const switchOrientation = (target: LayoutOrientation): void => {
    if (target === orientation) return
    applyCameraPreset({ layoutPreset: studioModeTogglePreset(target, captureConfig) })
  }
  const layoutTabPresets =
    orientation === 'vertical' ? VERTICAL_LAYOUT_TAB_PRESETS : HORIZONTAL_LAYOUT_TAB_PRESETS

  // Single-level undo (plan 174 S3.9, D15): the footer's Undo and ⌘Z on this
  // page both ask for the layout the last change replaced. The key yields to
  // text fields (the Edit menu's undo role owns those), dialogs, menus and a
  // stage gesture or commit in flight; it does nothing while a scene switch
  // is still warming, so it never races the latest-intent engine. The footer
  // button stays mounted through all of that and only disables: a footer
  // that reflows at pointerdown cancels the gesture (stage-undo-control.ts).
  const undoControl = stageUndoControl({
    hasUndo: peekLayoutUndo() !== null,
    phase: stagePhase,
    sceneSwitchPending,
    preciseEditPending
  })
  const undoAvailable = undoControl.enabled
  const undoAvailableRef = useRef(undoAvailable)
  undoAvailableRef.current = undoAvailable
  const undoLayout = useCallback(() => {
    if (!undoAvailableRef.current) return
    void undoLayoutPatch()
  }, [undoLayoutPatch])
  const platform = runtimeInfo?.platform
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isLayoutUndoShortcut(event, platform)) return
      if (layoutUndoShortcutBlocked(event, document)) return
      if (!undoAvailableRef.current) return
      event.preventDefault()
      void undoLayoutPatch()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [platform, undoLayoutPatch])

  // Live canvas (plan 058, macOS only): the docked native preview glues into
  // the stage's canvas rect instead of the Studio slot while this tab is
  // mounted. Only one tab mounts at a time, so the two reporters never fight.
  const liveCanvasSupported = nativePreviewSurfaceEnabled && runtimeInfo?.platform === 'darwin'
  const liveCanvasActive =
    liveCanvasSupported && previewWindow.open && previewWindow.mode === 'docked'
  const slotRef = useDockSlotReporter(liveCanvasActive, previewWindow.dockEpoch, 'scene')
  // Hit-only mode needs main to have ACCEPTED a scene-slot report and to be
  // showing the surface; until then the schematic stays visible.
  const liveSurface =
    liveCanvasActive &&
    previewWindow.dockSlot === 'scene' &&
    previewWindow.dockHiddenReason === null
  // While docked here but hidden, the stage footer states why with the Studio
  // slot's own copy (title, then what brings it back): one tertiary line,
  // never a new reason and never a toast.
  const liveHidden =
    liveCanvasActive && !liveSurface
      ? dockHiddenDisplay(previewWindow.dockHiddenReason ?? 'no-slot-report')
      : null
  const liveHint = liveHidden ? `${liveHidden.title}. ${liveHidden.detail}` : null
  // Decision 6: entering the tab with the preview CLOSED opens it docked into
  // the canvas; an open floating preview stays floating (the footer offers
  // "Show preview here"); leaving the tab changes nothing. Once per tab entry,
  // decided on main's fresh state so a stale renderer snapshot at app start
  // can never re-dock a window the user left floating.
  const autoOpenDecidedRef = useRef(false)
  useEffect(() => {
    if (autoOpenDecidedRef.current || !runtimeInfo) {
      return
    }
    autoOpenDecidedRef.current = true
    if (!liveCanvasSupported) {
      return
    }
    let cancelled = false
    void (async () => {
      const fresh = await window.videorc?.getPreviewWindowState?.()
      if (cancelled || !fresh || fresh.open) {
        return
      }
      await setPreviewWindowMode('docked')
      if (!cancelled) {
        await openPreviewWindow()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [liveCanvasSupported, openPreviewWindow, runtimeInfo, setPreviewWindowMode])
  const showLiveHere = useCallback(async () => {
    await setPreviewWindowMode('docked')
    if (!previewWindow.open) {
      await openPreviewWindow()
    }
  }, [openPreviewWindow, previewWindow.open, setPreviewWindowMode])

  // The canvas section names the saved scene it shows and whether it has
  // drifted; its actions ("Update “{name}”", "Save scene") sit in the header
  // (plan 174, C-23 and V-10).
  const activeSavedScene = savedScenes.find((entry) => entry.id === activeSavedSceneId)
  const canvasDescription = activeSavedScene
    ? `${activeSavedScene.name} · ${savedSceneModified ? 'Modified' : 'Applied'}`
    : 'Drag sources and overlays into place.'

  return (
    <div className="flex flex-col">
      <div className="grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col lg:border-r">
          <PanelSection
            action={
              // The canvas is fixed at session start, so the orientation is
              // too (the backend refuses cross-orientation switches live). A
              // switch restarts the canvas, so arrows only move focus (manual).
              <DisabledReason reason={isSessionActive ? ORIENTATION_LOCK_REASON : null}>
                <SegmentedControl
                  activationMode="manual"
                  aria-label="Orientation"
                  data-videorc-scene-orientation
                  disabled={isSessionActive}
                  options={SCENE_ORIENTATION_OPTIONS}
                  size="sm"
                  value={orientation}
                  onValueChange={switchOrientation}
                />
              </DisabledReason>
            }
            description="Pick how the screen and camera are arranged."
            icon={LayoutIcon}
            title="Layout"
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* One segmented control for the presets; Freeform is a mode, not
                  a preset, so it stands apart from them behind a hairline
                  (plan 174 C-15). A switch applies live, so arrows only move
                  focus (manual). */}
              <SegmentedControl<LayoutPreset>
                activationMode="manual"
                aria-label="Layout"
                // Live sessions switch through the backend's latest-intent engine.
                // Keep controls clickable while one warms so a newer choice can supersede it.
                disabled={stageBusy}
                options={layoutTabPresets.map((preset) => {
                  const needsCamera = layoutPresetNeedsCamera(preset.id)
                  const needsScreen = layoutPresetNeedsScreen(preset.id)
                  return {
                    value: preset.id,
                    label: (
                      <>
                        {layoutSwitchPending === preset.id ? 'Switching…' : preset.label}
                        {!preset.enabled ? <Badge variant="outline">Soon</Badge> : null}
                      </>
                    ),
                    disabled:
                      !preset.enabled || (needsCamera && !hasCamera) || (needsScreen && !hasScreen),
                    'data-videorc-layout-preset': preset.id,
                    // Every click is an intent: the checked preset is the committed
                    // one, so a click on it supersedes a newer pending switch.
                    onClick:
                      !isFreeform && layout.layoutPreset === preset.id
                        ? () => applyCameraPreset({ layoutPreset: preset.id })
                        : undefined
                  }
                })}
                value={isFreeform ? null : layout.layoutPreset}
                onValueChange={(layoutPreset) => applyCameraPreset({ layoutPreset })}
              />
              <Separator className="data-[orientation=vertical]:h-5" orientation="vertical" />
              {/* Freeform is a mode, not a preset: composition becomes the
                  user's per-source overrides (plan phase 4). A preset leaves it. */}
              <Toggle
                data-videorc-layout-preset="freeform"
                disabled={!scene || stageBusy}
                pressed={isFreeform}
                variant="outline"
                // Every click is an intent, as on the presets.
                onPressedChange={enterFreeform}
              >
                {layoutSwitchPending && isFreeform ? 'Switching…' : 'Freeform'}
              </Toggle>
            </div>
            {/* Devices are chosen on Sources (plan 174, C-21), so the hint
                sends people there, with the door beside it. */}
            {isSessionActive ? (
              <p className="text-xs text-muted-foreground">
                Switching applies live. Recording and streaming keep running.
              </p>
            ) : !hasScreen ? (
              <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                Choose a screen or window in Sources to use the screen layouts.
                <OpenSourcesLink />
              </p>
            ) : !hasCamera ? (
              <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                {orientation === 'vertical'
                  ? 'Choose a camera in Sources to use the camera layouts.'
                  : 'Choose a camera in Sources to use Camera only and Side by side.'}
                <OpenSourcesLink />
              </p>
            ) : null}
            {orientation === 'vertical' ? (
              <ScreenFramingControl
                value={layout.verticalScreenFraming}
                onChange={(verticalScreenFraming) => applyCameraPreset({ verticalScreenFraming })}
              />
            ) : null}
            {/* Scene motion changes what viewers see, so it lives with the
                layouts, not under Settings (plan 174, D17). */}
            <SettingsRow
              description="Layout switches glide into place instead of cutting, on stream and in recordings."
              label="Animate scene changes"
            >
              <Switch
                checked={settings.animateSceneChanges === true}
                id="animate-scene-changes"
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, animateSceneChanges: checked }))
                }
              />
            </SettingsRow>
          </PanelSection>

          {/* The Scene canvas: on macOS the docked native preview is the
              picture and the SVG stage owns pointer input (plan 058);
              elsewhere, or while the surface is hidden or floating, the SVG
              draws the committed composition as a schematic (zero idle IPC). */}
          <PanelSection
            action={<ScenePresetControls toolbar />}
            description={canvasDescription}
            title="Canvas"
          >
            {verticalLeg ? (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Overlays on</FieldLabel>
                </FieldContent>
                <SegmentedControl
                  data-videorc-overlay-orientation
                  options={OVERLAY_ORIENTATION_OPTIONS}
                  size="sm"
                  value={verticalView ? 'vertical' : 'horizontal'}
                  onValueChange={setOrientationChoice}
                />
              </Field>
            ) : null}
            <SceneStage
              aspectLocked={aspectLocked}
              externalPending={preciseEditPending}
              onPhaseChange={handleStagePhaseChange}
              // The camera's box aspect is owned by the mask law (circle boxes
              // are square by construction; square/portrait force the crop), so
              // resize gestures must not free it.
              cameraAspectLocked={
                layout.cameraShape === 'circle' || layout.cameraAspect !== 'source'
              }
              cameraCornerRadiusPct={layout.cameraCornerRadiusPct}
              // WYSIWYG: only the inset scenes mask the camera bubble (backend
              // camera_mask policy); side-by-side and the vertical bands render
              // a plain rectangle, so the schematic must too.
              cameraShape={effectiveCameraMaskShape(layout)}
              background={scene?.background ?? null}
              dragEnabled={
                !verticalView &&
                (showOverlayControls || isFreeform) &&
                !isSessionActive &&
                !preciseEditPending &&
                !sceneSwitchPending
              }
              freeform={isFreeform}
              outputAspect={stageAspect}
              previewOpen={previewWindow.open}
              // Free resize: the backend honors custom camera width/height
              // (aspect law permitting) since plan phase 3.
              resizeEnabled={
                !verticalView &&
                (showOverlayControls || isFreeform) &&
                !isSessionActive &&
                !preciseEditPending &&
                !sceneSwitchPending
              }
              // The vertical view is the derived stream's canvas: a greyed
              // stage with that stream's overlay rects; the sources stay with
              // the primary (the stream is derived, plan 164 out of scope).
              scene={verticalView ? null : scene}
              selectedSourceId={verticalView || selectedBanner ? null : selectedSceneSourceId}
              liveDocked={!verticalView && liveCanvasActive}
              liveHint={verticalView ? 'Vertical stream: overlay placement only.' : liveHint}
              liveSurface={!verticalView && liveSurface}
              slotRef={liveCanvasSupported && !verticalView ? slotRef : undefined}
              overlays={{
                // Banners first: they draw under the overlay items (D5).
                items: [
                  ...bannerStageItems(banners, selectedBannerId, overlayOrientation, stageAspect),
                  ...overlayStageItems(overlayLayout, overlayOrientation)
                ],
                selectedId: selectedBanner
                  ? bannerStageId(selectedBanner.id)
                  : selectedOverlayItem
                    ? overlayStageId(selectedOverlayItem)
                    : null,
                drafts: stageDrafts,
                editable: !preciseEditPending && !sceneSwitchPending && !overlayBlockedReason,
                onSelect: (entry) => {
                  if (entry.kind === 'banner') {
                    selectStageBanner(entry.id)
                    return
                  }
                  setSelectedOverlayItem(entry.item)
                  setSelectedSceneSourceId(null)
                  selectBanner(null)
                },
                onCommit: (entry, rect) => {
                  if (entry.kind === 'banner')
                    bannerEdits.submit(entry.id, overlayOrientation, rect)
                  else overlayEdits.submit(overlayLayout, entry.item, overlayOrientation, rect)
                }
              }}
              onPopOut={
                liveCanvasSupported ? () => void setPreviewWindowMode('floating') : undefined
              }
              onShowLive={liveCanvasSupported ? () => void showLiveHere() : undefined}
              // Live drafts (plan 058 S4): only flow while the surface is the
              // canvas; the stage gates them on `liveSurface`.
              onDraft={liveCanvasSupported ? setSceneEditorDraft : undefined}
              onDraftClear={liveCanvasSupported ? clearSceneEditorDraft : undefined}
              outputWidth={captureConfig.video.width}
              onCommitTransform={setSceneSourceTransform}
              // Arrows on the focused canvas (C-31) ride the same one-at-a-time
              // precise edit as the inspector's d-pad.
              onNudge={(sourceId, directionX, directionY, large) =>
                runPreciseEdit(() => nudgeSceneSource(sourceId, directionX, directionY, large))
              }
              onRequestFreeform={isFreeform || isSessionActive ? undefined : enterFreeform}
              onSelectSource={(sourceId) => {
                setSelectedOverlayItem(null)
                selectBanner(null)
                setSelectedSceneSourceId(sourceId)
                if (!sceneEditMode) {
                  setSceneEditMode(true)
                }
              }}
              // Corner release re-enters a preset corner; in freeform a corner
              // drop is just a position.
              onSnapCorner={
                isFreeform ? undefined : (cameraCorner) => applyCameraPreset({ cameraCorner })
              }
              onTogglePreview={() => void togglePreviewWindow()}
              onUndo={undoControl.shown ? undoLayout : undefined}
              undoEnabled={undoControl.enabled}
            />
          </PanelSection>

          {/* The old "Scene sources" panel is gone (post-0.9.4 fix batch F3):
              it duplicated the stage: the stage's rects and legend chips ARE
              the source list, clicking one selects it (and enables editing),
              and visibility now lives in the Inspector. */}
        </div>

        {/* The inspector: one section named after the selection, then the
            camera's Placement, Lens and Green screen (plan 174 S3.9, C-33 and
            C-35). Inert only during a pointer gesture (C-5). */}
        <FieldSet className="min-w-0 gap-0" inert={stageDragging}>
          {selectedBanner ? (
            <BannerInspector
              key={selectedBanner.id}
              atBack={banners[0]?.id === selectedBanner.id}
              banner={selectedBanner}
              blockedReason={overlayBlockedReason}
              inFront={banners[banners.length - 1]?.id === selectedBanner.id}
              placeLabel={verticalView ? 'Place on the vertical stream' : 'Place'}
              showLimitReason={bannerShowLimitReason}
              sizeAdvice={bannerSizeAdvice({
                banner: selectedBanner,
                output: captureConfig.video,
                verticalStream: verticalLeg?.video ?? null
              })}
              onBringToFront={() => moveSelectedBanner(banners.length - 1)}
              onManage={() => openWorkspaceTab('assets')}
              onPatch={(patch) => updateBanner(selectedBanner.id, patch)}
              onSendToBack={() => moveSelectedBanner(0)}
              onShowChange={(shown) => setBannerShown(selectedBanner.id, shown)}
              onSnap={(snap) => {
                const rect = bannerSnapRect(
                  selectedBanner,
                  selectedBanner[overlayOrientation],
                  overlayOrientation,
                  stageAspect,
                  snap
                )
                void updateBanner(
                  selectedBanner.id,
                  overlayOrientation === 'vertical' ? { vertical: rect } : { horizontal: rect }
                )
              }}
            />
          ) : !selectedSource && selectedOverlayItem && selectedOverlayLayout ? (
            <PanelSection
              className="min-w-0"
              icon={AdjustIcon}
              title={OVERLAY_ITEM_LABELS[selectedOverlayItem]}
            >
              <OverlayItemInspector
                blockedReason={overlayBlockedReason}
                item={selectedOverlayItem}
                layout={selectedOverlayLayout}
                orientation={overlayOrientation}
                onPatch={patchSelectedOverlay}
                onSnap={snapSelectedOverlay}
              />
            </PanelSection>
          ) : !selectedSource ? (
            <PanelSection
              className="min-w-0"
              description="Click a source, an overlay or a banner on the stage to edit it."
              icon={AdjustIcon}
              title="Inspector"
            />
          ) : selectedSource.kind === 'camera' ? (
            <CameraInspector
              aspectLocked={aspectLocked}
              isCameraOnly={isCameraOnly}
              isFreeform={isFreeform}
              isSessionActive={isSessionActive}
              isSideBySide={isSideBySide}
              isVerticalCameraOnly={isVerticalCameraOnly}
              isVerticalStack={isVerticalStack}
              layout={layout}
              outputHeight={captureConfig.video.height}
              outputWidth={captureConfig.video.width}
              showCameraBubbleControls={showCameraBubbleControls}
              showCameraCornerControls={showCameraCornerControls}
              source={selectedSource}
              stageDragging={stageDragging}
              onApplyCameraPreset={applyCameraPreset}
              onApplyLayoutPatch={applyLayoutPatch}
              onAspectLockedChange={setAspectLocked}
              onPatchLayout={patchLayout}
              onTransformCommit={(patch) =>
                runPreciseEdit(() => setSceneSourceTransform(selectedSource.id, patch))
              }
              onVisibilityChange={setSceneSourceVisible}
            />
          ) : sourceIsFullCanvas(selectedSource) && !isFreeform ? (
            // Compact inspector for full-canvas sources: no dead controls. A
            // source that fills the frame has no position to nudge and nothing
            // to reset, so the arrow grid never renders (post-0.9.4 fix F3;
            // the disabled-arrow grid read as a broken app).
            <PanelSection
              className="min-w-0"
              description="Fills the whole canvas. Position is fixed for this layout."
              icon={AdjustIcon}
              title={selectedSource.name}
            >
              <SourceVisibilityField
                disabled={isSessionActive || stageDragging}
                lockReason={isSessionActive ? SCENE_VISIBILITY_LOCK_REASON : null}
                source={selectedSource}
                onVisibilityChange={setSceneSourceVisible}
              />
            </PanelSection>
          ) : (
            <>
              <PanelSection className="min-w-0" icon={AdjustIcon} title={selectedSource.name}>
                <SourceVisibilityField
                  disabled={isSessionActive || stageDragging}
                  lockReason={isSessionActive ? SCENE_VISIBILITY_LOCK_REASON : null}
                  source={selectedSource}
                  onVisibilityChange={setSceneSourceVisible}
                />
              </PanelSection>
              <PanelSection
                action={
                  <Button
                    disabled={isSessionActive || stageDragging}
                    variant="outline"
                    onClick={() => void resetSceneSource(selectedSource.id)}
                  >
                    Reset
                  </Button>
                }
                className="min-w-0"
                // Disabled arrows must say why: silent dead controls read as
                // a broken app (2026-07-02 report on the full-canvas screen).
                // One line of copy whether or not editing has started: the
                // first pointerdown on the stage starts it, and a line that
                // left then would shrink the page under the pointer and
                // cancel that very gesture (stage-undo-control.ts).
                description={
                  isSessionActive
                    ? SCENE_POSITION_LOCK_REASON
                    : 'Click the source on the stage to edit it: drag it, or nudge it with the arrows.'
                }
                headingLevel={3}
                title="Placement"
              >
                {/* Precise numeric twin of the stage gestures; commits ride the
                  same backend scene commit and echo the sanitized result. */}
                <SourceTransformFields
                  key={selectedSource.id}
                  aspectLocked={aspectLocked}
                  onAspectLockedChange={setAspectLocked}
                  disabled={isSessionActive || stageDragging}
                  disabledReason={isSessionActive ? SCENE_POSITION_LOCK_REASON : undefined}
                  outputHeight={captureConfig.video.height}
                  outputWidth={captureConfig.video.width}
                  source={selectedSource}
                  onCommit={(patch) =>
                    runPreciseEdit(() => setSceneSourceTransform(selectedSource.id, patch))
                  }
                />
                {/* w-fit + auto columns keep the arrows a tight d-pad cluster;
                  1fr side columns stretched, stranding ← at the panel edge
                  (external tester report, 2026-07-06). Shift takes the bigger
                  step, as on the stage. */}
                <div className="grid w-fit grid-cols-[repeat(3,auto)] items-center justify-items-center gap-2 self-start">
                  <span />
                  <Button
                    aria-label="Nudge source up"
                    disabled={!sceneEditMode || isSessionActive || stageDragging}
                    size="icon"
                    variant="outline"
                    onClick={(event) =>
                      runPreciseEdit(() =>
                        nudgeSceneSource(selectedSource.id, 0, -1, event.shiftKey)
                      )
                    }
                  >
                    <ArrowUpIcon />
                  </Button>
                  <span />
                  <Button
                    aria-label="Nudge source left"
                    disabled={!sceneEditMode || isSessionActive || stageDragging}
                    size="icon"
                    variant="outline"
                    onClick={(event) =>
                      runPreciseEdit(() =>
                        nudgeSceneSource(selectedSource.id, -1, 0, event.shiftKey)
                      )
                    }
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <Button
                    aria-label="Nudge source down"
                    disabled={!sceneEditMode || isSessionActive || stageDragging}
                    size="icon"
                    variant="outline"
                    onClick={(event) =>
                      runPreciseEdit(() =>
                        nudgeSceneSource(selectedSource.id, 0, 1, event.shiftKey)
                      )
                    }
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    aria-label="Nudge source right"
                    disabled={!sceneEditMode || isSessionActive || stageDragging}
                    size="icon"
                    variant="outline"
                    onClick={(event) =>
                      runPreciseEdit(() =>
                        nudgeSceneSource(selectedSource.id, 1, 0, event.shiftKey)
                      )
                    }
                  >
                    <ArrowRightIcon />
                  </Button>
                </div>
              </PanelSection>
            </>
          )}
          {/* Every banner, below the selection's own sections (plan 186). */}
          <SceneBannersSection
            banners={banners}
            loaded={bannersLoaded}
            offline={bannersOffline}
            // The banner and overlay inspectors above lead with the same
            // reconnecting lock: the pane says it once.
            offlineAlert={!selectedBanner && !(!selectedSource && selectedOverlayItem)}
            selectedId={selectedBanner?.id ?? null}
            showLimitReason={bannerShowLimitReason}
            onOpenAssets={() => openWorkspaceTab('assets')}
            onSelect={selectStageBanner}
            onShowChange={(banner, shown) => setBannerShown(banner.id, shown)}
          />
        </FieldSet>
      </div>
    </div>
  )
}

type CameraLayout = ReturnType<typeof useStudioCore>['captureConfig']['layout']

// The camera's inspector: Placement, Lens and Green screen as three flush
// sections under the camera's own (plan 174 S3.9, step 7). Each takes its
// description from the layout, so a scene with no corner or size says so once
// in the right place instead of a loose paragraph.
function CameraInspector({
  source,
  layout,
  isFreeform,
  isSideBySide,
  isCameraOnly,
  isVerticalCameraOnly,
  isVerticalStack,
  showCameraCornerControls,
  showCameraBubbleControls,
  isSessionActive,
  stageDragging,
  aspectLocked,
  outputWidth,
  outputHeight,
  onAspectLockedChange,
  onApplyCameraPreset,
  onApplyLayoutPatch,
  onPatchLayout,
  onTransformCommit,
  onVisibilityChange
}: {
  source: SceneSource
  layout: CameraLayout
  isFreeform: boolean
  isSideBySide: boolean
  isCameraOnly: boolean
  isVerticalCameraOnly: boolean
  isVerticalStack: boolean
  showCameraCornerControls: boolean
  showCameraBubbleControls: boolean
  isSessionActive: boolean
  stageDragging: boolean
  aspectLocked: boolean
  outputWidth: number
  outputHeight: number
  onAspectLockedChange: (locked: boolean) => void
  onApplyCameraPreset: (patch: Partial<CameraLayout>) => void
  onApplyLayoutPatch: (patch: Partial<CameraLayout>) => void
  onPatchLayout: (patch: Partial<CameraLayout>) => void
  onTransformCommit: (patch: { x?: number; y?: number; width?: number; height?: number }) => void
  onVisibilityChange: (sourceId: string, visible: boolean) => Promise<void>
}): ReactElement {
  const placementDescription = isFreeform
    ? 'Drag and resize the camera on the stage, or set exact numbers below.'
    : isCameraOnly
      ? "Camera only fills the frame as a rectangle. Corner, size and shape don't apply; frame yourself under Lens."
      : isVerticalCameraOnly
        ? "The camera fills the whole 9:16 canvas and crops to fit. Corner, size and shape don't apply; frame yourself under Lens."
        : isVerticalStack
          ? "The stacked vertical scenes give the camera and the screen fixed bands of the 9:16 canvas. Corner, size and shape don't apply; frame yourself under Lens."
          : undefined
  // Vertical bands and the full-canvas vertical camera ALWAYS fill and crop:
  // a "Fit frame" option would letterbox the short-form frame (2026-07-13
  // fill-crop plan), so the toggle is hidden and honest copy replaces it.
  // Zoom and pan below still frame the crop.
  const lensDescription = isVerticalCameraOnly
    ? 'The camera always fills the 9:16 canvas and crops. Use zoom and pan to frame yourself.'
    : isVerticalStack
      ? 'The camera band always fills and crops. Use zoom and pan to frame yourself.'
      : undefined
  const placement: ReactNode[] = []
  if (isSideBySide && !isFreeform) {
    placement.push(
      <Field key="split">
        <FieldLabel>Split</FieldLabel>
        <SegmentedControl
          className="w-full"
          options={SIDE_BY_SIDE_SPLIT_OPTIONS}
          value={layout.sideBySideSplit}
          onValueChange={(sideBySideSplit) => onApplyCameraPreset({ sideBySideSplit })}
        />
      </Field>,
      <Field key="side">
        <FieldLabel>Camera side</FieldLabel>
        <SegmentedControl
          className="w-full"
          options={CAMERA_SIDE_OPTIONS}
          value={layout.sideBySideCameraSide}
          onValueChange={(sideBySideCameraSide) => onApplyCameraPreset({ sideBySideCameraSide })}
        />
      </Field>
    )
  }
  if (showCameraCornerControls) {
    placement.push(
      <Field key="corner">
        <FieldLabel>Corner</FieldLabel>
        <SegmentedControl
          className="w-full"
          options={CAMERA_CORNER_OPTIONS}
          value={layout.cameraTransformMode === 'custom' ? null : layout.cameraCorner}
          onValueChange={(cameraCorner) => onApplyCameraPreset({ cameraCorner })}
        />
      </Field>
    )
  }
  if (showCameraBubbleControls) {
    placement.push(
      <div key="size-shape" className="grid min-w-0 grid-cols-2 gap-4">
        {!isFreeform ? (
          <Field className="min-w-0">
            <FieldLabel>Size</FieldLabel>
            <SegmentedControl
              className="w-full"
              options={CAMERA_SIZE_OPTIONS}
              value={layout.cameraSize}
              onValueChange={(cameraSize) => onApplyCameraPreset({ cameraSize })}
            />
          </Field>
        ) : null}
        <Field className="min-w-0">
          <FieldLabel>Shape</FieldLabel>
          <SegmentedControl
            className="w-full"
            options={CAMERA_SHAPE_OPTIONS}
            value={layout.cameraShape}
            onValueChange={(cameraShape) =>
              onApplyLayoutPatch(
                // Rounded means a rounded SQUARE by default (owner decision
                // 2026-07-06): picking it snaps the aspect to square in the
                // same gesture; the Aspect control below still allows the
                // original or portrait afterwards.
                cameraShape === 'rounded'
                  ? { cameraShape: 'rounded', cameraAspect: 'square' }
                  : { cameraShape }
              )
            }
          />
        </Field>
      </div>
    )
    if (layout.cameraShape === 'rounded') {
      placement.push(
        <PowerSlider
          key="radius"
          label="Corner radius"
          max={50}
          min={0}
          numericInput
          suffix="%"
          value={layout.cameraCornerRadiusPct}
          onChange={(cameraCornerRadiusPct) => onApplyLayoutPatch({ cameraCornerRadiusPct })}
        />
      )
    }
    if (layout.cameraShape !== 'circle') {
      placement.push(
        <Field key="aspect">
          <FieldLabel>Aspect</FieldLabel>
          <SegmentedControl
            className="w-full"
            options={CAMERA_ASPECT_OPTIONS}
            value={layout.cameraAspect}
            onValueChange={(cameraAspect) => onApplyLayoutPatch({ cameraAspect })}
          />
          {layout.cameraAspect !== 'source' ? (
            <p className="text-xs text-muted-foreground">
              Crops the sides of the camera. Frame yourself centered.
            </p>
          ) : null}
        </Field>
      )
    }
    if (!isFreeform) {
      placement.push(
        <PowerSlider
          key="margin"
          label="Margin"
          max={96}
          min={0}
          numericInput
          suffix="px"
          value={layout.cameraMargin}
          onChange={(cameraMargin) => onPatchLayout({ cameraMargin })}
          onCommit={(cameraMargin) => onApplyLayoutPatch({ cameraMargin })}
        />
      )
    }
    placement.push(
      // The precise twin of the stage drag: numeric percent fields that
      // commit through the same backend scene commit, so both paths agree.
      <SourceTransformFields
        key={`fields-${source.id}`}
        aspectLocked={aspectLocked}
        onAspectLockedChange={onAspectLockedChange}
        aspectForced={layout.cameraShape === 'circle' || layout.cameraAspect !== 'source'}
        disabled={isSessionActive || stageDragging}
        disabledReason={isSessionActive ? SCENE_POSITION_LOCK_REASON : undefined}
        outputHeight={outputHeight}
        outputWidth={outputWidth}
        source={source}
        onCommit={onTransformCommit}
      />
    )
  }
  return (
    <>
      <PanelSection className="min-w-0" icon={AdjustIcon} title={source.name}>
        <SourceVisibilityField
          disabled={isSessionActive || stageDragging}
          lockReason={isSessionActive ? SCENE_VISIBILITY_LOCK_REASON : null}
          source={source}
          onVisibilityChange={onVisibilityChange}
        />
        {/* One committed patch back to the shipped camera defaults, behind a
            question (plan 174 C-18). Never touches the layout preset or the
            selected sources (owner request, 2026-08-19). */}
        <CameraResetButton
          onReset={(defaults) => {
            onPatchLayout(defaults)
            onApplyLayoutPatch(defaults)
          }}
        />
      </PanelSection>
      <PanelSection
        className="min-w-0"
        description={placementDescription}
        headingLevel={3}
        title="Placement"
      >
        {placement.length ? placement : null}
      </PanelSection>
      <PanelSection className="min-w-0" description={lensDescription} headingLevel={3} title="Lens">
        {isVerticalStack || isVerticalCameraOnly ? null : (
          <Field>
            <FieldLabel>Fit</FieldLabel>
            <SegmentedControl
              options={CAMERA_FIT_OPTIONS}
              value={layout.cameraFit}
              onValueChange={(cameraFit) => {
                onPatchLayout({ cameraFit })
                onApplyLayoutPatch({ cameraFit })
              }}
            />
          </Field>
        )}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="camera-mirror">Mirror camera</FieldLabel>
          </FieldContent>
          <Switch
            checked={layout.cameraMirror}
            id="camera-mirror"
            onCheckedChange={(checked) => {
              onPatchLayout({ cameraMirror: checked })
              onApplyLayoutPatch({ cameraMirror: checked })
            }}
          />
        </Field>
        <PowerSlider
          label="Zoom"
          max={200}
          min={100}
          numericInput
          step={5}
          suffix="%"
          value={layout.cameraZoom}
          onChange={(cameraZoom) => onPatchLayout({ cameraZoom })}
          onCommit={(cameraZoom) => onApplyLayoutPatch({ cameraZoom })}
        />
        <PowerSlider
          bipolar
          label="Pan X"
          max={100}
          min={-100}
          numericInput
          step={5}
          value={layout.cameraOffsetX}
          onChange={(cameraOffsetX) => onPatchLayout({ cameraOffsetX })}
          onCommit={(cameraOffsetX) => onApplyLayoutPatch({ cameraOffsetX })}
        />
        <PowerSlider
          bipolar
          label="Pan Y"
          max={100}
          min={-100}
          numericInput
          step={5}
          value={layout.cameraOffsetY}
          onChange={(cameraOffsetY) => onPatchLayout({ cameraOffsetY })}
          onCommit={(cameraOffsetY) => onApplyLayoutPatch({ cameraOffsetY })}
        />
      </PanelSection>
      <PanelSection className="min-w-0" headingLevel={3} title="Green screen">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="camera-chroma-key">Key out background</FieldLabel>
            <p className="text-xs text-muted-foreground">
              Needs an evenly lit green or blue screen behind you.
            </p>
          </FieldContent>
          <Switch
            checked={layout.cameraChromaKeyEnabled}
            id="camera-chroma-key"
            onCheckedChange={(cameraChromaKeyEnabled) =>
              onApplyLayoutPatch({ cameraChromaKeyEnabled })
            }
          />
        </Field>
        {layout.cameraChromaKeyEnabled ? (
          <>
            <Field>
              <FieldLabel>Key color</FieldLabel>
              <SegmentedControl
                className="w-full"
                options={CHROMA_KEY_COLOR_OPTIONS}
                value={layout.cameraChromaKeyColor === CHROMA_KEY_BLUE ? 'blue' : 'green'}
                onValueChange={(color) =>
                  onApplyLayoutPatch({
                    cameraChromaKeyColor: color === 'blue' ? CHROMA_KEY_BLUE : CHROMA_KEY_GREEN
                  })
                }
              />
            </Field>
            <PowerSlider
              label="Similarity"
              max={100}
              min={0}
              numericInput
              step={1}
              suffix="%"
              value={layout.cameraChromaKeySimilarityPct}
              onChange={(cameraChromaKeySimilarityPct) =>
                onPatchLayout({ cameraChromaKeySimilarityPct })
              }
              onCommit={(cameraChromaKeySimilarityPct) =>
                onApplyLayoutPatch({ cameraChromaKeySimilarityPct })
              }
            />
            <PowerSlider
              label="Smoothness"
              max={100}
              min={0}
              numericInput
              step={1}
              suffix="%"
              value={layout.cameraChromaKeySmoothnessPct}
              onChange={(cameraChromaKeySmoothnessPct) =>
                onPatchLayout({ cameraChromaKeySmoothnessPct })
              }
              onCommit={(cameraChromaKeySmoothnessPct) =>
                onApplyLayoutPatch({ cameraChromaKeySmoothnessPct })
              }
            />
            <PowerSlider
              label="Spill removal"
              max={100}
              min={0}
              numericInput
              step={1}
              suffix="%"
              value={layout.cameraChromaKeySpillPct}
              onChange={(cameraChromaKeySpillPct) => onPatchLayout({ cameraChromaKeySpillPct })}
              onCommit={(cameraChromaKeySpillPct) =>
                onApplyLayoutPatch({ cameraChromaKeySpillPct })
              }
            />
          </>
        ) : null}
      </PanelSection>
    </>
  )
}

// Shared visibility control for the Inspector (replaces the removed Scene
// sources rows: visibility now lives with the selected source). Disabled, it
// says why on hover and focus (plan 174, C-22).
function SourceVisibilityField({
  source,
  disabled,
  lockReason = null,
  onVisibilityChange
}: {
  source: SceneSource
  disabled: boolean
  /** Why the switch is off, while it is; null for a transient disable. */
  lockReason?: string | null
  onVisibilityChange: (sourceId: string, visible: boolean) => Promise<void>
}): ReactElement {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={`source-visible-${source.id}`}>Visible in scene</FieldLabel>
      </FieldContent>
      <DisabledReason reason={disabled ? lockReason : null}>
        <Switch
          checked={source.visible}
          disabled={disabled}
          id={`source-visible-${source.id}`}
          onCheckedChange={(visible) => void onVisibilityChange(source.id, visible)}
        />
      </DisabledReason>
    </Field>
  )
}

// The inspector for an overlay item (plan 164, S-B4.3): the two output
// switches and a snap menu for the orientation on the stage. Placement lives
// here and on the canvas, nowhere else (one-home law); the Stream Manager
// corner menu is a snap that writes the same rect.
const OVERLAY_ITEM_DESCRIPTIONS: Record<OverlayItem, string> = {
  highlight: 'The highlighted message card. Drag it on the stage or snap it to a corner.',
  captions:
    'The caption bar. Drag its edges to set its width; style and text size live in Captions.',
  buddy: 'Your Buddy and its speech bubble. Drag it on the stage or snap it to a corner.',
  poll: 'The poll card while a poll runs. Drag it on the stage or snap it to a corner.'
}

/** Exported for its test: the overlay controls, off with one reason while
 * they cannot reach the backend (plan 174, C-6). */
export function OverlayItemInspector({
  item,
  layout,
  orientation,
  blockedReason = null,
  onPatch,
  onSnap
}: {
  item: OverlayItem
  layout: { showOnStream: boolean; showInRecording: boolean }
  orientation: OverlayOrientation
  /** Why the controls are off; null while a change can be saved. */
  blockedReason?: string | null
  onPatch: (patch: Partial<{ showOnStream: boolean; showInRecording: boolean }>) => void
  onSnap: (snap: OverlaySnap) => void
}): ReactElement {
  const blocked = blockedReason !== null
  return (
    <div className="flex flex-col gap-4" data-videorc-overlay-inspector={item}>
      {blockedReason ? <LockAlert reason={blockedReason} /> : null}
      <p className="text-sm text-muted-foreground">{OVERLAY_ITEM_DESCRIPTIONS[item]}</p>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`overlay-${item}-stream`}>Show on stream</FieldLabel>
        </FieldContent>
        <Switch
          checked={layout.showOnStream}
          disabled={blocked}
          id={`overlay-${item}-stream`}
          onCheckedChange={(showOnStream) => onPatch({ showOnStream })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`overlay-${item}-recording`}>Show in recording</FieldLabel>
        </FieldContent>
        <Switch
          checked={layout.showInRecording}
          disabled={blocked}
          id={`overlay-${item}-recording`}
          onCheckedChange={(showInRecording) => onPatch({ showInRecording })}
        />
      </Field>
      <Field>
        <FieldLabel>
          {orientation === 'vertical' ? 'Snap on the vertical stream' : 'Snap to'}
        </FieldLabel>
        {/* One-shot moves, so plain Buttons: nothing stays selected (plan 174 C-37). */}
        <div aria-label="Snap overlay" className="flex w-full flex-wrap gap-2" role="group">
          {OVERLAY_SNAPS.map((snap) => (
            <Button key={snap} disabled={blocked} variant="outline" onClick={() => onSnap(snap)}>
              {OVERLAY_SNAP_LABELS[snap]}
            </Button>
          ))}
        </div>
      </Field>
    </div>
  )
}

function sourceIsFullCanvas(source: SceneSource): boolean {
  return source.transform.width >= 1 && source.transform.height >= 1
}
