import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Layout,
  SlidersHorizontal
} from '@phosphor-icons/react'
import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SceneStage } from '@/components/scene/scene-stage'
import { PowerSlider } from '@/components/power-slider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  CameraAspect,
  CameraCorner,
  CameraFit,
  CameraShape,
  CameraSize,
  SceneSource,
  SideBySideCameraSide,
  SideBySideSplit
} from '@/lib/backend'
import {
  hasSelectedCameraSource,
  hasSelectedScreenSource,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation
} from '@/lib/capture'

// Mode-scoped like the Scenes gallery: the tab edits the current
// orientation's scenes; the gallery's header toggle switches modes.
const HORIZONTAL_LAYOUT_TAB_PRESETS = [
  { id: 'screen-camera', label: 'Screen + camera', enabled: true },
  { id: 'screen-only', label: 'Screen only', enabled: true },
  { id: 'camera-only', label: 'Camera only', enabled: true },
  { id: 'side-by-side', label: 'Side-by-side', enabled: true }
] as const

const VERTICAL_LAYOUT_TAB_PRESETS = [
  { id: 'vertical-camera-top', label: 'Camera top', enabled: true },
  { id: 'vertical-camera-bottom', label: 'Camera bottom', enabled: true },
  { id: 'vertical-split', label: 'Split', enabled: true },
  { id: 'vertical-screen-camera', label: 'Screen + camera', enabled: true },
  { id: 'vertical-screen-only', label: 'Screen only', enabled: true }
] as const

