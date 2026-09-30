import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserMicVisualPipeline } from './browser-mic-visual-pipeline'

// Plan 080 S3: the browser adapter handed the pipeline's analyser WRAPPER to
// Web Audio's connect(), which only accepts an AudioNode and throws a
// TypeError otherwise. Every idle open failed as "audio-context" (and, before
// the reason existed, as a false "needs permission"). The pipeline tests use
// fakes that accept any object, so this fake Web Audio is strict like Chromium.

class FakeAnalyserNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  get frequencyBinCount(): number {
    return this.fftSize / 2
  }
  getFloatFrequencyData(samples: Float32Array): void {
    samples.fill(-60)
  }
  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(0.25)
  }
}

const connected: unknown[] = []

class FakeAudioContext {
  sampleRate = 48_000
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode()
  }
  createMediaStreamSource(): { connect: (node: unknown) => void; disconnect: () => void } {
    return {
      connect: (node) => {
        if (!(node instanceof FakeAnalyserNode)) {
          throw new TypeError(
            "Failed to execute 'connect' on 'AudioNode': parameter 1 is not of type 'AudioNode'."
          )
        }
        connected.push(node)
      },
      disconnect: () => undefined
    }
  }
  async close(): Promise<void> {}
}

afterEach(() => {
  connected.length = 0
  vi.unstubAllGlobals()
})

describe('createBrowserMicVisualPipeline', () => {
  it('connects the stream to the real analyser node and goes live', async () => {
    const track = { stop: vi.fn() }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'airpods', label: 'AirPods Pro (Bluetooth)' }
        ],
        getUserMedia: async () => ({ getTracks: () => [track] }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    })
    vi.stubGlobal('window', {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      setTimeout: (callback: () => void) => setTimeout(callback, 0),
      clearTimeout: (handle: number) => clearTimeout(handle)
    })

    const pipeline = createBrowserMicVisualPipeline()
    pipeline.retain()
    pipeline.configure({
      selectionKey: 'microphone:coreaudio:42',
      deviceName: 'AirPods Pro',
      strictDevice: true,
      enabled: true,
      permissionStatus: 'granted'
    })

    await vi.waitFor(() =>
      expect(pipeline.getLifecycleSnapshot()).toEqual({ status: 'active', active: true })
    )
    expect(connected).toHaveLength(1)
    expect(pipeline.getFrameSnapshot().bands.length).toBeGreaterThan(0)
    pipeline.dispose()
    expect(track.stop).toHaveBeenCalled()
  })
})
