# Settings screen implementation

Phase 3 macOS composition lives in `apps/videorc/src/screens/settings/`.
It uses `videorc-app-core::settings_page` and the published GPUI kit. It
changes no Electron settings or backend APIs.

The screen opens from the sidebar, the Settings menu and its binding;
the Shortcuts binding and About menu select their named tabs. The five tabs
remember the last selection in `ui-local.json`, refreshing on activation.
Theme changes apply to the native window appearance and the shell's tokens.
The other General preferences use Studio's existing settings journal;
chat emotes and usage stats use their backend APIs. Permissions use the
app's TCC, grant watcher and deferred backend restart services.

Remote reads pushed statuses. Switches wait for the backend, token rotation
and disabling with paired phones ask first, and repeated submissions are
held while a request runs. The pairing token is masked except when copied
explicitly. Existing phones can be renamed or revoked; existing agents can
be revoked and their activity filtered. No tokens are logged or persisted
by this screen. Reads are fenced against writes, disconnects and newer
pushed values. Activity events do not trigger a full-page polling loop.

## Parity evidence

No parity boxes are ticked by this implementation. `parity.md` defines a
pass as visual checks in three appearances, keyboard and screen-reader
checks, and green GPUI smokes. The owner's order for this phase forbids
local builds, tests and app runs until the final build on main. Rust format
checking and source inspection cannot prove those requirements.

Implementation coverage to exercise in that build:

- P1378–P1388: Settings navigation, tabs, appearance and chat preferences
  (P1383 is Windows-only). The stored Retro LCD, Studio chat and Stream
  Manager preferences still need their consuming screens wired.
- P1395–P1400: usage stats and permission controls, including failures and
  the environment-disabled usage setting.
- P1407–P1412: remote controls, masked copy, confirmation and phone status.
- P1417–P1419, P1422–P1423: existing device management, Agents switch and
  filtered activity. Phone actions are currently direct buttons rather
  than the renderer's More menu.
- P1427–P1428: About links, development version and release track.
- P1495: native Settings menu entry.

## Remaining work

| Rows                       | Remaining work and dependency                                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1381, P1387–P1388         | The preferences save, but the Studio's LCD/chat and Stream Manager auto-open consumers are separate screen slices.                                                                                                                                                                |
| P1382, P1390, P1397, P1426 | Scene, first-run setup, account and the linked pages need their screen routes. Unavailable actions are disabled.                                                                                                                                                                  |
| P1389                      | This row predates Electron's removal of Quiet while recording or live (#1909). It is not recreated. Reconcile it when regenerating parity.                                                                                                                                        |
| P1391–P1394                | OBS discovery, selection, report and apply are wired through admin RPCs and Studio. Image backgrounds are explicitly skipped until core supplies its Assets registry adapter; no image is falsely promised or copied.                                                             |
| P1402–P1406, P1537         | Global/scene shortcut recording and OS registration are wired for Record, microphone, System audio, clips and scene switching. Go Live and Hide screen remain disabled until their native confirmation/privacy controllers land. The app reference lists installed bindings only. |
| P1413–P1416                | Phone pairing needs its single-use QR/link dialog, reveal gate, network selection, expiry and cancellation lifecycle. The pairing trigger remains disabled.                                                                                                                       |
| P1420–P1421, P1424–P1425   | Bind failures render, but Connect is disabled until the native bridge-path resolver/installer and Connect/Add-to-app flow land. No agent token is minted for a missing bridge.                                                                                                    |
| P1429, P1435               | The manual What's new dialog fetches published notes with a timeout and body limit, filters by platform and links to full notes. Automatic post-update presentation waits for packaged version/updater wiring.                                                                    |
| P1430–P1431, P1555         | The native updater is Phase 5. About uses core's explicit unsupported-build message and downloads link.                                                                                                                                                                           |
| All Remote actions         | Listener settings and device management work through the backend; end-to-end remote/agent Studio actions also require the app's intent executor, outside this screen.                                                                                                             |
| All rows                   | Runtime/visual/accessibility evidence, native Increase Contrast wiring, and Windows/Linux passes remain outstanding.                                                                                                                                                              |

## Settings follow-ups

The setup replay uses core's step order and goal-dependent navigation, with
permission actions, saved-scene selection, microphone selection and System
audio. It never writes first-run completion markers or starts a performance
capture. The full first-run screen still owns the preview/background chooser,
live sound-level calibration and destination sign-in; the replay is not a
claim of their visual parity. Its destination link becomes available with the
Destinations route.

Account changes are read and pushed from the backend. A fully signed-in
account opens the same account webpage as Electron. Signed-out Sign in stays
disabled: `account/mod.rs` only exposes entitlements, and the deep-link service
has no account PKCE/state transaction owner installed. A plain web login is
not a substitute for desktop sign-in. Account secrets never enter the screen.
