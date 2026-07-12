import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Device, SourceSelection } from '../../../shared/backend'
import type { CaptureConfig } from './capture'
import {
  applyAudioSyncRecommendation,
  audioSyncCalibrationState,
  applyStoredManualStreamKeyResult,
  auxiliaryStreamOutputVideoSettings,
  buildCameraSources,
  buildCaptureSources,
  buildMicrophoneSources,
  capturePickerDevices,
  defaultCaptureConfig,
  formatMeasuredAudioLag,
  legacyStreamKeyMigrationCandidates,
  hasSelectedCameraSource,
  hasSelectedScreenSource,
  isCapturePickerDevice,
  isNativeCaptureDevice,
  microphonePickerDevices,
  isScreenCaptureKitCaptureDevice,
  isSelectableCaptureDevice,
  HORIZONTAL_LAYOUT_PRESETS,
  VERTICAL_LAYOUT_PRESETS,
  layoutPresetMemoryPatch,
  layoutPresetNeedsCamera,
  layoutPresetOrientation,
  studioModeTogglePreset,
  verticalOrientationVideoPatch,
  layoutPresetNeedsScreen,
  loadCaptureConfig,
  normalizeLayoutSettings,
  normalizeAudioSettings,
  normalizeMicrophoneSyncOffsetMs,
  normalizeVideoSettings,
  parseAudioSyncRecommendationJson,
  parseMicrophoneSyncOffsetInput,
  previewDeviceRefreshSignature,
  persistableCaptureConfig,
  reconcileSourceSelection,
  reconcileSourceSelectionForLayoutTransaction,
  resetAudioSyncCalibration,
  smokePreviewCompositorCaptureConfig,
  streamOutputVideoForTarget,
  sourceSelectionChangeEvents,
  streamOutputVideoSettings,
  streamOutputVideosForTargets,
  videoProfileCompatibility,
  videoPresets
} from './capture'

afterEach(() => {
  vi.unstubAllGlobals()
})

function captureConfigFixture(): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    streaming: {
      ...defaultCaptureConfig.streaming,
      targets: defaultCaptureConfig.streaming.targets.map((target) => ({ ...target }))
    }
  }
}

