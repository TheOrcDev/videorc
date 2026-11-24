# Library on GPUI

The Library page uses `videorc_app_core::library` for pagination, event
reconciliation, finalization, selection, row copy and file-action gates.
`apps/videorc/src/screens/library` owns the window's controls. The shared kit
supplies every control, including Checkbox (app #1967).

Local: filter, sort, search, import, selection and keyboard selection,
rename, duplicate, quality assessment/repair/restore, MP4 export, Finder,
external playback and a two-phase Trash confirmation. Import authorizes
both the chosen input and the configured output folder. Trash takes only
paths resolved from a backend deletion operation, refuses non-files, and
completes the receipt against the same backend bootstrap. A partial failure
keeps the recording in Library. Poster bytes never expose the loopback token.

Cloud: account-gated list states, refresh, downloads, cancellation, progress,
local-session navigation and totals. Account changes and reconnects invalidate
in-flight reads. Library completion events go through the notices store,
which decides whether anything interrupts; no direct background toast.

## Build-pass checklist (not visually verified)

Implemented: P1319–P1329, P1331–P1332, P1334–P1339, P1343,
P1345, P1347–P1351; the list/refresh portions of P1364, P1365–P1366,
the download/cancel/local-navigation portions of P1368, and P1370.
No parity checkboxes are changed by this implementation.

Still incomplete:

- P1330/P1333: the dense shared rows expose metadata but are not the full
  six-column accessible grid; Clean cut controller/entitlements and complete
  badge tooltips remain. Backend mutations still enforce active job locks.
- P1340/P1341/P1344/P1346: Sidekick report/Clean cut, noise cleanup initiation
  and historical Stream Manager routing need their owning GPUI controllers.
  Uninstalled menu actions are disabled with a reason.
- P1342/P1352–P1361 are implemented by the player PR below; their parity
  checkboxes remain for the visual build pass.
- P1362/P1363/P1367/P1369/P1371–P1374: cloud markers, grid keyboard navigation,
  row menus, web/download-file reveal, separate files and local archive controls
  still need their dedicated views/controllers wired into this window.
- Cloud rows refresh on entry/press; automatic post-stop polling is not wired.
- Storage's free-space suffix and large-library virtualization remain.
- Completion notification file buttons remain gated until their route is
  installed; Open Library now reaches and focuses the page.

Only `cargo fmt --check --all` is run under the owner's build-once order.
Compilation, real file operations, visual parity and playback verification
belong to the final main build pass.

## Native player and local markers

The Markers dialog now hosts the separate `videorc-preview::playback`
CAMetalLayer presenter in a GPUI NativeView. The normal Play button, row
double-click and Play menu still open the system player, matching Electron;
Markers opens the in-app player. Playback never borrows Studio's surface.

Implemented for the build pass: P1342 and P1352–P1361. Play/Pause, mute,
the scrubber and slot-focused Space/K/J/L/arrow/Home/End/M keys use app-core's
player rules. Child controls keep their own key handling. Retry/reconnect
uses the same session's position/play state; the mute choice is carried before
resuming sound. The old layer stays hidden until a new playback presents a
frame. Page-away and every dialog dismissal pause/close and hide it; release
and app quit also stop the owned presenter/feed.

Saved markers load by pages, refresh on change events, seek from a row or a
positioned pin (nearby pins share a menu), and rename inline. Delete hides a
marker while its five-second Undo toast is alive. The shared toaster's real
expiry/manual close commits exactly once; Undo cancels it. Leaving the dialog
flushes the remaining deletes and dismisses those Undo buttons, as Electron
does. Window replies are fenced by the selected recording's revision.

Windows/Linux show the core's unavailable-playback copy and the system-player
recovery route; native playback on those platforms is still Phase 4. The
macOS build pass must check NativeView stacking, marker hit areas, focus,
scrubbing, retry/resume, dismissal during opening and audio exclusion with a
real recording. No built-app or device evidence is claimed here.
