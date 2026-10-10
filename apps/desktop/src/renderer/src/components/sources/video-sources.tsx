import { CameraIcon, DisplayIcon, UploadIcon, WarningIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { SourceFacts, SourceItem } from '@/components/sources/source-item'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useStudioCore, useStudioDiagnostics, useStudioPreview } from '@/hooks/use-studio'
import type { Device, SourceSelection } from '@/lib/backend'
import { cameraFormatShortfall, cameraFormatShortfallMessage } from '@/lib/camera-format-shortfall'
import { buildCameraSources, buildCaptureSources, capturePickerDevices } from '@/lib/capture'
import { cameraFacts, screenFacts } from '@/lib/source-facts'
import { selectedDeviceStatus, videoSourceStatus, type SourceStatus } from '@/lib/source-status'
import { systemAccessAction, systemAccessRows } from '@/lib/system-access'

// Plan 173: the Sources page's Video column, Screen and Camera, each one
// SourceItem in one grouped list. What the column says about a source comes
// from the preview pipeline right now (status chip, facts line); a missing
// permission leads the column with its one fix and disables what it locks.

export interface VideoSourcesViewProps {
  sessionActive: boolean
  discoveryPending: boolean
  screen: {
    devices: Device[]
    value?: string
    selectedName?: string
    allowNone: boolean
    disabled: boolean
    status: SourceStatus | null
    facts: string | null
    switchStatus?: ReactNode
    onChange: (captureId: string | undefined) => void
  }
  camera: {
    devices: Device[]
    value?: string
    selectedName?: string
    disabled: boolean
    status: SourceStatus | null
    facts: string | null
    /** The format shortfall message (plan 024 S5); replaces the facts line. */
    shortfall: string | null
    switchStatus?: ReactNode
    onChange: (cameraId: string | undefined) => void
  }
  /** Screen Recording is missing: the column's first alert, with its fixes. */
  screenPermission: { targetName: string; onOpen: () => void; onReveal: () => void } | null
  /** Camera access is missing: the alert names the platform's own action. */
  cameraPermission: {
    targetName: string
    actionLabel: string | null
    onOpen: () => void
    onReveal: () => void
  } | null
  /** Development builds only: the deterministic synthetic screen. */
  synthetic: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void } | null
}

