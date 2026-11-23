# Plan 260 spikes (`spikes/gpui`)

Throwaway programs that each answer one question before Videorc's GPUI app
is built ([plan 260](../../plans/260-gpui-rewrite.md), Phase 0). This
folder exists only on the **`spikes/gpui`** branch. Nothing here is
merged into `main`, and nothing in the shipping app depends on it.

- Windows contributors: start with the
  [Windows code plan](../../plans/260-gpui-rewrite-windows-code.md) (what
  to write) and the
  [Windows testing plan](../../plans/260-gpui-rewrite-windows-testing.md)
  (setup, how to run, what to send).
- Every spike writes the same `summary.json`: [SUMMARY.md](SUMMARY.md).

## What is here

| Folder | What | Platforms | Slice |
| --- | --- | --- | --- |
| [`spike-native-preview/`](spike-native-preview/) | **The model.** A GPUI window with a sidebar and a pane; on macOS the pane is a `CAMetalLayer` presented on its own thread through GPUI's `NativeView`, with translucent GPUI elements drawn over it. On Windows and Linux GPUI paints the pane once a second (no native view there yet) | macOS (the full spike); Windows and Linux (the frame only) | Plan 260 S0.0 |
| [`spike-summary/`](spike-summary/) | The shared arguments, `summary.json` and `[spike] error` lines | All | — |

Spikes still to come, by the slice that adds them: `spike-hello`
(WC-0.1), the Windows native view and its patch (WC-0.2), the shared
texture (WC-0.3), CPU frames (WC-0.4), `spike-preview-windows` (WC-0.5),
`spike-chrome` (S0.4, WC-0.6), `spike-text` (S0.5, WC-0.7), `spike-a11y`
(S0.6, WC-0.8), `spike-desktop` (S0.7, WC-0.9).

## Build and run

This is its own Cargo workspace with its own `Cargo.lock` (separate from
the repository's root workspace). From a clone of `TheOrcDev/videorc`:

```sh
git fetch origin
git switch spikes/gpui
git pull
cd spikes/gpui
cargo build --release -p spike-native-preview
cargo run --release -p spike-native-preview -- --seconds 40
```

On Windows, use PowerShell and `cd spikes\gpui`; the commands are the
same. The first build compiles GPUI and takes 10 to 30 minutes and about
1.2 GB of `target/`; later builds take seconds.

Per platform:

- **macOS:** Xcode's command-line tools. No Metal Toolchain is needed: the
  workspace turns on GPUI's `runtime_shaders` feature, which compiles the
  Metal shaders when the app starts (development only).
- **Windows 11 x64:** the Windows testing plan's
  [one-time setup](../../plans/260-gpui-rewrite-windows-testing.md#one-time-setup)
  (Build Tools for Visual Studio 2022 with the Windows 11 SDK, Rust's
  `stable-x86_64-pc-windows-msvc`). GPUI compiles its shaders with
  `fxc.exe` from the Windows SDK during a release build; if the build says
  it cannot find it, set `$env:GPUI_FXC_PATH` to its full path.
- **Linux:** the packages GPUI's Linux crates need for Wayland and X11
  (`libxkbcommon`, `libwayland`, `libxcb`, Vulkan, `fontconfig`); see
  plan 260 S0.3.

The workspace's release profile keeps symbols (`strip = false`), because
some macOS toolchains have no `rust-objcopy` for the default strip.

## Rules for a new spike

1. **One folder, one question.** Add `spikes/gpui/<spike-name>/` and list
   it in `members` in [`Cargo.toml`](Cargo.toml). Name it as the Windows
   code plan does (`spike-hello`, `spike-preview-windows`…).
2. **Depend on the workspace's pins:** `gpui.workspace = true`,
   `gpui_platform.workspace = true`, `spike-summary.workspace = true`.
   Never change the `gpui-pre` version in a spike; a bump is its own PR
   (plan 260 D1). Platform-only crates go under
   `[target.'cfg(target_os = "…")'.dependencies]`, so every spike still
   resolves on every platform.
3. **Use `spike-summary`:** `Run::start` first, `run.set` for each number
   (names from [SUMMARY.md](SUMMARY.md)), `run.finish()` at the end of the
   timed run. Close the window yourself after `--seconds`.
4. **A README per spike** with: the question, the exact build and run
   commands, what you should see, the summary fields it writes, and a
   reference screenshot or `summary.example.json` from a real run.
5. **Patches to GPUI** go in `spikes/gpui/patches/<crate>/` and are wired
   with `[patch.crates-io]` in the workspace `Cargo.toml`. Count their
   lines (added, changed) in the PR. Plan 260 stops and asks the owner
   before a fourth patch.
6. **Licences:** Videorc is AGPL-3.0. GPUI and gpui-kit are Apache-2.0
   and may be used and patched. Never copy code from Zed's GPL crates
   (`ui`, `ui_input`, `component`, `theme`, `editor`, `settings`,
   `livekit_client`…).
7. **Pull requests** target `spikes/gpui`, never `main`. Title them as the
   history does (`feat(spikes): spike-hello on Windows`), link the slice,
   and post the evidence comment from the testing plan. Raw evidence
   (recordings, logs) stays out of the repository; a reference screenshot
   or example summary in the spike's folder is fine.
