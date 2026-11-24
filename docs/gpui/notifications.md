# Notification centre and toasts

Phase 3 uses one app-core `notices::Store`, shared by the main window and
Stream Manager. Each window has the kit's bell, a controlled 380 px Popover,
and a Toaster. Search's Open notifications command opens the main list;
Shift+Command+B toggles the list in the focused window.

The list uses Electron's strings and grouping: Notifications, Clear all,
Now, Earlier, and the empty state. Entries show their tone on the icon only,
relative time, unread dot, detail, two actions at most and Clear. Arrow keys
move between rows; Enter runs the first supported action, and Backspace or
Delete clears the focused row. Button focus retains its own keys. Closing
or destroying an open list marks entries read. Either open list suppresses
automatic pops in both windows.

The host routes session completion/failure, health, microphone loss,
destination state, MP4 export, Clips and watchdog updates through the core
source functions. Watchdog Clear acknowledges the matching alerts; Unmute,
I meant to and Reconnect use the existing Studio requests. Health, Sources,
Output, Audio's Studio route, Settings Permissions and Shortcuts, Retry
start, Resume System audio, Copy and existing supported page/URL actions
are connected. The backend and source controllers remain authoritative.

Only core Show effects pop up automatic entries. The launch quiet period,
idle rule, urgent episodes and explicit press-answer kinds remain in core.
The refused start, armed end-livestream key and Clip-key refusals retain
their explicit press-answer handling. Recovery replaces only a visible,
active toast; it never resurrects a queued or expired one. Timeout keeps
an entry unread; manual close or its action marks it read. The kit limits
the visible stack to three and replaces by key. No routine scene, source
or layout success is toasted.

The old notice stream has no initiating window or reliable provenance.
Known replaced producers are filtered by stable ids. Other legacy notices
are preserved behind the bell, with their actions, rather than treated as
permission for an unsolicited toast. Automatic toasts currently have one
home, the main window, to avoid duplicating them in Stream Manager.

Implemented rows, **not visually verified and not ticked**: P042, P057,
P098, P1020, P1027–P1030, P1033–P1034. Partial rows: P1026 (live
announcements pending), P1031 (progress spinner and visual sizing pending),
P1032 (supported actions only), P1444 (main toast routing). The current
Electron no longer renders P1035/P1036's quiet-switch footer, so this screen
does not bring it back. Existing checked parity rows are untouched.

Still to finish with the owning screens/controllers:

- Library Play, reveal and export retry, destination subroutes, and fixes
  whose control does not exist in this app yet are disabled with a reason.
- Cloud/platform/device-specific sources beyond those above still arrive
  through their legacy notices. Their typed recovery/subject mapping and
  per-window press provenance need the corresponding screen integrations.
- Open Audio opens Studio; focusing its microphone picker waits for that
  section's focus door. Watchdog fixes for scene/takeover and dashboard
  navigation likewise await their owning controls.
- AccessKit live announcements, animated progress/busy indicators, row
  focus/scroll behavior and exact visual dimensions need the build pass.
- The build pass must exercise two windows, outside/Escape close, fast
  reopen, timeouts versus manual dismissal, disabled actions, launch/idle
  suppression, recovery and theme/contrast. No local build, test, app or
  smoke ran under the owner's build-once-on-main order.

Shared kit changes are upstream videorc-ui #27 (command/toast hooks), #28
(controlled Popover/custom trigger) and #29 (visible recovery and flush
surface), synced through the GPUI registry tooling.
