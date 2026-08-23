import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateSupportBundle } from './support-bundle-verifier.mjs'

function validBundle(overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: '2026-06-13T18:00:00Z',
    app: {
      version: '0.9.0',
      platform: 'darwin',
      runMode: 'dev'
    },
    health: {
      status: 'ok',
      version: '0.9.0',
      platform: 'darwin',
      ffmpeg: {
        path: '/Applications/Videorc.app/Contents/Resources/bin/ffmpeg',
        available: true,
        version: 'ffmpeg version test'
      },
      databasePath: '<redacted:database-path>',
      secretStoreBackend: 'json-file'
    },
    devices: {
      devices: [
        {
          id: 'screen:screencapturekit:1',
          name: 'Display 1',
          kind: 'screen',
          status: 'available'
        }
      ],
      warnings: []
    },
    lastAudioMeter: null,
    entitlements: {
      tier: 'basic'
    },
    recording: {
      state: 'idle',
      outputPath: '<redacted:path:session.mkv>'
    },
    diagnostics: {
      previewTransport: 'native-surface',
      previewSurfaceBacking: 'cametal-layer',
      encodeBackend: 'hardware-videotoolbox',
      compositorBackend: 'metal'
    },
    rendererDiagnostics: {
      automaticSourceFallbacks: [],
      runtimeInfo: {
        version: '0.9.0',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '25.0.0',
        gpuDevices: [],
        isPackaged: true,
        permissionTargetName: 'Videorc',
        permissionTargetPath: '/Applications/Videorc.app',
        capturePermissionTargetName: 'videorc-backend',
        capturePermissionTargetPath: '/Applications/Videorc.app/Contents/Resources/videorc-backend',
        nativePreviewSurfaceProofEnabled: true
      }
    },
    logs: [
      {
        level: 'info',
        message: 'Backend ready.',
        timestamp: '2026-06-13T18:00:00Z'
      }
    ],
    sessions: [
      {
        id: 'session-1',
        title: 'Test',
        startedAt: '2026-06-13T18:00:00Z',
        endedAt: null,
        status: 'completed',
        mode: 'record',
        outputFile: '<redacted:path:session.mkv>',
        mp4File: '<redacted:path:session.mp4>',
        streamPreset: null,
        container: 'mkv',
        durationMs: 1000,
        healthEvents: [],
        sessionLogs: [],
        aiArtifacts: [
          {
            id: 'artifact-1',
            sessionId: 'session-1',
            kind: 'summary',
            status: 'completed',
            file: '<redacted:path:summary.md>',
            createdAt: '2026-06-13T18:00:00Z'
          }
        ]
      }
    ],
    redactionSummary: {
      secretValues: 1,
      databasePaths: 1,
      mediaPaths: 3,
      homePaths: 0,
      urlCredentials: 1,
      aiArtifactBodies: 1
    },
    ...overrides
  }
}

