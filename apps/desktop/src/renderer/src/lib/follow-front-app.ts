import { sceneForFrontApp, type SavedScene, type SceneOrientation } from './scene-presets'

/** Desktop application ids, including store/legacy variants. Keep exact ids;
 * Browser extension processes do not activate as foreground applications;
 * Safari companion apps below can have their own foreground windows.
 * Store variants verified through Apple search API (entity=macSoftware).
 * Sources: support.1password.com/deploy-1password/, diagnostics-privacy/;
 * help.enpass.io/business/latest/google-workspace/deploying-enpass-on-macos;
 * Homebrew/homebrew-cask Casks/{b/bitwarden,k/keeper-password-manager,
 * l/lastpass,p/proton-pass}.rb; keepassxreboot/keepassxc src/CMakeLists.txt.
 */
export const DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS: readonly string[] = [
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.agilebits.onepassword-osx',
  'com.agilebits.onepassword4',
  'com.bitwarden.desktop',
  'com.dashlane.dashlanephonefinal', // Current Mac App Store (Apple lookup 517914548).
  'com.dashlane.Dashlane',
  'com.dashlane.DashlaneAgent',
  'com.keepersecurity.passwordmanager',
  'com.callpod.keeper',
  'com.callpod.keepermac.lite',
  'com.lastpass.lastpassmacdesktop',
  'com.lastpass.LastPass',
  'com.lastpass.lastpassforsafari',
  'com.apple.Passwords',
  'com.apple.keychainaccess',
  'me.proton.pass.electron',
  'me.proton.pass',
  'me.proton.pass.catalyst',
  'org.keepassxc.keepassxc',
  'org.keepassx.keepassxc',
  'in.sinew.Enpass-Desktop',
  'in.sinew.Enpass-Desktop.App'
]

export type FrontApp = { bundleId: string; name: string; pid: number; frontWindowId?: string }
export type ScreenHideReason = 'you' | 'password-manager'
export type FollowFrontAppState = {
  front: FrontApp | null
  since: number
  manualHold: boolean
  hidden: boolean
  hideReason: ScreenHideReason | null
  issued: string | null
}
export type FollowFrontAppEvent =
  | ({ type: 'front-changed' } & FrontApp)
  | { type: 'tick'; now: number }
  | { type: 'manual-switch' }
  | { type: 'hide-changed'; hidden: boolean; reason: ScreenHideReason | null }
  | { type: 'settings-changed' }
export type FollowFrontAppContext = {
  now: number
  scenes: readonly SavedScene[]
  lastUsedAt: Readonly<Record<string, number>>
  followEnabled?: boolean
  passwordManagerHideEnabled?: boolean
  videorcBundleIds: readonly string[]
  /** Additions to defaults; [] means defaults. Removals take precedence. */
  passwordManagerBundleIds?: readonly string[]
  removedPasswordManagerBundleIds?: readonly string[]
  screenSource: 'display' | 'window' | 'app' | 'none'
  sessionState: 'idle' | 'starting' | 'recording' | 'streaming' | 'stopping' | 'failed'
  orientation: SceneOrientation
  currentSceneId: string | null
  currentWindowId?: string
}
export type FollowFrontAppAction =
  | { type: 'switch-scene'; sceneId: string }
  | { type: 'swap-window'; windowId: string }
  | { type: 'hide'; reason: 'password-manager' }
  | { type: 'show' }

export function initialFollowFrontAppState(): FollowFrontAppState {
  return { front: null, since: 0, manualHold: false, hidden: false, hideReason: null, issued: null }
}

/** Caller supplies monotonic milliseconds and feeds confirmed privacy changes
 * back through hide-changed. All automatic actions use the 400 ms settle
 * gate. Privacy works with Follow off and during a manual scene hold.
 * Orientation stays within the Studio's current orientation even while idle.
 */
export function reduceFollowFrontApp(
  previous: FollowFrontAppState,
  event: FollowFrontAppEvent,
  context: FollowFrontAppContext
): { state: FollowFrontAppState; actions: FollowFrontAppAction[] } {
  const state = { ...previous }
  const actions: FollowFrontAppAction[] = []
  const now = event.type === 'tick' ? event.now : context.now
  if (event.type === 'front-changed') {
    const changed =
      state.front?.bundleId.toLowerCase() !== event.bundleId.toLowerCase() ||
      state.front?.pid !== event.pid
    if (changed || state.front?.frontWindowId !== event.frontWindowId) {
      state.since = now
      state.issued = null
    }
    if (changed) state.manualHold = false
    state.front = {
      bundleId: event.bundleId,
      name: event.name,
      pid: event.pid,
      frontWindowId: event.frontWindowId
    }
  }
  if (event.type === 'manual-switch') {
    state.manualHold = true
    state.issued = null
  }
  if (event.type === 'hide-changed') {
    state.hidden = event.hidden
    state.hideReason = event.hidden ? event.reason : null
    return { state, actions }
  }
  const front = state.front
  if (!front || now - state.since < 400) return { state, actions }
  const bundleId = front.bundleId.toLowerCase()
  const passwordManagers = new Set(
    [...DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS, ...(context.passwordManagerBundleIds ?? [])].map(
      (id) => id.toLowerCase()
    )
  )
  for (const id of context.removedPasswordManagerBundleIds ?? [])
    passwordManagers.delete(id.toLowerCase())
  const shouldHide =
    context.passwordManagerHideEnabled !== false &&
    context.screenSource === 'display' &&
    passwordManagers.has(bundleId)
  if (shouldHide && !state.hidden) {
    actions.push({ type: 'hide', reason: 'password-manager' })
    state.hidden = true
    state.hideReason = 'password-manager'
  } else if (!shouldHide && state.hidden && state.hideReason === 'password-manager') {
    actions.push({ type: 'show' })
    state.hidden = false
    state.hideReason = null
  }
  if (
    context.followEnabled === false ||
    state.manualHold ||
    context.videorcBundleIds.some((id) => id.toLowerCase() === bundleId)
  )
    return { state, actions }
  // The observer/resolver supplies only eligible normal on-screen windows.
  if (!front.frontWindowId) return { state, actions }
  const scene = sceneForFrontApp(context.scenes, front, context.lastUsedAt, context.orientation)
  if (!scene) return { state, actions }
  const key = `${scene.id}:${front.frontWindowId}`
  if (state.issued === key) return { state, actions }
  if (context.currentSceneId !== scene.id) {
    actions.push({ type: 'switch-scene', sceneId: scene.id })
    state.issued = key
  } else if (front.frontWindowId !== context.currentWindowId) {
    actions.push({ type: 'swap-window', windowId: front.frontWindowId })
    state.issued = key
  }
  return { state, actions }
}