/** The Video column from props, so the tests render it without the studio. */
export function VideoSourcesView({
  sessionActive,
  discoveryPending,
  screen,
  camera,
  screenPermission,
  cameraPermission,
  synthetic
}: VideoSourcesViewProps): ReactElement {
  return (
    <PanelSection
      description={
        sessionActive
          ? 'What people see. A new source takes over once it sends fresh frames.'
          : 'What people see.'
      }
      title="Video"
    >
      {screenPermission ? (
        <Alert variant="warning">
          <WarningIcon weight="fill" />
          <AlertTitle>
            Screen Recording permission is required for {screenPermission.targetName}.
          </AlertTitle>
          <AlertDescription className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={screenPermission.onOpen}>
              <DisplayIcon data-icon="inline-start" />
              Open Screen Recording
            </Button>
            <Button size="sm" variant="ghost" onClick={screenPermission.onReveal}>
              <UploadIcon data-icon="inline-start" />
              Show Capture Helper
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {cameraPermission ? (
        <Alert variant="warning">
          <WarningIcon weight="fill" />
          <AlertTitle>Camera permission is required for {cameraPermission.targetName}.</AlertTitle>
          <AlertDescription className="flex flex-wrap gap-2 pt-2">
            {cameraPermission.actionLabel ? (
              <Button size="sm" variant="outline" onClick={cameraPermission.onOpen}>
                <CameraIcon data-icon="inline-start" />
                {cameraPermission.actionLabel}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={cameraPermission.onReveal}>
              <UploadIcon data-icon="inline-start" />
              Show Capture Helper
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <GroupedList>
        <SourceItem
          disabled={screen.disabled}
          icon={DisplayIcon}
          id="screen"
          status={screen.status}
          title="Screen"
        >
          <SourceSelect
            allowNone={screen.allowNone}
            description={screen.switchStatus}
            devices={screen.devices}
            disabled={screen.disabled}
            discoveryPending={discoveryPending}
            label="Screen / window"
            labelHidden
            searchable
            selectedName={screen.selectedName}
            value={screen.value}
            onChange={screen.onChange}
          />
          {screen.facts ? <SourceFacts>{screen.facts}</SourceFacts> : null}
          {synthetic ? (
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-foreground">
                  Synthetic diagnostic source
                </span>
                <span className="text-xs text-muted-foreground">
                  Development only. A frame-number and timecode screen for regression tests.
                </span>
              </span>
              <Switch
                aria-label="Synthetic diagnostic source"
                checked={synthetic.checked}
                data-videorc-synthetic-source-toggle
                disabled={synthetic.disabled}
                size="sm"
                onCheckedChange={synthetic.onChange}
              />
            </div>
          ) : null}
        </SourceItem>
        <SourceItem
          disabled={camera.disabled}
          icon={CameraIcon}
          id="camera"
          status={camera.status}
          title="Camera"
        >
          <SourceSelect
            allowNone
            description={camera.switchStatus}
            devices={camera.devices}
            disabled={camera.disabled}
            discoveryPending={discoveryPending}
            label="Camera"
            labelHidden
            noneLabel="Off"
            selectedName={camera.selectedName}
            value={camera.value}
            onChange={camera.onChange}
          />
          {/* Q024 S5: a capture camera (a Cam Link mirroring 4K@25 PAL) whose
              only format can't meet the requested rate used to fall back
              silently; the mismatch replaces the facts line. */}
          {camera.shortfall ? (
            <SourceFacts tone="warning">{camera.shortfall}</SourceFacts>
          ) : camera.facts ? (
            <SourceFacts>{camera.facts}</SourceFacts>
          ) : null}
        </SourceItem>
      </GroupedList>
    </PanelSection>
  )
}

/** The Video column, wired to the studio. */
export function VideoSources(): ReactElement {
  const {
    deviceList,
    captureConfig,
    setCaptureConfig,
    isSessionActive,
    layoutSwitchPending,
    sourceDeviceSwitchPending,
    switchSourceDeviceLive,
    sourceSwitchReason,
    allowCaptureNone,
    handleSystemPermission,
    revealPermissionTarget,
    runtimeInfo,
    mediaAccess,
    wsStatus
  } = useStudioCore()
  const { previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats } = useStudioDiagnostics()
  const sources = captureConfig.sources
  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const selectedCaptureId = sources.screenId ?? sources.windowId
  const targetName =
    runtimeInfo?.capturePermissionTargetName ?? runtimeInfo?.permissionTargetName ?? 'Videorc'

  // Screen Recording: any capture device waiting on it raises the alert (as
  // before); the picker locks only when nothing can be captured at all.
  const screenPermissionRequired = captureDevices.some(
    (device) => device.status === 'permission-required'
  )
  const screenLocked =
    captureDevices.length > 0 &&
    captureDevices.every((device) => device.status === 'permission-required')

  const cameraAccess = systemAccessRows({
    deviceList,
    audioMeter: null,
    platform: runtimeInfo?.platform,
    mediaAccess
  }).find((row) => row.id === 'camera')
  const cameraPermissionRequired =
    cameraAccess?.state === 'first-use' || cameraAccess?.state === 'not-granted'
  const cameraPermissionAction = systemAccessAction({
    pane: 'camera',
    state: cameraAccess?.state,
    platform: runtimeInfo?.platform,
    mediaAccessStatus: mediaAccess?.camera
  })
  // Denied locks the picker; first use stays open, because picking a camera
  // is one way the system asks.
  const cameraLocked = cameraAccess?.state === 'not-granted'

  const shortfall = sources.cameraId ? cameraFormatShortfall(diagnosticStats) : null

  const switchCapture = (captureId: string | undefined): void => {
    const next: SourceSelection = buildCaptureSources(sources, captureDevices, captureId)
    void switchSourceDeviceLive('capture', next)
  }
  const switchCamera = (cameraId: string | undefined): void => {
    void switchSourceDeviceLive('camera', buildCameraSources(sources, cameras, cameraId))
  }

  return (
    <VideoSourcesView
      camera={{
        devices: cameras,
        value: sources.cameraId,
        selectedName: sources.cameraName,
        disabled: cameraLocked || Boolean(sourceSwitchReason('camera') || layoutSwitchPending),
        status: videoSourceStatus({
          kind: 'camera',
          selected: Boolean(sources.cameraId),
          switching: sourceDeviceSwitchPending === 'camera',
          device: cameraPermissionRequired
            ? 'permission-required'
            : selectedDeviceStatus(deviceList.devices, sources.cameraId),
          preview: previewCameraStatus
        }),
        facts: cameraFacts(previewCameraStatus),
        shortfall: shortfall ? cameraFormatShortfallMessage(shortfall) : null,
        switchStatus: <SourceSwitchStatus kind="camera" />,
        onChange: switchCamera
      }}
      cameraPermission={
        cameraPermissionRequired
          ? {
              targetName,
              actionLabel: cameraPermissionAction
                ? cameraPermissionAction === 'request-media-access'
                  ? 'Enable Camera'
                  : 'Open Camera Settings'
                : null,
              onOpen: () => void handleSystemPermission('camera'),
              onReveal: () => void revealPermissionTarget()
            }
          : null
      }
      discoveryPending={wsStatus !== 'connected'}
      screen={{
        devices: captureDevices,
        value: selectedCaptureId,
        selectedName: sources.screenName ?? sources.windowName,
        allowNone: allowCaptureNone,
        disabled: screenLocked || Boolean(sourceSwitchReason('capture') || layoutSwitchPending),
        status: videoSourceStatus({
          kind: 'screen',
          selected: Boolean(selectedCaptureId),
          switching: sourceDeviceSwitchPending === 'capture',
          // The whole list, not the picker's: a selected legacy capture row the
          // picker hides is still connected.
          device: selectedDeviceStatus(deviceList.devices, selectedCaptureId),
          preview: previewScreenStatus
        }),
        facts: screenFacts(previewScreenStatus),
        switchStatus: <SourceSwitchStatus kind="capture" />,
        onChange: switchCapture
      }}
      screenPermission={
        screenPermissionRequired
          ? {
              targetName,
              onOpen: () => void handleSystemPermission('screen-recording'),
              onReveal: () => void revealPermissionTarget()
            }
          : null
      }
      sessionActive={isSessionActive}
      synthetic={
        import.meta.env.DEV
          ? {
              checked: sources.testPattern === true,
              disabled: isSessionActive,
              onChange: (testPattern) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: testPattern
                    ? {
                        ...current.sources,
                        screenId: undefined,
                        screenName: undefined,
                        windowId: undefined,
                        windowName: undefined,
                        testPattern
                      }
                    : { ...current.sources, testPattern }
                }))
            }
          : null
      }
    />
  )
}