describe('reconcileSourceSelection', () => {
  it('keeps the dev synthetic source authoritative across later device refreshes', () => {
    const next = reconcileSourceSelection(
      {
        testPattern: true,
        cameraId: 'camera:1',
        cameraName: 'FaceTime HD Camera'
      },
      [
        {
          id: 'screen:screencapturekit:1',
          name: 'Display 1',
          kind: 'screen',
          status: 'available'
        },
        {
          id: 'camera:1',
          name: 'FaceTime HD Camera',
          kind: 'camera',
          status: 'available'
        }
      ]
    )

    expect(next).toMatchObject({
      testPattern: true,
      cameraId: 'camera:1',
      cameraName: 'FaceTime HD Camera'
    })
    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })

  // The renderer mounts with an empty deviceList placeholder and the
  // reconcile effect fires before the backend's first devices.list answer.
  // Remembered selections must survive that pre-snapshot tick: clearing them
  // used to announce a missing source for devices that were actually present
  // one snapshot later (startup-toast bug, 2026-06-13).
  it('leaves remembered selections untouched before the first device snapshot', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:1',
      screenName: 'Display 1',
      cameraId: 'camera:1',
      cameraName: 'FaceTime HD Camera',
      microphoneId: 'microphone:1',
      microphoneName: 'MacBook Pro Microphone'
    }

    const next = reconcileSourceSelection(remembered, [])

    expect(next).toEqual(remembered)
    expect(sourceSelectionChangeEvents(remembered, next)).toEqual([])
  })

  // F-013: with Screen Recording denied the only enumerable capture device is
  // the macOS login window; auto-selecting it made the backend abort inside
  // SCContentFilter (SkyLight assert) one second after a fresh launch.
  it('never auto-selects a window — a fresh profile with only windows stays unselected', () => {
    const devices: Device[] = [
      {
        id: 'window:screencapturekit:55',
        name: 'loginwindow',
        kind: 'window',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection({}, devices)

    expect(next.screenId).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })

  // FX9 (0.9.8 sweep): a selected window vanishing from the next device
  // snapshot must still fall back to the default display. Plan 027 keeps the
  // explanation as diagnostics evidence instead of a startup warning.
  it('window vanishes → falls back to the default display and records diagnostics evidence', () => {
    const remembered: SourceSelection = {
      windowId: 'window:screencapturekit:42',
      windowName: 'cmux - ~/projects/videorc'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit:1',
        name: 'Display 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBe('screen:screencapturekit:1')
    expect(next.windowId).toBeUndefined()
    expect(sourceSelectionChangeEvents(remembered, next)).toEqual([
      {
        kind: 'automatic-source-fallback',
        sourceKind: 'capture',
        reason: 'unavailable-selected',
        previousId: 'window:screencapturekit:42',
        previousName: 'cmux - ~/projects/videorc',
        nextId: 'screen:screencapturekit:1',
        nextName: 'Display 1'
      }
    ])
  })

  it('drops even a REMEMBERED loginwindow selection (persisted by older builds)', () => {
    const remembered: SourceSelection = {
      windowId: 'window:screencapturekit:95728',
      windowName: 'loginwindow'
    }
    const devices: Device[] = [
      {
        id: 'window:screencapturekit:95728',
        name: 'loginwindow',
        kind: 'window',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
    expect(next.screenId).toBeUndefined()
  })

  it('still honors an explicitly remembered window selection', () => {
    const remembered: SourceSelection = {
      windowId: 'window:screencapturekit:77',
      windowName: 'Keynote'
    }
    const devices: Device[] = [
      {
        id: 'window:screencapturekit:77',
        name: 'Keynote',
        kind: 'window',
        status: 'available'
      },
      {
        id: 'screen:screencapturekit:1',
        name: 'Display 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.windowId).toBe('window:screencapturekit:77')
    expect(next.windowName).toBe('Keynote')
    expect(next.screenId).toBeUndefined()
  })

  it('migrates remembered avfoundation screen sources to native screen sources', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit:222',
        name: 'Display 2',
        kind: 'screen',
        status: 'available'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBe('screen:screencapturekit:222')
    expect(next.screenName).toBe('Display 2')
    expect(next.windowId).toBeUndefined()
  })

  it('revalidates a stale persisted Windows source immediately before a layout transaction', () => {
    const stale: SourceSelection = {
      screenId: 'screen:legacy-desktop:0',
      screenName: 'Old display'
    }
    const devices: Device[] = [
      {
        id: 'screen:dxgi:00000000000003f1:2',
        name: 'Display 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    expect(reconcileSourceSelectionForLayoutTransaction(stale, devices)).toMatchObject({
      screenId: 'screen:dxgi:00000000000003f1:2',
      screenName: 'Display 1',
      windowId: undefined,
      windowName: undefined
    })
  })

  it('keeps a legacy avfoundation screen source as a recording fallback when no native capture source is available', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBe('screen:avfoundation:7')
    expect(next.screenName).toBe('Capture screen 1')
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
    expect(sourceSelectionChangeEvents(remembered, next)).toEqual([])
  })

  it('selects the avfoundation screen fallback when ScreenCaptureKit only reports status rows', () => {
    const next = reconcileSourceSelection({}, [
      {
        id: 'screen:screencapturekit-timeout',
        name: 'Primary Display',
        kind: 'screen',
        status: 'unavailable'
      },
      {
        id: 'window:screencapturekit-missing',
        name: 'Window Capture',
        kind: 'window',
        status: 'unavailable'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'available'
      }
    ])

    expect(next.screenId).toBe('screen:avfoundation:7')
    expect(next.screenName).toBe('Capture screen 1')
  })

  it('does not select permission placeholders as renderable capture sources', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit-permission',
        name: 'Primary Display',
        kind: 'screen',
        status: 'permission-required'
      },
      {
        id: 'window:screencapturekit-permission',
        name: 'Window Capture',
        kind: 'window',
        status: 'permission-required'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })

  it('does not select avfoundation screen fallback while screen capture permission is blocked', () => {
    const remembered: SourceSelection = {
      screenId: 'screen:avfoundation:7',
      screenName: 'Capture screen 1'
    }
    const devices: Device[] = [
      {
        id: 'screen:screencapturekit-permission',
        name: 'Primary Display',
        kind: 'screen',
        status: 'permission-required'
      },
      {
        id: 'window:screencapturekit-permission',
        name: 'Window Capture',
        kind: 'window',
        status: 'permission-required'
      },
      {
        id: 'screen:avfoundation:7',
        name: 'Capture screen 1',
        kind: 'screen',
        status: 'permission-required'
      }
    ]

    const next = reconcileSourceSelection(remembered, devices)

    expect(next.screenId).toBeUndefined()
    expect(next.screenName).toBeUndefined()
    expect(next.windowId).toBeUndefined()
    expect(next.windowName).toBeUndefined()
  })
})

describe('microphone picker and fallback migration', () => {
  const nativeMicrophone: Device = {
    id: 'microphone:coreaudio:42',
    name: 'Shure MV7+',
    kind: 'microphone',
    status: 'available'
  }
  const avfoundationMicrophone: Device = {
    id: 'microphone:avfoundation:2',
    name: 'Shure MV7+',
    kind: 'microphone',
    status: 'available'
  }

  it('hides avfoundation microphone rows whenever a native row exists', () => {
    expect(microphonePickerDevices([avfoundationMicrophone, nativeMicrophone])).toEqual([
      nativeMicrophone
    ])
  })

  it('keeps avfoundation microphones only when they are the sole rows', () => {
    expect(microphonePickerDevices([avfoundationMicrophone])).toEqual([avfoundationMicrophone])
  })

  it('never defaults a fresh profile to an avfoundation fallback microphone', () => {
    // Older backends listed the avfoundation duplicate FIRST, which made
    // microphones[0] a broken "Fallback - X" default on fresh profiles.
    const next = reconcileSourceSelection({}, [avfoundationMicrophone, nativeMicrophone])

    expect(next.microphoneId).toBe('microphone:coreaudio:42')
    expect(next.microphoneName).toBe('Shure MV7+')
  })

  it('migrates a persisted fallback microphone selection to its native device', () => {
    const next = reconcileSourceSelection(
      {
        microphoneId: 'microphone:avfoundation:2',
        microphoneName: 'Fallback - Shure MV7+'
      },
      [nativeMicrophone]
    )

    expect(next.microphoneId).toBe('microphone:coreaudio:42')
    expect(next.microphoneName).toBe('Shure MV7+')
  })

  it('keeps a persisted avfoundation selection when no native input exists', () => {
    const next = reconcileSourceSelection(
      {
        microphoneId: 'microphone:avfoundation:2',
        microphoneName: 'Shure MV7+'
      },
      [avfoundationMicrophone]
    )

    expect(next.microphoneId).toBe('microphone:avfoundation:2')
    expect(next.microphoneName).toBe('Shure MV7+')
  })
})

describe('ScreenCaptureKit capture device filtering', () => {
  it('shows native status rows in the source picker but does not treat them as selectable native sources', () => {
    const permissionDisplay: Device = {
      id: 'screen:screencapturekit-permission',
      name: 'Primary Display',
      kind: 'screen',
      status: 'permission-required'
    }
    const permissionWindow: Device = {
      id: 'window:screencapturekit-permission',
      name: 'Window Capture',
      kind: 'window',
      status: 'permission-required'
    }
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }
    const blockedLegacyDisplay: Device = {
      id: 'screen:avfoundation:8',
      name: 'Capture screen 2',
      kind: 'screen',
      status: 'permission-required'
    }
    const nativeDisplay: Device = {
      id: 'screen:screencapturekit:222',
      name: 'Display 2',
      kind: 'screen',
      status: 'available'
    }
    const windowsDxgiDisplay: Device = {
      id: 'screen:dxgi:0000000000000001:0',
      name: 'Display 1',
      kind: 'screen',
      status: 'available'
    }
    const windowsGdigrabDisplay: Device = {
      id: 'screen:gdigrab:desktop',
      name: 'Desktop',
      kind: 'screen',
      status: 'available'
    }

    expect(isScreenCaptureKitCaptureDevice(permissionDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(permissionWindow)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(nativeDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(windowsDxgiDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(windowsGdigrabDisplay)).toBe(true)
    expect(isScreenCaptureKitCaptureDevice(legacyDisplay)).toBe(false)

    expect(isCapturePickerDevice(permissionDisplay)).toBe(true)
    expect(isCapturePickerDevice(permissionWindow)).toBe(true)
    expect(isCapturePickerDevice(nativeDisplay)).toBe(true)
    expect(isCapturePickerDevice(windowsDxgiDisplay)).toBe(true)
    expect(isCapturePickerDevice(windowsGdigrabDisplay)).toBe(true)
    expect(isCapturePickerDevice(legacyDisplay)).toBe(true)

    expect(isNativeCaptureDevice(permissionDisplay)).toBe(false)
    expect(isNativeCaptureDevice(permissionWindow)).toBe(false)
    expect(isNativeCaptureDevice(nativeDisplay)).toBe(true)
    expect(isNativeCaptureDevice(windowsDxgiDisplay)).toBe(true)
    expect(isNativeCaptureDevice(windowsGdigrabDisplay)).toBe(true)
    expect(isNativeCaptureDevice(legacyDisplay)).toBe(false)

    expect(isSelectableCaptureDevice(permissionDisplay)).toBe(false)
    expect(isSelectableCaptureDevice(permissionWindow)).toBe(false)
    expect(isSelectableCaptureDevice(nativeDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(windowsDxgiDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(windowsGdigrabDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(legacyDisplay)).toBe(true)
    expect(isSelectableCaptureDevice(blockedLegacyDisplay)).toBe(false)
  })

  it('keeps legacy avfoundation rows visible when ScreenCaptureKit only reports status rows', () => {
    const permissionDisplay: Device = {
      id: 'screen:screencapturekit-permission',
      name: 'Primary Display',
      kind: 'screen',
      status: 'permission-required'
    }
    const permissionWindow: Device = {
      id: 'window:screencapturekit-permission',
      name: 'Window Capture',
      kind: 'window',
      status: 'permission-required'
    }
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }

    expect(capturePickerDevices([permissionDisplay, permissionWindow, legacyDisplay])).toEqual([
      permissionDisplay,
      permissionWindow,
      legacyDisplay
    ])
  })

  it('hides legacy avfoundation screen rows when native ScreenCaptureKit rows are available', () => {
    const nativeDisplay: Device = {
      id: 'screen:screencapturekit:222',
      name: 'Display 2',
      kind: 'screen',
      status: 'available'
    }
    const nativeWindow: Device = {
      id: 'window:screencapturekit:111',
      name: 'Editor',
      kind: 'window',
      status: 'available'
    }
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }

    expect(capturePickerDevices([nativeDisplay, nativeWindow, legacyDisplay])).toEqual([
      nativeDisplay,
      nativeWindow
    ])
  })

  it('uses avfoundation screen rows only when ScreenCaptureKit does not report any capture rows', () => {
    const legacyDisplay: Device = {
      id: 'screen:avfoundation:7',
      name: 'Capture screen 1',
      kind: 'screen',
      status: 'available'
    }
    const camera: Device = {
      id: 'camera:avfoundation-native:abc',
      name: 'FaceTime HD Camera',
      kind: 'camera',
      status: 'available'
    }

    expect(capturePickerDevices([camera, legacyDisplay])).toEqual([legacyDisplay])
  })
})

describe('smokePreviewCompositorCaptureConfig', () => {
  const config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'> = {
    sources: {
      screenId: 'screen:1',
      screenName: 'Display',
      windowId: 'window:1',
      windowName: 'App',
      cameraId: 'camera:1',
      cameraName: 'Camera',
      microphoneId: 'microphone:1',
      microphoneName: 'Microphone'
    },
    layout: {
      layoutPreset: 'screen-camera',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraCornerRadiusPct: 12,
      cameraAspect: 'source',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    video: {
      preset: 'tutorial-1440p30',
      width: 2560,
      height: 1440,
      fps: 30,
      bitrateKbps: 8000
    }
  }

  it('uses renderable synthetic sources instead of stopped real preview sources', () => {
    expect(smokePreviewCompositorCaptureConfig(config)).toEqual({
      ...config,
      sources: {
        cameraId: 'camera:synthetic-preview-smoke',
        cameraName: 'Synthetic preview camera',
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone',
        testPattern: true
      }
    })
  })

  it('does not add a synthetic camera to screen-only smoke layouts', () => {
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'screen-only' }
      }).sources
    ).toEqual({
      cameraId: undefined,
      cameraName: undefined,
      microphoneId: 'microphone:1',
      microphoneName: 'Microphone',
      testPattern: true
    })
  })

  it('adds a synthetic camera to camera-required smoke layouts', () => {
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'camera-only' }
      }).sources.cameraId
    ).toBe('camera:synthetic-preview-smoke')
    expect(
      smokePreviewCompositorCaptureConfig({
        ...config,
        layout: { ...config.layout, layoutPreset: 'side-by-side' }
      }).sources.cameraId
    ).toBe('camera:synthetic-preview-smoke')
  })

  it('adds a synthetic camera to screen-camera smoke layouts', () => {
    const config: Pick<CaptureConfig, 'sources' | 'layout' | 'video'> = {
      sources: {
        screenId: 'screen:1',
        screenName: 'Display',
        windowId: 'window:1',
        windowName: 'App',
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone'
      },
      layout: {
        layoutPreset: 'screen-camera',
        cameraTransformMode: 'preset',
        cameraTransform: null,
        cameraCorner: 'bottom-right',
        cameraSize: 'medium',
        cameraShape: 'rectangle',
        cameraCornerRadiusPct: 12,
        cameraAspect: 'source',
        cameraMargin: 32,
        cameraFit: 'fill',
        cameraMirror: false,
        cameraZoom: 100,
        cameraOffsetX: 0,
        cameraOffsetY: 0,
        sideBySideSplit: '70-30',
        sideBySideCameraSide: 'right'
      },
      video: {
        preset: 'tutorial-1440p30',
        width: 2560,
        height: 1440,
        fps: 30,
        bitrateKbps: 8000
      }
    }

    expect(smokePreviewCompositorCaptureConfig(config)).toEqual({
      ...config,
      sources: {
        cameraId: 'camera:synthetic-preview-smoke',
        cameraName: 'Synthetic preview camera',
        microphoneId: 'microphone:1',
        microphoneName: 'Microphone',
        testPattern: true
      }
    })
  })
})

