# videorc-app-core

**Lane: L7 (Core).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The Videorc app without a UI: the typed backend client, the supervisor, the Studio state machine and every page's view-model, the smoke command server, settings. It never depends on GPUI (a test enforces it).

Empty until plan 260 **S1.6a to S1.6f** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-app-core = { workspace = true }`.
