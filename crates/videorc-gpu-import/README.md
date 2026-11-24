# videorc-gpu-import

**Lane: L1 (Preview).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

Imports the backend's shared preview surface (IOSurface, NT handle, dma-buf) as a GPU texture with no CPU copy.

Moved from `TheOrcDev/videorc-rust` (`crates/videorc-gpu-import` at `1e097e52c`) by plan 260 **S1.7**, unchanged. Plan 260 S1.0 created the member. Depend on it with `videorc-gpu-import = { workspace = true }`.