describe('layout preset source requirements', () => {
  it('matches the backend blockers for screen-backed presets', () => {
    expect(layoutPresetNeedsScreen('screen-camera')).toBe(true)
    expect(layoutPresetNeedsScreen('screen-only')).toBe(true)
    expect(layoutPresetNeedsScreen('side-by-side')).toBe(true)
    expect(layoutPresetNeedsScreen('vertical-camera-top')).toBe(true)
    expect(layoutPresetNeedsScreen('vertical-camera-bottom')).toBe(true)
    expect(layoutPresetNeedsScreen('vertical-split')).toBe(true)
    expect(layoutPresetNeedsScreen('vertical-screen-camera')).toBe(true)
    expect(layoutPresetNeedsScreen('vertical-screen-only')).toBe(true)
    expect(layoutPresetNeedsScreen('camera-only')).toBe(false)
  })

  it('matches the backend blockers for camera-required presets', () => {
    expect(layoutPresetNeedsCamera('camera-only')).toBe(true)
    expect(layoutPresetNeedsCamera('side-by-side')).toBe(true)
    expect(layoutPresetNeedsCamera('screen-camera')).toBe(true)
    expect(layoutPresetNeedsCamera('vertical-camera-top')).toBe(true)
    expect(layoutPresetNeedsCamera('vertical-camera-bottom')).toBe(true)
    expect(layoutPresetNeedsCamera('vertical-split')).toBe(true)
    expect(layoutPresetNeedsCamera('vertical-screen-camera')).toBe(true)
    expect(layoutPresetNeedsCamera('screen-only')).toBe(false)
    expect(layoutPresetNeedsCamera('vertical-screen-only')).toBe(false)
  })

  it('classifies every preset into exactly one orientation class', () => {
    // The class drives the Studio mode, the canvas coupling, and the live
    // blocker — a misclassified preset breaks all three.
    for (const preset of HORIZONTAL_LAYOUT_PRESETS) {
      expect(layoutPresetOrientation(preset)).toBe('horizontal')
    }
    for (const preset of VERTICAL_LAYOUT_PRESETS) {
      expect(layoutPresetOrientation(preset)).toBe('vertical')
    }
  })

  it('treats native screen/window, avfoundation fallback, and test pattern as screen-capable for layouts', () => {
    expect(hasSelectedScreenSource({ screenId: 'screen:screencapturekit:1' })).toBe(true)
    expect(hasSelectedScreenSource({ screenId: 'screen:dxgi:0000000000000001:0' })).toBe(true)
    expect(hasSelectedScreenSource({ screenId: 'screen:gdigrab:desktop' })).toBe(true)
    expect(hasSelectedScreenSource({ windowId: 'window:screencapturekit:1' })).toBe(true)
    expect(hasSelectedScreenSource({ testPattern: true })).toBe(true)
    expect(hasSelectedScreenSource({ screenId: 'screen:avfoundation:7' })).toBe(true)
    expect(hasSelectedScreenSource({ cameraId: 'camera:1' })).toBe(false)
  })

  it('requires a concrete camera id for camera layouts', () => {
    expect(hasSelectedCameraSource({ cameraId: 'camera:1' })).toBe(true)
    expect(hasSelectedCameraSource({ screenId: 'screen:1' })).toBe(false)
  })
})

