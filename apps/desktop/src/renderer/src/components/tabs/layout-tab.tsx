import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  FrameCorners,
  Layout,
  Selection,
  SlidersHorizontal
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { ScreensTab } from '@/components/tabs/screens-tab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudio } from '@/hooks/use-studio'
import type {
  CameraCorner,
  CameraFit,
  CameraShape,
  CameraSize,
  SceneSource,
  SideBySideCameraSide,
  SideBySideSplit
} from '@/lib/backend'
import { cn } from '@/lib/utils'

const LAYOUT_PRESETS = [
  { id: 'screen-camera', label: 'Screen + camera', enabled: true },
  { id: 'screen-only', label: 'Screen only', enabled: true },
  { id: 'camera-only', label: 'Camera only', enabled: true },
  { id: 'side-by-side', label: 'Side-by-side', enabled: true }
] as const

export function LayoutTab(): ReactElement {
  const {
    captureConfig,
    openPreviewPermissions,
    patchLayout,
    previewLiveStatus,
    previewSurfaceStatus,
    nativePreviewSurfaceEnabled,
    refreshPreview,
    scene,
    sceneEditMode,
    selectedSceneSourceId,
    setSceneEditMode,
    setSelectedSceneSourceId,
    resetSceneSource,
    nudgeSceneSource,
    applyCameraPreset,
    setSceneSourceVisible,
    moveSceneSource,
    isSessionActive,
    layoutSwitchPending
  } = useStudio()
  const layout = captureConfig.layout
  const selectedSource = scene?.sources.find((source) => source.id === selectedSceneSourceId)
  const hasCamera = Boolean(captureConfig.sources.cameraId)
  const isScreenOnly = layout.layoutPreset === 'screen-only'
  const isCameraOnly = layout.layoutPreset === 'camera-only'
  const isSideBySide = layout.layoutPreset === 'side-by-side'
  const showOverlayControls = layout.layoutPreset === 'screen-camera'

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <PanelSection
            description="Pick how the screen and camera are composed."
            icon={Layout}
            title="Layout preset"
          >
            <div className="flex flex-wrap gap-2">
              {LAYOUT_PRESETS.map((preset) => {
                const needsCamera = preset.id === 'camera-only' || preset.id === 'side-by-side'
                const switching = layoutSwitchPending === preset.id
                // Live sessions switch presets through the backend swap engine
                // (swap-on-ready); only an in-flight switch or a missing camera blocks.
                const disabled =
                  !preset.enabled || (needsCamera && !hasCamera) || layoutSwitchPending !== null
                return (
                  <button
                    aria-pressed={layout.layoutPreset === preset.id}
                    className="cursor-pointer rounded-lg border border-border p-3 text-left text-sm font-medium transition-colors duration-100 hover:bg-accent aria-pressed:border-ring aria-pressed:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
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
            ) : !hasCamera ? (
              <p className="text-xs text-muted-foreground">
                Select a camera in Studio to enable Camera only and Side-by-side.
              </p>
            ) : null}
          </PanelSection>

          <PanelSection icon={FrameCorners} title="Preview">
            <PreviewStage
              onOpenPermissions={openPreviewPermissions}
              onRetry={refreshPreview}
              previewLiveStatus={previewLiveStatus}
              previewSurfaceStatus={previewSurfaceStatus}
              nativePreviewSurfaceEnabled={nativePreviewSurfaceEnabled}
            />
          </PanelSection>

          <PanelSection icon={Selection} title="Scene sources">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="layout-edit-mode">Edit transforms</FieldLabel>
              </FieldContent>
              <Switch
                checked={sceneEditMode}
                id="layout-edit-mode"
                onCheckedChange={setSceneEditMode}
              />
            </Field>

            {isSessionActive ? (
              <p className="text-xs text-muted-foreground">
                Layout editing is paused while a recording or streaming session is active.
              </p>
            ) : sceneEditMode && showOverlayControls ? (
              <p className="text-xs text-muted-foreground">
                Drag the camera in the preview to reposition it. Arrow keys nudge, R resets.
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              {scene?.sources.length ? (
                scene.sources.map((source, index) => (
                  <SourceRow
                    index={index}
                    key={source.id}
                    selected={source.id === selectedSceneSourceId}
                    source={source}
                    total={scene.sources.length}
                    onMove={moveSceneSource}
                    onSelect={setSelectedSceneSourceId}
                    onVisibilityChange={setSceneSourceVisible}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  Scene sources will appear after capture sources are selected.
                </p>
              )}
            </div>

            <Separator />

            {selectedSource ? (
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
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 self-start">
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
              </div>
            ) : null}
          </PanelSection>
        </div>

        <PanelSection icon={SlidersHorizontal} title="Camera framing">
          {isScreenOnly ? (
            <p className="text-sm text-muted-foreground">
              Screen only records just the screen or window — no camera is captured, so there is
              nothing to frame.
            </p>
          ) : (
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

                  <div className="grid grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel>Size</FieldLabel>
                      <ToggleGroup
                        type="single"
                        value={layout.cameraSize}
                        variant="outline"
                        onValueChange={(value) =>
                          value && applyCameraPreset({ cameraSize: value as CameraSize })
                        }
                      >
                        <ToggleGroupItem value="small">S</ToggleGroupItem>
                        <ToggleGroupItem value="medium">M</ToggleGroupItem>
                        <ToggleGroupItem value="large">L</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field>
                      <FieldLabel>Shape</FieldLabel>
                      <ToggleGroup
                        type="single"
                        value={layout.cameraShape}
                        variant="outline"
                        onValueChange={(value) =>
                          value && patchLayout({ cameraShape: value as CameraShape })
                        }
                      >
                        <ToggleGroupItem value="rectangle">Rect</ToggleGroupItem>
                        <ToggleGroupItem value="circle">Circle</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                  </div>

                  <SliderField
                    label="Margin"
                    max={96}
                    min={8}
                    step={1}
                    suffix="px"
                    value={layout.cameraMargin}
                    onChange={(cameraMargin) => patchLayout({ cameraMargin })}
                  />
                </>
              ) : null}

              <span className="pt-2 text-[12.5px] leading-none font-medium text-subtle">Lens</span>
              <Field>
                <FieldLabel>Fit</FieldLabel>
                <ToggleGroup
                  type="single"
                  value={layout.cameraFit}
                  variant="outline"
                  onValueChange={(value) => value && patchLayout({ cameraFit: value as CameraFit })}
                >
                  <ToggleGroupItem value="fill">Fill crop</ToggleGroupItem>
                  <ToggleGroupItem value="fit">Fit frame</ToggleGroupItem>
                </ToggleGroup>
              </Field>

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

              <SliderField
                label="Zoom"
                max={200}
                min={100}
                step={5}
                suffix="%"
                value={layout.cameraZoom}
                onChange={(cameraZoom) => patchLayout({ cameraZoom })}
              />
              <SliderField
                label="Pan X"
                max={100}
                min={-100}
                step={5}
                value={layout.cameraOffsetX}
                onChange={(cameraOffsetX) => patchLayout({ cameraOffsetX })}
              />
              <SliderField
                label="Pan Y"
                max={100}
                min={-100}
                step={5}
                value={layout.cameraOffsetY}
                onChange={(cameraOffsetY) => patchLayout({ cameraOffsetY })}
              />
            </>
          )}
        </PanelSection>
      </div>

      {/* Takeover images are scene content (they replace the screen source),
          so the Screens grid lives on the Scene page (ux-ia plan slice 4). */}
      <ScreensTab />
    </div>
  )
}

function SourceRow({
  source,
  index,
  total,
  selected,
  onSelect,
  onMove,
  onVisibilityChange
}: {
  source: SceneSource
  index: number
  total: number
  selected: boolean
  onSelect: (sourceId: string) => void
  onMove: (sourceId: string, direction: -1 | 1) => Promise<void>
  onVisibilityChange: (sourceId: string, visible: boolean) => Promise<void>
}): ReactElement {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2',
        selected && 'border-primary bg-primary/10'
      )}
    >
      <button
        className="min-w-0 flex-1 text-left"
        type="button"
        onClick={() => onSelect(source.id)}
      >
        <div className="truncate text-sm font-medium">{source.name}</div>
        <div className="text-xs text-muted-foreground capitalize">
          {source.kind}
          {source.deviceId ? ` · ${source.deviceId}` : ''}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label={source.visible ? `Hide ${source.name}` : `Show ${source.name}`}
          size="sm"
          variant={source.visible ? 'secondary' : 'outline'}
          onClick={() => void onVisibilityChange(source.id, !source.visible)}
        >
          {source.visible ? 'Visible' : 'Hidden'}
        </Button>
        <Button
          aria-label="Move source up"
          disabled={index === 0}
          size="icon"
          variant="ghost"
          onClick={() => void onMove(source.id, -1)}
        >
          <ArrowUp />
        </Button>
        <Button
          aria-label="Move source down"
          disabled={index === total - 1}
          size="icon"
          variant="ghost"
          onClick={() => void onMove(source.id, 1)}
        >
          <ArrowDown />
        </Button>
      </div>
    </div>
  )
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

function SliderField({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <Field>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-sm font-medium tabular-nums text-muted-foreground">
          {value}
          {suffix}
        </span>
      </div>
      <Slider
        max={max}
        min={min}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
      />
    </Field>
  )
}
