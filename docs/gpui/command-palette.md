# Native command palette

`apps/videorc/src/screens/command_palette/` hosts Search on the shared kit
Command parts, added upstream in videorc-ui #27 and synced with ui:sync.
The app uses app-core's command-score filter, Studio state and command
owners. Search opens with the status-bar hint or the shell binding. Input
composition owns its arrows; other arrows wrap past disabled commands.
Enter uses the input's committed-key event. Selection is checked against
fresh state before dispatch. Stop opens Studio so End livestream's existing
confirmation remains visible. No command bypasses the core's session gates.

Implemented rows (not parity ticks): P085–P086; P087 recording/stop portion;
P092–P093; P095 installed page routes; P099 Preview/Stream Manager portion;
P101 saved-scene switching; P106; P108–P110; P038/P051 Search door.

Remaining: Go Live and Hide screen need their native owning controllers;
camera background, chroma key, virtual-camera switch, Stop agents, dynamic
banner/sound commands, scene editor/add/background commands, destination
subroutes, Avatar/Sidekick tabs, Connect agent, Notes and Captions reader
need their owning screen/service adapters. The notifications entry is wired
by the next screen slice. Unavailable installed-catalogue commands are
explicitly disabled; missing dynamic families are not fabricated.

The current kit puts Search on the existing dialog placement. The by-eye
pass must check the upper-window placement, group headings, command icons,
shortcut/checked metadata, focus restoration, keyboard modal gating and
VoiceOver. Preview uses the existing floating-preview toggle; its exact
remembered-mode wording awaits that controller's full shell API.

No parity cells are ticked. Validation is source inspection and
`cargo fmt --check --all`; no builds, tests or app runs.

local gates: not run (owner: build once on main)