describe('previewDeviceRefreshSignature', () => {
  it('changes when a selected device permission state changes without changing list length', () => {
    const camera: Device = {
      id: 'camera:avfoundation-native:abc',
      name: 'MacBook Pro Camera',
      kind: 'camera',
      status: 'permission-required'
    }
    const blocked: Device[] = [camera]
    const available: Device[] = [
      {
        ...camera,
        status: 'available'
      }
    ]

    expect(previewDeviceRefreshSignature(blocked)).not.toBe(
      previewDeviceRefreshSignature(available)
    )
  })
})

describe('normalizeMicrophoneSyncOffsetMs', () => {
  it('preserves exact measured millisecond offsets when the user has set one', () => {
    expect(normalizeMicrophoneSyncOffsetMs(-166)).toBe(-166)
    expect(
      normalizeAudioSettings({ microphoneSyncOffsetMs: -166, microphoneSyncOffsetUserSet: true })
        .microphoneSyncOffsetMs
    ).toBe(-166)
  })

  it('applies the structural default (0) until the user sets an offset', () => {
    // Alignment happens in the backend via the video epoch; this offset is a pure
    // manual trim. Stored non-user-set values (e.g. the old -750 calibration)
    // migrate back to 0 on load.
    expect(normalizeAudioSettings({ microphoneSyncOffsetMs: -750 }).microphoneSyncOffsetMs).toBe(0)
    expect(normalizeAudioSettings({}).microphoneSyncOffsetMs).toBe(0)
  })

  it('clamps to the backend-supported range', () => {
    expect(normalizeMicrophoneSyncOffsetMs(-1200)).toBe(-1000)
    expect(normalizeMicrophoneSyncOffsetMs(1200)).toBe(1000)
  })

  it('uses the provided fallback when the value is not numeric', () => {
    expect(normalizeMicrophoneSyncOffsetMs('nope', -120)).toBe(-120)
  })
})

