import { CameraIcon, DisplayIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { DevicePicker } from '@/components/device-picker'
import { PanelSection } from '@/components/panel-section'
import { SourceFacts, SourceItem } from '@/components/sources/source-item'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Switch } from '@/components/ui/switch'
import { useStudioCore, useStudioDiagnostics, useStudioPreview } from '@/hooks/use-studio'
import type { Device, DeviceList, SourceSelection } from '@/lib/backend'
import { cameraFormatShortfall, cameraFormatShortfallMessage } from '@/lib/camera-format-shortfall'
import { buildCameraSources, buildCaptureSources, capturePickerDevices } from '@/lib/capture'
import { cameraFacts, screenFacts } from '@/lib/source-facts'
import { screenShareLostStatus } from '@/lib/screen-share-recovery'
import { selectedDeviceStatus, videoSourceStatus, type SourceStatus } from '@/lib/source-status'
import { systemAccessRows } from '@/lib/system-access'

// Plan 173: the Sources page's Video column, Screen and Camera, each one
// SourceItem in one grouped list. What the column says about a source comes
// from the preview pipeline right now (status chip, facts line). A missing
// permission is the page's alert with its fix (plan 174 S3.8,
// `source-permission-alerts.tsx`); the screen picker stays locked while
// nothing can be captured at all.

export interface VideoSourcesViewProps {
  sessionActive: boolean
  discoveryPending: boolean
  screen: {
    devices: Device[]
    value?: string
    selectedName?: string
    /** The selected capture device from the whole list (the picker hides some). */
    selectedDevice?: Device
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
    /** The format shortfall message (plan 024 S5): an Alert in place of the facts line. */
    shortfall: string | null
    switchStatus?: ReactNode
    onChange: (cameraId: string | undefined) => void
  }
  /** Development builds only: the deterministic synthetic screen. */
  synthetic: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void } | null
}

/** The Video column from props, so the tests render it without the studio. */
export function VideoSourcesView({
  sessionActive,
  discoveryPending,
  screen,
  camera,
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
      <GroupedList>
        <SourceItem
          disabled={screen.disabled}
          icon={DisplayIcon}
          id="screen"
          status={screen.status}
          title="Screen"
        >
          <DevicePicker
            description={screen.switchStatus}
            devices={screen.devices}
            disabled={screen.disabled}
            discoveryPending={discoveryPending}
            groupByKind
            kind="capture"
            label="Screen / window"
            labelHidden
            noneLabel={screen.allowNone ? 'None' : undefined}
            searchable
            selectedDevice={screen.selectedDevice}
            selectedName={screen.selectedName}
            statusInTrigger={false}
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
          <DevicePicker
            description={camera.switchStatus}
            devices={camera.devices}
            disabled={camera.disabled}
            discoveryPending={discoveryPending}
            kind="camera"
            label="Camera"
            labelHidden
            noneLabel="Off"
            selectedName={camera.selectedName}
            statusInTrigger={false}
            value={camera.value}
            onChange={camera.onChange}
          />
          {/* Q024 S5: a capture camera (a Cam Link mirroring 4K@25 PAL) whose
              only format can't meet the requested rate used to fall back
              silently; the mismatch replaces the facts line. */}
          {camera.shortfall ? (
            <Alert data-videorc-camera-shortfall="" variant="warning">
              <AlertTitle>{camera.shortfall}</AlertTitle>
            </Alert>
          ) : camera.facts ? (
            <SourceFacts>{camera.facts}</SourceFacts>
          ) : null}
        </SourceItem>
      </GroupedList>
    </PanelSection>
  )
}

/**
 * What a missing permission means for the Video column: the screen picker
 * locks while nothing can be captured, and the camera's chip says it needs
 * permission. The page's alerts (`source-permission-alerts.tsx`) read it too.
 */
export function videoPermissionState({
  systemAccessContext,
  deviceList,
  platform,
  mediaAccess
}: {
  systemAccessContext?: import('@/lib/system-access').SystemAccessContext
  deviceList: DeviceList
  platform: Parameters<typeof systemAccessRows>[0]['platform']
  mediaAccess: Parameters<typeof systemAccessRows>[0]['mediaAccess']
}): {
  screenPermissionRequired: boolean
  screenLocked: boolean
  cameraPermissionRequired: boolean
} {
  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameraAccess = systemAccessRows({
    ...systemAccessContext,
    deviceList,
    audioMeter: null,
    platform,
    mediaAccess
  }).find((row) => row.id === 'camera')
  return {
    // Screen Recording: any capture device waiting on it raises the alert (as
    // before); the picker locks only when nothing can be captured at all.
    screenPermissionRequired: captureDevices.some(
      (device) => device.status === 'permission-required'
    ),
    screenLocked:
      captureDevices.length > 0 &&
      captureDevices.every((device) => device.status === 'permission-required'),
    // The camera picker never locks (plan 174 S3.8): choosing a camera is
    // one way the system asks, Off must stay reachable, and the alert for a
    // chosen camera carries the fix.
    cameraPermissionRequired:
      !cameraAccess?.checking &&
      (cameraAccess?.state === 'first-use' ||
        cameraAccess?.state === 'not-granted' ||
        cameraAccess?.state === 'waiting')
  }
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
    runtimeInfo,
    mediaAccess,
    systemAccessContext,
    wsStatus
  } = useStudioCore()
  const { previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats } = useStudioDiagnostics()
  const sources = captureConfig.sources
  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const selectedCaptureId = sources.screenId ?? sources.windowId

  const { screenLocked, cameraPermissionRequired } = videoPermissionState({
    systemAccessContext,
    deviceList,
    platform: runtimeInfo?.platform,
    mediaAccess
  })

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
        disabled: Boolean(sourceSwitchReason('camera') || layoutSwitchPending),
        status: videoSourceStatus({
          kind: 'camera',
          selected: Boolean(sources.cameraId),
          switching: sourceDeviceSwitchPending === 'camera',
          device: cameraPermissionRequired
            ? 'permission-required'
            : selectedDeviceStatus(deviceList.devices, sources.cameraId),
          preview: previewCameraStatus
        }),
        // Facts describe the selected source only (the synthetic screen and a
        // camera turned Off leave the picker saying None or Off).
        facts: sources.cameraId ? cameraFacts(previewCameraStatus) : null,
        shortfall: shortfall ? cameraFormatShortfallMessage(shortfall) : null,
        switchStatus: <SourceSwitchStatus kind="camera" />,
        onChange: switchCamera
      }}
      discoveryPending={wsStatus !== 'connected'}
      screen={{
        devices: captureDevices,
        value: selectedCaptureId,
        selectedName: sources.screenName ?? sources.windowName,
        selectedDevice: deviceList.devices.find((device) => device.id === selectedCaptureId),
        allowNone: allowCaptureNone,
        disabled: screenLocked || Boolean(sourceSwitchReason('capture') || layoutSwitchPending),
        status:
          screenShareLostStatus({
            selected: Boolean(selectedCaptureId),
            switching: sourceDeviceSwitchPending === 'capture',
            preview: previewScreenStatus
          }) ??
          videoSourceStatus({
            kind: 'screen',
            selected: Boolean(selectedCaptureId),
            switching: sourceDeviceSwitchPending === 'capture',
            // The whole list, not the picker's: a selected legacy capture row the
            // picker hides is still connected.
            device: selectedDeviceStatus(deviceList.devices, selectedCaptureId),
            preview: previewScreenStatus
          }),
        facts: selectedCaptureId ? screenFacts(previewScreenStatus) : null,
        switchStatus: <SourceSwitchStatus kind="capture" />,
        onChange: switchCapture
      }}
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
