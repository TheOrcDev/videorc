# videorc-preview-ring

**Lane: L1 (Preview).** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The shared-memory BGRA ring for CPU-composed previews.

Moved from `TheOrcDev/videorc-rust` (`crates/videorc-preview-ring` at `1e097e52c`) by plan 260 **S1.7**, unchanged. S1.7's backend half (the writer in `videorc-backend`, an L2 change at the coordinator's request) added the macOS half (`posix-shm`, `src/macos.rs`) and `handle_kind`, the wire-kind mapping the reader uses; the rest of the API is unchanged. Plan 260 S1.0 created the member. Depend on it with `videorc-preview-ring = { workspace = true }`.
