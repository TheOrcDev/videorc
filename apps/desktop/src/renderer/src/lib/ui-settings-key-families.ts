// Where every key the previous release kept in the window's web storage
// lives now (plan 220 S1.4b; the doc is docs/rust-ui/ui-settings.md).
//
// Product state moved to the backend's UI settings store: the families read
// and write it through `uiSettingsStorage()` under the same key and in the
// same string shape, and the S1.4a migration copied each value from a
// previous-release profile verbatim. What stays in web storage is a short,
// named list of per-device conveniences (a remembered tab, a collapsed
// section, an unsaved draft, a developer toggle) plus the store's own
// journal and the theme's pre-paint copy. `ui-settings-key-families.test.ts`
// fails when a renderer file touches web storage outside this list, and
// `ui-settings-migration.test.ts` proves every moved key arrives intact.

/** A key the families name exactly, or a family with an id after the prefix. */
export interface UiSettingsKeyName {
  key: string
  /** True when the key is a prefix and each id after it is its own key. */
  prefix?: boolean
}

/** The product state the backend holds (S1.4b), each with the family that reads it. */
export const UI_SETTINGS_MOVED_KEYS: readonly (UiSettingsKeyName & { family: string })[] = [
  { key: 'videorc.settings', family: 'lib/capture.ts STORAGE_KEYS.settings (use-studio)' },
  { key: 'videorc.captureConfig', family: 'lib/capture.ts loadCaptureConfig (use-studio)' },
  { key: 'videorc.onboardingComplete', family: 'lib/first-run.ts' },
  { key: 'videorc.firstRun', family: 'lib/first-run.ts' },
  { key: 'videorc.theme', family: 'App.tsx ThemeStoreSync (next-themes keeps a pre-paint copy)' },
  { key: 'videorc.backgroundAssets', family: 'hooks/use-background-assets.tsx' },
  { key: 'videorc.outputChosenByUser', family: 'hooks/use-studio.tsx' },
  { key: 'videorc.scene-presets.v1', family: 'lib/scenes-migration.ts' },
  { key: 'videorc.scenes.v2', family: 'hooks/use-scenes.ts' },
  { key: 'videorc.working-scene.v1', family: 'hooks/use-studio.tsx' },
  { key: 'videorc.scene-window-apps.v1', family: 'hooks/use-studio.tsx' },
  { key: 'videorc.aiConsent', family: 'hooks/use-studio.tsx' },
  {
    key: 'videorc.buddyAutoChatConsent',
    family: 'components/stream-manager/buddy-chat-controls.tsx'
  },
  { key: 'videorc.cleanCutAuto', family: 'hooks/use-clean-cut-auto.ts, lib/clean-cut-auto.ts' },
  { key: 'videorc.cleanCutAttempted', family: 'lib/clean-cut-auto.ts' },
  { key: 'videorc.cleanCutAnnounced', family: 'lib/clean-cut-notify.ts' },
  { key: 'videorc.followSettings.v1', family: 'lib/follow-settings.ts' },
  { key: 'videorc.privacySettings.v1', family: 'lib/privacy-settings.ts' },
  { key: 'videorc.whatsNewLastSeenVersion', family: 'lib/whats-new.ts, lib/first-run.ts' },
  { key: 'videorc.buddyPetReviewMarks', family: 'lib/buddy-pet-review-marks.ts' },
  { key: 'videorc.buddyInvitationDismissed', family: 'lib/buddy-library-view.ts' },
  { key: 'videorc.buddyWornPack:', prefix: true, family: 'lib/buddy-worn-pack.ts' },
  { key: 'videorc.cohostSensitivity', family: 'hooks/use-cohost-sensitivity.ts' },
  { key: 'videorc.cohostNudgeDismissed', family: 'comments/main.tsx' },
  { key: 'videorc.orcleListenPromptDismissed', family: 'lib/cohost-view.ts' },
  { key: 'videorc.streamManager.statsBar', family: 'lib/stream-manager-stats-layout.ts' },
  {
    key: 'videorc.screenTakeoverMuteOwnership.v1',
    family: 'lib/screen-takeover-microphone.ts'
  }
]

/** A renderer file allowed to touch web storage, and why. */
export interface LocalStorageAllowance {
  /** From `apps/desktop/src/renderer`. */
  file: string
  /** The keys it reads or writes there. */
  keys: readonly UiSettingsKeyName[]
  /** How many times the file names web storage (code and comments), so a new use fails the guard. */
  mentions: number
  why: string
}

/** The documented exceptions: nothing else in the renderer touches web storage. */
export const LOCAL_STORAGE_ALLOWLIST: readonly LocalStorageAllowance[] = [
  {
    file: 'src/lib/settings-tabs.ts',
    keys: [{ key: 'videorc.settingsTab' }],
    mentions: 2,
    why: 'Convenience: the Settings tab used last on this device.'
  },
  {
    file: 'src/lib/buddy-tabs.ts',
    keys: [{ key: 'videorc.orcleTab' }],
    mentions: 2,
    why: "Convenience: the Buddy page's tab used last on this device."
  },
  {
    file: 'src/lib/livestream-tabs.ts',
    keys: [{ key: 'videorc.livestreamView' }],
    mentions: 2,
    why: "Convenience: the Livestream page's view (Setup or Upcoming) used last on this device."
  },
  {
    file: 'src/lib/avatar-tabs.ts',
    keys: [{ key: 'videorc.avatarTab' }],
    mentions: 2,
    why: "Convenience: the Avatar page's tab used last on this device."
  },
  {
    file: 'src/components/sources/source-item.tsx',
    keys: [{ key: 'videorc.sources.more.', prefix: true }],
    mentions: 3,
    why: "Convenience: whether a source row's More section is open."
  },
  {
    file: 'src/lib/clean-cut-drafts.ts',
    keys: [{ key: 'videorc.cleanCutDrafts' }],
    mentions: 2,
    why: 'Convenience: unsaved Clean cut edits, kept per job on this device until Save or Discard (plan 174 E-5).'
  },
  {
    file: 'src/main.tsx',
    keys: [{ key: 'videorc.reactPerfTrack' }],
    mentions: 2,
    why: "Developer toggle (dev builds only), read at module load before the store hydrates: keep React's performance tracks."
  },
  {
    file: 'captions/main.tsx',
    keys: [{ key: 'videorc.reactPerfTrack' }],
    mentions: 1,
    why: 'Developer toggle (dev builds only), as in the main window.'
  },
  {
    file: 'comments/main.tsx',
    keys: [{ key: 'videorc.reactPerfTrack' }],
    mentions: 1,
    why: 'Developer toggle (dev builds only), as in the main window.'
  },
  {
    file: 'theme-bootstrap.js',
    keys: [{ key: 'videorc.theme' }],
    mentions: 1,
    why: "The theme's pre-paint copy: read before any script can reach the engine so frame one has the right palette. next-themes writes it; the store holds the truth (App.tsx ThemeStoreSync)."
  },
  {
    file: 'src/lib/ui-settings-store.ts',
    keys: [
      { key: 'videorc.', prefix: true },
      { key: 'videorc.uiSettings.journal.v1:', prefix: true }
    ],
    mentions: 10,
    why: 'The store itself: the one-time migration source and the per-window journal of writes the engine has not confirmed.'
  },
  {
    file: 'src/lib/ui-settings-window.ts',
    keys: [{ key: 'videorc.uiSettings.journal.v1:', prefix: true }],
    mentions: 5,
    why: "Hands the window's web storage to the store (the migration source and the journal)."
  }
]
