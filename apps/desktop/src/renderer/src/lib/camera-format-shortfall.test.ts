import { describe, expect, it } from 'vitest'

import type { DiagnosticStats } from '@/lib/backend'
import { cameraFormatShortfall, cameraFormatShortfallMessage } from '@/lib/camera-format-shortfall'

// Plan 024 S5: the Cam Link 4K case from the support bundle — a single 4K@25
// format that can't satisfy a 1080p30 request, silently falling back.
function stats(overrides: Partial<DiagnosticStats>): DiagnosticStats {
  return {
    previewCameraState: 'live',
    previewCameraRequestedWidth: 1920,
    previewCameraRequestedHeight: 1080,
    previewCameraSelectedFormatWidth: 3840,
    previewCameraSelectedFormatHeight: 2160,
    previewCameraSelectedFormatMaxFps: 25,
    previewCameraStatusMessage:
      'Requested 1280x720@30 was not available; selected native 3840x2160 at 25-25 fps.',
    previewCameraCapabilityFormats: [{ width: 3840, height: 2160, minFps: 25, maxFps: 25 }],
    ...overrides
  } as DiagnosticStats
}

describe('cameraFormatShortfall', () => {
  it('flags the Cam Link single-format 4K@25-vs-30 shortfall', () => {
    const shortfall = cameraFormatShortfall(stats({}))
    expect(shortfall).toMatchObject({
      fpsUnmet: true,
      resolutionUnmet: false,
      requestedFps: 30,
      selectedMaxFps: 25,
      singleFormat: true
    })
    expect(cameraFormatShortfallMessage(shortfall!)).toContain('only offers 3840 × 2160 at 25 fps')
    expect(cameraFormatShortfallMessage(shortfall!)).toContain("can't reach 30 fps")
  })

  it('returns null when the selected format meets the request', () => {
    expect(
      cameraFormatShortfall(
        stats({
          previewCameraSelectedFormatWidth: 1920,
          previewCameraSelectedFormatHeight: 1080,
          previewCameraSelectedFormatMaxFps: 60,
          previewCameraStatusMessage:
            'Requested 1920x1080@30; selected native 1920x1080 at 60 fps.',
          previewCameraCapabilityFormats: [{ width: 1920, height: 1080, minFps: 30, maxFps: 60 }]
        })
      )
    ).toBeNull()
  })

  it('does not flag a larger native format that will be downscaled (resolution met)', () => {
    // 4K native, but requested 1080p AND the camera can hit 30fps → fine.
    expect(
      cameraFormatShortfall(
        stats({
          previewCameraSelectedFormatMaxFps: 30,
          previewCameraStatusMessage: 'Requested 1920x1080@30; selected native 3840x2160 at 30 fps.'
        })
      )
    ).toBeNull()
  })

  it('flags a resolution shortfall when the only format is smaller than requested', () => {
    const shortfall = cameraFormatShortfall(
      stats({
        previewCameraRequestedWidth: 1920,
        previewCameraRequestedHeight: 1080,
        previewCameraSelectedFormatWidth: 640,
        previewCameraSelectedFormatHeight: 480,
        previewCameraSelectedFormatMaxFps: 30,
        previewCameraStatusMessage: 'Requested 1920x1080@30; selected native 640x480 at 30 fps.'
      })
    )
    expect(shortfall).toMatchObject({ resolutionUnmet: true, fpsUnmet: false })
  })

  it('returns null without a live camera or incomplete diagnostics', () => {
    expect(cameraFormatShortfall(stats({ previewCameraState: 'starting' }))).toBeNull()
    expect(
      cameraFormatShortfall(stats({ previewCameraSelectedFormatMaxFps: undefined }))
    ).toBeNull()
    // No parseable "Requested …@fps" → no ask to compare against.
    expect(cameraFormatShortfall(stats({ previewCameraStatusMessage: 'live' }))).toBeNull()
  })

  it('tolerates a 1fps rounding gap (25 vs 25 requested, or 29.97)', () => {
    expect(
      cameraFormatShortfall(
        stats({
          previewCameraSelectedFormatMaxFps: 30,
          previewCameraStatusMessage:
            'Requested 1920x1080@29.97; selected native 3840x2160 at 30 fps.'
        })
      )
    ).toBeNull()
  })
})