describe('parseMicrophoneSyncOffsetInput', () => {
  it('keeps transient number-input drafts out of committed state', () => {
    expect(parseMicrophoneSyncOffsetInput('', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('-', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('+', -750)).toBeNull()
    expect(parseMicrophoneSyncOffsetInput('nope', -750)).toBeNull()
  })

  it('parses and clamps valid millisecond drafts', () => {
    expect(parseMicrophoneSyncOffsetInput('-735', -750)).toBe(-735)
    expect(parseMicrophoneSyncOffsetInput('1200', -750)).toBe(1000)
    expect(parseMicrophoneSyncOffsetInput('-1200', -750)).toBe(-1000)
  })
})

describe('audio sync calibration helpers', () => {
  it('parses stable measure-av-sync JSON reports', () => {
    const parsed = parseAudioSyncRecommendationJson(
      JSON.stringify({
        schemaVersion: 1,
        pass: true,
        medianOffsetMs: 46,
        currentMicrophoneSyncOffsetMs: -120,
        recommendedMicrophoneSyncOffsetMs: -166,
        targetMs: 100,
        pairCount: 31,
        failures: [],
        warnings: ['within target']
      })
    )

    expect(parsed).toEqual({
      ok: true,
      recommendation: {
        pass: true,
        medianOffsetMs: 46,
        currentMicrophoneSyncOffsetMs: -120,
        recommendedMicrophoneSyncOffsetMs: -166,
        targetMs: 100,
        pairCount: 31,
        failures: [],
        warnings: ['within target']
      }
    })
  })

  it('rejects unsupported or malformed measurement JSON', () => {
    expect(parseAudioSyncRecommendationJson('nope')).toMatchObject({ ok: false })
    expect(parseAudioSyncRecommendationJson('{}')).toEqual({
      ok: false,
      error: 'Measurement JSON must use schemaVersion 1.'
    })
  })

  it('formats measured lag direction for operators', () => {
    expect(formatMeasuredAudioLag(121.4)).toBe('Audio lags video by 121 ms')
    expect(formatMeasuredAudioLag(-80.2)).toBe('Audio leads video by 80 ms')
    expect(formatMeasuredAudioLag(0)).toBe('Audio is aligned at 0 ms')
    expect(formatMeasuredAudioLag(null)).toBe('No paired flash/click measurement')
  })

  it('explains unavailable recommendations without changing audio settings', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: 3,
      microphoneMuted: true
    }
    const recommendation = {
      medianOffsetMs: null,
      recommendedMicrophoneSyncOffsetMs: null,
      pairCount: 0,
      pass: false
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'unavailable',
      canApply: false,
      recommendedOffsetMs: null
    })
    expect(applyAudioSyncRecommendation(audio, recommendation)).toBe(audio)
  })

  it('applies measured recommendations while preserving other audio controls', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: 4,
      microphoneMuted: true,
      microphoneSyncOffsetMs: -120,
      microphoneSyncOffsetUserSet: true
    }
    const recommendation = {
      medianOffsetMs: 46,
      currentMicrophoneSyncOffsetMs: -120,
      recommendedMicrophoneSyncOffsetMs: -166,
      targetMs: 100,
      pairCount: 31,
      pass: true
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'optional',
      canApply: true,
      recommendedOffsetMs: -166
    })
    expect(applyAudioSyncRecommendation(audio, recommendation)).toEqual({
      ...audio,
      microphoneSyncOffsetMs: -166,
      microphoneSyncOffsetUserSet: true
    })
  })

  it('recommends target misses and clamps imported recommendations', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneSyncOffsetMs: -900,
      microphoneSyncOffsetUserSet: true
    }
    const recommendation = {
      medianOffsetMs: 300,
      currentMicrophoneSyncOffsetMs: -900,
      recommendedMicrophoneSyncOffsetMs: -1200,
      targetMs: 100,
      pairCount: 4,
      pass: false
    }

    expect(audioSyncCalibrationState(recommendation, audio)).toMatchObject({
      status: 'recommended',
      canApply: true,
      recommendedOffsetMs: -1000
    })
  })

  it('resets calibration back to the structural default', () => {
    const audio = {
      ...defaultCaptureConfig.audio,
      microphoneGainDb: -2,
      microphoneSyncOffsetMs: -166,
      microphoneSyncOffsetUserSet: true
    }

    expect(resetAudioSyncCalibration(audio)).toEqual({
      ...audio,
      microphoneSyncOffsetMs: 0,
      microphoneSyncOffsetUserSet: false
    })
  })
})

describe('videoPresets', () => {
  it('includes first-class 4K recording and platform-safe streaming presets', () => {
    expect(videoPresets['record-4k30']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    })
    expect(videoPresets['record-4k60-experimental']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 60,
      bitrateKbps: 50000
    })
    expect(videoPresets['stream-safe-1080p30']).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000
    })
    expect(videoPresets['stream-safe-1080p60']).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 60,
      bitrateKbps: 6000
    })
    expect(videoPresets['stream-youtube-4k30']).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
      bitrateKbps: 30000
    })
  })

  it('normalizes persisted first-class presets through the shared map', () => {
    expect(normalizeVideoSettings({ preset: 'record-4k30' })).toEqual(videoPresets['record-4k30'])
    expect(normalizeVideoSettings({ preset: 'stream-safe-1080p30' })).toEqual(
      videoPresets['stream-safe-1080p30']
    )
    expect(normalizeVideoSettings({ preset: 'stream-youtube-4k30' })).toEqual(
      videoPresets['stream-youtube-4k30']
    )
  })
})

