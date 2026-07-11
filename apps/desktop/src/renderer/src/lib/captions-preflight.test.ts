import { describe, expect, it } from 'vitest'

import type { AiCapabilities } from '@/lib/backend'

import {
  captionsEnabledForSession,
  captionsSuppressedForSession,
  captionRuntimeStartBlocked,
  captionSessionOutputReadiness,
  decideGoLiveCaptionsReadiness
} from './captions-preflight'

function capabilities(captions: AiCapabilities['captions']): AiCapabilities {
  return { captions } as AiCapabilities
}

describe('decideGoLiveCaptionsReadiness', () => {
  it('fails closed when an enabled client receives an older capabilities payload', () => {
    const result = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: false,
      capabilities: capabilities(undefined)
    })

    expect(result.kind).toBe('blocked')
    expect(result.blocksStart).toBe(true)
    expect(result.description).toContain('could not verify')
  })

  it('uses a deployment-safe reason when caption infrastructure is unavailable', () => {
    const result = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: false,
      capabilities: capabilities({
        available: false,
        preferredTransport: null,
        reasonCode: 'captions-not-configured',
        realtime: { available: false, configured: false, disabled: false, model: '' },
        chunked: { available: false, configured: false, model: '' }
      })
    })

    expect(result).toMatchObject({ kind: 'blocked', blocksStart: true, transport: null })
    expect(result.description).toContain('deployment')
  })

  it('blocks Go Live when the monthly caption allowance is exhausted', () => {
    const result = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: false,
      capabilities: capabilities({
        available: false,
        preferredTransport: null,
        reasonCode: 'captions-monthly-quota-exhausted',
        monthlySecondsLimit: 180_000,
        remainingSeconds: 0,
        realtime: { available: true, configured: true, disabled: false, model: 'xai/realtime' },
        chunked: { available: true, configured: true, model: 'xai/chunked' }
      })
    })

    expect(result).toMatchObject({ kind: 'blocked', blocksStart: true, transport: null })
    expect(result.description).toContain('allowance is exhausted')
  })

  it('reports the preferred ready transport', () => {
    const result = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: false,
      capabilities: capabilities({
        available: true,
        preferredTransport: 'realtime',
        reasonCode: 'ready-realtime',
        realtime: {
          available: true,
          configured: true,
          disabled: false,
          model: 'xai/realtime'
        },
        chunked: { available: true, configured: true, model: 'xai/chunked' }
      })
    })

    expect(result).toMatchObject({ kind: 'ready', blocksStart: false, transport: 'realtime' })
  })

  it('allows an explicit one-session skip without changing persisted consent', () => {
    const result = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: true,
      capabilities: null
    })

    expect(result).toMatchObject({ kind: 'skipped', blocksStart: false })
    expect(captionsEnabledForSession({ persistedEnabled: true, suppressForSession: true })).toBe(
      false
    )
    expect(captionsEnabledForSession({ persistedEnabled: true, suppressForSession: false })).toBe(
      true
    )
  })

  it('blocks unsupported stream burn output but preserves Continue without captions', () => {
    const outputReadiness = captionSessionOutputReadiness({
      burnTarget: 'both',
      recordEnabled: true,
      streamEnabled: true,
      recordingVideo: { width: 1920, height: 1080, fps: 60, bitrateKbps: 9_000 },
      streamVideos: [{ width: 1920, height: 1080, fps: 60, bitrateKbps: 9_000 }]
    })
    expect(outputReadiness).toMatchObject({ ready: false })
    expect(outputReadiness.description).toContain('30 fps')

    const blocked = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: false,
      capabilities: null,
      outputReadiness
    })
    expect(blocked).toMatchObject({ kind: 'blocked', blocksStart: true })

    const skipped = decideGoLiveCaptionsReadiness({
      persistedEnabled: true,
      suppressForSession: true,
      capabilities: null,
      outputReadiness
    })
    expect(skipped).toMatchObject({ kind: 'skipped', blocksStart: false })
    expect(captionRuntimeStartBlocked({ captureActive: true, outputReadiness })).toBe(true)
    expect(captionRuntimeStartBlocked({ captureActive: false, outputReadiness })).toBe(false)
  })

  it('allows non-stream caption targets above 30fps', () => {
    for (const burnTarget of ['off', 'recording'] as const) {
      expect(
        captionSessionOutputReadiness({
          burnTarget,
          recordEnabled: true,
          streamEnabled: true,
          recordingVideo: { width: 3840, height: 2160, fps: 60, bitrateKbps: 50_000 },
          streamVideos: [{ width: 1920, height: 1080, fps: 60, bitrateKbps: 9_000 }]
        })
      ).toEqual({ ready: true })
    }
  })

  it('blocks captioned record plus mixed-profile multistream', () => {
    const readiness = captionSessionOutputReadiness({
      burnTarget: 'stream',
      recordEnabled: true,
      streamEnabled: true,
      recordingVideo: { width: 1920, height: 1080, fps: 30, bitrateKbps: 6_000 },
      streamVideos: [
        { width: 1920, height: 1080, fps: 30, bitrateKbps: 6_000 },
        { width: 1280, height: 720, fps: 30, bitrateKbps: 4_000 }
      ]
    })
    expect(readiness).toMatchObject({ ready: false })
    expect(readiness.description).toContain('one shared stream output profile')
  })

  it('does not gate sessions when captions are persistently off', () => {
    expect(
      decideGoLiveCaptionsReadiness({
        persistedEnabled: false,
        suppressForSession: false,
        capabilities: null
      })
    ).toMatchObject({ kind: 'disabled', blocksStart: false })
  })

  it('pre-arms eligible captions-off sessions but suppresses unsupported output shapes', () => {
    expect(
      captionsSuppressedForSession({
        persistedEnabled: false,
        explicitSuppression: false,
        outputReadiness: { ready: true }
      })
    ).toBe(false)
    expect(
      captionsSuppressedForSession({
        persistedEnabled: false,
        explicitSuppression: false,
        outputReadiness: { ready: false }
      })
    ).toBe(true)
    expect(
      captionsSuppressedForSession({
        persistedEnabled: true,
        explicitSuppression: true,
        outputReadiness: { ready: true }
      })
    ).toBe(true)
  })
})
