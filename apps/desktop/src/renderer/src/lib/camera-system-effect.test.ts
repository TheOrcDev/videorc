import { describe, expect, it } from 'vitest'

import type { CameraSystemEffect } from '@/lib/backend'
import { cameraSystemEffectLine } from './camera-system-effect'

const none: Omit<CameraSystemEffect, 'provider'> = {
  backgroundBlur: false,
  backgroundReplacement: false,
  studioLight: false,
  turnedOffByVideorc: false
}
const mac = (flags: Partial<CameraSystemEffect> = {}): CameraSystemEffect => ({
  provider: 'macos-video-effects',
  ...none,
  ...flags
})
const windows = (flags: Partial<CameraSystemEffect> = {}): CameraSystemEffect => ({
  provider: 'windows-studio-effects',
  ...none,
  ...flags
})

describe('cameraSystemEffectLine (plan 258 S4)', () => {
  it('says nothing without a system effect, or with none on', () => {
    expect(cameraSystemEffectLine(undefined)).toBeNull()
    expect(cameraSystemEffectLine(mac())).toBeNull()
    expect(cameraSystemEffectLine(windows())).toBeNull()
  })

  it("names macOS Portrait with the plan's copy", () => {
    expect(cameraSystemEffectLine(mac({ backgroundBlur: true }))).toBe(
      "macOS is blurring this camera (Video menu, Portrait). Turn it off there to use Videorc's background."
    )
  })

  it('names background replacement over Portrait, which it hides', () => {
    const line = cameraSystemEffectLine(mac({ backgroundBlur: true, backgroundReplacement: true }))
    expect(line).toContain('replacing')
    expect(line).toContain('(Video menu, Background)')
  })

  it('says nothing for Studio Light alone: it lights the face, not the room', () => {
    expect(cameraSystemEffectLine(mac({ studioLight: true }))).toBeNull()
  })

  it('names Windows Studio Effects blur and where to turn it off', () => {
    expect(cameraSystemEffectLine(windows({ backgroundBlur: true }))).toBe(
      "Windows Studio Effects is blurring this camera (Quick Settings, Studio effects). Turn it off there to use Videorc's background."
    )
  })

  it('says so when Videorc turned the Windows blur off for its own background', () => {
    expect(cameraSystemEffectLine(windows({ turnedOffByVideorc: true }))).toBe(
      "Windows Studio Effects blur is off while Videorc's background is on."
    )
  })
})
