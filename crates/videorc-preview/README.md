# videorc-preview

**Lane: L1 (Preview); its Linux files (`src/linux*`) are L5's.** Only that lane edits this crate ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The preview element: on macOS a `CAMetalLayer` presented on its own thread from the backend's IOSurface ring, the lease loop, the first-frame and presenting contracts; the Linux Wayland/X11 presenter.

Empty until plan 260 **S1.7** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. Depend on it with `videorc-preview = { workspace = true }`.
