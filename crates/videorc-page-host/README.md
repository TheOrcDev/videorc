# videorc-page-host

**Lane: L2 (Backend and contracts).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The engine-free half of the HTML banner host (plan 220 P5-D10).

Empty until plan 260 **S1.7** fills it. Plan 260 S1.0 created it as a workspace member (the root `Cargo.toml`'s `members`), so it builds with the workspace. Its `[workspace.dependencies]` entry waits for its first dependent: Cargo (1.100) warns on a workspace dependency nothing uses. The slice that first depends on it adds `videorc-page-host = { path = "crates/videorc-page-host" }` there, then `videorc-page-host = { workspace = true }` in its own manifest.
