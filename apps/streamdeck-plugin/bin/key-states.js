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
