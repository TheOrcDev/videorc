import { describe, expect, it } from 'vitest'

import type { Scene } from './backend'
import { defaultCaptureConfig, type CaptureConfig } from './capture'
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

  it('omits a null scene', () => {
    const params = buildStartSessionParams({
      captureConfig: captureConfig(),
      scene: null,
      settings: {
        outputDirectory: '',
        ffmpegPath: ''
      }
    })

    expect(params.scene).toBeUndefined()
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
})
