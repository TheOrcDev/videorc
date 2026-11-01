export function privacyKeyTitle(hidden) {
    return hidden ? 'Screen hidden' : 'Hide screen';
}
export function privacyKeyIntent() {
    return { kind: 'screenHideToggle' };
}