describe('validateSupportBundle', () => {
  it('accepts a redacted support bundle with required sections', () => {
    const result = validateSupportBundle(validBundle())

    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [])
  })

  it('requires the support bundle top-level sections', () => {
    const bundle = validBundle()
    delete bundle.sessions

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /Missing required top-level section: sessions/)
  })

  it('allows secretStoreBackend while rejecting raw secret-shaped values', () => {
    const bundle = validBundle({
      health: {
        databasePath: '<redacted:database-path>',
        version: '0.9.0',
        platform: 'darwin',
        ffmpeg: {
          path: 'ffmpeg',
          available: true,
          version: 'ffmpeg version test'
        },
        secretStoreBackend: 'json-file',
        accessToken: 'sk-real-token-value'
      }
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /health\.accessToken/)
    assert.doesNotMatch(result.failures.join('\n'), /secretStoreBackend/)
  })

  it('rejects raw database and media paths', () => {
    const bundle = validBundle({
      health: {
        status: 'ok',
        version: '0.9.0',
        platform: 'darwin',
        ffmpeg: {
          path: 'ffmpeg',
          available: true,
          version: 'ffmpeg version test'
        },
        databasePath: '/Users/orcdev/Library/Application Support/Videorc/videorc.sqlite3',
        secretStoreBackend: 'json-file'
      },
      sessions: [
        {
          ...validBundle().sessions[0],
          outputFile: '/Users/orcdev/Movies/Videorc/Recordings/session.mkv'
        }
      ]
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /health\.databasePath/)
    assert.match(result.failures.join('\n'), /sessions\.0\.outputFile/)
  })

  it('rejects an unredacted Windows quality-status path', () => {
    const session = validBundle().sessions[0]
    const bundle = validBundle({
      sessions: [
        {
          ...session,
          qualityStatus: {
            status: 'not-hundred-percent',
            path: 'C:\\Users\\orcdev\\Videos\\Videorc\\Recordings\\session.mp4',
            reasons: ['missing audio stream'],
            needsAttention: true
          }
        }
      ]
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /sessions\.0\.qualityStatus\.path/)
  })

  it('rejects raw RTMP URLs and URL credentials', () => {
    const bundle = validBundle({
      recording: {
        state: 'idle',
        streamUrl: 'rtmp://live.example.test/app/raw-stream-key',
        ingestUrl: 'https://user:pass@example.test/live'
      }
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /recording\.streamUrl/)
    assert.match(result.failures.join('\n'), /recording\.ingestUrl/)
  })

  it('rejects AI artifact bodies while allowing metadata', () => {
    const session = validBundle().sessions[0]
    const bundle = validBundle({
      sessions: [
        {
          ...session,
          aiArtifacts: [
            {
              ...session.aiArtifacts[0],
              content: 'Full transcript text should not be in a support bundle.'
            }
          ]
        }
      ]
    })

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /sessions\.0\.aiArtifacts\.0\.content/)
  })

  it('accepts Windows acceptance bundles with package, host, GPU, device, and diagnostic proof', () => {
    const result = validateSupportBundle(validWindowsAcceptanceBundle(), {
      windowsAcceptance: true
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [])
  })

  it('accepts Windows encoder proof from saved session final diagnostics', () => {
    const bundle = validWindowsAcceptanceBundle({
      diagnostics: {
        previewTransport: 'mjpeg-stream'
      },
      sessions: [
        {
          ...validWindowsAcceptanceBundle().sessions[0],
          finalDiagnostics: {
            encodeBackend: 'software-x264',
            compositorFallbackReason: 'Windows portable preview'
          }
        }
      ]
    })

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.equal(result.ok, true)
  })

  it('requires final and peak stream counters plus the effective encoder path', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.sessions[0].finalDiagnostics = validWindowsStreamDiagnostics()

    assert.equal(validateSupportBundle(bundle, { windowsAcceptance: true }).ok, true)

    delete bundle.sessions[0].finalDiagnostics.streamMeasuredBitrateMinKbps
    delete bundle.sessions[0].finalDiagnostics.encoderBridgeEffectiveVideoOutput
    bundle.sessions[0].finalDiagnostics.encoderBridgeRequestedVideoOutput =
      'windows-media-foundation-h264-mpegts'
    bundle.sessions[0].finalDiagnostics.encoderBridgeEffectiveVideoOutput = 'raw-yuv420p'
    delete bundle.sessions[0].finalDiagnostics.encoderBridgeEncodedOutputFallbackReason

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /streamMeasuredBitrateMinKbps/)
    assert.match(result.failures.join('\n'), /fallback reason/)
  })

  it('requires stable zero-copy D3D11 diagnostics for forced and automatic live paths', () => {
    const bundle = validWindowsAcceptanceBundle()
    const first = {
      ...validWindowsStreamDiagnostics(),
      compositorBackend: 'd3d11',
      previewTransport: 'd3d11-shared-texture',
      previewSurfaceBacking: 'directcomposition-swapchain',
      windowsD3d11Media: validWindowsD3d11Diagnostics({
        textureImportFrames: 1,
        encoderGpuSamples: 1
      })
    }
    const terminal = {
      ...validWindowsStreamDiagnostics(),
      compositorBackend: 'd3d11',
      previewTransport: 'd3d11-shared-texture',
      previewSurfaceBacking: 'directcomposition-swapchain',
      windowsD3d11Media: validWindowsD3d11Diagnostics()
    }
    bundle.diagnostics = first
    bundle.sessions[0].finalDiagnostics = terminal
    bundle.rendererDiagnostics.nativePreviewSurfaceStatus = validWindowsD3d11PreviewSurfaceStatus()
    assert.equal(validateSupportBundle(bundle, { windowsAcceptance: true }).ok, true)

    terminal.windowsD3d11Media.captureReadbackFrames = 2
    terminal.windowsD3d11Media.previewBmpRequests = 1
    terminal.windowsD3d11Media.fallbackReason = 'unexpected-readback'
    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /captureReadbackFrames=0/)
    assert.match(result.failures.join('\n'), /previewBmpRequests=0/)
    assert.match(result.failures.join('\n'), /must not contain a fallbackReason/)

    const automatic = validWindowsAcceptanceBundle()
    automatic.diagnostics = {
      ...first,
      windowsD3d11Media: validWindowsD3d11Diagnostics({
        required: false,
        captureReadbackFrames: 1
      })
    }
    const automaticResult = validateSupportBundle(automatic, { windowsAcceptance: true })
    assert.equal(automaticResult.ok, false)
    assert.match(automaticResult.failures.join('\n'), /captureReadbackFrames=0/)

    automatic.diagnostics.windowsD3d11Media.captureReadbackFrames = 0
    automatic.diagnostics.windowsD3d11Media.requested = false
    assert.match(
      validateSupportBundle(automatic, { windowsAcceptance: true }).failures.join('\n'),
      /requested=true/
    )
  })

  it('requires a named natural fallback when a Windows stream does not use live D3D11', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.sessions[0].finalDiagnostics = validWindowsStreamDiagnostics()
    assert.equal(validateSupportBundle(bundle, { windowsAcceptance: true }).ok, true)

    delete bundle.sessions[0].finalDiagnostics.windowsD3d11Media.fallbackReason
    bundle.sessions[0].finalDiagnostics.windowsD3d11Media.adapterLuid = '00000000000003f1'
    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /named fallbackReason/)
    assert.match(result.failures.join('\n'), /must not claim adapterLuid/)
  })

  it('requires scheduler fairness and a zero synchronization-timeout counter', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.diagnostics = {
      ...validWindowsStreamDiagnostics(),
      windowsD3d11Media: validWindowsD3d11Diagnostics({
        mediaCommandLagP95Ms: 51,
        maximumConsecutiveMediaBatch: 33,
        synchronizationTimeouts: 1
      })
    }

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /mediaCommandLagP95Ms within 50 ms/)
    assert.match(result.failures.join('\n'), /maximumConsecutiveMediaBatch within 32/)
    assert.match(result.failures.join('\n'), /synchronizationTimeouts=0/)
  })

  it('validates Desktop Duplication cursor-on and cursor-excluded WGC without inverting exclusion', () => {
    const desktop = validWindowsAcceptanceBundle()
    desktop.diagnostics = {
      ...validWindowsStreamDiagnostics(),
      windowsD3d11Media: validWindowsD3d11Diagnostics()
    }
    assert.equal(validateSupportBundle(desktop, { windowsAcceptance: true }).ok, true)

    const wgc = validWindowsAcceptanceBundle()
    wgc.diagnostics = {
      ...validWindowsStreamDiagnostics(),
      windowsD3d11Media: validWindowsD3d11Diagnostics({
        captureBackend: 'windows-graphics-capture-monitor',
        cursorRequested: false,
        cursorMode: 'excluded-wgc',
        cursorPixelsSource: 'excluded-by-windows-graphics-capture',
        cursorExclusionGuaranteed: true,
        cursorShapeUploads: 0,
        cursorCompositedFrames: 0
      })
    }
    assert.equal(validateSupportBundle(wgc, { windowsAcceptance: true }).ok, true)

    wgc.diagnostics.windowsD3d11Media.cursorRequested = true
    const inverted = validateSupportBundle(wgc, { windowsAcceptance: true })
    assert.equal(inverted.ok, false)
    assert.match(inverted.failures.join('\n'), /cursorRequested=false/)

    desktop.diagnostics.windowsD3d11Media.cursorMode = 'embedded'
    const doubleDrawn = validateSupportBundle(desktop, { windowsAcceptance: true })
    assert.equal(doubleDrawn.ok, false)
    assert.match(doubleDrawn.failures.join('\n'), /cursorCompositedFrames=0 for embedded/)
  })

  it('requires every present D3D11 role adapter to equal the media authority', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.diagnostics = {
      ...validWindowsStreamDiagnostics(),
      windowsD3d11Media: validWindowsD3d11Diagnostics({
        compositorAdapterLuid: '00000000000003f2'
      })
    }
    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /compositorAdapterLuid to equal adapterLuid/)
  })

  it('requires sanitized D3D11 presenter style, owner, adapter, and liveness proof', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.diagnostics = {
      ...validWindowsStreamDiagnostics(),
      compositorBackend: 'd3d11',
      previewTransport: 'd3d11-shared-texture',
      previewSurfaceBacking: 'directcomposition-swapchain',
      windowsD3d11Media: validWindowsD3d11Diagnostics()
    }
    bundle.rendererDiagnostics.nativePreviewSurfaceStatus = validWindowsD3d11PreviewSurfaceStatus()
    assert.equal(validateSupportBundle(bundle, { windowsAcceptance: true }).ok, true)

    const presenter = bundle.rendererDiagnostics.nativePreviewSurfaceStatus.windowsD3d11Presenter
    presenter.sameAdapter = false
    presenter.windowFocused = true
    presenter.actualBounds.width = 0
    presenter.fallbackReason = 'adapter-crossed'
    const result = validateSupportBundle(bundle, { windowsAcceptance: true })
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /sameAdapter=true/)
    assert.match(result.failures.join('\n'), /windowFocused=false/)
    assert.match(result.failures.join('\n'), /positive integral actualBounds/)
    assert.match(result.failures.join('\n'), /must not contain a fallbackReason/)
  })

  it('rejects a privileged HWND from any support-bundle section', () => {
    const bundle = validBundle()
    bundle.diagnostics.orderAboveWindowHandle = '0x0000000000001234'
    const result = validateSupportBundle(bundle)
    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /leaked a privileged native window handle/)
  })

  it('accepts visible persisted software rendering with recovery evidence', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.rendererDiagnostics.runtimeInfo.hardwareAccelerationDisabled = true
    bundle.rendererDiagnostics.runtimeInfo.gpuFallback = {
      source: 'persisted',
      reason: 'gpu-process-crashes',
      crashCount: 2,
      updatedAt: '2026-07-20T00:00:00.000Z',
      retryScheduled: true,
      retryAttempts: 1
    }

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.equal(result.ok, true)
  })

  it('rejects Windows acceptance without an explicit graphics fallback status', () => {
    const bundle = validWindowsAcceptanceBundle()
    delete bundle.rendererDiagnostics.runtimeInfo.hardwareAccelerationDisabled
    delete bundle.rendererDiagnostics.runtimeInfo.gpuFallback

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /hardwareAccelerationDisabled/)
    assert.match(result.failures.join('\n'), /gpuFallback/)
  })

  it('accepts a bundle without backend crash records (older apps) and with valid ones', () => {
    const bundle = validWindowsAcceptanceBundle()
    assert.equal(validateSupportBundle(bundle, { windowsAcceptance: true }).ok, true)

    bundle.rendererDiagnostics.runtimeInfo.backendCrashes = [
      {
        at: '2026-08-23T10:00:05.000Z',
        generation: 2,
        code: 101,
        signal: null,
        attempt: 2,
        uptimeMs: 1200,
        intentional: false,
        stderrTail: ['{"panic":"boom","location":"main.rs:1","thread":"main"}']
      },
      {
        at: '2026-08-23T10:00:00.000Z',
        generation: 1,
        code: null,
        signal: 'SIGKILL',
        attempt: 1,
        uptimeMs: 65000,
        intentional: false,
        stderrTail: []
      }
    ]

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.deepEqual(result.failures, [])
    assert.equal(result.ok, true)
  })

  it('rejects malformed backend crash records', () => {
    const bundle = validBundle()
    bundle.rendererDiagnostics.runtimeInfo.backendCrashes = [
      {
        at: '2026-08-23T10:00:00.000Z',
        generation: 1,
        code: null,
        signal: null,
        attempt: 0,
        uptimeMs: -1,
        intentional: false,
        stderrTail: 'not-a-list'
      },
      {
        at: '2026-08-23T10:00:05.000Z',
        generation: 2,
        code: 1,
        signal: null,
        attempt: null,
        uptimeMs: 1,
        intentional: false,
        stderrTail: []
      }
    ]

    const result = validateSupportBundle(bundle)

    assert.equal(result.ok, false)
    const failures = result.failures.join('\n')
    assert.match(failures, /backendCrashes\.0 must name an exit code or a signal/)
    assert.match(failures, /backendCrashes\.0\.attempt must be a positive integer or null/)
    assert.match(failures, /backendCrashes\.0\.uptimeMs must be a non-negative integer/)
    assert.match(failures, /backendCrashes\.0\.stderrTail must be an array of strings/)
    assert.match(failures, /must be ordered most recent first \(record 1\)/)

    bundle.rendererDiagnostics.runtimeInfo.backendCrashes = { at: 'x' }
    assert.match(
      validateSupportBundle(bundle).failures.join('\n'),
      /backendCrashes must be an array of crash records/
    )
  })

  it('rejects software rendering without its persisted reason', () => {
    const bundle = validWindowsAcceptanceBundle()
    bundle.rendererDiagnostics.runtimeInfo.hardwareAccelerationDisabled = true
    bundle.rendererDiagnostics.runtimeInfo.gpuFallback = {
      source: 'persisted',
      reason: null,
      crashCount: 2,
      updatedAt: '2026-07-20T00:00:00.000Z',
      retryScheduled: false,
      retryAttempts: 0
    }

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /fallback reason/)
  })

  it('rejects Windows acceptance bundles without packaged Windows runtime proof', () => {
    const bundle = validWindowsAcceptanceBundle({
      app: {
        version: '0.9.16',
        platform: 'windows',
        runMode: 'dev'
      },
      rendererDiagnostics: {
        automaticSourceFallbacks: [],
        runtimeInfo: {
          version: '0.9.16',
          platform: 'win32',
          arch: 'arm64',
          osRelease: '10.0.19045',
          gpuDevices: [],
          isPackaged: false
        }
      }
    })

    const result = validateSupportBundle(bundle, { windowsAcceptance: true })

    assert.equal(result.ok, false)
    assert.match(result.failures.join('\n'), /app\.runMode/)
    assert.match(result.failures.join('\n'), /arch/)
    assert.match(result.failures.join('\n'), /Windows 11 build 22000/)
    assert.match(result.failures.join('\n'), /isPackaged=true/)
    assert.match(result.failures.join('\n'), /gpuDevices/)
  })
})

