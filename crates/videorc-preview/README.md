# videorc-preview

**Lane: L1 (Preview); its Linux files (`src/linux*`) are L5's.** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The preview element: on macOS a `CAMetalLayer` presented on its own thread from the backend's IOSurface ring, the lease loop, the first-frame and presenting contracts; the Linux Wayland/X11 presenter.

Moved from `TheOrcDev/videorc-rust` (`crates/videorc-preview` at `1e097e52c`) by plan 260 **S1.7b**. Two catch-up edits: the Slint texture route's backing is `PreviewSurfaceBacking::GpuiImage`, and two cards' words follow today's `preview-stage.tsx` (issue #1273; a test compares them byte for byte). Plan 260 S1.0 created the member. Depend on it with `videorc-preview = { workspace = true }`. Plan 260 S0.1 measured it under GPUI: `spikes/gpui/spike-preview-backend` on the `spikes/gpui` branch.
