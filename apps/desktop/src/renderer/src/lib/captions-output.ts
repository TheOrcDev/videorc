import type { OverlayItemLayout } from '@/lib/backend'
import type { CaptionBurnTarget } from '@/lib/capture'

// Captions keep `burnTarget` on the wire for one release (plan 164, D14): it
// is DERIVED from the two overlay switches on the captions item, so the Rust
// caption path and every renderer caller (session params, the target plan,
// preflight, the plan 090 block) keep their shape. The switches live in the
// Scene inspector; the Captions panel only points there.

/** `stream` = on/off, `recording` = off/on, `both` = on/on, `off` = off/off. */
export function burnTargetFromOverlaySwitches(
  switches: Pick<OverlayItemLayout, 'showOnStream' | 'showInRecording'>
): CaptionBurnTarget {
  if (switches.showOnStream && switches.showInRecording) return 'both'
  if (switches.showOnStream) return 'stream'
  if (switches.showInRecording) return 'recording'
  return 'off'
}

export function overlaySwitchesFromBurnTarget(
  burnTarget: CaptionBurnTarget
): Pick<OverlayItemLayout, 'showOnStream' | 'showInRecording'> {
  return {
    showOnStream: burnTarget === 'stream' || burnTarget === 'both',
    showInRecording: burnTarget === 'recording' || burnTarget === 'both'
  }
}

/**
 * The one-time seed after the update: a streamer whose saved `burnTarget` was
 * on meets a fresh layout whose captions switches are both off (the shipped
 * default). The saved target wins once, so nobody loses their caption burn
 * setting; after that the layout drives the target. Returns the seeded
 * captions item, or null when nothing needs seeding.
 */
export function seedCaptionsSwitchesFromBurnTarget(
  captions: OverlayItemLayout,
  burnTarget: CaptionBurnTarget
): OverlayItemLayout | null {
  if (burnTarget === 'off' || captions.showOnStream || captions.showInRecording) return null
  return { ...captions, ...overlaySwitchesFromBurnTarget(burnTarget) }
}