export function LayoutTab(): ReactElement {
  const {
    captureConfig,
    patchLayout,
    applyLayoutPatch,
    previewWindow,
    togglePreviewWindow,
    scene,
    sceneEditMode,
    selectedSceneSourceId,
    setSceneEditMode,
    setSelectedSceneSourceId,
    resetSceneSource,
    nudgeSceneSource,
    setSceneSourceTransform,
    applyCameraPreset,
    setSceneSourceVisible,
    isSessionActive,
    layoutSwitchPending
  } = useStudioCore()
  const layout = captureConfig.layout
  const selectedSource = scene?.sources.find((source) => source.id === selectedSceneSourceId)
  // SC2: the inspector follows the stage selection; default to the camera
  // (the thing people usually frame) so the panel is never empty.
  useEffect(() => {
    if (selectedSceneSourceId || !scene?.sources.length) {
      return
    }
    const camera = scene.sources.find((source) => source.kind === 'camera')
    setSelectedSceneSourceId((camera ?? scene.sources[0]).id)
  }, [scene, selectedSceneSourceId, setSelectedSceneSourceId])
  const hasCamera = hasSelectedCameraSource(captureConfig.sources)
  const hasScreen = hasSelectedScreenSource(captureConfig.sources)
  const isCameraOnly = layout.layoutPreset === 'camera-only'
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
  const layoutTabPresets =
    layoutPresetOrientation(layout.layoutPreset) === 'vertical'
      ? VERTICAL_LAYOUT_TAB_PRESETS
      : HORIZONTAL_LAYOUT_TAB_PRESETS

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <PanelSection
            description="Pick how the screen and camera are composed."
            icon={Layout}
            title="Layout preset"
          >
            <div className="flex flex-wrap gap-2">
              {layoutTabPresets.map((preset) => {
                const needsCamera = layoutPresetNeedsCamera(preset.id)
                const needsScreen = layoutPresetNeedsScreen(preset.id)
                const switching = layoutSwitchPending === preset.id
                // Live sessions switch through the backend's latest-intent engine.
                // Keep controls clickable while one warms so a newer choice can supersede it.
                const disabled =
                  !preset.enabled || (needsCamera && !hasCamera) || (needsScreen && !hasScreen)
                return (
                  <button
                    aria-pressed={layout.layoutPreset === preset.id}
                    className="cursor-pointer rounded-row border border-border p-3 text-left text-sm font-medium transition-colors duration-100 hover:bg-accent aria-pressed:border-ring aria-pressed:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disabled}
                    key={preset.id}
                    data-videorc-layout-preset={preset.id}
                    type="button"
                    onClick={() => applyCameraPreset({ layoutPreset: preset.id })}
                  >
                    <div>{switching ? 'Switching…' : preset.label}</div>
                    {!preset.enabled ? (
                      <Badge className="mt-1.5" variant="outline">
                        Soon
                      </Badge>
                    ) : null}
                  </button>
                )
              })}
            </div>
            {isSessionActive ? (
              <p className="text-xs text-muted-foreground">
                Switching applies live — recording and streaming keep running.
              </p>
            ) : !hasScreen ? (
              <p className="text-xs text-muted-foreground">
                Select a screen or window in Studio to enable screen layouts.
              </p>
            ) : !hasCamera ? (
              <p className="text-xs text-muted-foreground">
                {layoutPresetOrientation(layout.layoutPreset) === 'vertical'
                  ? 'Select a camera in Studio to enable the camera scenes.'
                  : 'Select a camera in Studio to enable Camera only and Side-by-side.'}
              </p>
            ) : null}
          </PanelSection>

          {/* SC1: schematic stage — the committed composition rendered from the
              real normalized transforms (pure SVG, zero idle IPC). Live pixels
              stay in the detached preview window. */}
          <SceneStage
            cameraCornerRadiusPct={layout.cameraCornerRadiusPct}
            cameraShape={layout.cameraShape}
            dragEnabled={showOverlayControls && !isSessionActive}
            hasBackground={Boolean(scene?.background)}
            outputAspect={captureConfig.video.width / Math.max(1, captureConfig.video.height)}
            previewOpen={previewWindow.open}
            scene={scene}
            selectedSourceId={selectedSceneSourceId}
            onCommitPosition={(sourceId, position) =>
              void setSceneSourceTransform(sourceId, position)
            }
            onSelectSource={(sourceId) => {
              setSelectedSceneSourceId(sourceId)
              if (!sceneEditMode) {
                setSceneEditMode(true)
              }
            }}
            onSnapCorner={(cameraCorner) => applyCameraPreset({ cameraCorner })}
            onTogglePreview={() => void togglePreviewWindow()}
          />

          {/* The old "Scene sources" panel is gone (post-0.9.4 fix batch F3):
              it duplicated the stage — the stage's rects and legend chips ARE
              the source list, clicking one selects it (and enables editing),
              and visibility now lives in the Inspector. */}
        </div>

        <PanelSection
          className="min-w-0"
          icon={SlidersHorizontal}
          title={selectedSource ? selectedSource.name : 'Inspector'}
        >
          {!selectedSource ? (
            <p className="text-sm text-muted-foreground">Click a source on the stage to edit it.</p>
          ) : selectedSource.kind === 'camera' ? (
            <>
              <span className="text-[12.5px] leading-none font-medium text-subtle">Placement</span>
              {isSideBySide ? (
                <>
                  <Field>
                    <FieldLabel>Split</FieldLabel>
                    <ToggleGroup
                      className="w-full"
                      type="single"
                      value={layout.sideBySideSplit}
                      variant="outline"
                      onValueChange={(value) =>
                        value && applyCameraPreset({ sideBySideSplit: value as SideBySideSplit })
                      }
                    >
                      <ToggleGroupItem value="50-50">50/50</ToggleGroupItem>
                      <ToggleGroupItem value="60-40">60/40</ToggleGroupItem>
                      <ToggleGroupItem value="70-30">70/30</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                  <Field>
                    <FieldLabel>Camera side</FieldLabel>
                    <ToggleGroup
                      className="w-full"
                      type="single"
                      value={layout.sideBySideCameraSide}
                      variant="outline"
                      onValueChange={(value) =>
                        value &&
                        applyCameraPreset({ sideBySideCameraSide: value as SideBySideCameraSide })
                      }
                    >
                      <ToggleGroupItem value="left">Camera left</ToggleGroupItem>
                      <ToggleGroupItem value="right">Camera right</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>
                </>
              ) : null}

              {isCameraOnly ? (
                <p className="text-sm text-muted-foreground">
                  Camera only fills the frame as a rectangle. Corner, size, and shape do not apply —
                  use fit, mirror, zoom, and pan.
                </p>
              ) : null}

              {isVerticalStack ? (
                <p className="text-sm text-muted-foreground">
                  The stacked vertical scenes give the camera and the screen fixed bands of the 9:16
                  canvas. Corner, size, and shape do not apply — use fit, mirror, zoom, and pan.
                </p>
              ) : null}

              {showOverlayControls ? (
                <>
                  <Field>
                    <FieldLabel>Corner</FieldLabel>
                    <ToggleGroup
                      className="w-full"
                      type="single"
                      value={layout.cameraTransformMode === 'custom' ? '' : layout.cameraCorner}
                      variant="outline"
                      onValueChange={(value) =>
                        value && applyCameraPreset({ cameraCorner: value as CameraCorner })
                      }
                    >
                      <ToggleGroupItem value="top-left">Top L</ToggleGroupItem>
                      <ToggleGroupItem value="top-right">Top R</ToggleGroupItem>
                      <ToggleGroupItem value="bottom-left">Bot L</ToggleGroupItem>
                      <ToggleGroupItem value="bottom-right">Bot R</ToggleGroupItem>
                    </ToggleGroup>
                  </Field>

                  <div className="grid min-w-0 grid-cols-2 gap-4">
                    <Field className="min-w-0">
                      <FieldLabel>Size</FieldLabel>
                      <ToggleGroup
                        className="w-full"
                        spacing={0}
                        type="single"
                        value={layout.cameraSize}
                        variant="outline"
                        onValueChange={(value) =>
                          value && applyCameraPreset({ cameraSize: value as CameraSize })
                        }
                      >
                        <ToggleGroupItem className="flex-1" value="small">
                          S
                        </ToggleGroupItem>
                        <ToggleGroupItem className="flex-1" value="medium">
                          M
                        </ToggleGroupItem>
                        <ToggleGroupItem className="flex-1" value="large">
                          L
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field className="min-w-0">
                      <FieldLabel>Shape</FieldLabel>
                      <ToggleGroup
                        className="w-full"
                        spacing={0}
                        type="single"
                        value={layout.cameraShape}
                        variant="outline"
                        onValueChange={(value) =>
                          value &&
                          applyLayoutPatch(
                            // Rounded means a rounded SQUARE by default (owner
                            // decision 2026-07-06) — picking it snaps the aspect
                            // to square in the same gesture; the Aspect toggle
                            // below still allows wide/portrait afterwards.
                            value === 'rounded'
                              ? { cameraShape: 'rounded', cameraAspect: 'square' }
                              : { cameraShape: value as CameraShape }
                          )
                        }
                      >
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-shape="rectangle"
                          value="rectangle"
                        >
                          Rect
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-shape="rounded"
                          value="rounded"
                        >
                          Round
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-shape="circle"
                          value="circle"
                        >
                          Circle
                        </ToggleGroupItem>
                      </ToggleGroup>
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
                      <ToggleGroup
                        className="w-full"
                        spacing={0}
                        type="single"
                        value={layout.cameraAspect}
                        variant="outline"
                        onValueChange={(value) =>
                          value && applyLayoutPatch({ cameraAspect: value as CameraAspect })
                        }
                      >
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-aspect="source"
                          value="source"
                        >
                          Wide
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-aspect="square"
                          value="square"
                        >
                          Square
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          className="min-w-0 flex-1 px-1 text-xs"
                          data-videorc-camera-aspect="portrait"
                          value="portrait"
                        >
                          Portrait
                        </ToggleGroupItem>
                      </ToggleGroup>
                      {layout.cameraAspect !== 'source' ? (
                        <p className="text-xs text-muted-foreground">
                          Crops the sides of the camera — frame yourself centered.
                        </p>
                      ) : null}
                    </Field>
                  ) : null}

                  <PowerSlider
                    label="Margin"
                    max={96}
                    min={8}
                    numericInput
                    suffix="px"
                    value={layout.cameraMargin}
                    onChange={(cameraMargin) => patchLayout({ cameraMargin })}
                    onCommit={(cameraMargin) => applyLayoutPatch({ cameraMargin })}
                  />
                </>
              ) : null}

              <span className="pt-2 text-[12.5px] leading-none font-medium text-subtle">Lens</span>
              {/* Vertical bands ALWAYS fill and crop — a "Fit frame" band would
                  letterbox the short-form frame (2026-07-13 fill-crop plan), so
                  the toggle is hidden and honest copy replaces it. Zoom and pan
                  below still frame the crop. */}
              {isVerticalStack ? (
                <p className="text-sm text-muted-foreground">
                  The camera band always fills and crops. Use zoom and pan to frame yourself.
                </p>
              ) : (
                <Field>
                  <FieldLabel>Fit</FieldLabel>
                  <ToggleGroup
                    type="single"
                    value={layout.cameraFit}
                    variant="outline"
                    onValueChange={(value) =>
                      value && patchLayout({ cameraFit: value as CameraFit })
                    }
                  >
                    <ToggleGroupItem value="fill">Fill crop</ToggleGroupItem>
                    <ToggleGroupItem value="fit">Fit frame</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              )}

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="camera-mirror">Mirror camera</FieldLabel>
                </FieldContent>
                <Switch
                  checked={layout.cameraMirror}
                  id="camera-mirror"
                  onCheckedChange={(checked) => patchLayout({ cameraMirror: checked })}
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
              />
              <SourceVisibilityField
                disabled={isSessionActive}
                source={selectedSource}
                onVisibilityChange={setSceneSourceVisible}
              />
            </>
          ) : sourceIsFullCanvas(selectedSource) ? (
            // Compact inspector for full-canvas sources: no dead controls — a
            // source that fills the frame has no position to nudge and nothing
            // to reset, so the arrow grid never renders (post-0.9.4 fix F3;
            // the disabled-arrow grid read as a broken app).
            <div className="grid gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{selectedSource.name}</div>
                <div className="text-xs text-muted-foreground">
                  Fills the whole canvas — position is fixed for this layout.
                </div>
              </div>
              <SourceVisibilityField
                disabled={isSessionActive}
                source={selectedSource}
                onVisibilityChange={setSceneSourceVisible}
              />
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{selectedSource.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {transformLabel(selectedSource)}
                  </div>
                </div>
                <Button
                  disabled={isSessionActive}
                  size="sm"
                  variant="outline"
                  onClick={() => void resetSceneSource(selectedSource.id)}
                >
                  Reset
                </Button>
              </div>
              {/* w-fit + auto columns keep the arrows a tight d-pad cluster —
                  1fr side columns stretched, stranding ← at the panel edge
                  (external tester report, 2026-07-06). */}
              <div className="grid w-fit grid-cols-[repeat(3,auto)] items-center justify-items-center gap-2 self-start">
                <span />
                <Button
                  aria-label="Nudge source up"
                  disabled={!sceneEditMode || isSessionActive}
                  size="icon"
                  variant="outline"
                  onClick={() => void nudgeSceneSource(selectedSource.id, 0, -1)}
                >
                  <ArrowUp />
                </Button>
                <span />
                <Button
                  aria-label="Nudge source left"
                  disabled={!sceneEditMode || isSessionActive}
                  size="icon"
                  variant="outline"
                  onClick={() => void nudgeSceneSource(selectedSource.id, -1, 0)}
                >
                  <ArrowLeft />
                </Button>
                <Button
                  aria-label="Nudge source down"
                  disabled={!sceneEditMode || isSessionActive}
                  size="icon"
                  variant="outline"
                  onClick={() => void nudgeSceneSource(selectedSource.id, 0, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  aria-label="Nudge source right"
                  disabled={!sceneEditMode || isSessionActive}
                  size="icon"
                  variant="outline"
                  onClick={() => void nudgeSceneSource(selectedSource.id, 1, 0)}
                >
                  <ArrowRight />
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
                  Scene layout is locked while a session is live.
                </p>
              ) : null}
              <SourceVisibilityField
                disabled={isSessionActive}
                source={selectedSource}
                onVisibilityChange={setSceneSourceVisible}
              />
            </div>
          )}
        </PanelSection>
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

function sourceIsFullCanvas(source: SceneSource): boolean {
  return source.transform.width >= 1 && source.transform.height >= 1
}

function transformLabel(source: SceneSource): string {
  const transform = source.transform
  return [
    `x ${Math.round(transform.x * 100)}%`,
    `y ${Math.round(transform.y * 100)}%`,
    `w ${Math.round(transform.width * 100)}%`,
    `h ${Math.round(transform.height * 100)}%`
  ].join(' · ')
}
