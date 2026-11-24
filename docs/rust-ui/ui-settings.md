# UI settings: where the renderer's product state lives

Plan 260 S1.4 (from plan 220's S1.4a, the store and the migration, and S1.4b,
every key family reads it). The GPUI app reads the same store.

## The store

The backend keeps one `app_settings` row per key under `ui:`, read with
`ui.settings.get`, written with `ui.settings.set`, and announced to every
window as `ui.settings.changed`. Each window hydrates a synchronous cache
before its first render (`lib/ui-settings-store.ts`, `lib/ui-settings-window.ts`).
The first hydrate of a previous-release profile copies every `videorc.*` web
storage key verbatim (S1.4a); web storage keeps its copy so a rollback still
works.

Key families read and write through `uiSettingsStorage()`
(`lib/ui-settings-storage.ts`): the `Storage` slice they were written against,
over the store. Keys keep their names and values their string shapes. A write
the engine would refuse (past the limits) throws at once, like full web
storage did, so each family's "could not save" path still runs.

## Moved to the store (S1.4b)

The list with each key's family is `UI_SETTINGS_MOVED_KEYS` in
`apps/desktop/src/renderer/src/lib/ui-settings-key-families.ts`.

| Area                   | Keys                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio                 | `videorc.settings`, `videorc.captureConfig`, `videorc.scenes.v2`, `videorc.scene-presets.v1` (read once to migrate), `videorc.working-scene.v1`, `videorc.scene-window-apps.v1`, `videorc.backgroundAssets`, `videorc.outputChosenByUser`, `videorc.screenTakeoverMuteOwnership.v1` |
| First run and app      | `videorc.firstRun`, `videorc.onboardingComplete`, `videorc.whatsNewLastSeenVersion`, `videorc.theme`                                                                                                                                    |
| Consents and Clean cut | `videorc.aiConsent`, `videorc.buddyAutoChatConsent`, `videorc.cleanCutAuto`, `videorc.cleanCutAttempted`, `videorc.cleanCutAnnounced`                                                                                                   |
| Scenes and privacy     | `videorc.followSettings.v1`, `videorc.privacySettings.v1`                                                                                                                                                                               |
| Buddy                  | `videorc.buddyPetReviewMarks`, `videorc.buddyInvitationDismissed`, `videorc.buddyWornPack:<persona>`, `videorc.cohostSensitivity`, `videorc.cohostNudgeDismissed`, `videorc.orcleListenPromptDismissed`                                 |
| Stream Manager         | `videorc.streamManager.statsBar`                                                                                                                                                                                                        |

Cross-window updates that used to ride the `storage` event (the co-host
sensitivity, the Clean cut switch) now subscribe to the store.

The theme keeps a pre-paint copy: `theme-bootstrap.js` must paint frame one
before any script can reach the engine, so next-themes still writes its copy
under the same key. The store is the truth: on mount the store's value wins,
a toggle writes the store, and another window's change is applied
(`ThemeStoreSync` in `App.tsx`).

A window whose engine did not answer within the hydrate deadline renders
anyway, and its families read their defaults. Nothing it writes from them
reaches the store (the writes are refused and named in the console, so the
profile is never overwritten with defaults), and when the snapshot arrives
the window reloads once to read the real values. Meanwhile first-run setup
keeps its placeholder up (for up to another hydrate deadline, then it is
treated like missing storage: no setup, nothing written), and the
performance check treats the output as chosen by the user (it suggests,
never applies).

The main window reads the store over its own connection; `ui.settings.get`
always sends an object (the engine reads absent params as null and refused
them, so before S1.4b the main window never hydrated).

## Allowed to stay in web storage

`LOCAL_STORAGE_ALLOWLIST` in the same file, each with its reason and the exact
number of mentions in its file:

| Key                                      | File                                                 | Why                                               |
| ---------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `videorc.settingsTab`                    | `lib/settings-tabs.ts`                               | the Settings tab used last on this device         |
| `videorc.orcleTab`                       | `lib/buddy-tabs.ts`                                  | the Buddy page's tab used last                    |
| `videorc.livestreamView`                 | `lib/livestream-tabs.ts`                             | the Livestream page's view used last              |
| `videorc.avatarTab`                      | `lib/avatar-tabs.ts`                                 | the Avatar page's tab used last                   |
| `videorc.sources.more.<id>`              | `components/sources/source-item.tsx`                 | a source row's More section                       |
| `videorc.cleanCutDrafts`                 | `lib/clean-cut-drafts.ts`                            | unsaved Clean cut edits, per job on this device   |
| `videorc.reactPerfTrack`                 | `main.tsx`, `captions/main.tsx`, `comments/main.tsx` | a dev-build toggle read before the store hydrates |
| `videorc.theme` (copy)                   | `theme-bootstrap.js`                                 | the pre-paint copy above                          |
| `videorc.uiSettings.journal.v1:<window>` | the store                                            | writes the engine has not confirmed yet           |

The S1.4a migration also copied these conveniences into the store; those
copies are unused.

## Guards

- `lib/ui-settings-key-families.test.ts` fails when a renderer source names
  web storage outside the allowlist (or more often than it says), when a key
  the previous release could write is neither moved nor allowed, or when a
  moved family's file touches web storage.
- `lib/ui-settings-migration.test.ts` migrates the previous-release fixture
  (`protocol-fixtures/ui-settings-previous-release-profile.json`) and checks
  every moved family answers as it did from web storage.
- `scripts/lib/renderer-profile-seed.test.mjs` fails when a script touches a
  product key through web storage.

## Smokes and the live lab

Page code reaches the store through `window.__videorcUiSettings`
(`getItem`, `setItem`, `removeItem`, `keys`, `clear`, `flush`), installed in
every build because the live lab drives the packaged app. `seedUiSettingsJs`
and `reloadKeepingSeedJs` in `scripts/lib/renderer-profile-seed.mjs` wrap it.
A write lands in the window's journal synchronously, so a reload right after
it still finds the value. Setting `videorc.theme` in web storage and
dispatching a `storage` event still switches the theme live; a seed that
reloads writes the store too.
