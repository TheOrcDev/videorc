# Health screen implementation

The Phase 3 macOS screen is `apps/videorc/src/screens/health/`. It projects
app-core's `studio::health_page` views through the synced kit: Alert,
PanelSection, GroupedList/ListRow, Button, Dialog, ScrollArea and StatusDot.
The shell uses the kit StatusBar and StatusBarAction for the Health door.
Settings → About → Health and the status-bar button open the same route.

The screen follows the Studio snapshot and telemetry, rebuilding while
visible. Entry, reconnect, session changes and event gaps refresh the
recording log and camera reads. The first log page is the backend's newest
120 lines, returned oldest first for display. Live log events merge by ID,
and the tail stays bounded. Generation/session fences discard old reads;
camera and compositor events supersede in-flight reads.

Permission warnings group the existing health events by permission. They
use the existing permission actions and last-asked timestamp. Dismiss hides
those event IDs, so a later failure can show again. The verdict includes
these warnings. Camera removal confirms, turns the switch off, then calls
the existing extension controller. No capture is started by Health.

Support export goes through Studio's single-flight command and the backend's
redaction and managed destination. Reveal accepts only a regular,
non-symlink support JSON directly in the managed support-bundles folder.
The success result also offers Copy path. No renderer-chosen destination or
new backend route is introduced.

## Implementation coverage

- P062–P066, P068–P069: checks, verdict, event-scoped permission warnings,
  fixes, dismissal, missing-recorder alert and show-all controls.
- P071–P075, P077–P084: support export, details, metric groups, recording and
  app log tails, last crash, and camera removal.
- P076: core preview metrics are drawn; native GPUI presenter observations
  still need validation against the actual host before claiming parity.
- P037, P1426: the status-bar Health tooltip/action and Settings' Health link.

No parity cells are marked passed: the checklist requires visual checks in
three appearances, keyboard/screen-reader checks and green GPUI smokes.
The owner prohibits builds, tests and app runs until the final build on main.
The coverage above records what is ready to exercise, not runtime evidence.

## Remaining work

- P070: Cloud room layers need the renderer's cloud-program-health projection
  and the native room-microphone observation integrated into app-core.
- P067 and Windows/Linux columns: platform passes, including Linux setup
  diagnostics; this task is the macOS slice.
- P036: the shell still shows the supervisor/connection words; the session
  clock and on-air/also-recording state belong to the shell status leaf.
- P031: the account-menu Health entry belongs to the account menu slice.
- The metric disclosures use kit buttons; expanded-state accessibility and
  the exact log-scroll/metric layout need the final visual/accessibility pass.
- Packaged version/updater integration must replace the current development
  build flag before release, as it must for Settings.

Validation: source inspection and `cargo fmt --check --all` only.

local gates: not run (owner: build once on main)
