export function recordKeyLit(state) {
    return Boolean(state?.sessionActive && state.recordEnabled);
}
export function streamKeyLit(state) {
    return Boolean(state?.sessionActive && state.streamEnabled);
}
export function recordKeyIntent(state) {
    return { kind: recordKeyLit(state) ? 'recordStop' : 'recordStart' };
}
export function streamKeyIntent(state) {
    return { kind: streamKeyLit(state) ? 'streamStop' : 'streamStart' };
}
export function micKeyLit(state) {
    return state?.micMuted === false;
}
export function systemAudioKeyLit(state) {
    return Boolean(state?.systemAudioAvailable && state.systemAudioOn);
}
export function layoutKeyLit(state, layoutPreset) {
    return Boolean(layoutPreset) && state?.layoutPreset === layoutPreset;
}
export function takeoverKeyLit(state, assetId) {
    return Boolean(assetId) && state?.activeTakeoverId === assetId;
}
export function takeoverKeyIntent(state, assetId) {
    if (state?.activeTakeoverId && (!assetId || state.activeTakeoverId === assetId)) {
        return { kind: 'takeoverHide' };
    }
    return assetId ? { kind: 'takeoverShow', assetId } : null;
}
export function bannerKeyLit(describe, bannerId) {
    return Boolean(describe?.banners?.find((banner) => banner.id === bannerId)?.shown);
}
export function soundKeyLit(describe, soundId) {
    return Boolean(describe?.sounds?.find((sound) => sound.id === soundId)?.playing);
}
export function buddyKeyLit(state) {
    return state?.buddyLive === true;
}
export function buddyKeyIntent() {
    return { kind: 'buddyLiveToggle' };
}
function shownOn(state, screenId) {
    const place = state?.streamManager;
    return Boolean(screenId && state?.windows?.comments && place?.visible && place.screenId === screenId);
}
/** On (state 1) while the window shows on the Presenting screen and Hide
 * from stream is off: viewers see it. */
export function streamManagerScreenKeyLit(state, settings) {
    return shownOn(state, settings.presentingScreen) && !state?.streamManager?.hiddenFromStream;
}
/** Null (the key alerts) until two different screens are picked. */
export function streamManagerScreenKeyIntent(settings) {
    const { presentingScreen, monitorScreen } = settings;
    if (!presentingScreen || !monitorScreen || presentingScreen === monitorScreen)
        return null;
    return { kind: 'streamManagerScreenSwap', presentingScreen, monitorScreen };
}
/** A hold: to the front where it is, or closed when it has the focus. */
export function streamManagerFrontOrCloseIntent() {
    return { kind: 'streamManagerFrontOrClose' };
}
/** `screens`: the connected screens from describe, once Videorc sent them. */
export function streamManagerScreenKeyTitle(state, connected, settings, screens) {
    if (!connected)
        return 'Videorc\noffline';
    const picked = [settings.presentingScreen, settings.monitorScreen];
    const isConnected = (id) => Boolean(id) && (!screens || screens.some((screen) => screen.id === id));
    if (!picked.every(isConnected) || picked[0] === picked[1])
        return 'Pick\nscreens';
    if (shownOn(state, settings.presentingScreen)) {
        return state?.streamManager?.hiddenFromStream ? 'Hidden' : 'Present';
    }
    if (shownOn(state, settings.monitorScreen))
        return 'Monitor';
    const place = state?.streamManager;
    return state?.windows?.comments && place?.visible && place.screenId ? 'Away' : 'Closed';
}
