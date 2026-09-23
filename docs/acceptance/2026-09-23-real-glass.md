# Real glass and a native look in every window: acceptance (plan 050)

Date: 2026-09-23 · branch `feat/real-glass` · macOS 26.5.1 (Apple M4, built-in
Retina display) · Electron 39.8.10.

Plan: `plans/050-real-glass-in-every-window.md`. Companion notes:

- `2026-09-23-real-glass-calibration.md` (S1–S2): probe populations and
  thresholds.
- `2026-09-23-real-glass-accessibility-and-capture.md` (S7): accessibility,
  window capture, and cost.

## What shipped

| Slice   | Change                                                                                   |
| ------- | ---------------------------------------------------------------------------------------- |
| S1      | `probe:ui-glass` measures real composited glass in every window                          |
| S2      | the main window on `under-window` vibrancy, `visualEffectState: 'active'`                |
| S3      | Chat and Captions on the same material, pinned dark per window                           |
| S4      | Notes becomes a renderer window on the same glass                                        |
| S5      | the Preview frame on glass                                                               |
| S6      | the simulated glass (wallpaper underlay, sweep, plumbing) deleted                        |
| S7      | Reduce Transparency, Increase Contrast, captured windows                                 |
| S8      | every badge, status pill, tag, and key chip is glass                                     |
| S9      | design language v2: the skill, radius tiers 12 / 8 / 6, 28 px controls                   |
| S10     | pane primitives: toolbar, pane body, status bar, flush sections, lists                   |
| S11     | the main shell: sidebar top row, toolbar, status bar                                     |
| S12     | Studio: preview-led bench, inspector, transport                                          |
| S13–S17 | Livestream, Sources, Scene, Assets, Output, Captions, Library, Publish, Settings, Health |
| S18     | floating surfaces                                                                        |
| S19     | the Chat and Captions window bodies                                                      |
| S20     | native feel and the renderer style guards                                                |
| S21     | Mica on Windows 11, solid on Windows 10                                                  |

## Decisions made during execution

- **No buttons in the toolbar's top-right corner (owner call).** The first
  cut of S11–S13 put page actions in the toolbar. The owner rejected that:
  the Studio transport (status, clock, Record / Stream / Stop) now sits at
  the top of the inspector, right above Session. Page actions stay in the
  page body, and the toolbar carries only the title. Plan 050 (D4, S12), the
  design skill, and a memory note record the rule.
- **Windows keeps the dark-always windows solid.** Windows has no
  per-window appearance pin, so only the main window gets Mica. Chat,
  Captions, Notes, and Preview keep the solid dark palette, the same rule as
  an unpinned window on macOS.
- **Notes has no context menu.** A popup menu is a separate window that
  capture protection does not cover, so it would appear on stream.
- **The size tokens extend tailwind-merge.** `h-control`, `h-row`, and the
  others would otherwise survive next to a call site's override. The
  extension uses `createTailwindMerge` with a config function, which keeps
  the eager renderer JS inside its budget.
- **Health keeps its log panes scrollable at a fixed height.** Only Publish
  had a viewport-height box (`calc(100vh-15rem)`), and it is gone.

## Gates

Run on the finished branch unless noted. `smoke:local-gates` was not run as
one command, because it includes the full Rust suite (owner directive:
targeted Rust tests and clippy only). Its relevant parts ran individually.

| Gate                                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint` (with the em-dash gate), `pnpm format:check`                                                                 | pass                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm --filter @videorc/desktop test`                                                                                                      | pass: 203 files, 2006 tests                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:scripts`                                                                                                                        | pass                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm build`, `pnpm check:renderer-assets`                                                                                                 | pass: 384,881 / 385,000 eager gzip bytes (budget unchanged)                                                                                                                                                                                                                                                                                                                                                            |
| `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`, `cargo clippy -p videorc-native-preview-addon -- -D warnings` | pass                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm probe:ui-glass --gate`                                                                                                               | pass: 12 / 12 samples, both themes, all five windows                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm probe:comments-window`                                                                                                               | pass: 168 checks, 320–900 px tiers. One in-suite run failed every width check by a constant 0.76 factor right after an external 4K display was attached; the re-run passed                                                                                                                                                                                                                                             |
| `pnpm smoke:record-latency:gate`                                                                                                           | pass, enforce mode (S12, transport moved)                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm probe:preview-window`                                                                                                                | pass: open, move, resize, toggle, dock-follow, dock-occlusion, undock (S12)                                                                                                                                                                                                                                                                                                                                            |
| `pnpm probe:preview-lifecycle`                                                                                                             | **re-run needed on an idle machine.** Passed at S12 (100 toggles). On the final branch, four runs were each cut short by a native close of the main window at a random cycle (1, 20, 70, 90): a real `close` event with no JavaScript origin, while the machine was in active use (HID idle 5 s) and the probe kept activating the app. No main-window or preview code changed after S12                               |
| `pnpm smoke:preview-performance`                                                                                                           | CPU at or below the 2026-09-23 baseline (main 9.7%, renderer 2.8%, backend 4.1%), presents 59.6 fps; fails only the pre-existing 80 KiB/s wire-rate budget (80.6 KiB/s; clean main 82.4)                                                                                                                                                                                                                               |
| `pnpm smoke:recording-studio`                                                                                                              | Gates 1–9 pass. Gate 10 (freeform editor) failed twice in-suite, once under the load of concurrent builds and once when a drag lost pointer capture, then passed 2 of 2 standalone runs (98 trusted gestures). The suite stops at its first failure, so gates 11–31 ran individually: all pass except 22 (`probe:comments-window`, passed on re-run) and 27 (`probe:preview-lifecycle`, re-run needed; see their rows) |
| Notes recording invisibility                                                                                                               | pass (S4; also inside `smoke:recording-studio`)                                                                                                                                                                                                                                                                                                                                                                        |
| ⌘K compositor wedge probe                                                                                                                  | no wedge (S2)                                                                                                                                                                                                                                                                                                                                                                                                          |
| Glass against `VIDEORC_GLASS=0`                                                                                                            | no measurable cost (S7 notes: WindowServer +0.6 pp over eight runs)                                                                                                                                                                                                                                                                                                                                                    |

## Owner checks (pending)

- **Checkpoint 1:** all five windows in both themes, over your own
  wallpaper, including a live session with Chat and Captions on stream.
- **Checkpoint 2a/2b:** the shell and the Studio (idle, recording, live;
  preview floating and docked).
- Focused and unfocused windows, fullscreen, minimize and restore.
- A bright wallpaper.
- System Settings → Accessibility → Display: Reduce Transparency and
  Increase Contrast, with all five windows open.
- Native feel: text selection, the edit context menu (spelling
  suggestions), overscroll, overlay scrollbars, 600 ms tooltips, image drag.
- **Windows 11 box:** every window in both themes and readability; Mica
  coats tuned; `smoke-windows-stream-performance` on a low-end iGPU;
  `smoke-windows-native-screen-app`; Windows 10 (or `VIDEORC_GLASS=0`) on the
  solid palette.