function validWindowsAcceptanceBundle(overrides = {}) {
  return validBundle({
    app: {
      version: '0.9.16',
      platform: 'windows',
      runMode: 'packaged'
    },
    health: {
      status: 'ok',
      version: '0.9.16',
      platform: 'windows',
      ffmpeg: {
        path: 'C:\\Program Files\\Videorc\\resources\\bin\\ffmpeg.exe',
        available: true,
        version: 'ffmpeg version 7.1'
      },
      databasePath: '<redacted:database-path>',
      secretStoreBackend: 'windows-credential-manager'
    },
    devices: {
      devices: [
        {
          id: 'screen:dxgi-output:0',
          name: 'DISPLAY1',
          kind: 'screen',
          status: 'available',
          detail: 'Windows DXGI output DISPLAY1 on NVIDIA RTX.'
        },
        {
          id: 'camera:windows-dshow:5553422043616d657261',
          name: 'USB Camera',
          kind: 'camera',
          status: 'available',
          detail: 'Windows MediaFoundation camera. Recording uses dshow device `USB Camera`.'
        },
        {
          id: 'microphone:windows-dshow:4d6963726f70686f6e65204172726179',
          name: 'Microphone Array',
          kind: 'microphone',
          status: 'available',
          detail: 'Windows dshow microphone.'
        }
      ],
      warnings: []
    },
    diagnostics: {
      previewTransport: 'mjpeg-stream',
      encodeBackend: 'software-x264',
      compositorFallbackReason: 'Windows portable preview'
    },
    rendererDiagnostics: {
      automaticSourceFallbacks: [],
      runtimeInfo: {
        version: '0.9.16',
        platform: 'win32',
        arch: 'x64',
        osRelease: '10.0.22631',
        gpuDevices: [
          {
            vendorId: 4318,
            deviceId: 9348,
            active: true,
            vendor: 'NVIDIA',
            description: 'NVIDIA RTX'
          }
        ],
        hardwareAccelerationDisabled: false,
        gpuFallback: {
          source: 'none',
          reason: null,
          crashCount: 0,
          updatedAt: null,
          retryScheduled: false,
          retryAttempts: 0
        },
        isPackaged: true,
        permissionTargetName: 'Videorc',
        permissionTargetPath: 'C:\\Program Files\\Videorc\\Videorc.exe',
        capturePermissionTargetName: 'videorc-backend.exe',
        capturePermissionTargetPath: 'C:\\Program Files\\Videorc\\resources\\videorc-backend.exe',
        nativePreviewSurfaceProofEnabled: true
      }
    },
    ...overrides
  })
}

