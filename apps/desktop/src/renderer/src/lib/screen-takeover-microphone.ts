export const SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY = 'videorc.screenTakeoverMuteOwnership.v1'

export type ScreenTakeoverMuteOwnership = Readonly<{
  priorMicrophoneMuted: boolean
}>

export type ScreenTakeoverMicrophoneTransition = Readonly<{
  microphoneMuted: boolean
  ownership: ScreenTakeoverMuteOwnership | null
}>

/**
 * The takeover owns only the mute it introduced. Existing ownership survives a
 * reconnect/reload, while clearing restores an originally-live microphone
 * without undoing a manual unmute made while the takeover was active.
 */
export function screenTakeoverMicrophoneTransition(input: {
  active: boolean
  microphoneMuted: boolean
  ownership: ScreenTakeoverMuteOwnership | null
}): ScreenTakeoverMicrophoneTransition {
  if (input.active) {
    return input.ownership
      ? { microphoneMuted: input.microphoneMuted, ownership: input.ownership }
      : {
          microphoneMuted: true,
          ownership: { priorMicrophoneMuted: input.microphoneMuted }
        }
  }

  if (!input.ownership) {
    return { microphoneMuted: input.microphoneMuted, ownership: null }
  }
  return {
    microphoneMuted: input.ownership.priorMicrophoneMuted ? input.microphoneMuted : false,
    ownership: null
  }
}

export function loadScreenTakeoverMuteOwnership(
  storage: Pick<Storage, 'getItem'> = localStorage
): ScreenTakeoverMuteOwnership | null {
  try {
    const raw = storage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return parsed &&
      typeof parsed === 'object' &&
      'priorMicrophoneMuted' in parsed &&
      typeof parsed.priorMicrophoneMuted === 'boolean'
      ? { priorMicrophoneMuted: parsed.priorMicrophoneMuted }
      : null
  } catch {
    return null
  }
}

export function persistScreenTakeoverMuteOwnership(
  ownership: ScreenTakeoverMuteOwnership | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  try {
    if (ownership) {
      storage.setItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY, JSON.stringify(ownership))
    } else {
      storage.removeItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)
    }
  } catch {
    // Storage can be unavailable in hardened/test renderer contexts. The ref
    // still preserves ownership for this renderer lifetime.
  }
}
