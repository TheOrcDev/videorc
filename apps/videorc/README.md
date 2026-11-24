# apps/videorc (videorc-app, the Videorc binary)

**Lane: L4 (Shell and OS) for `src/main.rs`, `src/app/`, `src/platform/mod.rs` and `src/platform/macos/`; L1 for `src/preview/`; L5 for `src/platform/linux/`; the Windows contributors for `src/platform/windows/`; L6 for `src/smoke/`; the screens by the lanes plan 260's Phase 3 names.** Only that lane edits this app ([plan 260, Lanes](../../plans/260-gpui-rewrite.md#lanes-at-least-four-agents-at-once)).

The `Videorc` binary on GPUI: windows, screens, the preview element's GPUI side, OS integration, the smoke UI driver. It replaces the Electron shell (`apps/desktop`) on macOS, Windows and Linux at the switch (D8).

Empty until plan 260 **S2.1** fills it. Plan 260 S1.0 created it, with its entry in the root `Cargo.toml` (`members` and `[workspace.dependencies]`), so no later slice edits the root manifest to add it. It is a binary: nothing depends on it.
