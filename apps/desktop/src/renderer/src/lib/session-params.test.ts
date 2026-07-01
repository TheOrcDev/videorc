import { describe, expect, it } from 'vitest'

import type { Scene } from './backend'
import { defaultCaptureConfig, videoPresets, type CaptureConfig } from './capture'
import { buildStartSessionParams } from './session-params'

const scene: Scene = {
  id: 'scene-1',
  name: 'Studio',
  sources: [],
  outputs: []
}

function captureConfig(patch: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    ...patch
  }
}

describe('buildStartSessionParams', () => {
  it('normalizes blank local paths to undefined', () => {
    const params = buildStartSessionParams({
      captureConfig: captureConfig(),
      scene,
      settings: {
        outputDirectory: '   ',
        ffmpegPath: ''
      }
    })

    expect(params.output.outputDirectory).toBeUndefined()
    expect(params.output.ffmpegPath).toBeUndefined()
  })

  it('trims output paths and RTMP fields without changing the selected preset', () => {
    const params = buildStartSessionParams({
      captureConfig: captureConfig({
        rtmpServerUrl: '  rtmp://example.test/live  ',
        streamKey: '  secret-key  '
      }),
      scene,
      settings: {
        outputDirectory: '  /tmp/videos  ',
        ffmpegPath: '  /opt/bin/ffmpeg  '
      }
    })

    expect(params.output.outputDirectory).toBe('/tmp/videos')
    expect(params.output.ffmpegPath).toBe('/opt/bin/ffmpeg')
    expect(params.output.rtmp).toEqual({
      preset: 'youtube',
      serverUrl: 'rtmp://example.test/live',
      streamKey: 'secret-key'
    })
  })

  it('omits the derived scene unless scene edit mode is active', () => {
    const params = buildStartSessionParams({
      captureConfig: captureConfig(),
      scene,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.scene).toBeUndefined()
  })

  it('passes the edited scene while scene edit mode is active', () => {
    const params = buildStartSessionParams({
      captureConfig: captureConfig(),
      scene,
      sceneEditMode: true,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.scene).toBe(scene)
  })

  it('sends the scene with a background even when scene edit mode is off', () => {
    const withBackground: Scene = {
      ...scene,
      background: {
        assetId: 'a1',
        managedAssetPath: '/managed/a1.png',
        fit: 'fill',
        scale: 100,
        offsetX: 0,
        offsetY: 0,
        blurPx: 0,
        dimPercent: 0,
        saturationPercent: 100,
        vignettePercent: 0,
        visibilityPercent: 20
      }
    }

    const params = buildStartSessionParams({
      captureConfig: captureConfig(),
      scene: withBackground,
      settings: { outputDirectory: '', ffmpegPath: '' }
    })

    expect(params.scene).toBe(withBackground)
    expect(params.scene?.background?.assetId).toBe('a1')
  })

  it('passes through streaming and output enablement from capture config', () => {
    const config = captureConfig({
      recordEnabled: false,
      streamEnabled: true,
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        enabledTargetIds: ['youtube']
      }
    })

    const params = buildStartSessionParams({
      captureConfig: config,
      scene,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.output.recordEnabled).toBe(false)
    expect(params.output.streamEnabled).toBe(true)
    expect(params.streaming).toBe(config.streaming)
  })

  it('passes 4K recording video and stream-safe output defaults for split output sessions', () => {
    const config = captureConfig({
      recordEnabled: true,
      streamEnabled: true,
      video: videoPresets['record-4k30'],
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        defaultOutputPreset: 'stream-safe-1080p30',
        defaultBitrateKbps: 6000,
        enabledTargetIds: ['youtube']
      }
    })

    const params = buildStartSessionParams({
      captureConfig: config,
      scene,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.output.video).toEqual(videoPresets['record-4k30'])
    expect(params.streaming?.defaultOutputPreset).toBe('stream-safe-1080p30')
    expect(params.streaming?.defaultBitrateKbps).toBe(6000)
    expect(params.streaming?.enabledTargetIds).toEqual(['youtube'])
  })

  it('passes YouTube 4K30 stream defaults with 4K local recording intact', () => {
    const config = captureConfig({
      recordEnabled: true,
      streamEnabled: true,
      video: videoPresets['record-4k30'],
      streaming: {
        ...defaultCaptureConfig.streaming,
        enabled: true,
        defaultOutputPreset: 'stream-youtube-4k30',
        defaultBitrateKbps: 30000,
        enabledTargetIds: ['youtube'],
        targets: defaultCaptureConfig.streaming.targets.map((target) => ({
          ...target,
          enabled: target.id === 'youtube'
        }))
      }
    })

    const params = buildStartSessionParams({
      captureConfig: config,
      scene,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.output.video).toEqual(videoPresets['record-4k30'])
    expect(params.streaming?.defaultOutputPreset).toBe('stream-youtube-4k30')
    expect(params.streaming?.defaultBitrateKbps).toBe(30000)
    expect(params.streaming?.enabledTargetIds).toEqual(['youtube'])
  })
})
