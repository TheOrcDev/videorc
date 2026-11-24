# videorc-updater

**Lane: L2 (Backend and contracts).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Electron's update rules in Rust, on today's feed format (plan 220 P5-D3), for the GPUI app's second feed (P5-D6).

Empty until plan 260 **S1.7** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-updater = { workspace = true }`.
