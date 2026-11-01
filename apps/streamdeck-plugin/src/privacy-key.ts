export function privacyKeyTitle(hidden: boolean): string {
  return hidden ? 'Screen hidden' : 'Hide screen'
}
export function privacyKeyIntent(): { kind: 'screenHideToggle' } {
  return { kind: 'screenHideToggle' }
}
