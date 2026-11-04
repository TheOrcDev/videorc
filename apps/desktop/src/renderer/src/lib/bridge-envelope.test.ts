import { describe, expect, it } from 'vitest'

import { videoPresets } from './capture'
import { recordOnlyBridgeEnvelopeFits, windowsBridgeEnvelopeRefusal } from './bridge-envelope'

// Issue #1062: the words and the envelope mirror recording.rs
// (`windows_bridge_envelope_refusal`); its tests pin the same sentences.

type Video = Parameters<typeof recordOnlyBridgeEnvelopeFits>[0]

const refusal = (
  video: Video,
  { platform = 'win32', recordEnabled = true, streamEnabled = false } = {}
) => windowsBridgeEnvelopeRefusal({ platform, recordEnabled, streamEnabled, video })

describe('windowsBridgeEnvelopeRefusal', () => {
  it('refuses a 60 fps recording outside the bridge envelope with the choices inside it', () => {
    expect(refusal(videoPresets['record-4k60-experimental'])).toBe(
      "4K at 60 fps isn't supported on Windows yet. Choose 4K at 30 fps or 1440p at 60 fps."
    )
    // The advice keeps the requested rate: every rate up to 60 fits.
    expect(refusal({ width: 3840, height: 2160, fps: 48 })).toBe(
      "4K at 48 fps isn't supported on Windows yet. Choose 4K at 30 fps or 1440p at 48 fps."
    )
    // A portrait canvas is named by both sides, like formatVideoQuality.
    expect(refusal({ width: 2160, height: 3840, fps: 60 })).toBe(
      "2160 × 3840 at 60 fps isn't supported on Windows yet. Choose 2160 × 3840 at 30 fps or 1440 × 2560 at 60 fps."
    )
  })

  it('leaves every other computer and every request inside the envelope alone', () => {
    const fourKSixty = videoPresets['record-4k60-experimental']
    expect(refusal(fourKSixty, { platform: 'darwin' })).toBeNull()
    expect(refusal(fourKSixty, { platform: 'linux' })).toBeNull()
    expect(
      windowsBridgeEnvelopeRefusal({
        platform: undefined,
        recordEnabled: true,
        streamEnabled: false,
        video: fourKSixty
      })
    ).toBeNull()
    for (const preset of [
      'record-4k30',
      'tutorial-1440p30',
      'tutorial-1080p30',
      'stream-safe-1080p60',
      'vertical-1080x1920'
    ] as const) {
      expect(refusal(videoPresets[preset]), preset).toBeNull()
      expect(recordOnlyBridgeEnvelopeFits(videoPresets[preset]), preset).toBe(true)
    }
    expect(refusal({ width: 2560, height: 1440, fps: 60 })).toBeNull()
    expect(refusal({ width: 1440, height: 2560, fps: 60 })).toBeNull()
    expect(recordOnlyBridgeEnvelopeFits(fourKSixty)).toBe(false)
    expect(refusal(fourKSixty, { recordEnabled: false })).toBeNull()
  })

  it('never judges a livestream: the Go Live sheet shares or refuses the encode itself', () => {
    expect(refusal(videoPresets['record-4k60-experimental'], { streamEnabled: true })).toBeNull()
    expect(
      refusal(videoPresets['record-4k30'], { recordEnabled: false, streamEnabled: true })
    ).toBeNull()
  })
})