describe('videoProfileCompatibility', () => {
  it('resolves the stream output video from enabled streaming defaults', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: 4500
    }

    expect(streamOutputVideoSettings(config.video, config.streaming)).toEqual({
      ...videoPresets['stream-safe-1080p30'],
      bitrateKbps: 4500
    })
  })

  it('resolves mixed destination outputs from a YouTube 4K default profile', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube' || target.platform === 'twitch'
      }))
    }

    const outputs = streamOutputVideosForTargets(config.video, config.streaming)
    const youtube = outputs.find((output) => output.target?.platform === 'youtube')
    const twitch = outputs.find((output) => output.target?.platform === 'twitch')

    expect(youtube?.video).toEqual(videoPresets['stream-youtube-4k30'])
    expect(twitch?.video).toEqual(videoPresets['stream-safe-1080p30'])
  })

  it('lets an explicit target output override the platform default', () => {
    const config = captureConfigFixture()
    config.streaming = {
      ...config.streaming,
      enabled: true
    }
    const twitch = {
      ...config.streaming.targets.find((target) => target.platform === 'twitch')!,
      enabled: true,
      outputPreset: 'stream-safe-1080p60' as const,
      outputBitrateKbps: 5500
    }

    expect(streamOutputVideoForTarget(config.video, config.streaming, twitch)).toEqual({
      ...videoPresets['stream-safe-1080p60'],
      bitrateKbps: 5500
    })
  })

  it('uses the enabled Twitch 1080p override for a 4K-default auxiliary canvas', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) =>
        target.platform === 'twitch'
          ? {
              ...target,
              enabled: true,
              outputPreset: 'stream-safe-1080p30',
              outputBitrateKbps: 6000
            }
          : { ...target, enabled: target.platform === 'youtube' }
      )
    }

    expect(streamOutputVideoSettings(config.video, config.streaming)).toEqual(
      videoPresets['stream-youtube-4k30']
    )
    expect(auxiliaryStreamOutputVideoSettings(config.video, config.streaming)).toEqual(
      videoPresets['stream-safe-1080p30']
    )
  })

  it('falls back to the recording canvas when enabled targets share its profile', () => {
    const config = captureConfigFixture()
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-youtube-4k30',
      defaultBitrateKbps: 30000,
      targets: config.streaming.targets.map((target) => ({
        ...target,
        enabled: target.platform === 'youtube'
      }))
    }

    expect(auxiliaryStreamOutputVideoSettings(config.video, config.streaming)).toEqual(config.video)
  })

  it('warns (never blocks) on 4K local recording while streaming — the reproduced freeze profile', () => {
    // docs/live-video-freeze-incident-plan.md: split-output 4K record + stream
    // drops recorded video to ~8fps. Warning only, until LVF2–LVF4 land.
    const config = captureConfigFixture()
    config.recordEnabled = true
    config.streamEnabled = true
    config.video = videoPresets['record-4k30']
    config.streaming = {
      ...config.streaming,
      enabled: true,
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: 6000
    }

    const result = videoProfileCompatibility(config)
    expect(result.blockingReason).toBeNull()
    expect(result.warning).toMatch(/4K local recording while livestreaming/)
  })

  it('never blocks, and only the 4K record+stream profile warns', () => {
    // Guardrails stay removed (owner 2026-06-24) except the freeze-incident
    // warning above; everything else passes clean and the backend rejects
    // genuinely-unsupported combinations at runtime.
    const cleanCases: Parameters<typeof videoProfileCompatibility>[0][] = [
      { recordEnabled: false, streamEnabled: true, video: videoPresets['record-4k30'] },
      { recordEnabled: false, streamEnabled: true, video: videoPresets['stream-1080p60'] },
      {
        recordEnabled: true,
        streamEnabled: false,
        video: videoPresets['record-4k60-experimental']
      }
    ]
    for (const config of cleanCases) {
      expect(videoProfileCompatibility(config)).toEqual({ blockingReason: null, warning: null })
    }
    const warned = videoProfileCompatibility({
      recordEnabled: true,
      streamEnabled: true,
      video: videoPresets['record-4k30']
    })
    expect(warned.blockingReason).toBeNull()
    expect(warned.warning).not.toBeNull()
  })
})

describe('persistable capture settings', () => {
  it('keeps live microphone gain and mute as next-session defaults', () => {
    const config = captureConfigFixture()
    config.audio = {
      ...config.audio,
      microphoneGainDb: 6,
      microphoneMuted: true
    }

    expect(persistableCaptureConfig(config).audio).toMatchObject({
      microphoneGainDb: 6,
      microphoneMuted: true
    })
  })
})