function validWindowsStreamDiagnostics() {
  return {
    activeOutputMode: 'stream',
    encodeBackend: 'hardware-media-foundation',
    compositorBackend: 'cpu',
    streamMeasuredBitrateKbps: 11_980,
    streamMeasuredBitrateMinKbps: 10_900,
    streamMeasuredBitrateMaxKbps: 12_090,
    streamOutputTotalBytes: 200_000_000,
    streamDuplicatedFrames: 0,
    encoderBridgeRequestedVideoOutput: 'windows-media-foundation-h264-mpegts',
    encoderBridgeEffectiveVideoOutput: 'windows-media-foundation-h264-mpegts',
    encoderBridgeEncodedOutputBackend: 'windows-media-foundation',
    windowsD3d11Media: validWindowsNaturalD3d11FallbackDiagnostics()
  }
}

function validWindowsNaturalD3d11FallbackDiagnostics(overrides = {}) {
  return {
    state: 'fallback',
    requested: false,
    required: false,
    adapterLuid: null,
    captureAdapterLuid: null,
    compositorAdapterLuid: null,
    primaryEncoderAdapterLuid: null,
    auxiliaryEncoderAdapterLuid: null,
    captureBackend: 'legacy-ffmpeg',
    fallbackReason: 'd3d11-fence-interface-unavailable',
    messagePumpLagP95Ms: 0,
    messagePumpLagMaxMs: 0,
    mediaCommandLagP95Ms: 0,
    mediaCommandLagMaxMs: 0,
    maximumConsecutiveMessageBatch: 0,
    maximumConsecutiveMediaBatch: 0,
    synchronizationTimeouts: 0,
    ...overrides
  }
}

