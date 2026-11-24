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
- P1342/P1352–P1361: native player and markers are the next separate PR.
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