describe('legacy stream key migration', () => {
  it('detects legacy top-level stream keys that need backend storage', () => {
    const config = captureConfigFixture()
    config.rtmpPreset = 'twitch'
    config.streamKey = ' fixture-top-level-key '

    expect(legacyStreamKeyMigrationCandidates(config)).toEqual([
      { targetId: 'twitch', streamKey: 'fixture-top-level-key' }
    ])
  })

  it('detects per-target plaintext keys that do not already have secret refs', () => {
    const config = captureConfigFixture()
    config.streaming.targets = config.streaming.targets.map((target) =>
      target.id === 'youtube'
        ? { ...target, streamKey: ' fixture-youtube-key ', streamKeyPresent: true }
        : target
    )

    expect(legacyStreamKeyMigrationCandidates(config)).toEqual([
      { targetId: 'youtube', streamKey: 'fixture-youtube-key' }
    ])
  })

  it('clears plaintext keys from persisted config after backend store succeeds', () => {
    const config = captureConfigFixture()
    config.rtmpPreset = 'youtube'
    config.streamKey = 'fixture-legacy-key'
    config.streaming.enabled = true
    config.streaming.targets = config.streaming.targets.map((target) =>
      target.id === 'youtube'
        ? {
            ...target,
            enabled: true,
            streamKey: 'fixture-legacy-key',
            streamKeyPresent: true
          }
        : target
    )

    const migrated = applyStoredManualStreamKeyResult(config, 'youtube', {
      streamKeySecretRef: 'stream-target:youtube:manual-stream-key',
      streamKeyPresent: true,
      streamKeyHint: '****-key',
      previousStreamKeyPresent: false
    })
    const persisted = persistableCaptureConfig(migrated)
    const youtube = persisted.streaming.targets.find((target) => target.id === 'youtube')

    expect(migrated.streamKey).toBe('')
    expect(youtube?.streamKey).toBe('')
    expect(persisted.streamKey).toBe('')
    expect(JSON.stringify(persisted)).not.toContain('fixture-legacy-key')
  })

  it('does not persist the dev synthetic diagnostic source', () => {
    const config = captureConfigFixture()
    config.sources = {
      ...config.sources,
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1',
      testPattern: true
    }

    expect(persistableCaptureConfig(config).sources).toMatchObject({
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1'
    })
    expect(persistableCaptureConfig(config).sources.testPattern).toBeUndefined()
  })

  it('heals old persisted configs that still contain the synthetic diagnostic source', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          sources: {
            screenId: 'screen:screencapturekit:1',
            screenName: 'Display 1',
            testPattern: true
          }
        }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })

    expect(loadCaptureConfig().sources).toMatchObject({
      screenId: 'screen:screencapturekit:1',
      screenName: 'Display 1',
      testPattern: false
    })
  })

  it('keeps per-mode scene memory across reloads and heals cross-class values', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          lastHorizontalPreset: 'side-by-side',
          lastVerticalPreset: 'vertical-split'
        }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    expect(loadCaptureConfig()).toMatchObject({
      lastHorizontalPreset: 'side-by-side',
      lastVerticalPreset: 'vertical-split'
    })

    // A cross-class or junk memory would strand the mode toggle — reset it.
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          lastHorizontalPreset: 'vertical-split',
          lastVerticalPreset: 'diagonal'
        }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    expect(loadCaptureConfig()).toMatchObject({
      lastHorizontalPreset: 'screen-camera',
      lastVerticalPreset: 'vertical-camera-top'
    })
  })
})

describe('per-mode scene memory and the mode toggle', () => {
  it('remembers a committed preset in its own mode slot only', () => {
    expect(layoutPresetMemoryPatch('side-by-side')).toEqual({
      lastHorizontalPreset: 'side-by-side'
    })
    expect(layoutPresetMemoryPatch('vertical-screen-camera')).toEqual({
      lastVerticalPreset: 'vertical-screen-camera'
    })
  })

  it('the toggle re-enters each mode on its remembered scene', () => {
    const memory = {
      lastHorizontalPreset: 'camera-only' as const,
      lastVerticalPreset: 'vertical-split' as const
    }
    expect(studioModeTogglePreset('horizontal', memory)).toBe('camera-only')
    expect(studioModeTogglePreset('vertical', memory)).toBe('vertical-split')
  })

  it('falls back to the mode default when the memory is cross-class', () => {
    const swapped = {
      lastHorizontalPreset: 'vertical-camera-top' as const,
      lastVerticalPreset: 'screen-camera' as const
    }
    expect(studioModeTogglePreset('horizontal', swapped)).toBe('screen-camera')
    expect(studioModeTogglePreset('vertical', swapped)).toBe('vertical-camera-top')
  })
})

describe('buildCaptureSources / buildCameraSources / buildMicrophoneSources', () => {
  const captureDevices: Device[] = [
    { id: 'screen:1', name: 'Display 1', kind: 'screen', status: 'available' },
    { id: 'window:1', name: 'Notes', kind: 'window', status: 'available' }
  ]
  const cameras: Device[] = [
    { id: 'cam:1', name: 'FaceTime HD', kind: 'camera', status: 'available' }
  ]
  const microphones: Device[] = [
    { id: 'mic:1', name: 'MacBook Mic', kind: 'microphone', status: 'available' }
  ]

  it('selects a screen and clears any window selection', () => {
    const next = buildCaptureSources(
      { windowId: 'window:9', testPattern: true },
      captureDevices,
      'screen:1'
    )
    expect(next.screenId).toBe('screen:1')
    expect(next.screenName).toBe('Display 1')
    expect(next.windowId).toBeUndefined()
    expect(next.testPattern).toBe(false)
  })

  it('selects a window and clears any screen selection', () => {
    const next = buildCaptureSources({ screenId: 'screen:1' }, captureDevices, 'window:1')
    expect(next.windowId).toBe('window:1')
    expect(next.windowName).toBe('Notes')
    expect(next.screenId).toBeUndefined()
  })

  it('clears the capture source for an unknown id', () => {
    const next = buildCaptureSources({ screenId: 'screen:1' }, captureDevices, undefined)
    expect(next.screenId).toBeUndefined()
    expect(next.windowId).toBeUndefined()
  })

  it('sets camera id + name, preserving other sources', () => {
    const next = buildCameraSources({ screenId: 'screen:1' }, cameras, 'cam:1')
    expect(next.cameraId).toBe('cam:1')
    expect(next.cameraName).toBe('FaceTime HD')
    expect(next.screenId).toBe('screen:1')
  })

  it('sets microphone id + name and clears it for undefined', () => {
    const set = buildMicrophoneSources({}, microphones, 'mic:1')
    expect(set.microphoneId).toBe('mic:1')
    expect(set.microphoneName).toBe('MacBook Mic')
    const cleared = buildMicrophoneSources({ microphoneId: 'mic:1' }, microphones, undefined)
    expect(cleared.microphoneId).toBeUndefined()
    expect(cleared.microphoneName).toBeUndefined()
  })
})