function validWindowsD3d11Diagnostics(overrides = {}) {
  return {
    state: 'live',
    requested: true,
    required: true,
    adapterLuid: '00000000000003f1',
    captureAdapterLuid: '00000000000003f1',
    compositorAdapterLuid: '00000000000003f1',
    primaryEncoderAdapterLuid: '00000000000003f1',
    auxiliaryEncoderAdapterLuid: null,
    generation: 4,
    captureBackend: 'desktop-duplication',
    captureReadbackFrames: 0,
    compositorCpuFallbackFrames: 0,
    encoderSystemMemorySamples: 0,
    rawVideoCopiedFrames: 0,
    previewBmpRequests: 0,
    previewBmpBytes: 0,
    texturePoolPressureEvents: 0,
    adapterMismatches: 0,
    deviceResets: 0,
    staleGenerationCallbacks: 0,
    cameraUploadFrames: 0,
    texturePoolCapacity: 8,
    texturePoolInUse: 2,
    messagePumpLagP95Ms: 10,
    messagePumpLagMaxMs: 20,
    mediaCommandLagP95Ms: 8,
    mediaCommandLagMaxMs: 16,
    maximumConsecutiveMessageBatch: 12,
    maximumConsecutiveMediaBatch: 10,
    synchronizationTimeouts: 0,
    cursorRequested: true,
    cursorMode: 'separate',
    cursorPixelsSource: 'duplication-pointer-shape',
    cursorExclusionGuaranteed: false,
    cursorCompositedFrames: 900,
    textureImportFrames: 9000,
    encoderGpuSamples: 8990,
    fallbackReason: null,
    ...overrides
  }
}

function validWindowsD3d11PreviewSurfaceStatus(overrides = {}) {
  return {
    state: 'live',
    transport: 'd3d11-shared-texture',
    backing: 'directcomposition-swapchain',
    sourcePixelsPresent: true,
    framePollingSuppressed: true,
    windowsD3d11Presenter: {
      layered: true,
      transparent: true,
      noActivate: true,
      excludedFromCapture: true,
      windowActive: false,
      windowFocused: false,
      generationMatches: true,
      ownerProcessMatches: true,
      sameAdapter: true,
      sourceLive: true,
      firstPresentSucceeded: true,
      successfulPresents: 9000,
      lastPresentedSequence: 9000,
      latestWinsDrops: 0,
      hiddenDrops: 0,
      busyDrops: 0,
      staleFrameDrops: 0,
      actualBounds: {
        x: -1920,
        y: 0,
        width: 960,
        height: 540
      },
      fallbackReason: null
    },
    ...overrides
  }
}
