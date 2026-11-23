import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { Scene, SceneSource } from './backend'
import { defaultCaptureConfig, type CaptureConfig } from './capture'
import { startBufferOnlySession } from './replay-buffer'

const source = (id: string, kind: SceneSource['kind']): SceneSource =>
  ({ id, kind, name: id, visible: true }) as SceneSource

const scene = (sources: SceneSource[]): Scene => ({
  id: 'scene:default',
  name: 'Default Scene',
  sources,
  outputs: [],
  background: { assetId: 'library:silk' } as Scene['background']
})

function sessionStartClient() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    requestTyped: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return { state: 'recording' }
    })
  } as unknown as BackendClient
  return { client, requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('startBufferOnlySession', () => {
  // Release pass 2026-11-23 (smoke:freeform-editor, mask law): Screen only
  // crossed the orientation, so the ring stopped and re-armed behind the
  // Freeform entry. Its start carried the Screen only scene the Studio had
  // held, the backend committed it over the Freeform layout, and the camera
  // left the scene. The start must carry the scene as it is when it goes out.
  it('sends the scene and config the Studio holds when the request goes out, not when it was asked for', async () => {
    let authorize: (value: { capabilityId: string }) => void = () => undefined
    vi.stubGlobal('window', {
      videorc: {
        authorizeOutputDirectory: () =>
          new Promise<{ capabilityId: string }>((resolve) => {
            authorize = resolve
          })
      }
    })
    const screenOnly: CaptureConfig = {
      ...defaultCaptureConfig,
      sources: { ...defaultCaptureConfig.sources, cameraId: 'camera:1' },
      layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' }
    }
    let held = {
      captureConfig: screenOnly,
      scene: scene([source('source:screen', 'screen')])
    }
    const { client, requests } = sessionStartClient()

    const started = startBufferOnlySession({
      client,
      current: () => held,
      sceneEditMode: true,
      settings: {
        outputDirectory: '',
        outputDirectoryHandle: 'handle:1',
        keepOriginalRecording: false
      } as Parameters<typeof startBufferOnlySession>[0]['settings']
    })
    // The Freeform entry lands while the start is on its way.
    held = {
      captureConfig: {
        ...screenOnly,
        layout: { ...screenOnly.layout, arrangementMode: 'freeform' }
      },
      scene: scene([source('source:screen', 'screen'), source('source:camera', 'camera')])
    }
    authorize({ capabilityId: 'capability:1' })
    await started

    expect(requests).toHaveLength(1)
    const params = requests[0]!.params as {
      scene?: Scene
      layout: CaptureConfig['layout']
      output: { outputDirectoryCapability?: string; recordEnabled: boolean }
    }
    expect(requests[0]!.method).toBe('session.start')
    expect(params.scene?.sources.map((entry) => entry.id)).toEqual([
      'source:screen',
      'source:camera'
    ])
    expect(params.layout.arrangementMode).toBe('freeform')
    expect(params.output.outputDirectoryCapability).toBe('capability:1')
    expect(params.output.recordEnabled).toBe(false)
  })
})
