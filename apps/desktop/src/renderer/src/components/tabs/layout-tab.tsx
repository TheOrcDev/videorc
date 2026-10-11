import ScenePresetControls from '@/components/scene-presets'
import {
  AdjustIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  LayoutIcon
} from '@/components/icons'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { dockHiddenDisplay } from '@/components/preview-stage'
import { CameraResetButton } from '@/components/scene/camera-reset-button'
import {
  OverlayEdits,
  overlayEditsBlockedReason,
  overlayStageItems,
  withOverlayRect
} from '@/components/scene/overlay-stage'
import { SceneStage } from '@/components/scene/scene-stage'
import { SourceTransformFields } from '@/components/scene/source-transform-fields'
import { PowerSlider } from '@/components/power-slider'
import { SectionLabel } from '@/components/section-label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldLabel, FieldSet } from '@/components/ui/field'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { useDockSlotReporter } from '@/hooks/use-dock-slot'
import { useStudioCore } from '@/hooks/use-studio'
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
  simulcastLegLiveRequest
} from '@/lib/capture'
import { freeformEntryOverrides, rememberedFreeform } from '@/lib/freeform-memory'
import {
  OVERLAY_ITEM_LABELS,
  OVERLAY_SNAPS,
  OVERLAY_SNAP_LABELS,
  overlayOrientationForCanvas,
  overlaySnapRect
} from '@/lib/overlay-layout'
import { LAYOUT_PRESET_LABELS } from '@/lib/layout-labels'
import { effectiveCameraMaskShape } from '../../../../shared/native-preview-proof-geometry'

// The two real-world screen colors; the protocol takes any #RRGGBB so a
// custom picker later needs no wire change.
const CHROMA_KEY_GREEN = '#00FF00'
const CHROMA_KEY_BLUE = '#0000FF'

// Mode-scoped like the Scenes gallery: the tab edits the current
// orientation's scenes; the gallery's header toggle switches modes.
// Names come from the one layout table (plan 174 S1.4, V-X3).
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

const CAMERA_CORNER_OPTIONS: SegmentedControlOption<CameraCorner>[] = [
  { value: 'top-left', label: 'Top L' },
  { value: 'top-right', label: 'Top R' },
  { value: 'bottom-left', label: 'Bot L' },
  { value: 'bottom-right', label: 'Bot R' }
]

const CAMERA_SIZE_OPTIONS: SegmentedControlOption<CameraSize>[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' }
]

const CAMERA_SHAPE_OPTIONS: SegmentedControlOption<CameraShape>[] = [
  { value: 'rectangle', label: 'Rect', 'data-videorc-camera-shape': 'rectangle' },
  { value: 'rounded', label: 'Round', 'data-videorc-camera-shape': 'rounded' },
  { value: 'circle', label: 'Circle', 'data-videorc-camera-shape': 'circle' }
]

