# Plan 260: The whole desktop app in GPUI

> **Executor instructions**: this is a program plan: seven phases, about
> 110 slices, run in at least four parallel lanes
> ([Lanes](#lanes-at-least-four-agents-at-once)). The owner took D1 to D13
> on 2026-11-23. Phase 0 is the gate for GPUI work: nothing in Phase 2 or
> later starts until S0.1, S0.2 and S0.3 pass on their machines, the owner
> has judged S0.4's look (D3) and has taken D12's route on S0.2's numbers.
> Phase 1 ships in Electron and starts now. Before a phase starts, cut it
> into agent-sized slices with the `cut-it` skill; the slices below are
> each phase's outline and its "Done when" checks. Every slice is one PR to
> `TheOrcDev/videorc` `main` (spikes excepted: they go to the `spikes/gpui`
> branch), leaves `main` green and runs the `AGENTS.md` gates for what it
> touches. Windows slices are done by two outside contributors from two
> companion docs: [Windows testing](260-gpui-rewrite-windows-testing.md)
> and [Windows code](260-gpui-rewrite-windows-code.md). Anything under
> "STOP conditions" means stop and report, not improvise.
>
> **Drift check (run before each phase):** recount "The app today" against
> `origin/main`. A new window, page, RPC method or smoke since this plan is
> scope to add, not to drop.

The owner, 2026-11-23: "We are going to rewrite complete Videorc Electron
to GPUI. I already started but I don't like [Slint] because it is without
GPU. It is actually only Rust. I want you to plan out a complete rewrite of
that refactoring that we did to GPUI. Plan it out properly. Ask me any
questions if you need something."

The owner's answers, the same day:

- On why GPUI: "I want GPUI, it's going forward, everyone is using it, and
  many UI libs are coming out with GPUI support."
- On the component library: "we have ui.videorc.com, we can just create
  GPUI support for our lib."
- On Windows: "We have two contributors on Windows. We'll make a plan for
  testing for them and a plan for writing code."
- On pace: "always have a minimum of 4 agents working on different
  slices."

## Status and scope

- **Status: DECIDED 2026-11-23.** Research, source reads and one spike;
  no product code changed. The owner took D1 to D13 the same day: eleven
  as recommended, D8 (all three platforms switch together) and D10
  (ui.videorc.com is kept and gains a GPUI flavour) changed
  ([Owner decisions](#owner-decisions)). Owed before the switch: the
  hardware under [D8](#owner-decisions).
- **What it is:** one Rust desktop app on GPUI, Zed's GPU-accelerated UI
  framework, that replaces the Electron shell (`apps/desktop`: main
  process, React renderer, preload) on macOS, Windows and Linux, and looks,
  reads and behaves as Videorc does today. The backend
  (`crates/videorc-backend`) stays.
- **What it replaces:** plan 220's Slint UI in `TheOrcDev/videorc-rust`.
  This plan keeps everything of plan 220 that is not Slint: its core, its
  preview element, its contracts, its spikes, its decisions on banners,
  the updater and identity, and its lessons. It drops the Slint crates. It
  reverses two of plan 220's decisions: D6 (videorc-ui freezes at the
  cutover) by this plan's D10, and D12 (macOS first) by this plan's D8.
- **Not in scope:** a redesign (the `videorc-design` skill, `docs/ui-copy.md`
  and the `CONTEXT.md` glossary are the spec, and every owner call in them
  still binds), new features during the rewrite beyond [D7](#owner-decisions),
  and backend behaviour changes beyond Phase 1's moves.
- **Base:** `TheOrcDev/videorc` `origin/main` at `c0cdc36f0` (0.37.1,
  2026-11-23). `TheOrcDev/videorc-rust` `main` at `1e097e52c`
  (2026-11-17). GPUI as `gpui-pre` 0.3.14, a snapshot of Zed at
  `f126950f9d3b62666f97437ae5d4ccac2272c4db`, published 2026-11-23.
- **Branch:** `plan/260-gpui-rewrite`, PR #1713, merged after the owner's
  answers.
- **Companion docs (public, for the Windows contributors):**
  [260-gpui-rewrite-windows-testing.md](260-gpui-rewrite-windows-testing.md)
  and [260-gpui-rewrite-windows-code.md](260-gpui-rewrite-windows-code.md).
- **Working notes and spike:** `~/cloud-test/reports/2026-11-23-gpui-plan/`
  (notes) and `~/gpui-scratch/spike-native-preview/` (the spike), outside
  both repos. S0.12 copies the spike to the `spikes/gpui` branch as the
  contributors' model.

## Why GPUI, and what it does not change

**The owner's reason is the ecosystem (decided 2026-11-23).** "I want
GPUI, it's going forward, everyone is using it, and many UI libs are coming
out with GPUI support." It is not a complaint about Slint's speed. The facts
behind it, as of today ([GPUI today](#gpui-today)): Zed and Delta ship on
it on three platforms; Longbridge publishes weekly `gpui-pre` snapshots;
gpui-kit (21.2k stars, weekly releases) is a shadcn-style library on it and
powers Longbridge Pro; Cap's open-source screen recorder has a GPUI desktop
app; and Zed keeps adding the platform work an app like Videorc needs
(accessibility, system notifications, headless rendering, native views).
Videorc's own library joins that ecosystem as the GPUI flavour of
ui.videorc.com (D3, D10).

So Phase 0 does not set out to beat Slint on a number (Slint drew on the
GPU too: Skia on wgpu, `videorc-rust:crates/videorc-app/src/renderer.rs:1-11`).
It checks what any desktop UI must get right, on all three platforms,
against Electron's baseline (S0.10): **smoothness** (the preview, S0.1 to
S0.3; scrolling and resizing, S0.5), **the look** (S0.4), **text** (S0.5)
and **start-up** (S0.9).

Plan 220's reasons for leaving Electron stand
(`videorc-rust:plans/220-the-whole-ui-in-rust.md:161-180`): about 14,000
lines of Electron code keep a `CAMetalLayer` lined up with a Chromium page;
the Windows preview is uncompressed BMPs polled over HTTP; Chromium's
processes compete with the encoder on weak PCs; and `protocol.rs` is
mirrored by hand in TypeScript (10,434 + 8,667 lines today). Recording
correctness and stream performance live in the backend and do not change.

What GPUI changes against Slint, checked in the source on 2026-11-23:

- **The UI paints over the video on macOS.** GPUI's `NativeView` puts an
  `NSView` beneath the window's GPUI content, and "elements painted after it
  cover it like they would cover any other element"
  (`gpui-pre 0.3.14 src/window/native_view.rs:30-69`). Slint could draw
  nothing on top of its native layer, so the freeform scene editor had to
  switch to a texture route at 30 to 40 % of a core at 4K60
  (`videorc-rust:docs/rust-ui/spike-report.md:53-60`). With GPUI the editor's
  handles, scrims and labels sit on the same layer route as the docked
  preview. [The spike](#spike-s00-native-preview-under-gpui) measured it.
- **Plain Rust, no second language.** Screens are Rust functions, not
  `.slint` files, which is what agents write best and what Zed itself is written
  in. No vendored toolkit patches today (Slint needed three,
  `videorc-rust:plans/220-the-whole-ui-in-rust.md:420-437`).
- **A daily-driven renderer on all three platforms:** Metal on macOS
  (`gpui-pre-apple src/metal_renderer.rs`), DirectX 11 with DirectWrite and
  DirectComposition on Windows (`gpui-pre-windows src/directx_renderer.rs:116-181`),
  and wgpu (Vulkan) on Wayland and X11 (`gpui-pre-linux
  src/linux/wayland/window.rs:48`, `gpui-pre-wgpu src/wgpu_renderer.rs`).
  Zed ships on all three.

What GPUI costs, also from the source:

- **No stable release.** crates.io `gpui` stops at 0.2.2 (2025-10-22).
  Outside apps consume weekly snapshots (`gpui-pre`, published by
  Longbridge) or a git pin of the Zed repo. The API moves every week. See
  [GPUI today](#gpui-today).
- **Native views are macOS only.** `NativeView::new` "fails on every other
  platform" (`native_view.rs:84-92`), and the `surface()` element is macOS
  only and NV12 only (`gpui-pre src/elements/surface.rs:13-40`,
  `gpui-pre-apple src/metal_renderer.rs:1267-1270`); the Windows renderer's
  `draw_surfaces` is an empty function (`gpui-pre-windows
  src/directx_renderer.rs:845-850`). The Windows and Linux preview need a
  route of our own ([The preview](#the-preview-is-an-element-on-every-platform)),
  and since all three platforms switch together (D8) those routes are on
  the critical path.
- **Two-stop gradients only, no radial gradient.** `linear_gradient` takes
  exactly two stops (`gpui-pre src/color.rs:865-876`). Liquid Chrome uses
  five-stop fills and radial beads
  (`apps/desktop/src/renderer/src/styles.css:192-209`, `:809-848`). See
  S0.4.
- **No tray and no global hotkeys** in GPUI (neither `NSStatusItem`,
  `Shell_NotifyIcon` nor `RegisterHotKey` appears in the snapshot). Videorc
  has no tray today; global shortcuts come from a small crate
  ([Electron's jobs](#every-electron-job-and-its-replacement)).

## GPUI today

Checked on 2026-11-23 against crates.io, the `gpui-pre` 0.3.14 sources and
the primary sources listed under [Sources](#sources).

| Question | Answer | Evidence |
| --- | --- | --- |
| How it is consumed | crates.io `gpui` is 0.2.2 (2025-10-22). Longbridge publishes `gpui-pre` weekly (0.3.11 2026-11-02, 0.3.12 11-09, 0.3.13 11-16, 0.3.14 11-23), each a snapshot of one Zed commit, with the platform crates split out: `gpui-pre-platform`, `-macos`, `-apple` (Metal), `-windows`, `-linux`, `-wgpu` | crates.io API; `gpui-pre-0.3.14/Cargo.toml` `[package.metadata.gpui-pre] zed-rev = "f126950…"` |
| Licence | Apache-2.0 for `gpui-pre` and every split crate; gpui-component Apache-2.0. Compatible with Videorc's AGPL-3.0 (no Slint-style GPL decision needed) | crates.io metadata |
| macOS | Metal renderer, Core Text; `NativeView` (NSView beneath GPUI); `surface()` for NV12 `CVPixelBuffer`; native menus, dock menu, URL scheme, system notifications | `gpui-pre-apple src/metal_renderer.rs`; `native_view.rs`; `platform.rs:522-527`; `app.rs:359`, `:2059`; `gpui-pre-macos src/system_notifications.rs` |
| Windows | DirectX 11 renderer on one DirectComposition visual, DirectWrite text, system notifications; no native views; surfaces not drawn | `gpui-pre-windows src/directx_renderer.rs:116-181`, `:845-850`; `src/system_notifications.rs` |
| Linux | wgpu renderer (Vulkan) on Wayland and X11; layer shell; background effect protocol | `gpui-pre-linux src/linux/wayland/window.rs:21-48`; examples `layer_shell.rs` |
| Windows and popups | `WindowKind::{Normal, PopUp, AnchoredPopup, Floating, LayerShell}`; every window gives a raw window handle | `gpui-pre src/platform.rs:2930-2951`; `src/window.rs:8112` |
| Accessibility | AccessKit integrated, with a guide and an example | `gpui-pre src/_accessibility.rs:1-60`; `examples/a11y.rs` |
| Text input | A text input is an `EntityInputHandler` the app (or a component library) writes; IME goes through it | `examples/input.rs` |
| Tests | `TestAppContext`, `VisualTestContext`, a test platform, a visual test module, an inspector | `src/platform/test/`, `src/platform/visual_test.rs`, `src/inspector.rs` |
| Components | gpui-component 0.11.0 (2026-11-23, Apache-2.0) pins `gpui-pre =0.3.14`; shadcn-inspired | crates.io dependency list |

Upstream, at Zed `main` `6501df157` (2026-11-23):

- **Releases.** Zed's own crates are `publish = false` since the
  platform split ([#49277](https://github.com/zed-industries/zed/pull/49277),
  2026-02-19). On 2026-10-30 Zed promised automated weekly GPUI releases
  and said to pin a git revision until then
  ([#66275](https://github.com/zed-industries/zed/issues/66275)); none had
  shipped by 2026-11-22 ([#67338](https://github.com/zed-industries/zed/issues/67338)).
  Other channels: `gpui-ce` (a community fork from 2025-12-12),
  `gpui-unofficial` (from Zed tags, seeking a maintainer), and git forks
  such as Cap's.
- **Who it is built for.** On 2025-12-12 Zed closed outside PRs for custom
  shaders ([#42905](https://github.com/zed-industries/zed/pull/42905):
  "without a Zed use case, I can't validate this code") and a tray
  ([#44047](https://github.com/zed-industries/zed/pull/44047)). No formal
  reversal since, but in practice the work picked up, driven by Zed and
  Delta (Zed's second GPUI app): the platform split (February), wgpu on
  Linux ([#46758](https://github.com/zed-industries/zed/pull/46758),
  2026-02-13), AccessKit ([#56065](https://github.com/zed-industries/zed/pull/56065),
  2026-05-27), system notifications ([#61189](https://github.com/zed-industries/zed/pull/61189),
  2026-07-17), headless rendering on Windows and Linux
  ([#63012](https://github.com/zed-industries/zed/pull/63012),
  [#64718](https://github.com/zed-industries/zed/pull/64718)), hot reload
  ([#65738](https://github.com/zed-industries/zed/pull/65738)) and
  `NativeView` ([#67311](https://github.com/zed-industries/zed/pull/67311)
  and its fix [#67316](https://github.com/zed-industries/zed/pull/67316),
  **merged 2026-11-22, one day before this plan**). Read it as: what Zed or
  Delta needs lands; what only Videorc needs is ours to carry.
- **Churn.** 55 commits touched `crates/gpui` in the last 31 days, plus 11
  to 18 in each platform crate. gpui-kit moved to exact pins after a
  snapshot broke its users (gpui-kit #3156).
- **Windows.** DirectX 11 since [#34374](https://github.com/zed-industries/zed/pull/34374)
  (2025-07-30); Zed for Windows stable since 2025-10-15. IME through IMM32
  (no TSF). Native anchored popups are Wayland only, so menus and popovers
  draw inside the window on macOS and Windows (as they do in Electron).
  Child HWNDs such as WebView2 can sit above GPUI content
  ([#66368](https://github.com/zed-industries/zed/pull/66368)), but GPUI
  cannot draw over them. Zed's Windows screen-reader support is still open
  ([#41138](https://github.com/zed-industries/zed/issues/41138)).
- **Video in Zed.** Zed's call video is a CPU copy per frame on every
  platform: I420 into a pooled NV12 `CVPixelBuffer` for `surface()` on
  macOS, ARGB into a `RenderImage` elsewhere
  (`crates/livekit_client/src/playback.rs:603-768`). The surface shader
  hard-codes BT.601 full range (`crates/gpui_apple/src/shaders.metal:953-969`).
  Videorc's preview must not take that route: it keeps its own presenter.
- **Licences inside Zed.** GPUI and its path dependencies are Apache-2.0.
  Zed's `ui`, `ui_input`, `component`, `theme`, `editor`, `settings` and
  `livekit_client` are GPL-3.0-or-later: nothing is copied from them.
- **Components.** longbridge/gpui-kit (renamed from gpui-component; 21.2k
  stars, weekly releases) has three layers: `gpui-base`, unstyled
  behaviour modelled on Base UI; `gpui-component`, styled and modelled on
  shadcn's layering (accordion, alert, badge, button, checkbox, combobox,
  command, dialog, hover card, input and editor, kbd, list and virtual
  list, menu, popover, progress, radio, resizable, select, sheet, sidebar,
  skeleton, slider, switch, tabs, table, tooltip, tree, title bar…); and a
  shell. That mirrors how Videorc is built today (shadcn over Base UI). It
  powers Longbridge Pro.
- **Apps outside Zed.** Delta (Zed); Longbridge Pro; **Cap**, an
  open-source screen recorder with a GPUI desktop app on an FFmpeg engine
  (`apps/desktop-gpui`, pinned to a git fork with a transparency fix, and
  using `tray-icon` and `global-hotkey`), the closest analogue to Videorc.
- **Build.** On macOS GPUI compiles its Metal shaders at build time, which
  needs Xcode's Metal Toolchain component (`xcodebuild
  -downloadComponent MetalToolchain`); the `runtime_shaders` feature
  avoids it for development. This Mac does not have it (found by the
  spike). Release and CI machines need it installed.

## What carries over from the Slint work

`TheOrcDev/videorc-rust` holds 2,699 commits of plan 220 work. Its rule
"the core never imports the UI framework" is enforced by a test that
fails on a dependency on slint, egui, winit, wgpu, gpui or iced
(`videorc-rust:crates/videorc-app-core/src/lib.rs:124-130`). That rule is
why most of it survives a framework change.

| Crate | Size | Fate |
| --- | --- | --- |
| `videorc-protocol` | 8.9k lines | **Keep.** Every wire type, serde only; optional `ts-rs` generates the TypeScript while Electron lives |
| `videorc-app-core` | 146k lines | **Keep.** Typed backend client, supervisor, the Studio state machine (the port of `use-studio.tsx`), every page's view-model, the smoke command server, settings, desktop rules. 885 shipping commits behind ([Drift](#the-drift-is-the-largest-risk)) |
| `videorc-preview` | 10.8k lines | **Keep.** The macOS layer presenter (`src/macos.rs:123-698`: `CAMetalLayer`, presenter thread, 3-entry import cache), the lease feed, first-frame contracts and watchdog, playback, the Linux Wayland/X11 presenter. Measured at 5.6 % of a core at live 4K60 (`videorc-rust:docs/rust-ui/preview-element.md:60-100`) |
| `videorc-gpu-import` | 1.3k lines | **Keep** the raw Metal import; the D3D11 and dma-buf imports are written and unused |
| `videorc-preview-ring` | 1.3k lines | **Keep.** Shared-memory BGRA ring for CPU-composed previews |
| `videorc-updater` | 7.9k lines | **Keep.** Electron's update rules ported, 174 tests, not wired yet |
| `videorc-page-host` | 2.7k lines | **Keep.** The engine-free half of the HTML banner host |
| `videorc-ui-lint` | 4.3k lines | **Keep** the copy and string-table rules; the `.slint` design lint is replaced by a Rust one |
| desktop code in `videorc-app` | part of 58.7k | **Lift** the objc2 menu bar, Apple Events, hotkeys, permissions, traffic lights (`src/desktop/`, `frame.rs`, `display.rs`) |
| `videorc-ui` and the Slint glue | 76k lines, plus most of `videorc-app` | **Drop** |
| `videorc-spike-*` | evidence | Keep the reports in `videorc-rust:docs/rust-ui/`; drop the crates |

Also carried: the string tables (`videorc-rust:docs/rust-ui/strings/*.json`,
`screens.toml`), `videorc-rust:docs/rust-ui/screens.md` (every per-screen deviation and
owner look), `studio-state-port.md` (the map from `use-studio.tsx` to the
core), the smoke ledger, the JS UI driver (`scripts/lib/ui-driver.mjs`,
`ui-driver-map.mjs`) and the `VIDEORC_APP` launcher switch.

Plan 220 decisions this plan keeps (D11, decided 2026-11-23): D2 (two
processes), D5 (the action executor in the app's core), D7/P5-D3 (a small
Rust updater on today's feed), D8 (the backend rasterises stream
graphics), D9 (Library playback decoded by the backend), D11 (identity),
P5-D6 (a second feed), P5-D10 (a Chromium page host fetched on first use
for HTML banners), and P4-D6 (a contributor's Windows run with evidence is
the physical pass). Two are reversed: D6 (videorc-ui freezes at the
cutover) by this plan's D10, and D12 (macOS first) by this plan's D8.
D13 (Slint's licence) falls away.

Lessons that carry (from the Slint work and its memory notes): set a view's
data only when it changed (rebuilt models cost two full redraws a second
at idle, `preview-element.md:812-840`); release backends need
`CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true` to accept the synthetic
scene; CPU numbers only compare back to back on an unoccluded window; one
UI-crate compile at a time on this Mac, and a fresh debug build of the
workspace is 25 to 33 GB.

## The app today

Counted on `origin/main` `c0cdc36f0`.

| Part | Size |
| --- | --- |
| Renderer | 338 `.tsx` and 1,179 `.ts` files, about 205,500 non-test lines; 642 test files |
| The state machine, `hooks/use-studio.tsx` | 22,187 lines |
| Main process, `main/index.ts` | 20,316 lines, plus about 130 modules |
| Protocol | 301 RPC methods (`shared/backend-rpc-contract.ts:435-1061`), 269 used by the renderer; about 71 events; `protocol.rs` 10,786 lines; 53 fixture files |
| IPC | about 582 renderer↔main channels (`shared/electron-ipc-contract.ts`) |
| Design system | 52 `components/ui` primitives; `styles.css` |
| Pages | 13 in the sidebar plus Health (`shared/sidebar-pages.ts:45`) |
| Windows | Main, Stream Manager, Notes, Captions reader, Preview, the proof surfaces, the HTML banner host, a smoke backdrop |
| Smokes | 116 `scripts/smoke-*.mjs`, 23 probes; `scripts/lib/app-launcher.mjs` used by 101 scripts; 105 smoke commands in `main/index.ts:12823-15521`; 42 scripts use `eval-js`, 17 raw CDP |
| Backend | 652k lines of Rust |

## The design

### Two processes, as today (D4)

`Videorc` (the GPUI app: windows, the core, OS integration) spawns and
supervises `videorc-backend` as Electron main does now, with app-core's
supervisor and restart ladder. A UI crash never ends a recording or a
stream, and the backend's other clients (the Stream Deck plugin over
`remote_control.rs`, the phone remote over `remote_lan_server.rs`, MCP
agents over `/mcp`) keep their transport. The UI talks to the backend over
the same loopback WebSocket, typed by `videorc-protocol`.

In-process was weighed and not taken (D4): it saves one socket hop
(sub-millisecond on loopback) and lets the preview share a GPU device, but
the preview already crosses processes with zero copies (IOSurface ids, NT
handles), and a panic in 652k lines of capture and encoding code would
take the window with it.

### Crates (in `TheOrcDev/videorc`)

- `crates/videorc-protocol`, `crates/videorc-app-core`,
  `crates/videorc-preview`, `crates/videorc-gpu-import`,
  `crates/videorc-preview-ring`, `crates/videorc-updater`,
  `crates/videorc-page-host`: from `videorc-rust`, caught up (Phase 1).
- `crates/videorc-kit` (new): the design system on GPUI, **synced from the
  GPUI flavour of videorc-ui** (D3, D10;
  [below](#the-gpui-flavour-of-videorc-ui-d3-d10)), never edited here, as
  `apps/desktop/src/renderer/src/components/ui` is synced today. Only this
  crate and the app touch GPUI.
- `apps/videorc` (new, the `Videorc` binary): windows, screens, the
  preview element's GPUI side, OS integration, the smoke UI driver.

The rule stays: the core never imports GPUI (the test above is kept).

### State: the core owns it, GPUI views reflect it

- app-core's `Studio` keeps the state in one `StudioSnapshot` on a
  `tokio::sync::watch`, plus watches for telemetry, levels, chat, the
  dashboard, the co-host and Go Live, broadcasts for effects and toasts
  (`videorc-rust:crates/videorc-app-core/src/studio/mod.rs:806-861`). It
  runs on its own two-worker Tokio runtime and keeps running with no
  window open, so remotes work with every window closed.
- A GPUI `Entity` per store mirrors it. A bridge task per watch
  (`cx.spawn`) awaits `changed()` (Tokio's sync types run on any
  executor), maps the snapshot through the core's pure view functions and
  calls `cx.notify()` only when the mapped value changed. That is the GPUI
  form of the Slint lesson above.
- Intents are GPUI actions (`actions!`), bound to keys through GPUI's
  keymap, dispatched to async methods on `Studio` through the Tokio
  handle. Shortcut text comes from the same keymap, so `ShortcutKeys`
  cannot drift from the binding.
- The UI settings that Electron keeps in `localStorage` (26 at plan
  220's count) live in the backend's `app_settings` (plan 220 S1.4), so both apps read the same
  values during the crossover.

### The preview is an element on every platform

| Platform | Route | Status |
| --- | --- | --- |
| macOS | A `NativeView` holding an `NSView` whose layer is `videorc-preview`'s `CAMetalLayer`, presented on its own thread from the backend's IOSurface ring. GPUI lays it out like any element and paints the scene editor's handles, the scrims and the labels over it. The detached Preview window gets its own `NativeView` (a view shows in one window only, `native_view.rs:62-67`) | Spike S0.0 showed it on synthetic content ([below](#spike-s00-native-preview-under-gpui)); S0.1 measures it with the backend's real ring at 4K60 |
| Windows | To measure (S0.2, D12): (a) a native view for Windows, contributed to GPUI: a DirectComposition visual beneath GPUI's visual, showing a composition surface the backend's presenter presents into (`DCompositionCreateSurfaceHandle`, opened with `CreateSurfaceFromHandle`), so the presenter stays in the backend as on macOS; (b) a shared-texture `draw_surfaces` in GPUI's DirectX renderer, which redraws the window at video rate; (c) the backend's own DirectComposition window stacked over ours (`windows_d3d11_preview.rs:610-1016`, today's unqualified presenter); (d) CPU frames from the shared-memory ring as GPUI images | Unbuilt. **On the critical path (D8).** Built and measured by the Windows contributors ([code](260-gpui-rewrite-windows-code.md) WC-0.2 to WC-0.5); (a), (b) and (d) need the backend's hand-over first (S0.2b). Anything beats today's BMP proof surface |
| Linux | `videorc-preview`'s Wayland subsurface or X11 child window over the shared-memory ring, placed below a transparent hole in GPUI's surface; fallback (d) | Built for Slint (plan 220 P4-D2), never under GPUI. **On the critical path (D8):** S0.3 on ogre |

The preview contracts stay as built: one lease at a time, the first-frame
and source-liveness watchdogs, the honest fallback labels (`AGENTS.md`
Native Preview Rules), one `PreviewSurfaceBounds` type. Live backgrounds
and Library playback come from the backend through the same element (plan
220 D9); the UI runs no WebGL and no `<video>`.

### Strict contracts and fixtures

- `videorc-protocol` holds the types once. The backend and the app both
  depend on it, so the UI cannot drift from the wire. `deny_unknown_fields`
  stays where it is; the serde-null trap is closed by `skip_serializing_if`
  on every `Option` the TS side treated as absent.
- While Electron ships, `backend.ts` is generated from the crate (`ts-rs`)
  and `backend-rpc-contract.ts`'s validators stay; `protocol-fixtures/`
  and both sides' fixture tests run unchanged (`protocol.rs:8783`,
  `shared/protocol-contract-fixtures.test.ts`).
- When Electron is deleted, the TS mirrors and their tests go; the fixture
  JSON and the Rust fixture tests stay, and a new test round-trips every
  fixture through the app's client types.
- The ~582 IPC channels and the preload disappear: main and renderer
  become one process.

### The design system in GPUI

- The skill is the spec. Opaque solid windows on every platform, no
  vibrancy, no Mica, no backdrop blur (skill: "A plain solid ground, never
  the desktop and never fake blur"), so GPUI's lack of a backdrop filter
  costs nothing.
- **Liquid Chrome needs more than GPUI draws.** Five-stop linear fills,
  radial beads and the metallic red Record are beyond `linear_gradient`'s
  two stops. Routes, to be judged by eye in S0.4: stacked two-stop bands
  clipped to the control (GPUI's content mask is rectangular, so rounded
  ends need care); chrome rasterised once per size and scale with
  tiny-skia into an image with corner radii; or a multi-stop gradient
  patch to GPUI (Zed declined custom shaders from outside, so this one
  may stay ours).
- **The preview's corners.** A native view is "treated as opaque, and is
  not affected by element opacity or transformations"
  (`native_view.rs:37-38`), so the preview stage's rounded corners come
  from the layer's own `cornerRadius`, not from GPUI clipping.
- **Behaviour from gpui-kit, looks from Videorc (D3, decided
  2026-11-23).** gpui-kit brings unstyled behaviour (`gpui-base`, modelled
  on Base UI) and styled components (`gpui-component`, modelled on shadcn):
  a tested text input (IME, selection), virtual lists and tables, menus,
  popovers, a command palette. Videorc's look is its own: the GPUI flavour
  of videorc-ui styles `gpui-base`, as the React flavour styles Base UI
  today, and borrows gpui-component's input, editor, virtual list and table
  where `gpui-base` has none. The kit is built only after the owner has
  judged S0.4's look.
- **Guards become types and lints.** Theme tokens only (a lint rejects raw
  colours in screens), radii from the tiers, control heights from the
  primitive, a text scale that starts at 11 px, shortcuts only through
  `ShortcutKeys`, toasts that tint only their icon. The copy, toast,
  Sidekick-name and shortcut guards port as Rust tests over the string
  tables.
- **Parity is by eye and by diff:** every screen in dark, light and
  Increase Contrast against an Electron baseline shot the same day.
- **videorc-ui (ui.videorc.com) is kept and maintained (D10, decided
  2026-11-23).** It becomes the home of both flavours, React and GPUI, with
  the same names, tokens and design language. It is never frozen or
  archived.

### The GPUI flavour of videorc-ui (D3, D10)

The owner: "we have ui.videorc.com, we can just create GPUI support for our
lib." So the kit is not a private crate of the app. It is the second flavour
of the registry that already serves Videorc's React components
(`TheOrcDev/videorc-ui`, `~/projects/videorc-ui`, MIT; 89 registry items in
`registry.json`, served from `public/r/<item>.json`).

- **Where it lives.** videorc-ui gains `gpui/`, a Cargo workspace beside
  the Next.js site: `gpui/kit/src/<item>.rs`, one module per registry item
  with the same name as its React twin (`button`, `switch`, `slider`,
  `list-row`, `pane`, `status-bar`, `shortcut-keys`…); `gpui/kit/src/tokens.rs`,
  generated; `gpui/gallery/`, a binary that shows every item in dark, light
  and Increase Contrast; and one exact pin of `gpui-pre` and `gpui-base`,
  the same as the app's (D1). gpui-kit (Apache-2.0) is a dependency; code
  adapted from it keeps its notice in `THIRD_PARTY_NOTICES.md`; nothing
  comes from Zed's GPL crates.
- **One token source.** `styles/videorc.css` and `styles/desktop.css` stay
  the source; `scripts/build-theme.mjs` already turns them into the
  registry's `theme` and `desktop` items. It gains a GPUI output,
  `gpui/kit/src/tokens.rs` (every colour per appearance, radii, control
  heights, the type scale), and `theme:check` fails when it is stale. Until
  Electron is deleted, the skill's rule stays: a token goes in the desktop's
  `styles.css` and in videorc-ui's theme in the same change.
- **Publishing.** Each GPUI item is a registry item in a second index,
  `registry-gpui.json`, built into `public/r/gpui/<item>.json` and served at
  `https://ui.videorc.com/r/gpui/<item>.json`, in the shadcn item shape
  (`files` with `path`, `content` and `target`, `registryDependencies` on
  other GPUI items). Each component's docs page gets a GPUI tab beside the
  React one: the Rust usage and a gallery screenshot. Vercel builds only
  the site, so the shots are made by the gallery on CI runners (macOS
  first, then Windows and Linux) and committed; a check fails when an
  item's source changed after its shot.
- **Syncing into the app.** The model the app uses today, copied in and
  never edited here: `crates/videorc-kit/ui-registry.json` lists the synced
  GPUI items and their `keepLocal`; `pnpm ui:sync --flavour gpui [item…]`
  fetches them, writes them into `crates/videorc-kit/src/`, formats them
  with `rustfmt` and prints the diff; `--local` reads videorc-ui's dev
  server; and `pnpm ui:check` checks both flavours, so the existing
  `AGENTS.md` gate covers the kit. `ui:check` also fails when the app's
  `gpui-pre` pin differs from the registry's. Videorc's own compositions
  (screens, the Retro LCD kit) stay in `apps/videorc`, as they stay in
  `apps/desktop` today.
- **Checks in videorc-ui.** CI adds `cargo fmt --check`, `cargo clippy -D
  warnings` and `cargo test` (GPUI's headless test platform) for `gpui/` on
  macOS, Windows and Linux runners; a twin check that every GPUI item has a
  React item of the same name with the same variants and sizes; the token
  check; the shot check. The site's `pnpm build` stays free of Rust.
- **One change, both flavours.** While both flavours exist, a change to a
  component's look lands in its React and GPUI files in the same videorc-ui
  PR (the twin check enforces the names and variants; the gallery and the
  docs shots show the look). Then `ui:sync` in this repo, for each flavour
  that changed.
- **Bumping GPUI** is two PRs in order: videorc-ui first (the kit builds,
  the gallery is looked at), then this repo (`ui:sync`, the pin, the bump
  slice's checks).
- **The skill.** `videorc-design` gains a GPUI section in S2.2d: the
  primitive names map one to one, and every owner call binds both flavours.

## Every Electron job and its replacement

From a read of `apps/desktop/src` at `c0cdc36f0`. Paths are relative to
`apps/desktop/src` unless they start with `crates/`.

### Rooms (LiveKit)

Today the host joins the talk-show room from the renderer with
`livekit-client` 2.23.0 (`renderer/src/lib/talk-show-room.ts`, 10 files).
No local encoder leg feeds the show: the renderer publishes, the backend
lends the camera for the room's life, and the cloud runner composes and
records (`crates/videorc-backend/src/cloud_talk.rs:6-10`). The backend
already produces most of what the renderer publishes:

- the processed camera, backend → main → `MediaStreamTrackGenerator`
  (`main/room-frame-bridge.ts:133`, `renderer/src/lib/room-frame-source.ts:71`);
- the processed microphone and system audio as PCM into AudioWorklets
  (`main/room-pcm-bridge.ts:77`, `lib/room-pcm-source.ts:102`);
- screen share through `getDisplayMedia` behind a privacy canvas
  (`talk-show-room.ts:835`, `lib/room-private-screen.ts:34`);
- the aux and soundboard mix as screen-share audio
  (`lib/room-aux-publisher.ts:282`);
- byte streams for scene backgrounds, graphics, the avatar atlas and
  overlay cards (`room-scene-publisher.ts:393`, `talk-show-overlays.ts:197`);
- data messages for stage, privacy and latency; `getStats` for latency;
- guest speech mixed for captions (`lib/room-guest-speech.ts:86`) and the
  room program rasterised for Videorc Camera (`lib/room-program-raster.ts`).

**Replacement (D9, decided 2026-11-23): LiveKit's Rust SDK in the
backend**, confirmed on S0.8's numbers; the first beta may start without
the room, which is required before Electron is deleted. The backend
holds the camera, microphone, system audio and screen already, so it
publishes its own frames and PCM: the bridges, the camera hand-over and the
Windows camera limit go away, and the guests' frames come back to the UI
as preview feeds. Zed runs this SDK in production for calls and screen
share on macOS, Windows and Linux (through its own fork of
`livekit-rust-sdks`, 438 commits behind upstream); upstream `livekit`
0.12.0 (2026-11-18, Apache-2.0) lists all three with VideoToolbox, NVIDIA
and AMD hardware codecs. Zed's `livekit_client` wrapper is GPL and is not
used. The price is libwebrtc in the
backend (a 264 MB build input on macOS arm64; what it adds to the download
is S0.8's to measure). Part 2 of plan 220's room spike
(`videorc-rust:docs/rust-ui/spike-guests-room.md`) is the test list. The fallback is
`livekit-client` inside the page host of P5-D10.

### Stream graphics drawn in the renderer

Captions, the chat box, the highlight and milestone cards and the
Sidekick bubble are drawn with `OffscreenCanvas` and sent as PNG
(`captions.overlay.set`, `chat.overlay.set`, `comments.highlight.set`,
`buddy.overlay.set`; `lib/caption-overlay.ts:453`, `lib/buddy-overlay.ts:449`).
**Replacement:** the backend lays them out and rasterises them (plan 220
S1.2, built in `videorc-rust` with parley, swash and tiny-skia), landed in
Electron first (Phase 1).

### HTML banners

One hidden offscreen `BrowserWindow` per banner
(`main/html-overlay-host.ts:211`, `webContents.on('paint')` at `:281`, the
`videorc-overlay://` scheme), frames sent to the backend as `VHOF` records
over loopback (`main/html-overlay-frames.ts`, `crates/videorc-backend/src/html_overlay.rs`).
**Replacement:** P5-D10 as the owner took it: a Chromium (CEF) page host in
a helper process, fetched the first time a streamer imports an HTML banner
(129 MB download, 342 MB unpacked on macOS), handing frames over through
`OnAcceleratedPaint`'s shared textures; `videorc-page-host` holds the
rules. The system web view was measured and rejected (sheared CSS 3D, no
WebM alpha; `videorc-rust:docs/rust-ui/spike-html-banners.md:218-260`). GPUI's
`NativeView` can show a `WKWebView`, but banners are drawn offscreen for
the compositor, not shown in the UI, so it does not change this answer.

### Windows, menus and the shell

| Electron job | Where today | GPUI replacement |
| --- | --- | --- |
| Main window | `main/index.ts:3042` | GPUI window; title bar per the skill (traffic lights over a custom header, lifted from `videorc-rust` `frame.rs`) |
| Stream Manager, Notes, Captions reader | `:4724`, `:3780`, `:5167` | GPUI windows; width tiers as today |
| Detached Preview | `:5788` | GPUI window with its own `NativeView` (macOS) or the Windows/Linux route |
| Keep on top (Notes, Preview) | `:3780` | `WindowKind::Floating` or the NSWindow level through the raw handle |
| Hide from stream | `main/window-capture-protection.ts:136` (`setContentProtection`) | Raw handle: `NSWindow.sharingType = none` and window ids for the backend's ScreenCaptureKit filter; `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows; Hyprland rules offered as plan 257 D8 says |
| Proof surfaces | `:8025`, `:8069` | Gone: every platform has a real preview route |
| App menu | `main/app-menu.ts:152` | `cx.set_menus` (`gpui-pre src/platform.rs:522`) |
| Edit context menu with spelling | `main/context-menu.ts:67` | The input's own menu (gpui-component); spelling suggestions wait (D13) |
| Tray, dock menu, login items | none today | None needed |
| Global shortcuts | `index.ts:931-1013`, `main/global-shortcut-lifecycle.ts` | The `global-hotkey` crate on macOS and Windows (as `videorc-rust` does); the GlobalShortcuts portal on Wayland (plan 257 S11) |
| Shortcut recorder | `before-input-event` (`:3141`) | GPUI key and modifier events |
| System notifications | watchdog (`:19712`), update ready (`main/updater.ts:381`) | GPUI's system notifications (`gpui-pre-macos src/system_notifications.rs`, `gpui-pre-windows src/system_notifications.rs`); in-app toasts and the notification centre are GPUI views |
| Deep links, single instance | `videorc://` (`:10824`, `:11041-11079`, `:18227-18259`) | `cx.on_open_urls` and `register_url_scheme` (`app.rs:359`, `:2059`); the backend's registry lock plus a loopback hand-off for argv on Windows and Linux; the Linux `.desktop` writer ports |
| Auto-update | `electron-updater` 6.8.9 on `videorc.com/api/updates` (+ mirror, Windows pilot) | `videorc-updater` on the same feed format (P5-D3), a second feed for the GPUI app (P5-D6) |
| Account sign-in | PKCE in `main/account-sign-in-transactions.ts`, sealed with `safeStorage`, system browser, `videorc://account/callback` | Same flow in app-core; sealing with the OS keychain (`keyring` crate: Keychain, Credential Manager, Secret Service) |
| Provider OAuth | backend loopback `/oauth/callback` | Unchanged (it is the backend's) |
| File dialogs, reveal, trash | about 13 `dialog.showOpenDialog` sites, `shell.*` (`:16818-16959`) | GPUI's `prompt_for_paths`/`reveal_path`; trash through the `trash` crate |
| Drag and drop of files | `preload/dropped-file-paths.ts` | GPUI `on_drop` with `ExternalPaths` |
| Clipboard (write only) | `lib/copy-text.ts:26` | `cx.write_to_clipboard` |
| Display sleep guard | `main/display-sleep-guard.ts` | `IOPMAssertionCreateWithName` / `SetThreadExecutionState` / the Inhibit portal |
| TCC prompts and relaunch | `:16552-16581`, `:12713-12729`, `main/permission-relaunch.ts` | Lifted from `videorc-rust`'s `desktop/` permissions code |
| Videorc Camera activation | addon `OSSystemExtensionRequest` (`crates/videorc-native-preview-addon/src/lib.rs:1302-1313`) | The same objc2 call from the app; Linux `pkexec modprobe` ports |
| Front app and app icons | addon (`main/front-app.ts`, `main/app-icons.ts`) | objc2 in the app, as `videorc-rust` does |
| Avatar, emote, GIF cache; asset grants | main, `videorc-asset://` (`:17360`) | Backend cache (plan 220 S1.6); the UI reads files directly, no scheme |
| Agent bridge and config writes | `main/agent-bridge.ts`, `main/agent-config-install.ts` | Backend (plan 220 S1.6) |
| Crash reporting | Crashpad local only, WER helper | A panic hook and minidumps for the app; the backend's crash log as today |
| GPU fallback, Chromium switches | `main/gpu-fallback.ts`, `chromium-disabled-features.ts` | Gone. GPUI's own failure to create a device is surfaced in Health |
| Stream Deck | `apps/streamdeck-plugin` → backend | Unchanged |
| Phone remote | backend LAN server + PWA; QR drawn in the renderer with `uqr` | Unchanged; the QR drawn with the `qrcode` crate |
| MCP | `videorc_mcp` stdio bridge → backend | Unchanged |

### Media the renderer handles today

| Use | Where | Replacement |
| --- | --- | --- |
| Microphone meter (getUserMedia + Web Audio) | `lib/mic-stream.ts:180` | `audio.levels` from the backend (plan 220 S1.3) |
| Soundboard monitor, click sounds, join chime | `lib/sound-monitor.ts:124`, `hooks/use-audio-context.tsx:18`, `lib/join-request-chime.ts:93` | Backend monitor output kept out of system-audio capture (S1.3); click and chime through the same path |
| Live background (WebGL) on first run and proof surfaces | `shared/live-background-webgl.js` | The backend's `live_background/` renderers through the preview element |
| Session player (`<video>`) | `components/media/session-player.tsx:205` | Backend FFmpeg decode into the preview element (plan 220 D9) |
| Canvas thumbnails, portrait fill, hidden still | `components/camera-background/…:67`, `lib/portrait-fill.ts:37`, `lib/hidden-still.ts:245` | `image`/tiny-skia in the core or the backend |
| Charts (`recharts` sparkline) | `components/stream-manager/sparkline.tsx` | A GPUI path element (gpui-component has charts) |
| Virtual lists (`@tanstack/react-virtual`) | chat, Clean cut, Community | `uniform_list`/`list` (`gpui-pre src/elements/`) |
| ⌘K (`cmdk`), toasts (`sonner`), icons (Phosphor) | | `videorc-kit` palette and toasts; Phosphor SVGs drawn with GPUI's `svg()` |

## Migration

### Strategy (D5, D6)

- **Beside, then one switch on all three platforms (D5, D8, decided
  2026-11-23).** The GPUI app grows next to Electron against the same
  backend and data directory, and takes the bundle id at the switch. Screen-by-screen inside Electron is not
  possible: two UI processes would stack windows and fight over the
  backend's registry lock, which already refuses a second owner.
- **One repo.** The GPUI app is built in `TheOrcDev/videorc` (P5-D1 put
  the Rust app there anyway). `videorc-rust` is archived once its crates
  have moved (D2).
- **Move the brains to Rust first, shipping in Electron (Phase 1).** Each
  move is one PR, proven by today's smokes in the app streamers use, and
  leaves Electron better if the rewrite stops: the protocol crate with
  generated TS, stream graphics in the backend, meters and monitor from the
  backend, UI settings in the backend, main's side jobs in the backend.
  They were built in `videorc-rust` and never reached streamers
  (`videorc-rust:plans/220-the-whole-ui-in-rust.md:335-343`); here they are re-landed on
  today's code, not merged across 885 commits.
- **Electron keeps releasing** on all three platforms until the one switch,
  through the `videorc-release` skill. What Electron may still gain is D7.
- **Crossover (unchanged from plan 220):** an Electron release carries
  Phase 1 to every install; the GPUI app ships on a second feed only the
  bridge build and the GPUI app read; the last Electron build (the bridge)
  updates installs into the GPUI app with the same bundle id and team on
  macOS, the same NSIS install on Windows and plan 257's packages on Linux,
  all in the same release. The last Electron build
  stays downloadable for one release cycle; the UI never changes the
  backend's schema, so a rollback reads the same data.
- **No platform order (D8, decided 2026-11-23): all three switch
  together.** No macOS-first beta. Every platform reaches parity before
  anyone switches: Windows on real PCs with no waiver (the two
  contributors), Linux on its Tier 1 boxes (plan 257). Each screen slice is
  done on all three before Phase 5, so the platform passes trail each
  macOS screen PR by days, not phases.

### The drift is the largest risk

Plan 220's copy is 885 commits and 330 renderer commits behind
(`git rev-list --count 81e756ca..origin/main`), with 230 in the last six
days. In that time Electron gained Videorc Cloud and managed media, guests
and the room redesign, Avatar as its own page, Sounds, the notification
centre, two-screen layouts, background effects and more. app-core models
the app at the copy. Plan 220's "batch 1" grew from 2 to 19 slices in four
days chasing that pace. So:

- Phase 1 lands app-core in the shipping repo early and catches it up
  once, by area, with a drift list per area (the `upstream-drift.md`
  method).
- From then on, D7 (decided 2026-11-23) decides how new behaviour lands:
  any new behaviour goes into the backend or app-core (Rust) in the same
  PR that adds Electron's UI for it, and the GPUI screen gains the UI in
  its next pass. Electron takes bug fixes only once the GPUI beta starts.

### What parity means

The GPUI app is at parity when every row below works as in Electron on
macOS, Windows and Linux (D8), by eye in dark, light and the platform's
high-contrast mode, with byte-identical strings, every control reachable
by keyboard and named for the platform's screen reader (VoiceOver,
Narrator, Orca), and its smokes green with `VIDEORC_APP=gpui`. A row that
Electron does not have on a platform today (Videorc Camera on Windows) is
not a row there. The Windows-only rows (scale, snap layouts, IME, Narrator,
the installer) are in the
[Windows testing plan](260-gpui-rewrite-windows-testing.md#windows-parity-checklist).

| Area | Rows |
| --- | --- |
| Shell | Sidebar zones and ⌘1–9, ⌘0, ⌘, (`shared/sidebar-pages.ts:45`); account row and plan; status bar (Search, Preview, Notes, Stream Manager, the bell); window frame and page tabs; Health from ⌘K and the status bar |
| Studio ⌘1 | Docked preview; Session panel (Record, Go Live, alerts, agents and guests rows); quick settings; Scenes gallery; Audio section in both looks (Retro LCD); soundboard; Studio chat; vertical leg monitor; screen privacy; watchdog card; Show stage and room host |
| Sources ⌘2 | Video sources; the mixer; permission alerts |
| Scene ⌘3 | Scene list and dialogs; the freeform stage editor (gestures, nudge, undo, transforms) over the live preview; banners inspector; camera look, key and edges; Background (plan 258); hide screen; screen zoom; follow front app; scene shortcut keys |
| Captions ⌘4 | Preview, controls, host transcript; the Captions reader window |
| Output ⌘5 | Encoder, presets, Clips ring, shortcuts, Videorc Camera |
| Destinations ⌘6 | Setup, Upcoming and Discord views; destination cards; Go Live panel and dialog; broadcast info; category; thumbnail; stream quality; chat commands; watchdog; cloud; Discord; stream report email; schedule dialog |
| Guests ⌘7 | Room, moderation, cloud ISO, close room (allowance-gated) |
| Avatar ⌘8 | Profile and Greetings; pet creator and settings; living preview |
| Sidekick ⌘9 | Overview, Chat, Community, Voice, Reports, Clean cut; co-host pane |
| Images, Sounds | Banners, takeover screens, live backgrounds, background replace; sound pads and hotkeys |
| Library ⌘0 | Sessions table, poster, menus, player and markers, cloud recordings, ISO, archive, cloud clips |
| Settings ⌘, | General, Permissions, Shortcuts, Remote (phone QR), About; agents and connect-agent; OBS import; 7TV; usage |
| Dialogs | ⌘K palette; Go Live; End livestream; What's New; OBS import; Schedule; Session and cloud markers; Background replace; consents; confirm; scene picker; camera background |
| Stream Manager | Chat, activity, stats, Sidekick cards, platform filter, moderation, sounds popover, notification centre, the 420×640 tier |
| Notes | The Notes window, keep on top, hidden from stream |
| First run | Welcome backdrop, goal, look, permissions, sound, destinations; Sidekick onboarding; Linux setup alert |
| OS | Menus, deep links, global shortcuts, TCC prompts and relaunch, Videorc Camera activation, sleep guard, Hide from stream on every window, saved window frames, update UI |

The table is the outline; S0.11 generates it from the code into
`docs/gpui/parity.md` with one line per control and a column per platform,
each screen slice ticks its lines on each platform, and S5.0 regenerates
it before the switch.

## Verification

- **The smoke command server stays.** app-core already serves Electron's
  loopback command interface and prints the same `[smoke]` markers
  (`videorc-rust:crates/videorc-app-core/src/smoke/server.rs:88`). Smokes
  that assert backend state, files or ffprobe run unchanged against either
  app through `VIDEORC_APP=electron|gpui` in `scripts/lib/app-launcher.mjs`.
  The inventory counts about 20 backend-only smokes and about 35 that
  launch the app but assert on the backend.
- **The UI driver moves to the accessibility tree.** `ui-tree`, `ui-find`,
  `ui-click`, `ui-type`, `ui-key`, `ui-scroll`, `ui-set-value`,
  `ui-appearance`, `capture-page` and `resize-window`, as `videorc-rust`
  defined them, are rebuilt on GPUI's AccessKit tree (role and name
  selectors) and its window. `scripts/lib/ui-driver.mjs` stays the one
  driver for both apps; CSS selectors map through `ui-driver-map.mjs`.
- **What gets rewritten:** the 42 `eval-js` smokes and 17 CDP smokes
  (first run, the freeform editor and scene-item drag, scheduled streams,
  comment highlight, scene presets, smart scenes, the preview truth
  probes, `probe:comments-window`, `probe:ui-glass`…) become UI-driver
  smokes or app-core tests. The 14 `window.__videorc*` hooks become smoke
  commands on the core. The smoke ledger (`videorc-rust:docs/rust-ui/smoke-ledger.md`)
  is re-counted for GPUI in S2.5 and each screen slice moves its smokes.
- **Headless tests:** `TestAppContext` and `VisualTestContext` for view
  logic and focus order; the core's tests stay framework-free.
- **By eye:** the kit's `gallery` binary in videorc-ui, on all three
  platforms; the baseline harness
  (`scripts/rust-ui-baseline.mjs compare`) shoots the GPUI app against
  Electron per screen, theme and width, side by side, and an agent looks
  at every pair. The owner's looks are recorded in `docs/gpui/screens.md`.
- **Windows evidence comes from the contributors** in the form the
  [testing plan](260-gpui-rewrite-windows-testing.md#sending-evidence)
  fixes: a comment per run on the slice's PR with the machine, the commit,
  the command, a verdict per check (`PASS`, `FAIL`, `BLOCKED`), the
  spike's `summary.json`, screenshots, the app's logs and a screen
  recording. A Windows check counts once the owner has reviewed it (plan
  220 P4-D6). Raw evidence never enters the repository.
- **Gates by phase:** end of Phase 1, `pnpm smoke:local-gates` (Electron)
  on main, and the Windows smokes each Phase 1 PR names on a contributor's
  PC; end of Phase 2, the recording-studio fixtures and
  `smoke:record-latency` with `VIDEORC_APP=gpui` on macOS, and the shell
  opening and recording on a contributor's PC and on ogre; end of Phases 3
  and 4, all with `VIDEORC_APP=gpui`: `smoke:local-gates` on macOS,
  `smoke:local-gates:windows` on both contributors' PCs, and plan 257's
  matrix on its Tier 1 Linux boxes; Phase 5, the crossover proof on all
  three before any release slice, then the `videorc-release` gates.

## Spike S0.0: native preview under GPUI

Run on 2026-11-23 on the owner's M4 MacBook Pro, in a scratch crate
outside both repos (`~/gpui-scratch/spike-native-preview`, about 200
lines), against `gpui-pre` 0.3.14 from crates.io.

- **What it is:** a GPUI window with a 280 pt sidebar and a content pane.
  The pane holds a `NativeView` whose `NSView` hosts a `CAMetalLayer`. A
  plain thread outside GPUI calls `nextDrawable`, clears it to a colour
  that cycles over time and presents it, as `videorc-preview`'s presenter
  thread does. Over the video GPUI paints a translucent bordered box (an
  editor handle) and a translucent pill with text.
- **What it proved:**
  - `gpui-pre` and `gpui-pre-platform` build from crates.io with exact
    pins and no patch. A clean release build with one job took about ten
    minutes on this loaded Mac and 1.2 GB of `target/`.
  - **The video runs on its own clock:** 4,678 presents in 40.3 s (116 a
    second on the 120 Hz panel), while GPUI drew the window twice in the
    whole run. The UI does not redraw per video frame.
  - **GPUI draws over the native layer**, translucency included: the box
    and the pill blend over the video in both captures (the video is blue
    in the first, green in the second):
    `~/.local/share/ghostex/i/gpui-spike-native-preview-a.png`,
    `~/.local/share/ghostex/i/gpui-spike-native-preview-b.png`. This is
    what Slint could not do.
  - The process used 7.1 % of a core on average (12 samples, 2 s apart)
    and 67 MB RSS, presenting a drawable of about 2,370 × 1,600 px 116
    times a second.
  - Building on macOS needs Xcode's Metal Toolchain, or the
    `runtime_shaders` feature (used here).
- **What it did not prove:** no IOSurface import, no backend, no 4K, the
  window was behind other windows for part of the run, and there was no
  resize or drag test. The CPU figure is for clear-only frames and is not
  comparable to plan 220's lines. S0.1 measures the real presenter with
  the backend's ring against those lines.

## Phases and slices

Route, lane and fit per `CLAUDE.md` follow each slice. "Lane" is the
[lane](#lanes-at-least-four-agents-at-once) that owns the slice; **W** is
the Windows contributors, whose slices are numbered WC-… in the
[Windows code plan](260-gpui-rewrite-windows-code.md) and tested by the
[Windows testing plan](260-gpui-rewrite-windows-testing.md).

### Phase 0: prove it, on all three platforms (gate)

Phase 0 gates every GPUI slice from Phase 2 on. It passes when S0.1, S0.2
and S0.3 meet their lines, the owner has judged S0.4 (D3) and taken D12 on
S0.2's numbers, and S0.5 to S0.7 leave no gap without a known fix on any
platform. S0.8 and S0.9 inform the plan and do not gate it.

| # | Slice | Where | Lane | Route · lane · fit | Done when |
| --- | --- | --- | --- | --- | --- |
| S0.1 | macOS preview with the real backend: `videorc-preview`'s presenter in a `NativeView`, the IOSurface ring at 4K60, docked and floating, editor handles over the video | This Mac: a quiet machine and an unoccluded window; one build slot for the backend | L1 | Diagnose · `fable-5.1` · 9 | Plan 220's week-1 lines pass for 10 min at 4K60: zero CPU copies, present p95 ≤ 20 ms, still frame ≤ 3 % CPU, live ≤ 10 %, ≤ 2 ms GPU per frame, floating window out of capture; and the editor overlay adds ≤ 1 % CPU while idle |
| S0.2a | GPUI on Windows: the frame spike, then routes (a), (b) and (d) in one process with synthetic frames | Both contributors' PCs | W (WC-0.1 to WC-0.4) | Contributors; reviewed as Diagnose · `fable-5.1` · 9 | The testing plan's S0.2a checks on both PCs; the patch sizes of (a) and (b) |
| S0.2b | The backend hands its preview over on Windows: a DirectComposition surface handle for (a), shared NT-handle textures with a keyed mutex for (b), the shared-memory ring for (d), and the lease message that names them | This Mac (`pnpm check:windows`); run on a contributor's PC | L2 | Implementation · `fable-5.1` · 9 | Windows CI green; a contributor's spike receives frames by each route |
| S0.2c | Routes (a) to (d) measured with the real backend at 4K60 | Both contributors' PCs | W (WC-0.5) | Contributors | Numbers per route on both PCs against S0.1's lines, reviewed by the owner; the owner takes D12 |
| S0.3 | Linux preview: the Wayland subsurface and the X11 child under GPUI's wgpu window | ogre (Hyprland, and one X11 session) | L5 | Diagnose · `fable-5.1` · 8 | It presents below GPUI content at the camera's rate on both sessions, within S0.1's CPU lines; GNOME and KDE wait for the second box (a Phase 4 gate, not this one) |
| S0.4 | Liquid Chrome in GPUI: Button (every variant), Switch, Slider, the Record button, a pane with sidebar and toolbar, in dark, light and Increase Contrast | This Mac, in `~/gpui-scratch` (its warm target needs no slot); the same spike on Windows and ogre | L3 (+ W WC-0.6, L5) | UI/Product Design · `opus-5.5` · 9 | Side-by-side shots against Electron; the owner judges macOS equal by eye (D3); the Windows (DirectWrite) and Linux shots show nothing the owner rejects |
| S0.5 | Text: IME (Japanese, Chinese) on each platform, colour emoji, font fallback, selectable text, tabular numbers, a 10,000-row chat with inline animated WebP emotes | This Mac; W (WC-0.7); ogre (fcitx5 on Wayland, XIM on X11) | L4 (+ W, L5) | Implementation · `fable-5.1` · 8 | Scrolls at 60 fps with ≤ 100 MB extra and first paint ≤ 100 ms; IME commits correctly on each platform; the gaps are listed against D13 |
| S0.6 | Accessibility and testing: VoiceOver, Narrator and Orca read a list and a dialog; a headless test clicks Record; the UI driver finds a control by role and name through AccessKit | This Mac; W (WC-0.8); ogre | L4 (+ W, L5) | Implementation · `fable-5.1` · 8 | All work on each platform, or the gap and its patch size are reported (`gpui-pre-windows` depends on `accesskit_windows`; Zed's Windows screen-reader issue #41138 is still open) |
| S0.7 | Desktop: menus, the title bar over a custom header, a global hotkey, a deep link on a cold start, single instance, window ordering, Hide from stream, sleep guard, notifications, files | This Mac; W (WC-0.9); ogre | L4 (+ W, L5) | Implementation · `gpt-6.1-sol` · 8 | Each works on each platform, or the gap is listed |
| S0.8 | Rooms: LiveKit's Rust SDK in the backend against a local `livekit-server`, with a browser guest (plan 220 room spike Part 2's nine checks) | This Mac; one build slot | L2 | Diagnose · `fable-5.1` · 9 | The nine checks pass or the report names the blocker; the download size added is measured; D9 confirmed |
| S0.9 | Build, bump and start-up: clean and incremental build time and disk per platform; cold start to first paint and to `backend.ready` against Electron's; a weekly `gpui-pre` bump rehearsed | This Mac (one slot); ogre; W (from WC-0.1) | L4 (+ L5, W) | Research · `gpt-6.1-sol` · 7 | Numbers in this plan; start-up no slower than Electron's; the bump's breakage counted in lines |
| S0.10 | The Electron baseline: screenshots of every window, page, tab and dialog in three appearances, per platform; idle and live cost of Electron's processes | This Mac (the dev app's backend build takes a slot); W (the current Windows Alpha); ogre (the Linux Alpha) | L6 (+ W, L5) | Implementation · `gpt-6.1-sol` · 8 | The archive exists outside the repo with its manifest committed (plan 220 S0.1 reused) |
| S0.11 | The parity list from the code: `docs/gpui/parity.md`, one line per control, a column per platform | Docs only, no build | L6 | Research · `gpt-6.1-sol` · 8 | Every row of [What parity means](#what-parity-means) expanded; its Windows column is the testing plan's checklist |
| S0.12 | The spikes branch: `spikes/gpui` in `TheOrcDev/videorc` with a spikes workspace, S0.0's spike as the model, the `summary.json` format and a README per spike | This Mac, no slot | L6 | Implementation · `gpt-6.1-sol` · 7 | A contributor can clone it, build the model and see the summary format; nothing reaches `main` |

#### S0.9 results on macOS (2026-11-24, lane L4)

The spikes workspace (`spikes/gpui`), `gpui-pre` 0.3.14, the owner's M4
MacBook Pro, `CARGO_BUILD_JOBS=1` in a fresh target under the build slot,
load average 3 to 5. Evidence: `~/cloud-test/reports/2026-11-23-plan-260/s0-9/`.

| What | Number |
| --- | --- |
| Clean release build (`spike-desktop`: GPUI, menus, hotkey, trash) | 263 s, 1,170 MB of target |
| Incremental release build (one file touched) | 4.6 s |
| Clean debug build, same target | 147 s, +2,255 MB (3,425 MB with release) |
| Incremental debug build | 1.0 s |
| Release binary | 10.0 MB; 7.4 MB stripped (`spike-text` 13.1 / 10.0 MB) |
| A spike as a signed `.app` | 7.0 MB; 3.1 MB zipped, 3.6 MB as a DMG |
| Today's Electron app (0.37.x, installed) | 491 MB; 203 MB zipped. Electron's framework (254 MB, 109 MB zipped) and `app.asar` (97 MB, 23 MB zipped) are what GPUI removes; the backend, FFmpeg, MCP and assets that stay zip to 67 MB |
| Bump, one week (0.3.13 → 0.3.14), all five spike crates | 2 lines break, both `gpui::NativeView`, new in 0.3.14 |
| Bump, one month (0.3.10 → 0.3.14) | 7 lines break: the same 2, and 5 in the input element copied from GPUI's own example (the `Element` trait changed). Menus, windows, notifications and the accessibility API compiled unchanged |
| Start-up, launch to the first window with content (5 rounds, measured from outside the app: window list, then ScreenCaptureKit) | GPUI `spike-text` (10,000-row chat) median **297 ms** (285 to 592); `spike-desktop` 332 ms (315 to 423). Electron 0.37 (the installed app, a fresh isolated profile) median **706 ms** (633 to 1,449), and its first launch showed no window within 2 s. Load average 2.9 to 3.4 |
| `backend.ready` | Electron spawns the backend 310 to 330 ms after launch; ready follows 40 to 45 ms later on a fresh profile (744 ms in one round; 0.7 to 1.2 s on the owner's real data, from the installed app's log). A GPUI app spawns it first thing in `main`, so `backend.ready` arrives about 300 ms earlier |

- A release build needs Xcode's Metal Toolchain: without `runtime_shaders`
  `gpui-pre-apple`'s build script runs `xcrun metal`, which fails here
  ("missing Metal Toolchain"). The GPUI start-up numbers include
  compiling the shaders at launch (`runtime_shaders`), so they are an
  upper bound for a release build. Start-up passes S0.9's line ("no
  slower than Electron's"): about 400 ms faster to first content.
- Expected download for the GPUI app: about 75 to 95 MB against 203 MB
  today, depending on the final binary (the spikes are 3 to 4 MB zipped).
- Bumps are cheap so far, and `NativeView` (the macOS preview's
  foundation) is a week old in `gpui-pre`: keep the exact pin (D1).

#### S0.9 results on Linux (2026-11-24, lane L5)

ogre (Omarchy, Hyprland 0.56.2, i7-8750H, 16 GB), the spikes workspace,
`gpui-pre` 0.3.14, `CARGO_BUILD_JOBS=3` in a fresh target under the box's
build lock. **The T2 firmware pinned every core at 800 MHz for the builds**
(a fifth of the box's clock); start-up was measured in both clock states
and is given per state. The owner's session was locked, so the apps ran in
a nested Hyprland on the lab output. Evidence: `~/linux-beta/plan260-s0-9/`
on ogre.

| What | Number |
| --- | --- |
| Clean release build (`spike-desktop`), 800 MHz | 1,222 s, 1,916 MB of target |
| Incremental release build (one file touched) | 17.2 s |
| Clean debug build, same target | 410 s, 5,638 MB with release |
| Incremental debug build | 9.5 s |
| Release binary | 46.6 MB; **30.0 MB stripped**, 11.4 MB gzipped (macOS: 7.4 MB stripped: Linux carries wgpu's Vulkan path, Wayland and X11, cosmic-text and zbus) |
| Today's Electron app (the Linux Alpha, 0.37.0, unpacked) | 699 MB: Electron and Chromium, `app.asar` 97 MB, FFmpeg 220 MB, the backend 88 MB |
| Start-up, launch to the first frame with content (measured from outside: the nested compositor's client list, then `grim` frames), **4 GHz** | GPUI `spike-text` (10,000-row chat) **351 to 355 ms** (3 rounds); `spike-desktop` 370 to 371 ms (3). Electron, the Linux Alpha on a fresh isolated profile, **1,429 and 1,701 ms** (2 rounds) |
| The same, **800 MHz** | GPUI `spike-text` 1.50 to 1.67 s (5), `spike-desktop` 1.63 to 1.69 s (4); Electron 6.72 to 6.87 s (3) |
| `backend.ready` | Electron spawns the backend 539 to 548 ms after launch at 4 GHz and it is ready 94 to 107 ms later (634 to 654 ms after launch); at 800 MHz 2.51 to 2.62 s and 2.60 to 2.70 s. A GPUI app spawns it first thing in `main`, so about 0.5 s earlier at 4 GHz |
| Bump, one week (0.3.13 → 0.3.14), all six spike crates, `cargo check` on Linux | **0 lines break** (macOS's 2 are `gpui::NativeView`, macOS only); 240 s cold at 800 MHz |
| Bump, one month (0.3.10 → 0.3.14) | **5 lines break**, the same 5 as macOS: the input element copied from GPUI's own example (`TextElement` no longer an `IntoElement` under 0.3.10's `Element` trait). The Linux-only code (the preview presenter in `spike-linux-preview`, `spike-desktop`'s Linux `os.rs`, `spike-a11y`) compiled unchanged against both |

- Start-up passes S0.9's line on Linux too: GPUI shows content about 4x
  sooner than Electron at either clock (about 1.1 to 1.3 s sooner at 4 GHz).
  A fresh Linux Alpha also opens the microphone and camera before its
  first frame (its meters and device list were live in the first screenshot).
- The GPUI binary is four times larger on Linux than on macOS; a Linux
  package of the GPUI app plus the backend and FFmpeg is still well under
  today's 699 MB.

### Phase 1: the core lands in the shipping repo (ships in Electron, starts now)

Phase 1 needs no GPUI, and each move leaves Electron better if the rewrite
stops, so it runs beside Phase 0 (D2). Only S1.8 waits, on S0.8. Each
move that changes Windows behaviour in today's app is also run on a
contributor's PC (the testing plan's Phase 1 row).

| # | Slice | Lane | Done when |
| --- | --- | --- | --- |
| S1.0 | The workspace scaffold: the root `Cargo.toml` members and `[workspace.dependencies]` for every crate this plan adds (empty crates, each with a README naming its lane), so no later lane edits the root manifest | L2 | CI green on all three platforms; each new crate compiles empty |
| S1.1 | `videorc-protocol` extracted from `protocol.rs` (moved to L4, approved 2026-11-24, while L2 runs S0.2b: S1.1a the Rust extraction, the backend's behaviour identical and its tests the proof; S1.1b `backend.ts` generated); later protocol changes stay with L2 | L4 | Contract tests and `protocol-fixtures/` pass on both sides; Windows and Linux CI compile |
| S1.2 | Stream graphics in the backend (captions, chat box, cards, Sidekick bubble) | L2 | Golden images match the renderer's within a threshold and by eye; `smoke:captions-live`, `smoke:comment-highlight-stream` and a record-plus-stream smoke pass on macOS and on a contributor's PC |
| S1.3 | Meters from `audio.levels`; the monitor, clicks and chime from the backend | L2 | `smoke:soundboard`, `smoke:system-audio` and the mixer tests pass on macOS and on a contributor's PC; the meter, monitor, click and chime paths use no getUserMedia or AudioContext (the room microphone keeps its renderer graph, `lib/room-microphone-source.ts:257`, until S1.8 moves rooms) |
| S1.4 | UI settings into `app_settings`, with a one-time migration | L2 | `smoke:first-run` and `smoke:scene-presets` pass on a profile from the previous release |
| S1.5 | Main's side jobs to the backend: avatar/emote/GIF cache, comments history, thumbnails, agent config writes, OBS import | L2 | Their tests move with them; main owns none of them |
| S1.6s | `videorc-app-core`'s shell lands from `videorc-rust` (moved to L4, approved 2026-11-24): the app log, crash log and restart policy; then the process launch, paths, the ledger and the supervisor; then the typed client (after S1.1); then `desktop/` (one instance, deep links, permissions, global shortcuts, the menu model, the sleep guard, Videorc Camera). Module paths stay as in `videorc-rust`, so L1's `videorc-preview` (S1.7) compiles unchanged; L1's S1.7b waits on the logger, the supervisor and the client | L4 | Each part's tests pass; its drift against Electron main (`backend-log-file.ts`, `backend-crash-log.ts`, the supervisor in `index.ts`, `backend-bootstrap.ts`, `backend-isolation.ts`) is checked and listed in its PR |
| S1.6a–f | `videorc-app-core` lands and catches up, one area per slice: session and Studio; scenes, sources and the editor; live, destinations, Go Live, cloud; guests and rooms; Sidekick, Avatar, chat, notifications; Library, Settings, first run | L7 | Each area's drift list is empty, its core tests pass, and the smokes it can run headless pass |
| S1.7 | `videorc-preview`, `-gpu-import` and `-preview-ring` land (L1); `-updater` and `-page-host` land (L2) | L1, L2 | Their tests pass on all three CI platforms |
| S1.8 | Rooms in the backend (D9) | L2 | The room spike's checks pass from Electron with the backend publishing; `livekit-client` leaves the renderer |

Routes: S1.2, S1.3, S1.6a, S1.6d and S1.8 touch recording, audio or rooms:
Implementation · `fable-5.1` · 9. The rest: Implementation · `gpt-6.1-sol`
· 8.

### Phase 2: the shell, on all three platforms

| # | Slice | Lane | Done when |
| --- | --- | --- | --- |
| S2.1 | `apps/videorc` starts: supervisor, registry lock, logs, crash log, typed client, the store bridge; CI builds it on macOS (with the Metal Toolchain on the runner), Windows and Linux | L4 | The main window opens with the sidebar and empty pages, and `backend.ready` arrives, on this Mac, on a contributor's PC and on ogre |
| S2.2a | videorc-ui's `gpui/` workspace: the pin, `tokens.rs` from the theme CSS, the gallery, CI on three runners | L3 | `theme:check` covers `tokens.rs`; the gallery runs on all three |
| S2.2b | Publishing and syncing: `registry-gpui.json`, `public/r/gpui/`, the docs' GPUI tab; `ui:sync --flavour gpui` and `ui:check` for both flavours here | L3 | A test item round-trips (edited in videorc-ui, deployed, synced here) and `ui:check` fails on a local edit |
| S2.2c | The primitives the skill lists, on S0.4's route, in a few videorc-ui PRs, then synced | L3 | The gallery matches the React docs by eye in three appearances on macOS; Windows and Linux shots from W and L5; the twin check is green |
| S2.2d | The `videorc-design` skill's GPUI section and the guard tests (tokens only, radii tiers, text scale from 11 px, `ShortcutKeys`, icon-only toast tint) | L3 | Each guard fails on a planted violation |
| S2.3a | The preview element on macOS, docked and floating, with the first-frame contracts and fallback labels | L1 | The GPUI forms of `probe:preview-lifecycle` and `probe:preview-window` pass; the owner judges it against S0.10 |
| S2.3b | The preview element on Windows on D12's route | W (WC-2.2), reviewed by L1 | The testing plan's S0.2c checks pass against the real app on both PCs |
| S2.3c | The preview element on Linux on S0.3's route | L5 | It presents on ogre on Wayland and X11 within S0.1's lines |
| S2.4 | The core runs a session from the UI: Record, Stop, a minimal Go Live | L7 | The owner records from the skeleton on macOS; a contributor and ogre record too |
| S2.5 | The smoke command server and the AccessKit UI driver; `VIDEORC_APP=gpui`; the smoke ledger re-counted for GPUI | L6 | `smoke:record-latency`, `smoke:recording-matrix` and the recording-studio fixtures pass with it on macOS |
| S2.6a | OS integration on macOS from S0.7, behind one OS interface (`apps/videorc/src/platform/`) | L4 | Menus, shortcuts, deep links, TCC and relaunch, Videorc Camera activation, sleep guard, Hide from stream, saved frames |
| S2.6b | OS integration on Windows | W (WC-2.4 to WC-2.7) | The testing plan's Windows rows for them pass on both PCs |
| S2.6c | OS integration on Linux: the desktop entry, the GlobalShortcuts and Inhibit portals, Secret Service, plan 257's setup alert | L5 | The same rows pass on ogre |

Routes: Orchestrator · `fable-5.1` · 10 for S2.1, S2.3a, S2.5; UI/Product
Design · `opus-5.5` · 9 for S2.2a–d; Implementation · `gpt-6.1-sol` · 8 for
S2.4 and S2.6a; S2.3c and S2.6c: Implementation · `fable-5.1` · 8.

**S2.3a, from S0.1 (2026-11-23).** S0.1 passed every line with plan 220's
element unchanged
([`spikes/gpui/spike-preview-backend`](https://github.com/TheOrcDev/videorc/pull/1718)).
It found one gap S2.3a closes: after a surface is destroyed and created again
(the suspend path, `preview.surface.destroy` then `create`), `main`'s backend
refuses every lease until a fresh scene commit, and the element only gets
there through its watchdog's resync-scene step, 4.6 to 5.2 s later. The lease
loop re-commits the scene itself right after `preview.surface.create`, and
S2.3a's GPUI `probe:preview-lifecycle` asserts frames within one second of
the new surface. Hosting under GPUI: a layer-hosting `NSView` (flipped root
layer) goes to `NativeView`, the element attaches to that view's handle, and
its `CAMetalLayer` gets an autoresizing mask and the slot's corner radius.

### Phase 3: screens to parity on all three platforms

One PR per screen, owned by one screen lane, done by the parity bar above
on macOS; behind it, L5 and the contributors run the screen's Linux and
Windows pass and fix platform-only problems in their own small PRs. A
screen is done when its lines in `docs/gpui/parity.md` are ticked on all
three. Each lane owns its screens' folders under `apps/videorc/src/screens/`;
the Studio is split by sub-folder between L1 and L7.

| Lane | Screens, in order |
| --- | --- |
| L1 (preview) | Studio: preview and session; Scene with the freeform editor (two); Library with its player (two) |
| L3 (kit) | Settings; Images and Sounds; Avatar; ⌘K; the dialogs; the notification centre and toasts |
| L4 (shell) | Sources; Output; Captions and the reader; Destinations and the Go Live dialog (two); first run; Health |
| L7 (core) | Studio: audio in both looks; Studio: scenes and chat; the Stream Manager (two) and Notes; Guests; Sidekick (two) |
| L6 (harness) | Each screen's smokes moved to the UI driver; the baseline pairs shot and compared |
| L5 (ogre) | Each screen's Linux pass |
| W | Each screen's Windows pass; fixes as WC-3.x |

About 30 screen slices and as many platform passes. Routes: UI/Product
Design · `opus-5.5` · 9; the Studio, the Scene editor, the Stream Manager
and Guests take `fable-5.1`.

### Phase 4: platform finish (beside Phase 3)

- **Windows** (W: WC-4.1 to WC-4.3): the smokes through the GPUI app, the
  NSIS installer upgrading an Electron install in place, the updater.
  _Done when:_ `smoke:local-gates:windows` passes with `VIDEORC_APP=gpui`
  on both contributors' PCs, and a contributor records and streams on each
  PC with evidence the owner has reviewed (no waiver).
- **Linux** (L5, about 8 slices, with plan 257's beta work): the first run
  on Wayland and X11, the desktop entry and deep links, packages, every
  screen. _Done when:_ plan 257's matrix passes with the GPUI app on its
  Tier 1 boxes (ogre and the second box).
- **macOS** (L4): the remaining OS rows found by the screens.

Routes: the first run on each machine and the preview: `fable-5.1` · 9;
screens: `opus-5.5` · 8; packaging: `gpt-6.1-sol` · 8.

### Phase 5: one switch

S5.0 the parity file regenerated and the crossover proof on all three (an
installed, signed Electron build updates into a signed GPUI app with every
setting, grant and sign-in kept: macOS by L2, Windows by W in WC-5.1,
Linux by L5); S5.1 packaging per platform (a: macOS without
electron-builder, with entitlements, the camera extension and app group,
hardened runtime, notarisation, DMG, a `check-packaged-app` equivalent and
the Metal Toolchain on the release machine, L4; b: the Windows NSIS
installer signed by our workflows, W with WC-4.2; c: Linux packages, L5);
S5.2 the updater wired, its UI and the second feed on all three, the
release scripts and the `videorc-release` skill (L2); S5.3 a week on the
signed builds, Electron and GPUI back to back (the owner on macOS, the
contributors on Windows, ogre on Linux); S5.4 the opt-in beta on all three
at once (it may start without the room, D9); S5.5 the bridge release on all
three. About 14 slices. Every release slice: Release · `fable-5.1` · 10.

### Phase 6: delete Electron

One release cycle after the switch, on the owner's go, and only with the
room in (D9): remove `apps/desktop`, the Electron and React dependencies,
the desktop's React sync (`apps/desktop/ui-registry.json`; ui.videorc.com
keeps both flavours, D10), the TS mirrors and Electron-only smokes, the
native preview addon, the BMP proof surface and the PNG overlay
parameters; rewrite `AGENTS.md`, `CLAUDE.md` and the `videorc-design` skill
for GPUI first; delete the `spikes/gpui` branch; archive `videorc-rust`.
About 6 slices.

## Lanes: at least four agents at once

The owner, 2026-11-23: "always have a minimum of 4 agents working on
different slices." The slices above run in seven lanes on our side, each
owning its own crates and files, so at least five agents can work at once
in every phase without editing the same files. The Windows contributors are
extra and are not counted.

### The lanes

| Lane | Owns (only this lane edits these) | Machine | Build weight |
| --- | --- | --- | --- |
| L1 Preview | `crates/videorc-preview` (except its Linux files), `-gpu-import`, `-preview-ring`; `apps/videorc/src/preview/`; the screens in L1's row of Phase 3 | This Mac | Heavy once per phase (S0.1's backend build, a cold target), then light |
| L2 Backend and contracts | `crates/videorc-backend`, `crates/videorc-protocol` (its extraction, S1.1, by L4), `crates/videorc-updater`, `crates/videorc-page-host`, the generated `backend.ts`, the root `Cargo.toml` and `Cargo.lock` (S1.0 and bumps only), the release scripts | This Mac | Heavy: every slice compiles the backend |
| L3 Kit | videorc-ui's `gpui/`, `scripts/build-theme.mjs` and registry files; `crates/videorc-kit`; `scripts/sync-ui.mjs` and `scripts/lib/ui-registry.mjs`; the design skill; L3's screens | This Mac | Light: a warm GPUI target, no backend |
| L4 Shell and OS | `apps/videorc/src/main.rs`, `app/`, `platform/mod.rs`, `platform/macos/`; `videorc-app-core`'s shell modules (`src/log.rs`, `crash_log.rs`, `restart.rs`, `process.rs`, `paths.rs`, `ledger.rs`, `supervisor.rs`, `client/`, `desktop/`; moved from L7, approved 2026-11-24); L4's screens; macOS packaging | This Mac | Light, except S0.9 and release builds |
| L5 Linux | `apps/videorc/src/platform/linux/`, `crates/videorc-preview/src/linux*`, Linux packaging; every Linux pass | ogre: one Rust build at a time under `~/linux-beta/ogre-rust.lock`, `cargo -j3` | Its own machine |
| L6 Harness and parity | `scripts/lib/app-launcher.mjs`, `scripts/lib/ui-driver*.mjs`, the smoke scripts as they move, `apps/videorc/src/smoke/`, `docs/gpui/`, the baseline archive, the `spikes/gpui` branch | This Mac | Light; S0.10's dev-app build takes a slot |
| L7 Core | `crates/videorc-app-core` except L4's shell modules; L7's screens | This Mac | Light: app-core does not compile the backend |
| W Windows (extra) | `apps/videorc/src/platform/windows/`, the GPUI Windows patch crates, the Windows installer; their spikes on `spikes/gpui` | Two contributors' PCs | Theirs |

### What each lane does next

`→` means "then"; `[…]` is a wait on another lane or the gate.

- **L1:** S0.1 → S1.7 (its crates) → [Phase 0 gate] → S2.3a → Studio
  preview and session → the Scene editor (two) → Library (two); reviews
  S2.3b.
- **L2:** S1.0 → S0.2b → [S1.1, by L4] → S0.8 → S1.2 → S1.3 → S1.4 → S1.5 → S1.7
  (its crates) → S1.8 → backend fixes the screens find → S5.2 → S5.0 on
  macOS.
- **L3:** S0.4 → [the owner's look, D3] → S2.2a's token output (plain
  JavaScript in `build-theme.mjs`, no GPUI) → [Phase 0 gate] → the rest of
  S2.2a → S2.2b → S2.2c (a few PRs)
  → S2.2d → L3's screens.
- **L4:** S0.7 → S0.5 → S0.6 → S0.9 → [S1.0] S1.6s (the logger, crash log and supervisor first, for L1's S1.7b; the client after [S1.1]) → [gate] → S2.1 → S2.6a → L4's screens
  → S5.1a.
- **L5:** S0.3 → the Linux halves of S0.4 to S0.7, S0.9 and S0.10 → [gate]
  → S2.3c → S2.6c → each screen's Linux pass → Phase 4's Linux slices →
  S5.0 and S5.1c on Linux.
- **L6:** S0.12 → S0.11 → S0.10 → [S2.1] S2.5 → each screen's smokes →
  S5.0's parity file.
- **L7:** [S1.1] S1.6a → b → c → d → e → f → [S2.1] S2.4 → L7's screens.
- **W:** WC-0.1 → WC-0.2 to WC-0.4 and WC-0.5's route (c) → [S0.2b] WC-0.5
  → the owner takes D12 → [S2.1, S2.3a] WC-2.x → WC-3.x → WC-4.x → WC-5.1.

### Dispatch table

At most two heavy builds on this Mac at a time; at least five of our lanes
busy in each window.

| Window | Heavy on this Mac (≤ 2) | Light on this Mac | ogre | Windows contributors (extra) |
| --- | --- | --- | --- | --- |
| **Now** (Phase 0, Phase 1 starts) | L1 S0.1; L2 S1.0 → S0.2b | L3 S0.4; L4 S0.7; L6 S0.12 → S0.11 | L5 S0.3 | WC-0.1 on both PCs, then WC-0.2 (one) and WC-0.5's route (c) (the other) |
| After S1.1 merges | L2 S0.8 → S1.2…; L6 S0.10 when L1 is light | L1 S1.7; L3 the owner's look → S2.2a's token output (the rest of S2.2a waits for the gate); L4 S0.5 → S0.6; L7 S1.6a… | L5 the Linux halves | WC-0.5 routes (a), (b), (d) after S0.2b; WC-0.6 to WC-0.9 |
| Phase 2 (after the gate) | L2 Phase 1's tail; one cold build at a time from L1 (S2.3a) or L4 (S2.1) | L3 S2.2a–d; L6 S2.5; L7 S1.6's tail → S2.4 | L5 S2.3c, S2.6c | WC-2.1, WC-2.2, WC-2.4 to WC-2.7 |
| Phase 3 | L2 backend fixes and S1.8 | L1, L3, L4, L7 screen PRs (warm targets); L6 smokes | L5 each screen's Linux pass | WC-3.x Windows passes |
| Phases 4 and 5 | L2 S5.2; L4 release builds | L6 the parity file; L3 the kit's polish | L5 Linux packages and passes | WC-4.x, WC-5.1 |

### Builds, worktrees and disk on this Mac

- **Two shared build slots.** Heavy builds run through
  `node scripts/with-build-slot.mjs <command>` (two slots machine-wide,
  shared with other sessions), so at most two are heavy at once. Heavy
  means anything that compiles `videorc-backend` (a full backend test build
  has peaked at 41 GB of memory: one at a time, `--bin videorc-backend -j
  1`), a cold GPUI build into a new target, a release build, or a
  workspace clippy. Light means a warm incremental build or test of a
  crate that does not compile the backend (the kit, app-core, the
  protocol, the preview crates, the GPUI app with a warm target), with
  `CARGO_BUILD_JOBS=2` and no slot.
- **Lanes plan around the slots.** L2 is heavy by nature; L1, L4 and L6
  are heavy about once per phase; L3 and L7 never compile the backend. A
  lane waiting for a slot writes code, docs or tests meanwhile and batches
  its gates at the end of the slice.
- **One worktree per lane,** made from fresh `origin/main`:
  `~/projects/videorc-wt-260-l<N>`, reused across the lane's slices with a
  new branch per slice (`gpui/<slice>-<words>`). L3 also has
  `~/projects/videorc-ui-wt-260-kit`.
- **One Cargo target per lane, never shared between lanes:**
  `CARGO_TARGET_DIR=~/projects/.targets/260-l<N>`. A target shared across
  worktrees once ran another worktree's stale binary (2026-11-22). Within
  a lane the target stays warm. A new lane that needs GPUI starts from an
  APFS clone of a warm target (`cp -cR`, near-free on this disk) instead
  of a cold build: L3 keeps `~/gpui-scratch/target` (S0.0's build), and L1
  and L4 begin from clones of it. GPUI's share: a clean release build of
  `gpui-pre` took about ten minutes on one job and 1.2 GB (S0.0); a debug
  target that includes the backend takes 25 to 33 GB.
- **Disk is the hard limit today: 31 GB free (97 % used) on 2026-11-23.**
  Two backend targets alone exceed it. Free at least 120 GB before more
  than one heavy lane starts (`pnpm clean:worktrees --apply`, the targets
  of finished lanes), and remove a lane's target when the lane ends.
- **The Metal Toolchain.** Until Xcode's Metal Toolchain is installed
  (`xcodebuild -downloadComponent MetalToolchain`, an owner action on this
  Mac), every macOS lane builds with GPUI's `runtime_shaders` feature,
  which is for development only. Release builds (S5.1a) and the macOS CI
  runner (S2.1) need the toolchain.
- **ogre** runs L5 only: one Rust build at a time under
  `flock ~/linux-beta/ogre-rust.lock`, `cargo -j3`.

### Merging without blocking

- One slice, one small PR to `main` (under about 800 changed lines,
  generated files aside). A lane's agent merges its own PR once CI is
  green and its review route has passed: squash, never `--admin`.
- Every file has one owner lane (the table above). A change a lane needs in
  a file it doesn't own is a small PR by the owning lane first: protocol
  changes by L2, kit changes by L3 in videorc-ui. The shared files (root
  `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `AGENTS.md`,
  `plans/README.md`) change only in S1.0, in a GPUI bump, or in a PR of
  their own.
- The author rebases: whoever merges second rebases their own branch on
  `origin/main`; nobody rebases another lane's branch. `Cargo.lock` and the
  generated files (`backend.ts`, `tokens.rs`, synced kit files) are
  regenerated after a rebase, never merged by hand.
- Protocol changes stay additive while Electron lives, so a merged
  protocol PR never breaks another lane's open branch.
- The orchestrator keeps the dispatch table full, gives a free lane its
  next ready slice at once, and runs the full gates on `main` after each
  batch of merges.

## Sizing

From plan 220's measured pace (Phase 2's 19 slices in three days; Phase 3
at 54 of 65 slices in nine days, with one to three lanes), the lanes above,
and what is new here:

- **Phase 0:** two to three weeks. The Windows half sets the end (the
  contributors' time, and S0.2b before WC-0.5); S0.4 needs the owner's eye.
- **Phase 1:** three to five weeks, beside Phase 0. The catch-up (S1.6) is
  the bulk and is set by the shipping repo's pace; each move also waits
  for an Electron release.
- **Phases 2 and 3:** five to seven weeks with five lanes, the Linux and
  Windows passes trailing each screen by days. The owner's looks and the
  contributors' passes set the end more than building does.
- **Phase 4:** beside Phase 3, plus two to four weeks after the last
  screen, mostly the Windows installer, the updater and the gate runs on
  both PCs.
- **Phase 5:** six to ten weeks, mostly waiting that agents cannot
  shorten: an Electron release carrying Phase 1, a week on the signed
  builds, two weeks of beta.

That puts the one beta on all three platforms in April 2027 at the
earliest and the switch in May. It is an estimate from plan 220's pace, not
a commitment. It holds only if D7 stops the drift, Phase 0 passes without
a toolkit fork, the disk is freed for the lanes, and the Windows
contributors keep pace: their time is the largest unknown, because nothing
switches without Windows.

## Risks

| Risk | Mitigation |
| --- | --- |
| GPUI has no stable release; weekly snapshots break the build | Pin `gpui-pre` and gpui-kit exactly (D1); bump on purpose, at most monthly, in one slice that runs the gallery, the headless tests and the preview probes; S0.9 rehearses a bump |
| GPUI is built for Zed first: on 2025-12-12 Zed declined outside PRs with no Zed use case (custom shaders, a tray), and that still holds; `NativeView` is one day old | The core stays framework-free (the test is kept), so a swap costs the kit and screens only; any patch is kept in a fork of the platform crates and sent upstream; a fourth patch is a STOP |
| Native views exist only on macOS, and all three platforms switch together | S0.2 and S0.3 measure the Windows and Linux routes before any screen; a miss on every route of either platform is a STOP |
| Windows rests on two outside contributors; their pace sets the switch | Cold-start docs and self-contained slices; we do the backend half (S0.2b) first; either contributor can take any slice; macOS and Linux keep moving, since only the switch waits on Windows |
| Windows evidence is remote and second-hand | One fixed evidence form (testing plan); the owner reviews it before a check counts; screen recordings and logs, not summaries |
| Liquid Chrome needs multi-stop and radial gradients | S0.4 by the owner's eye before the kit is built, with the Windows and Linux shots beside it |
| Two component flavours drift apart | Same names, one token source, the twin check, and both flavours changed in one videorc-ui PR |
| The drift: Electron gains features weekly | Phase 1 lands the core early; D7's rule; a drift list per phase |
| `use-studio.tsx` (22,187 lines) hides behaviour | app-core already ports it with tests (`studio-state-port.md`); S1.6's catch-up re-reads the diff since the copy; the smokes run through both apps |
| Rooms move from Chromium to libwebrtc in the backend | S0.8 measures first; the fallback is `livekit-client` in the page host; the first beta may start without the room (D9) |
| Text: IME, selectable text, spellcheck | S0.5 lists the gaps on each platform; D13 sets the bar; Electron's spellcheck has no Rust equivalent and waits |
| Accessibility is newer in GPUI than in Slint, and Zed's Windows screen-reader issue (#41138) is open | S0.6 with VoiceOver, Narrator and Orca before screens; every screen's done check names its controls |
| Build cost and disk on a shared Mac: 31 GB free, two build slots | The lane rules above; free disk before dispatching more than one heavy lane; one GPUI compile per lane target |
| The update from Electron into the GPUI app fails | S5.0 proves it on all three before any release slice; the fallback is a one-time manual download |
| The Developer ID certificate expires on 2027-02-01, before the earliest switch | Renew it and the Videorc Camera profile before the bridge release (`docs/releases/macos-signing.md`) |
| Two UIs maintained for months | D7's rule and a fixed end: Electron bug fixes only from the GPUI beta |

## Owner decisions

All taken by the owner on 2026-11-23. D8 and D10 differ from what this plan
recommended; the rest are the recommended defaults.

- **D1. How GPUI is consumed. Decided 2026-11-23: `gpui-pre` snapshots
  from crates.io, pinned exactly,** with gpui-kit at the matching version,
  bumped on purpose at most monthly, with a fork of only the crates we must
  patch (the Windows native view, maybe gradients) through
  `[patch.crates-io]`, each patch sent upstream. (Not taken: a git pin of
  `zed-industries/zed`; our own fork of GPUI.)
- **D2. Where the work happens. Decided 2026-11-23: in
  `TheOrcDev/videorc`.** `videorc-rust`'s framework-free crates land here
  (Phase 1), the GPUI app is built beside Electron, and `videorc-rust` is
  archived. It ends the 885-commit gap, and each move ships to streamers in
  Electron as it lands.
- **D3. The look's building blocks. Decided 2026-11-23: Videorc's own kit
  over gpui-kit's unstyled `gpui-base`,** borrowing gpui-component's input,
  editor, virtual list and table where `gpui-base` has none, built after
  the owner has judged S0.4's look. **And, the owner's note: the kit is the
  GPUI flavour of videorc-ui** (ui.videorc.com), beside the React
  components, with the same names, tokens and design language, published
  and synced as [The GPUI flavour of videorc-ui](#the-gpui-flavour-of-videorc-ui-d3-d10)
  describes.
- **D4. One process or two. Decided 2026-11-23: two, as today** (plan 220
  D2): a UI crash never ends a live stream.
- **D5. How to switch. Decided 2026-11-23: build beside Electron to parity,
  then switch** (plan 220 D3), in one release for all three platforms
  (D8).
- **D6. Slint. Decided 2026-11-23: stop now.** No more Slint slices; the
  Slint crates stay in `videorc-rust` until it is archived.
- **D7. Electron during the rewrite. Decided 2026-11-23:** new behaviour
  lands in the backend or app-core in the same PR as Electron's UI for it,
  and Electron takes bug fixes only from the GPUI beta.
- **D8. Platform order. Decided 2026-11-23, changed from the
  recommendation: all three platforms together.** No macOS-first beta:
  Windows and Linux reach parity before anyone switches, so the Windows and
  Linux preview routes (S0.2, S0.3) and their spikes are on the critical
  path, and Phases 2 to 5 run each platform side by side
  ([Phases](#phases-and-slices)). **The hardware it needs:**
  - **Windows: the two contributors' own PCs.** Windows 11 x64 on real
    hardware (no VM), no waiver; ideally one with integrated and one with
    discrete graphics, and at least one display above 100 % scale. Their
    run with the testing plan's evidence, reviewed by the owner, is the
    physical pass (plan 220 P4-D6). Videorc has no Windows PC and needs
    none on its side. Their work: the
    [Windows testing plan](260-gpui-rewrite-windows-testing.md) and the
    [Windows code plan](260-gpui-rewrite-windows-code.md).
  - **Linux: ogre** (Hyprland on Wayland, and an X11 session) for every
    Linux slice, and **the second Tier 1 box of plan 257 D2** (Ubuntu
    24.04 on GNOME, Intel or AMD graphics), needed before the switch for
    S0.3's GNOME half and plan 257's matrix in Phase 4. That box is still
    owed in plan 257.
  - **macOS: this Mac,** with at least 120 GB of free disk for the lanes
    and Xcode's Metal Toolchain for release builds.
- **D9. Rooms. Decided 2026-11-23: LiveKit's Rust SDK in the backend,**
  confirmed on S0.8's numbers (the fallback is `livekit-client` in the
  Chromium page host). The first beta may start without the room; the
  room is required before Electron is deleted.
- **D10. videorc-ui and ui.videorc.com. Decided 2026-11-23, changed from
  the recommendation: kept and maintained for GPUI too.** It is never
  frozen or archived: it becomes the home of both flavours (D3). Phase 6
  removes only the desktop app's React copy.
- **D11. Plan 220's settled decisions carry over. Decided 2026-11-23: yes,
  all of them:** two processes, the executor in the core, a small Rust
  updater on today's feed and a second feed, the backend draws stream
  graphics and decodes Library playback, the same bundle id, data
  directory and `videorc://` scheme, and a Chromium page host fetched on
  first use for HTML banners. (Plan 220's D6 and D12 are replaced by D10
  and D8 here.)
- **D12. Windows preview route. Decided 2026-11-23: taken on S0.2's
  numbers;** if they allow, (a), a native view for Windows contributed to
  GPUI, with (d) CPU frames as the fallback for machines without a shared
  texture. The pick itself waits for S0.2c.
- **D13. The bar for text and accessibility at the switch. Decided
  2026-11-23:** IME, colour emoji, inline emotes, selectable chat and Notes
  text, and screen-reader names on every control are required on all three
  platforms; spellcheck in the chat composer and Notes waits for a
  follow-up (no Rust toolkit has it; Electron gets it from Chromium).

## Questions for the owner

Both questions of the draft were answered on 2026-11-23: GPUI is an
ecosystem choice ([Why GPUI](#why-gpui-and-what-it-does-not-change)), and
all platforms switch together (D8). What is still owed is the owner's to
do, not to decide:

- **The second Linux box** (plan 257 D2), before Phase 4's Linux gate.
- **Free disk on this Mac** (at least 120 GB) before more than one heavy
  lane runs.
- **Xcode's Metal Toolchain** on this Mac before the first release build.

## STOP conditions

- Phase 0 misses a pass line on macOS (S0.1): stop, report, start no
  screen.
- Every Windows preview route misses its lines (S0.2c), or both Linux
  routes do (S0.3): stop before Phase 2 and bring it to the owner. All
  platforms switch together, so no platform goes ahead alone.
- GPUI needs a fork of more than the platform crates, or a fourth patch:
  stop and bring it to the owner.
- A Phase 1 PR changes a recording, a stream or a remote's behaviour:
  stop. Phase 1 moves code; it must not change behaviour.
- A design owner call can't be met in GPUI: ask the owner; never bend the
  call.
- No Windows contributor can run the next Windows slice for two weeks:
  report to the owner. The switch date moves; nothing switches without
  Windows.
- The crossover cannot update an installed Electron app into the GPUI app
  and a manual download is not accepted: stop before the release slices.

## Routing (CLAUDE.md)

- The program: Orchestrator · `fable-5.1` · 10 (cross-cutting,
  release-critical, already failed once on another framework).
- Phase 0: Diagnose/Research · `fable-5.1` · 9, except S0.4 (UI/Product
  Design · `opus-5.5` · 9) and S0.7, S0.9 to S0.12 (`gpt-6.1-sol` · 7–8).
  Windows slices are the contributors'; their reviews take the slice's
  route.
- Later phases: each slice above carries its own line.

## Sources

- Code: `TheOrcDev/videorc` `origin/main` `c0cdc36f0` (file:line refs
  above); `TheOrcDev/videorc-rust` `main` `1e097e52c` (refs prefixed
  `videorc-rust:`), its `plans/220-*.md` (P4-D6, Windows by contributors:
  `plans/220-slices-phase-4-6.md:2931-2955`) and `videorc-rust:docs/rust-ui/*.md`.
- `TheOrcDev/videorc-ui` `main` at `ef2b3a0`: `registry.json` (89 items),
  `scripts/build-theme.mjs`, `styles/`; this repo's `scripts/sync-ui.mjs`
  and `apps/desktop/ui-registry.json`; the `videorc-design` skill's "Where
  components come from".
- Windows contributor practice in this repo: `docs/windows-dev-loop.md`,
  `docs/acceptance/windows-physical-acceptance-checklist.md`,
  `docs/acceptance/windows-alpha-acceptance-record.md`,
  `.github/ISSUE_TEMPLATE/windows-alpha-bug.yml`; `gpui-pre-windows`
  0.3.14 (`Cargo.toml`: `accesskit_windows`; `build.rs`: `fxc.exe`;
  `src/events.rs:1507`: IMM32).
- Plan 257 (Linux beta): its Tier 1 boxes and D2, the second Linux box.
- GPUI source as published on crates.io, read on 2026-11-23: `gpui-pre`,
  `gpui-pre-platform`, `-macos`, `-apple`, `-windows`, `-linux`, `-wgpu`
  0.3.14 (snapshot of Zed `f126950f9d3b62666f97437ae5d4ccac2272c4db`);
  <https://crates.io/crates/gpui-pre>, <https://crates.io/crates/gpui>,
  <https://crates.io/crates/gpui-component>.
- Zed upstream at `6501df15765d66d6c2a2b66b1eb22434ccef3f86`
  (2026-11-23): <https://github.com/zed-industries/zed>, `Cargo.toml:281`
  (`publish = false`), `:539-542` (AccessKit adapters), `:1054-1058`
  (LiveKit fork pin); PRs and issues linked in [GPUI today](#gpui-today);
  <https://www.gpui.rs>; <https://zed.dev/blog/zed-for-windows-is-here>.
- gpui-kit: <https://github.com/longbridge/gpui-kit> (`Cargo.toml` L62-78,
  the exact pins), <https://gpui-kit.com>.
- Cap's GPUI app: <https://github.com/CapSoftware/Cap/blob/main/apps/desktop-gpui/Cargo.toml>.
- LiveKit Rust SDK: <https://github.com/livekit/rust-sdks>,
  <https://crates.io/crates/livekit>.
- Inventories of the Electron app (platform jobs, screens, smokes,
  contracts) and of `videorc-rust`, made for this plan on 2026-11-23; the
  notes are in `~/cloud-test/reports/2026-11-23-gpui-plan/NOTES.md`.