describe('normalizeCaptionsCaptureSettings', () => {
  it('defaults, validates, and migrates the pre-R1 boolean', async () => {
    const { normalizeCaptionsCaptureSettings } = await import('./capture')
    expect(normalizeCaptionsCaptureSettings(undefined)).toEqual({
      enabled: false,
      burnTarget: 'stream',
      styleId: 'classic',
      language: 'auto',
      styleRevision: 0,
      position: 'bottom',
      textSize: 'm'
    })
    // Pre-R1 config: burnInEnabled true meant the stream leg.
    expect(normalizeCaptionsCaptureSettings({ burnInEnabled: true })).toEqual({
      enabled: false,
      burnTarget: 'stream',
      styleId: 'glass',
      language: 'auto',
      styleRevision: 0,
      position: 'bottom',
      textSize: 'm'
    })
    expect(normalizeCaptionsCaptureSettings({ burnInEnabled: false })).toEqual({
      enabled: false,
      burnTarget: 'off',
      styleId: 'glass',
      language: 'auto',
      styleRevision: 0,
      position: 'bottom',
      textSize: 'm'
    })
    // Explicit target wins over the legacy flag; junk falls back to off.
    expect(
      normalizeCaptionsCaptureSettings({
        burnTarget: 'recording',
        burnInEnabled: true,
        position: 'top',
        textSize: 'l'
      })
    ).toEqual({
      enabled: false,
      burnTarget: 'recording',
      styleId: 'glass',
      language: 'auto',
      styleRevision: 0,
      position: 'top',
      textSize: 'l'
    })
    expect(normalizeCaptionsCaptureSettings({ burnTarget: 'sideways' as never })).toEqual({
      enabled: false,
      burnTarget: 'off',
      styleId: 'glass',
      language: 'auto',
      styleRevision: 0,
      position: 'bottom',
      textSize: 'm'
    })
  })

  it('keeps valid consent, language, style, and monotonic revision values', async () => {
    const { normalizeCaptionsCaptureSettings } = await import('./capture')
    expect(
      normalizeCaptionsCaptureSettings({
        enabled: true,
        burnTarget: 'both',
        styleId: 'high-contrast',
        language: ' es ',
        styleRevision: 7,
        position: 'top',
        textSize: 's'
      })
    ).toEqual({
      enabled: true,
      burnTarget: 'both',
      styleId: 'high-contrast',
      language: 'es',
      styleRevision: 7,
      position: 'top',
      textSize: 's'
    })
  })
})

describe('camera shape and aspect (2026-07-06)', () => {
  it('defaults new fields for configs persisted before they existed', () => {
    const layout = normalizeLayoutSettings({
      layoutPreset: 'screen-camera',
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32
    })

    expect(layout.cameraCornerRadiusPct).toBe(12)
    expect(layout.cameraAspect).toBe('source')
  })

  it('keeps valid persisted values and clamps the radius', () => {
    const layout = normalizeLayoutSettings({
      layoutPreset: 'screen-camera',
      cameraShape: 'rounded',
      cameraCornerRadiusPct: 900,
      cameraAspect: 'portrait'
    })

    expect(layout.cameraShape).toBe('rounded')
    expect(layout.cameraCornerRadiusPct).toBe(50)
    expect(layout.cameraAspect).toBe('portrait')
  })

  it('rejects junk shape/aspect values back to defaults', () => {
    const layout = normalizeLayoutSettings({ cameraShape: 'triangle', cameraAspect: 'ultrawide' })

    expect(layout.cameraShape).toBe('rectangle')
    expect(layout.cameraAspect).toBe('source')
  })

  it('migrates the dev-era vertical preset to its renamed variant', () => {
    // 'vertical' never shipped, but dev configs persisted it before the
    // orientation-mode split — mirror the backend serde alias.
    expect(normalizeLayoutSettings({ layoutPreset: 'vertical' }).layoutPreset).toBe(
      'vertical-camera-top'
    )
    expect(normalizeLayoutSettings({ layoutPreset: 'diagonal' }).layoutPreset).toBe(
      defaultCaptureConfig.layout.layoutPreset
    )
  })
})

describe('vertical orientation video coupling', () => {
  const landscape = videoPresets['record-4k30']
  const vertical = videoPresets['vertical-1080x1920']

  it('entering vertical mode applies the portrait profile and remembers the landscape canvas', () => {
    const patch = verticalOrientationVideoPatch(
      'screen-camera',
      'vertical-camera-top',
      landscape,
      null
    )
    expect(patch).toEqual({ video: vertical, verticalRestoreVideo: landscape })
  })

  it('entering vertical mode keeps a canvas the user already made portrait', () => {
    const customPortrait = { ...landscape, preset: 'custom' as const, width: 1440, height: 2560 }
    expect(
      verticalOrientationVideoPatch('screen-only', 'vertical-screen-camera', customPortrait, null)
    ).toBeNull()
  })

  it('leaving vertical mode restores exactly the remembered landscape canvas once', () => {
    const patch = verticalOrientationVideoPatch(
      'vertical-camera-top',
      'screen-camera',
      vertical,
      landscape
    )
    expect(patch).toEqual({ video: landscape, verticalRestoreVideo: null })
  })

  it('leaving vertical mode falls back to the default landscape profile with nothing remembered', () => {
    const patch = verticalOrientationVideoPatch('vertical-split', 'side-by-side', vertical, null)
    expect(patch).toEqual({ video: defaultCaptureConfig.video, verticalRestoreVideo: null })
  })

  it('leaving vertical mode never clobbers a canvas the user already made landscape', () => {
    const patch = verticalOrientationVideoPatch(
      'vertical-camera-top',
      'screen-camera',
      landscape,
      vertical
    )
    expect(patch).toEqual({ video: landscape, verticalRestoreVideo: null })
  })

  it('is inert for same-orientation transitions', () => {
    expect(
      verticalOrientationVideoPatch('screen-camera', 'side-by-side', landscape, null)
    ).toBeNull()
    // Scene switches WITHIN vertical mode must never touch the canvas — this
    // is what keeps them live-safe during a running session.
    expect(
      verticalOrientationVideoPatch('vertical-camera-top', 'vertical-split', vertical, landscape)
    ).toBeNull()
    expect(
      verticalOrientationVideoPatch(
        'vertical-screen-camera',
        'vertical-screen-only',
        vertical,
        landscape
      )
    ).toBeNull()
  })
})
