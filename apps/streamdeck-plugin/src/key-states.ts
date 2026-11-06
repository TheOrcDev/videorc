import type { RemoteDescribe, RemoteState } from './videorc-client.js'

type State = RemoteState | null

export function recordKeyLit(state: State): boolean {
  return Boolean(state?.sessionActive && state.recordEnabled)
}

export function streamKeyLit(state: State): boolean {
  return Boolean(state?.sessionActive && state.streamEnabled)
}

export function recordKeyIntent(state: State): Record<string, unknown> {
  return { kind: recordKeyLit(state) ? 'recordStop' : 'recordStart' }
}

export function streamKeyIntent(state: State): Record<string, unknown> {
  return { kind: streamKeyLit(state) ? 'streamStop' : 'streamStart' }
}

export function micKeyLit(state: State): boolean {
  return state?.micMuted === false
}

export function systemAudioKeyLit(state: State): boolean {
  return Boolean(state?.systemAudioAvailable && state.systemAudioOn)
}

export function layoutKeyLit(state: State, layoutPreset: string | undefined): boolean {
  return Boolean(layoutPreset) && state?.layoutPreset === layoutPreset
}

export function takeoverKeyLit(state: State, assetId: string | undefined): boolean {
  return Boolean(assetId) && state?.activeTakeoverId === assetId
}

export function takeoverKeyIntent(
  state: State,
  assetId: string | undefined
): Record<string, unknown> | null {
  if (state?.activeTakeoverId && (!assetId || state.activeTakeoverId === assetId)) {
    return { kind: 'takeoverHide' }
  }
  return assetId ? { kind: 'takeoverShow', assetId } : null
}

export function bannerKeyLit(
  describe: RemoteDescribe | null,
  bannerId: string | undefined
): boolean {
  return Boolean(describe?.banners?.find((banner) => banner.id === bannerId)?.shown)
}

export function soundKeyLit(describe: RemoteDescribe | null, soundId: string | undefined): boolean {
  return Boolean(describe?.sounds?.find((sound) => sound.id === soundId)?.playing)
}

export function buddyKeyLit(state: State): boolean {
  return state?.buddyLive === true
}

export function buddyKeyIntent(): Record<string, unknown> {
  return { kind: 'buddyLiveToggle' }
}