const CAMERA_ASPECT_OPTIONS: SegmentedControlOption<CameraAspect>[] = [
  { value: 'source', label: 'Wide', 'data-videorc-camera-aspect': 'source' },
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

export function LayoutTab(): ReactElement {
  const {
    captureConfig,
    patchLayout,
    applyLayoutPatch,
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
    overlayLayout,
    setOverlayLayout,
    reportError,
    wsStatus
  } = useStudioCore()
  const [stageBusy, setStageBusy] = useState(false)
  // Overlay items on the canvas (plan 164, D15). One selection on the stage:
  // picking an item clears the source selection and the other way round.
  const [selectedOverlayItem, setSelectedOverlayItem] = useState<OverlayItem | null>(null)
  const [, redrawOverlays] = useReducer((value: number) => value + 1, 0)
  const overlayEditsRef = useRef<OverlayEdits | null>(null)
  if (!overlayEditsRef.current)
    overlayEditsRef.current = new OverlayEdits(setOverlayLayout, redrawOverlays, reportError)
  const overlayEdits = overlayEditsRef.current
  overlayEdits.configure(setOverlayLayout, reportError)
  // Plan 174, C-6: overlay changes need the backend; without it the controls
  // are off with one reason, and every failed change is reported.
  const overlayBlockedReason = overlayEditsBlockedReason(wsStatus)
  useLayoutEffect(() => {
    overlayEdits.observe(overlayLayout)
  }, [overlayEdits, overlayLayout])
  // Orientation (D15): the primary canvas places the item's horizontal rect
  // (or its vertical one for a vertical scene); with a vertical leg armed the
  // toggle shows that leg's rects over a greyed 9:16 canvas.
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
  const handleStageBusyChange = useCallback(
    (busy: boolean) => {
      setStageBusy(busy)
      setSceneGesturePending(busy)
    },
    [setSceneGesturePending]
  )
  const sceneSwitchPending = layoutSwitchPending !== null || savedScenePendingId !== null
  const [preciseEditPending, setPreciseEditPending] = useState(false)
  const preciseEditPendingRef = useRef(false)
  const runPreciseEdit = (operation: () => Promise<unknown>): void => {
    if (stageBusy || preciseEditPendingRef.current || sceneSwitchPending) return
    preciseEditPendingRef.current = true
    setPreciseEditPending(true)
    void operation().finally(() => {
      preciseEditPendingRef.current = false
      setPreciseEditPending(false)
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
  const selectedSource = scene?.sources.find((source) => source.id === selectedSceneSourceId)
  // SC2: the inspector follows the stage selection; default to the camera
  // (the thing people usually frame) so the panel is never empty.
  useEffect(() => {
    if (selectedSceneSourceId || selectedOverlayItem || !scene?.sources.length) {
      return
    }
    const camera = scene.sources.find((source) => source.kind === 'camera')
    setSelectedSceneSourceId((camera ?? scene.sources[0]).id)
  }, [scene, selectedOverlayItem, selectedSceneSourceId, setSelectedSceneSourceId])
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
  // The stacked vertical scenes have fixed bands — no corner/size/shape; the
  // vertical Screen + camera is a true inset scene and keeps every overlay
  // control, exactly like its landscape twin.
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
      layoutPresetOrientation(layout.layoutPreset),
      scene.sources
    )
    applyCameraPreset({ arrangementMode: 'freeform', sourceTransformOverrides })
  }
  const layoutTabPresets =
    layoutPresetOrientation(layout.layoutPreset) === 'vertical'
      ? VERTICAL_LAYOUT_TAB_PRESETS
      : HORIZONTAL_LAYOUT_TAB_PRESETS

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

  return (
    <div className="flex flex-col">
      <div className="grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col lg:border-r">
          <PanelSection
            description="Pick how the screen and camera are composed."
            icon={LayoutIcon}
            title="Layout preset"
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* One segmented control for the presets; Freeform is a mode, not
                  a preset, so it is its own toggle beside them (plan 174 C-15).
                  A switch applies live, so arrows only move focus (manual). */}
              <SegmentedControl<LayoutPreset>
                activationMode="manual"
                aria-label="Layout preset"
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
            {isSessionActive ? (
              <p className="text-xs text-muted-foreground">
                Switching applies live. Recording and streaming keep running.
              </p>
            ) : !hasScreen ? (
              <p className="text-xs text-muted-foreground">
                Select a screen or window in Studio to enable screen layouts.
              </p>
            ) : !hasCamera ? (
              <p className="text-xs text-muted-foreground">
                {layoutPresetOrientation(layout.layoutPreset) === 'vertical'
                  ? 'Select a camera in Studio to enable the camera scenes.'
                  : 'Select a camera in Studio to enable Camera only and Side by side.'}
              </p>
            ) : null}
          </PanelSection>

          {/* The Scene canvas: on macOS the docked native preview is the
              picture and the SVG stage owns pointer input (plan 058);
              elsewhere, or while the surface is hidden or floating, the SVG
              draws the committed composition as a schematic (zero idle IPC). */}
          <div className="flex flex-col gap-3 border-b border-border p-gutter">
            <ScenePresetControls toolbar />
            {verticalLeg ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-subtle">Overlays on</span>
                <SegmentedControl
                  aria-label="Overlay orientation"
                  data-videorc-overlay-orientation
                  options={OVERLAY_ORIENTATION_OPTIONS}
                  size="sm"
                  value={verticalView ? 'vertical' : 'horizontal'}
                  onValueChange={setOrientationChoice}
                />
              </div>
            ) : null}
            <SceneStage
              aspectLocked={aspectLocked}
              externalPending={preciseEditPending}
              onBusyChange={handleStageBusyChange}
              // The camera's box aspect is owned by the mask law (circle boxes
              // are square by construction; square/portrait force the crop), so
              // resize gestures must not free it.
              cameraAspectLocked={
                layout.cameraShape === 'circle' || layout.cameraAspect !== 'source'
              }
              cameraCornerRadiusPct={layout.cameraCornerRadiusPct}
              // WYSIWYG: only the inset scenes mask the camera bubble (backend
              // camera_mask policy) — side-by-side and the vertical bands render
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
              outputAspect={
                verticalView && verticalLeg?.video
                  ? verticalLeg.video.width / Math.max(1, verticalLeg.video.height)
                  : verticalView
                    ? 9 / 16
                    : captureConfig.video.width / Math.max(1, captureConfig.video.height)
              }
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
              // The vertical view is the derived leg's canvas: a greyed stage
              // with that leg's overlay rects; the sources stay with the
              // primary (the leg is derived, plan 164 out of scope).
              scene={verticalView ? null : scene}
              selectedSourceId={verticalView ? null : selectedSceneSourceId}
              liveDocked={!verticalView && liveCanvasActive}
              liveHint={verticalView ? 'Vertical stream: only overlays move here.' : liveHint}
              liveSurface={!verticalView && liveSurface}
              slotRef={liveCanvasSupported && !verticalView ? slotRef : undefined}
              overlays={{
                items: overlayStageItems(overlayLayout, overlayOrientation),
                selectedItem: selectedOverlayItem,
                draft:
                  overlayEdits.draft?.orientation === overlayOrientation
                    ? overlayEdits.draft
                    : null,
                editable: !preciseEditPending && !sceneSwitchPending && !overlayBlockedReason,
                onSelect: (item) => {
                  setSelectedOverlayItem(item)
                  setSelectedSceneSourceId(null)
                },
                onCommit: (item, rect) =>
                  overlayEdits.submit(overlayLayout, item, overlayOrientation, rect)
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
              onRequestFreeform={isFreeform || isSessionActive ? undefined : enterFreeform}
              onSelectSource={(sourceId) => {
                setSelectedOverlayItem(null)
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
            />
          </div>

          {/* The old "Scene sources" panel is gone (post-0.9.4 fix batch F3):
              it duplicated the stage — the stage's rects and legend chips ARE
              the source list, clicking one selects it (and enables editing),
              and visibility now lives in the Inspector. */}
        </div>

        <FieldSet
          className="min-w-0"
          disabled={stageBusy || preciseEditPending || sceneSwitchPending}
          inert={stageBusy || preciseEditPending || sceneSwitchPending}
        >
          <PanelSection
            className="min-w-0"
            icon={AdjustIcon}
            title={
              selectedSource
                ? selectedSource.name
                : selectedOverlayItem
                  ? OVERLAY_ITEM_LABELS[selectedOverlayItem]
                  : 'Inspector'
            }
          >
            {!selectedSource && selectedOverlayItem && selectedOverlayLayout ? (
              <OverlayItemInspector
                blockedReason={overlayBlockedReason}
                item={selectedOverlayItem}
                layout={selectedOverlayLayout}
                orientation={overlayOrientation}
                onPatch={patchSelectedOverlay}
                onSnap={snapSelectedOverlay}
              />
            ) : !selectedSource ? (
              <p className="text-sm text-muted-foreground">
                Click a source or an overlay on the stage to edit it.
              </p>
            ) : selectedSource.kind === 'camera' ? (
              <>
                <SectionLabel>Placement</SectionLabel>
                {isFreeform ? (
                  <p className="text-sm text-muted-foreground">
                    Freeform scene: drag and resize the camera on the stage, or set exact numbers
                    below.
                  </p>
                ) : null}
                {isSideBySide && !isFreeform ? (
                  <>
                    <Field>
                      <FieldLabel>Split</FieldLabel>
                      <SegmentedControl
                        className="w-full"
                        options={SIDE_BY_SIDE_SPLIT_OPTIONS}
                        value={layout.sideBySideSplit}
                        onValueChange={(sideBySideSplit) => applyCameraPreset({ sideBySideSplit })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Camera side</FieldLabel>
                      <SegmentedControl
                        className="w-full"
                        options={CAMERA_SIDE_OPTIONS}
                        value={layout.sideBySideCameraSide}
                        onValueChange={(sideBySideCameraSide) =>
                          applyCameraPreset({ sideBySideCameraSide })
                        }
                      />
                    </Field>
                  </>
                ) : null}

                {isCameraOnly && !isFreeform ? (
                  <p className="text-sm text-muted-foreground">
                    Camera only fills the frame as a rectangle. Corner, size, and shape do not
                    apply. Use fit, mirror, zoom, and pan.
                  </p>
                ) : null}

                {isVerticalCameraOnly && !isFreeform ? (
                  <p className="text-sm text-muted-foreground">
                    The camera fills the whole 9:16 canvas and crops to fit. Corner, size, and shape
                    do not apply. Use mirror, zoom, and pan to frame yourself.
                  </p>
                ) : null}

                {isVerticalStack && !isFreeform ? (
                  <p className="text-sm text-muted-foreground">
                    The stacked vertical scenes give the camera and the screen fixed bands of the
                    9:16 canvas. Corner, size, and shape do not apply. Use mirror, zoom, and pan.
                  </p>
                ) : null}

                {showCameraCornerControls ? (
                  <Field>
                    <FieldLabel>Corner</FieldLabel>
                    <SegmentedControl
                      className="w-full"
                      options={CAMERA_CORNER_OPTIONS}
                      value={layout.cameraTransformMode === 'custom' ? null : layout.cameraCorner}
                      onValueChange={(cameraCorner) => applyCameraPreset({ cameraCorner })}
                    />
                  </Field>
                ) : null}

                {showCameraBubbleControls ? (
                  <>
                    <div className="grid min-w-0 grid-cols-2 gap-4">
                      {!isFreeform ? (
                        <Field className="min-w-0">
                          <FieldLabel>Size</FieldLabel>
                          <SegmentedControl
                            className="w-full"
                            options={CAMERA_SIZE_OPTIONS}
                            value={layout.cameraSize}
                            onValueChange={(cameraSize) => applyCameraPreset({ cameraSize })}
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
                            applyLayoutPatch(
                              // Rounded means a rounded SQUARE by default (owner
                              // decision 2026-07-06) — picking it snaps the aspect
                              // to square in the same gesture; the Aspect toggle
                              // below still allows wide/portrait afterwards.
                              cameraShape === 'rounded'
                                ? { cameraShape: 'rounded', cameraAspect: 'square' }
                                : { cameraShape }
                            )
                          }
                        />
                      </Field>
                    </div>

                    {layout.cameraShape === 'rounded' ? (
                      <PowerSlider
                        label="Corner radius"
                        max={50}
                        min={0}
                        numericInput
                        suffix="%"
                        value={layout.cameraCornerRadiusPct}
                        onChange={(cameraCornerRadiusPct) =>
                          applyLayoutPatch({ cameraCornerRadiusPct })
                        }
                      />
                    ) : null}

                    {layout.cameraShape !== 'circle' ? (
                      <Field>
                        <FieldLabel>Aspect</FieldLabel>
                        <SegmentedControl
                          className="w-full"
                          options={CAMERA_ASPECT_OPTIONS}
                          value={layout.cameraAspect}
                          onValueChange={(cameraAspect) => applyLayoutPatch({ cameraAspect })}
                        />
                        {layout.cameraAspect !== 'source' ? (
                          <p className="text-xs text-muted-foreground">
                            Crops the sides of the camera. Frame yourself centered.
                          </p>
                        ) : null}
                      </Field>
                    ) : null}

                    {!isFreeform ? (
                      <PowerSlider
                        label="Margin"
                        max={96}
                        min={0}
                        numericInput
                        suffix="px"
                        value={layout.cameraMargin}
                        onChange={(cameraMargin) => patchLayout({ cameraMargin })}
                        onCommit={(cameraMargin) => applyLayoutPatch({ cameraMargin })}
                      />
                    ) : null}

                    {/* The precise twin of the stage drag: numeric percent
                      fields that commit through the same backend scene
                      commit, so both paths always agree. */}
                    <SourceTransformFields
                      key={selectedSource.id}
                      aspectLocked={aspectLocked}
                      onAspectLockedChange={setAspectLocked}
                      aspectForced={
                        layout.cameraShape === 'circle' || layout.cameraAspect !== 'source'
                      }
                      disabled={isSessionActive || stageBusy}
                      disabledReason={
                        isSessionActive
                          ? 'The layout is locked while you’re recording or live.'
                          : undefined
                      }
                      outputHeight={captureConfig.video.height}
                      outputWidth={captureConfig.video.width}
                      source={selectedSource}
                      onCommit={(patch) =>
                        runPreciseEdit(() => setSceneSourceTransform(selectedSource.id, patch))
                      }
                    />
                  </>
                ) : null}

                <SectionLabel className="pt-2">Lens</SectionLabel>
                {/* Vertical bands and the full-canvas vertical camera ALWAYS
                  fill and crop — a "Fit frame" option would letterbox the
                  short-form frame (2026-07-13 fill-crop plan), so the toggle
                  is hidden and honest copy replaces it. Zoom and pan below
                  still frame the crop. */}
                {isVerticalStack || isVerticalCameraOnly ? (
                  <p className="text-sm text-muted-foreground">
                    {isVerticalCameraOnly
                      ? 'The camera always fills the 9:16 canvas and crops. Use zoom and pan to frame yourself.'
                      : 'The camera band always fills and crops. Use zoom and pan to frame yourself.'}
                  </p>
                ) : (
                  <Field>
                    <FieldLabel>Fit</FieldLabel>
                    <SegmentedControl
                      options={CAMERA_FIT_OPTIONS}
                      value={layout.cameraFit}
                      onValueChange={(cameraFit) => {
                        patchLayout({ cameraFit })
                        applyLayoutPatch({ cameraFit })
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
                      patchLayout({ cameraMirror: checked })
                      applyLayoutPatch({ cameraMirror: checked })
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
                  onChange={(cameraZoom) => patchLayout({ cameraZoom })}
                  onCommit={(cameraZoom) => applyLayoutPatch({ cameraZoom })}
                />
                <PowerSlider
                  bipolar
                  label="Pan X"
                  max={100}
                  min={-100}
                  numericInput
                  step={5}
                  value={layout.cameraOffsetX}
                  onChange={(cameraOffsetX) => patchLayout({ cameraOffsetX })}
                  onCommit={(cameraOffsetX) => applyLayoutPatch({ cameraOffsetX })}
                />
                <PowerSlider
                  bipolar
                  label="Pan Y"
                  max={100}
                  min={-100}
                  numericInput
                  step={5}
                  value={layout.cameraOffsetY}
                  onChange={(cameraOffsetY) => patchLayout({ cameraOffsetY })}
                  onCommit={(cameraOffsetY) => applyLayoutPatch({ cameraOffsetY })}
                />

                <SectionLabel className="pt-2">Green screen</SectionLabel>
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
                      applyLayoutPatch({ cameraChromaKeyEnabled })
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
                          applyLayoutPatch({
                            cameraChromaKeyColor:
                              color === 'blue' ? CHROMA_KEY_BLUE : CHROMA_KEY_GREEN
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
                        patchLayout({ cameraChromaKeySimilarityPct })
                      }
                      onCommit={(cameraChromaKeySimilarityPct) =>
                        applyLayoutPatch({ cameraChromaKeySimilarityPct })
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
                        patchLayout({ cameraChromaKeySmoothnessPct })
                      }
                      onCommit={(cameraChromaKeySmoothnessPct) =>
                        applyLayoutPatch({ cameraChromaKeySmoothnessPct })
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
                      onChange={(cameraChromaKeySpillPct) =>
                        patchLayout({ cameraChromaKeySpillPct })
                      }
                      onCommit={(cameraChromaKeySpillPct) =>
                        applyLayoutPatch({ cameraChromaKeySpillPct })
                      }
                    />
                  </>
                ) : null}

                {/* One committed patch back to the shipped camera defaults,
                  behind a question (plan 174 C-18). Never touches the layout
                  preset or the selected sources (owner request, 2026-08-19). */}
                <CameraResetButton
                  onReset={(defaults) => {
                    patchLayout(defaults)
                    applyLayoutPatch(defaults)
                  }}
                />

                <SourceVisibilityField
                  disabled={isSessionActive || stageBusy}
                  source={selectedSource}
                  onVisibilityChange={setSceneSourceVisible}
                />
              </>
            ) : sourceIsFullCanvas(selectedSource) && !isFreeform ? (
              // Compact inspector for full-canvas sources: no dead controls — a
              // source that fills the frame has no position to nudge and nothing
              // to reset, so the arrow grid never renders (post-0.9.4 fix F3;
              // the disabled-arrow grid read as a broken app).
              <div className="grid gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{selectedSource.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Fills the whole canvas. Position is fixed for this layout.
                  </div>
                </div>
                <SourceVisibilityField
                  disabled={isSessionActive || stageBusy}
                  source={selectedSource}
                  onVisibilityChange={setSceneSourceVisible}
                />
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-sm font-semibold">
                    {selectedSource.name}
                  </div>
                  <Button
                    disabled={isSessionActive || stageBusy}
                    size="sm"
                    variant="outline"
                    onClick={() => void resetSceneSource(selectedSource.id)}
                  >
                    Reset
                  </Button>
                </div>
                {/* Precise numeric twin of the stage gestures; commits ride the
                  same backend scene commit and echo the sanitized result. */}
                <SourceTransformFields
                  key={selectedSource.id}
                  aspectLocked={aspectLocked}
                  onAspectLockedChange={setAspectLocked}
                  disabled={isSessionActive || stageBusy}
                  disabledReason={
                    isSessionActive
                      ? 'The layout is locked while you’re recording or live.'
                      : undefined
                  }
                  outputHeight={captureConfig.video.height}
                  outputWidth={captureConfig.video.width}
                  source={selectedSource}
                  onCommit={(patch) =>
                    runPreciseEdit(() => setSceneSourceTransform(selectedSource.id, patch))
                  }
                />
                {/* w-fit + auto columns keep the arrows a tight d-pad cluster —
                  1fr side columns stretched, stranding ← at the panel edge
                  (external tester report, 2026-07-06). */}
                <div className="grid w-fit grid-cols-[repeat(3,auto)] items-center justify-items-center gap-2 self-start">
                  <span />
                  <Button
                    aria-label="Nudge source up"
                    disabled={!sceneEditMode || isSessionActive || stageBusy}
                    size="icon"
                    variant="outline"
                    onClick={() => runPreciseEdit(() => nudgeSceneSource(selectedSource.id, 0, -1))}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <span />
                  <Button
                    aria-label="Nudge source left"
                    disabled={!sceneEditMode || isSessionActive || stageBusy}
                    size="icon"
                    variant="outline"
                    onClick={() => runPreciseEdit(() => nudgeSceneSource(selectedSource.id, -1, 0))}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <Button
                    aria-label="Nudge source down"
                    disabled={!sceneEditMode || isSessionActive || stageBusy}
                    size="icon"
                    variant="outline"
                    onClick={() => runPreciseEdit(() => nudgeSceneSource(selectedSource.id, 0, 1))}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    aria-label="Nudge source right"
                    disabled={!sceneEditMode || isSessionActive || stageBusy}
                    size="icon"
                    variant="outline"
                    onClick={() => runPreciseEdit(() => nudgeSceneSource(selectedSource.id, 1, 0))}
                  >
                    <ArrowRightIcon />
                  </Button>
                </div>
                {/* Disabled arrows must say why — silent dead controls read as
                  a broken app (2026-07-02 report on the full-canvas screen). */}
                {!sceneEditMode ? (
                  <p className="text-xs text-muted-foreground">
                    Click the source on the stage to start editing, then nudge with the arrows.
                  </p>
                ) : isSessionActive ? (
                  <p className="text-xs text-muted-foreground">
                    The layout is locked while you’re recording or live.
                  </p>
                ) : null}
                <SourceVisibilityField
                  disabled={isSessionActive || stageBusy}
                  source={selectedSource}
                  onVisibilityChange={setSceneSourceVisible}
                />
              </div>
            )}
          </PanelSection>
        </FieldSet>
      </div>
    </div>
  )
}

// Shared visibility control for the Inspector (replaces the removed Scene
// sources rows — visibility now lives with the selected source).
function SourceVisibilityField({
  source,
  disabled,
  onVisibilityChange
}: {
  source: SceneSource
  disabled: boolean
  onVisibilityChange: (sourceId: string, visible: boolean) => Promise<void>
}): ReactElement {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={`source-visible-${source.id}`}>Visible in scene</FieldLabel>
      </FieldContent>
      <Switch
        checked={source.visible}
        disabled={disabled}
        id={`source-visible-${source.id}`}
        onCheckedChange={(visible) => void onVisibilityChange(source.id, visible)}
      />
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
  buddy: 'Your Buddy and its speech bubble. Drag it on the stage or snap it to a corner.'
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
            <Button
              key={snap}
              disabled={blocked}
              size="sm"
              variant="outline"
              onClick={() => onSnap(snap)}
            >
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
