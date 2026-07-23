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
