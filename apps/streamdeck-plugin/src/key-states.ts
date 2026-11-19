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

/** The Stream Manager Screen key's settings (plan 230): two display ids. */
export interface StreamManagerScreenKeySettings {
  presentingScreen?: string
  monitorScreen?: string
}

function shownOn(state: State, screenId: string | undefined): boolean {
  const place = state?.streamManager
  return Boolean(
    screenId && state?.windows?.comments && place?.visible && place.screenId === screenId
  )
}

/** On (state 1) while the window shows on the Presenting screen and Hide
 * from stream is off: viewers see it. */
export function streamManagerScreenKeyLit(
  state: State,
  settings: StreamManagerScreenKeySettings
): boolean {
  return shownOn(state, settings.presentingScreen) && !state?.streamManager?.hiddenFromStream
}

/** Null (the key alerts) until two different screens are picked. */
export function streamManagerScreenKeyIntent(
  settings: StreamManagerScreenKeySettings
): Record<string, unknown> | null {
  const { presentingScreen, monitorScreen } = settings
  if (!presentingScreen || !monitorScreen || presentingScreen === monitorScreen) return null
  return { kind: 'streamManagerScreenSwap', presentingScreen, monitorScreen }
}

/** A hold: to the front where it is, or closed when it has the focus. */
export function streamManagerFrontOrCloseIntent(): Record<string, unknown> {
  return { kind: 'streamManagerFrontOrClose' }
}

/** What keeps the key from working with this Videorc, read from describe:
 * `update` for an app older than the key (its describe has no screen list,
 * and it knows neither intent), `wayland` where a tap cannot move a window
 * (a hold still works). Null while describe has not arrived yet. */
export type StreamManagerScreenKeyBlock = 'update' | 'wayland' | null

export function streamManagerScreenKeyBlock(
  describe: Pick<RemoteDescribe, 'screens' | 'screenMoves'> | null | undefined
): StreamManagerScreenKeyBlock {
  if (!describe) return null
  if (!Array.isArray(describe.screens)) return 'update'
  return describe.screenMoves === 'wayland' ? 'wayland' : null
}

/** Whether a tap (`tap`) or a hold (`hold`) may send its intent: blocked
 * keys stay quiet on press, since the title already says why. */
export function streamManagerScreenKeyAllows(
  block: StreamManagerScreenKeyBlock,
  gesture: 'tap' | 'hold'
): boolean {
  if (block === 'update') return false
  return !(block === 'wayland' && gesture === 'tap')
}

/** The property inspector's note for a blocked key, else null. */
export function streamManagerScreenKeyNotice(block: StreamManagerScreenKeyBlock): string | null {
  if (block === 'update') {
    return 'This key needs a newer Videorc. Update Videorc, then pick your two screens here.'
  }
  if (block === 'wayland') {
    return (
      "Wayland doesn't let Videorc move windows, so a tap does nothing in this session. " +
      'Hold the key to bring the Stream Manager to the front, or to close it.'
    )
  }
  return null
}

/** `describe`: Videorc's describe, once it arrived; its `screens` are the
 * connected screens. */
export function streamManagerScreenKeyTitle(
  state: State,
  connected: boolean,
  settings: StreamManagerScreenKeySettings,
  describe?: Pick<RemoteDescribe, 'screens' | 'screenMoves'> | null
): string {
  if (!connected) return 'Videorc\noffline'
  const block = streamManagerScreenKeyBlock(describe)
  if (block === 'update') return 'Update\nVideorc'
  if (block === 'wayland') return 'Not on\nWayland'
  const screens = describe?.screens
  const picked = [settings.presentingScreen, settings.monitorScreen]
  const isConnected = (id: string | undefined) =>
    Boolean(id) && (!screens || screens.some((screen) => screen.id === id))
  if (!picked.every(isConnected) || picked[0] === picked[1]) return 'Pick\nscreens'
  if (shownOn(state, settings.presentingScreen)) {
    return state?.streamManager?.hiddenFromStream ? 'Hidden' : 'Present'
  }
  if (shownOn(state, settings.monitorScreen)) return 'Monitor'
  const place = state?.streamManager
  return state?.windows?.comments && place?.visible && place.screenId ? 'Away' : 'Closed'
}

/**
 * A key saved before scenes (a `layoutPreset` and no scene) still asks for
 * its layout: Videorc puts on the first scene that uses it (plan 231 D14). So
 * the key names that layout, as it reads in Videorc, never the scene on
 * stream. Two lines fit a key.
 */
const LEGACY_LAYOUT_KEY_TITLES: Readonly<Record<string, string>> = {
  'screen-camera': 'Screen +\ncamera',
  'screen-only': 'Screen\nonly',
  'camera-only': 'Camera\nonly',
  'side-by-side': 'Side by\nside',
  'vertical-camera-top': 'Camera\ntop',
  'vertical-camera-bottom': 'Camera\nbottom',
  'vertical-split': 'Split',
  'vertical-screen-camera': 'Screen +\ncamera',
  'vertical-screen-only': 'Screen\nonly',
  'vertical-camera-only': 'Camera\nonly'
}

/**
 * The Scene key's title: its scene's name (with ON while on stream) once one
 * is chosen; before that, an old key's layout, else "Scene".
 */
export function sceneActionTitle(
  state: State,
  settings: { sceneId?: string; layoutPreset?: string },
  connected: boolean
): string {
  if (!connected) return 'Videorc\noffline'
  if (settings.sceneId) {
    const scene = state?.savedScenes?.find((entry) => entry.id === settings.sceneId)
    if (!scene) return 'Scene'
    return state?.activeSavedSceneId === scene.id ? `${scene.name}\nON` : scene.name
  }
  return (settings.layoutPreset && LEGACY_LAYOUT_KEY_TITLES[settings.layoutPreset]) || 'Scene'
}

/** Both Scene actions read the ordered scene list. Old keys keep their wire request. */
export function sceneActionIntent(settings: {
  sceneId?: string
  layoutPreset?: string
}): Record<string, unknown> | null {
  return settings.sceneId
    ? { kind: 'sceneApply', sceneId: settings.sceneId }
    : settings.layoutPreset
      ? { kind: 'sceneApply', layoutPreset: settings.layoutPreset }
      : null
}

export function sceneActionOptions(state: State): { value: string; label: string }[] {
  return (state?.savedScenes ?? []).map(({ id, name }) => ({ value: id, label: name }))
}
