# Plan 260: The whole desktop app in GPUI

> **Executor instructions**: this is a program plan: seven phases, about
> 100 slices. Phase 0 is a gate. Nothing in Phase 2 or later starts until
> the owner has taken D1 to D3 on Phase 0's numbers and looks. Before a
> phase starts, cut it into agent-sized slices with the `cut-it` skill; the
> slices below are each phase's outline and its "Done when" checks. Every
> slice is one PR to `TheOrcDev/videorc` `main`, leaves `main` green and
> runs the `AGENTS.md` gates for what it touches. Anything under "STOP
> conditions" means stop and report, not improvise.
>
> **Drift check (run before each phase):** recount "The app today" against
> `origin/main`. A new window, page, RPC method or smoke since this plan is
> scope to add, not to drop.

The owner, 2026-11-23: "We are going to rewrite complete Videorc Electron
to GPUI. I already started but I don't like [Slint] because it is without
GPU. It is actually only Rust. I want you to plan out a complete rewrite of
that refactoring that we did to GPUI. Plan it out properly. Ask me any
questions if you need something."

## Status and scope

- **Status: PLANNED 2026-11-23.** Research, source reads and one spike;
  no product code changed. Every decision below is open, each with a
  recommended default ([Owner decisions](#owner-decisions)).
- **What it is:** one Rust desktop app on GPUI, Zed's GPU-accelerated UI
  framework, that replaces the Electron shell (`apps/desktop`: main
  process, React renderer, preload) on macOS, Windows and Linux, and looks,
  reads and behaves as Videorc does today. The backend
  (`crates/videorc-backend`) stays.
- **What it replaces:** plan 220's Slint UI in `TheOrcDev/videorc-rust`.
  This plan keeps everything of plan 220 that is not Slint: its core, its
  preview element, its contracts, its spikes, its decisions on banners,
  the updater and identity, and its lessons. It drops the Slint crates.
- **Not in scope:** a redesign (the `videorc-design` skill, `docs/ui-copy.md`
  and the `CONTEXT.md` glossary are the spec, and every owner call in them
  still binds), new features during the rewrite beyond [D7](#owner-decisions),
  and backend behaviour changes beyond Phase 1's moves.
- **Base:** `TheOrcDev/videorc` `origin/main` at `c0cdc36f0` (0.37.1,
  2026-11-23). `TheOrcDev/videorc-rust` `main` at `1e097e52c`
  (2026-11-17). GPUI as `gpui-pre` 0.3.14, a snapshot of Zed at
  `f126950f9d3b62666f97437ae5d4ccac2272c4db`, published 2026-11-23.
- **Branch:** `plan/260-gpui-rewrite`, a draft PR until the owner has
  answered the decisions.
- **Working notes and spike:** `~/cloud-test/reports/2026-11-23-gpui-plan/`
  (notes) and `~/gpui-scratch/spike-native-preview/` (the spike), outside
  both repos.

## Why GPUI, and what it does not change

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
  preview. [The spike](#spike-s0-0-native-preview-under-gpui) measured it.
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

On the owner's reason ("without GPU"): the Slint app does draw on the GPU.
Its default renderer is Skia on wgpu (`videorc-rust:crates/videorc-app/src/renderer.rs:1-11`,
`Cargo.toml` `default = ["skia"]`), and its preview is a Metal layer. Both
apps would be GPU-drawn. So the question in [Questions for the
owner](#questions-for-the-owner) asks what the owner saw, so that Phase 0 tests
that exact thing in GPUI before any screen is built.

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
  route of our own ([The preview](#the-preview-is-an-element-on-every-platform)).
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

Plan 220 decisions this plan keeps unless the owner says otherwise
([D11](#owner-decisions)): D2 (two processes), D5 (the action executor in
the app's core), D6 (videorc-ui freezes at the cutover), D7/P5-D3 (a small
Rust updater on today's feed), D8 (the backend rasterises stream
graphics), D9 (Library playback decoded by the backend), D11 (identity),
D12 (macOS first), P5-D6 (a second feed), P5-D10 (a Chromium page host
fetched on first use for HTML banners). D13 (Slint's licence) falls away.

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

In-process was weighed and is not recommended: it saves one socket hop
(sub-millisecond on loopback) and lets the preview share a GPU device, but
the preview already crosses processes with zero copies (IOSurface ids, NT
handles), and a panic in 652k lines of capture and encoding code would
take the window with it.

### Crates (in `TheOrcDev/videorc`)

- `crates/videorc-protocol`, `crates/videorc-app-core`,
  `crates/videorc-preview`, `crates/videorc-gpu-import`,
  `crates/videorc-preview-ring`, `crates/videorc-updater`,
  `crates/videorc-page-host`: from `videorc-rust`, caught up (Phase 1).
- `crates/videorc-kit` (new): the design system on GPUI: tokens from
  `styles.css`, Liquid Chrome, one primitive per job as the skill lists
  them, the gallery. Only this crate and the app touch GPUI.
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
| macOS | A `NativeView` holding an `NSView` whose layer is `videorc-preview`'s `CAMetalLayer`, presented on its own thread from the backend's IOSurface ring. GPUI lays it out like any element and paints the scene editor's handles, the scrims and the labels over it. The detached Preview window gets its own `NativeView` (a view shows in one window only, `native_view.rs:62-67`) | Spike S0.0 showed it on synthetic content ([below](#spike-s0-0-native-preview-under-gpui)); S0.1 measures it with the backend's real ring at 4K60 |
| Windows | To measure (S0.2, D12): (a) a native view for Windows, contributed to GPUI: a DirectComposition visual beneath GPUI's visual, holding the backend's shared D3D11 texture (or a cross-process composition surface) presented on its own thread; (b) a shared-texture `draw_surfaces` in GPUI's DirectX renderer, which redraws the window at video rate; (c) the backend's own DirectComposition window stacked over ours (`windows_d3d11_preview.rs`, today's unqualified presenter); (d) CPU frames from the shared-memory ring as GPUI images | Unbuilt. Anything beats today's BMP proof surface |
| Linux | `videorc-preview`'s Wayland subsurface or X11 child window over the shared-memory ring, placed below a transparent hole in GPUI's surface; fallback (d) | Built for Slint (plan 220 P4-D2), never under GPUI |

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
- **gpui-kit or our own primitives (D3).** gpui-kit brings unstyled
  behaviour (`gpui-base`, modelled on Base UI) and styled components
  (`gpui-component`, modelled on shadcn): a tested text input (IME,
  selection), virtual lists and tables, menus, popovers, a command palette.
  Videorc's look is its own. The recommended split: behaviour from
  gpui-kit, looks from `videorc-kit`, which wraps it, as shadcn wraps Base
  UI in the Electron app today.
- **Guards become types and lints.** Theme tokens only (a lint rejects raw
  colours in screens), radii from the tiers, control heights from the
  primitive, a text scale that starts at 11 px, shortcuts only through
  `ShortcutKeys`, toasts that tint only their icon. The copy, toast,
  Sidekick-name and shortcut guards port as Rust tests over the string
  tables.
- **Parity is by eye and by diff:** every screen in dark, light and
  Increase Contrast against an Electron baseline shot the same day.
- **videorc-ui (ui.videorc.com) freezes** at the cutover and is archived
  when Electron is deleted (D10). It stays the reference while screens are
  ported.

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

**Replacement (D9): LiveKit's Rust SDK in the backend.** The backend
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

- **Beside, then switch, per platform.** The GPUI app grows next to
  Electron against the same backend and data directory, and takes the
  bundle id at the switch. Screen-by-screen inside Electron is not
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
- **Electron keeps releasing.** Every Electron release continues through
  the `videorc-release` skill. What Electron may still gain is D7.
- **Crossover (unchanged from plan 220):** an Electron release carries
  Phase 1 to every install; the GPUI app ships on a second feed only the
  bridge build and the GPUI app read; the last Electron build (the bridge)
  updates installs into the GPUI app with the same bundle id and team on
  macOS and the same NSIS installer on Windows. The last Electron build
  stays downloadable for one release cycle; the UI never changes the
  backend's schema, so a rollback reads the same data.
- **Platform order (D8):** macOS first, then Windows on a physical PC
  with no waiver, then Linux as its alpha and beta lane (plan 257).

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
- From then on, D7 decides how new behaviour lands. The recommended rule:
  any new behaviour goes into the backend or app-core (Rust) in the same
  PR that adds Electron's UI for it, and the GPUI screen gains the UI in
  its next pass. Electron takes bug fixes only once the GPUI beta starts.

### What parity means

The GPUI app is at parity on a platform when every row below works as in
Electron, by eye in dark, light and Increase Contrast, with byte-identical
strings, every control reachable by keyboard and named for a screen
reader, and its smokes green with `VIDEORC_APP=gpui`.

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

The table is the outline; S5.0 regenerates it from the code into
`docs/gpui/parity.md` with one line per control, and each screen slice
ticks its lines.

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
  is re-counted for GPUI in S2.6 and each screen slice moves its smokes.
- **Headless tests:** `TestAppContext` and `VisualTestContext` for view
  logic and focus order; the core's tests stay framework-free.
- **By eye:** a `gallery` binary for the kit; the baseline harness
  (`scripts/rust-ui-baseline.mjs compare`) shoots the GPUI app against
  Electron per screen, theme and width, side by side, and an agent looks
  at every pair. The owner's looks are recorded in `docs/gpui/screens.md`.
- **Gates by phase:** end of Phase 1, `pnpm smoke:local-gates` (Electron)
  on main; end of Phase 2, the recording-studio fixtures and
  `smoke:record-latency` with `VIDEORC_APP=gpui`; end of Phase 3, the
  whole `smoke:local-gates` with `VIDEORC_APP=gpui` on macOS; end of Phase
  4, `smoke:local-gates:windows` on the physical PC and plan 257's Linux
  matrix; Phase 5, the crossover proof before any release slice, then the
  `videorc-release` gates.

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

Route, lane and fit per `CLAUDE.md` follow each slice. Phases 1 and 2 can
overlap once Phase 0's macOS gate (S0.1) passes.

### Phase 0: prove it (gate)

| # | Slice | Route · lane · fit | Done when |
| --- | --- | --- | --- |
| S0.1 | macOS preview under GPUI with the real backend: `videorc-preview`'s presenter in a `NativeView`, the IOSurface ring at 4K60, docked and floating, editor handles over the video | Diagnose · `fable-5.1` · 9 | Plan 220's week-1 lines pass for 10 min at 4K60: zero CPU copies, present p95 ≤ 20 ms, still frame ≤ 3 % CPU, live ≤ 10 %, ≤ 2 ms GPU per frame, floating window out of capture; and the editor overlay adds ≤ 1 % CPU while idle |
| S0.2 | Windows preview routes (a) to (d) on the physical PC | Diagnose · `fable-5.1` · 9 | Numbers per route against the same lines; the patch size of (a) and (b); the owner takes D12 |
| S0.3 | Linux preview: the Wayland subsurface and X11 child under GPUI's wgpu window on ogre | Diagnose · `fable-5.1` · 8 | It presents below GPUI content at the camera's rate on Hyprland and one X11 session; the CPU line is reported |
| S0.4 | Liquid Chrome in GPUI: Button (every variant), Switch, Slider, the Record button, a pane with sidebar and toolbar, in both themes | UI/Product Design · `opus-5.5` · 9 | Side-by-side shots against Electron; the owner judges them equal by eye (D3) |
| S0.5 | Text: Japanese IME on macOS and Windows, colour emoji, font fallback, selectable text, tabular numbers, a 10,000-row chat with inline animated WebP emotes | Implementation · `fable-5.1` · 8 | Scrolls at 60 fps with ≤ 100 MB extra and first paint ≤ 100 ms; IME commits correctly; the gaps are listed against D13 |
| S0.6 | Accessibility and testing: VoiceOver and Narrator read a list and a dialog; a headless test clicks Record; the UI driver finds a control by role and name through AccessKit | Implementation · `fable-5.1` · 8 | All three work, or the gap and its patch size are reported |
| S0.7 | Desktop: menus, traffic lights over a custom header, a global hotkey, deep link on a cold start, single instance, window ordering, Hide from stream | Implementation · `gpt-6.1-sol` · 8 | Each works on macOS; Windows and Linux are listed for S0.2/S0.3's machines |
| S0.8 | Rooms: LiveKit's Rust SDK in the backend against a local `livekit-server`, with a browser guest (plan 220 room spike Part 2's nine checks) | Diagnose · `fable-5.1` · 9 | The nine checks pass or the report names the blocker; the download size added is measured; the owner takes D9 |
| S0.9 | Build cost: the GPUI app's clean and incremental build time and disk on this Mac, one compile at a time; a weekly `gpui-pre` bump rehearsed | Research · `gpt-6.1-sol` · 7 | Numbers in this plan; the bump's breakage counted in lines |
| S0.10 | The Electron baseline: screenshots of every window, page, tab and dialog in three appearances; idle and live cost of Electron's processes | Implementation · `gpt-6.1-sol` · 8 | The archive exists outside the repo with its manifest committed (plan 220 S0.1 reused) |

### Phase 1: the core lands in the shipping repo (ships in Electron)

| # | Slice | Done when |
| --- | --- | --- |
| S1.1 | `videorc-protocol` extracted from `protocol.rs`; `backend.ts` generated | Contract tests and `protocol-fixtures/` pass on both sides; Windows and Linux CI compile |
| S1.2 | Stream graphics in the backend (captions, chat box, cards, Sidekick bubble) | Golden images match the renderer's within a threshold and by eye; `smoke:captions-live`, `smoke:comment-highlight-stream` and a record-plus-stream smoke pass |
| S1.3 | Meters from `audio.levels`; the monitor, clicks and chime from the backend | `smoke:soundboard`, `smoke:system-audio` and the mixer tests pass; the renderer has no getUserMedia or AudioContext |
| S1.4 | UI settings into `app_settings`, with a one-time migration | `smoke:first-run` and `smoke:scene-presets` pass on a profile from the previous release |
| S1.5 | Main's side jobs to the backend: avatar/emote/GIF cache, comments history, thumbnails, agent config writes, OBS import | Their tests move with them; main owns none of them |
| S1.6a–f | `videorc-app-core` lands and catches up, one area per slice: session and Studio; scenes, sources and the editor; live, destinations, Go Live, cloud; guests and rooms; Sidekick, Avatar, chat, notifications; Library, Settings, first run | Each area's drift list is empty, its core tests pass, and the smokes it can run headless pass |
| S1.7 | `videorc-preview`, `-gpu-import`, `-preview-ring`, `-updater`, `-page-host` land | Their tests pass on all three CI platforms |
| S1.8 | Rooms in the backend, if D9 takes the Rust SDK | The room spike's checks pass from Electron with the backend publishing; `livekit-client` leaves the renderer |

Routes: S1.2, S1.3, S1.6a, S1.6d and S1.8 touch recording, audio or rooms:
Implementation · `fable-5.1` · 9. The rest: Implementation · `gpt-6.1-sol`
· 8.

### Phase 2: the shell

| # | Slice | Done when |
| --- | --- | --- |
| S2.1 | `apps/videorc` starts: supervisor, registry lock, logs, crash log, typed client, the store bridge | The main window opens with the sidebar and empty pages, and `backend.ready` arrives |
| S2.2 | `videorc-kit` v1 on S0.4's route: tokens, Liquid Chrome, the primitives the skill lists, toasts, the gallery | The gallery matches videorc-ui's docs by eye in three appearances; the guard tests exist |
| S2.3 | The preview element on macOS, docked and floating, with the first-frame contracts and fallback labels | The GPUI forms of `probe:preview-lifecycle` and `probe:preview-window` pass; the owner judges it against S0.10 |
| S2.4 | The core runs a session from the UI: Record, Stop, a minimal Go Live | The owner records from the skeleton |
| S2.5 | The smoke command server and the AccessKit UI driver; `VIDEORC_APP=gpui` | `smoke:record-latency`, `smoke:recording-matrix` and the recording-studio fixtures pass with it |
| S2.6 | OS integration from S0.7, for real | Menus, shortcuts, deep links, TCC and relaunch, Videorc Camera activation, sleep guard, Hide from stream, saved frames |

Routes: Orchestrator · `fable-5.1` · 10 for S2.1, S2.3, S2.5; UI/Product
Design · `opus-5.5` · 9 for S2.2; Implementation · `gpt-6.1-sol` · 8 for
S2.4 and S2.6.

### Phase 3: screens to parity (macOS)

One PR per screen, in this order, each done by the parity bar above:
Studio (three slices: preview and session, audio in both looks, scenes and
chat); Scene with the freeform editor (two); Sources; the Stream Manager
(two) and Notes; Destinations and the Go Live dialog (two); Guests; Output;
Captions and the reader; Library with its player (two); Images and Sounds;
Avatar; Sidekick (two); Settings; Health; ⌘K; the dialogs; first run; the
notification centre and toasts. About 30 slices.

Routes: UI/Product Design · `opus-5.5` · 9; Studio, the Scene editor, the
Stream Manager and Guests take `fable-5.1`.

### Phase 4: Windows and Linux

- **Windows** (about 10 slices): the first run on the physical PC; the
  preview on D12's route, docked and floating; the frame, scale, theme and
  type; keys, links and single instance; Hide from stream, files and
  permissions; every screen; the smokes; the NSIS installer upgrading an
  Electron install in place. _Done when:_ `smoke:local-gates:windows`
  passes with `VIDEORC_APP=gpui` and the owner records and streams on the
  physical PC with no waiver.
- **Linux** (about 8 slices, after plan 257's beta work): the first run on
  ogre, Wayland and X11; the preview on S0.3's route; the desktop entry and
  deep links; the GlobalShortcuts portal; every screen; the AppImage.
  _Done when:_ plan 257's matrix passes with the GPUI app on its Tier 1
  boxes.

Routes: the first run on each machine and the preview: `fable-5.1` · 9;
screens: `opus-5.5` · 8; packaging: `gpt-6.1-sol` · 8.

### Phase 5: ship it

S5.0 the parity file regenerated and the crossover proof (an installed,
signed Electron build updates into a signed GPUI app with every setting,
grant and sign-in kept, on macOS and Windows); S5.1 macOS packaging without
electron-builder (entitlements, the camera extension and app group,
hardened runtime, notarisation, DMG, a `check-packaged-app` equivalent);
S5.2 the updater wired, its UI and the second feed, the release scripts and
the `videorc-release` skill; S5.3 the owner's week on the signed build,
Electron and GPUI compared back to back; S5.4 opt-in beta on macOS; S5.5 the
bridge release; S5.6 Windows and Linux switch, each after a real run.
About 14 slices. Every release slice: Release · `fable-5.1` · 10.

### Phase 6: delete Electron

One release cycle after Windows switches, on the owner's go: remove
`apps/desktop`, the Electron and React dependencies, the videorc-ui sync,
the TS mirrors and Electron-only smokes, the native preview addon, the BMP
proof surface and the PNG overlay parameters; rewrite `AGENTS.md`,
`CLAUDE.md` and the `videorc-design` skill for GPUI primitives; archive
`videorc-rust` and ui.videorc.com. About 6 slices.

## Sizing

From plan 220's measured pace (Phase 2's 19 slices in three days; Phase 3
at 54 of 65 slices in nine days, with one to three lanes), and what is new
here:

- **Phase 0:** one to two weeks. S0.2 and S0.8 need the Windows PC and a
  quiet Mac; S0.4 needs the owner's eye.
- **Phase 1:** three to five weeks. The catch-up (S1.6) is the bulk and
  is set by the shipping repo's pace; each move also waits for an Electron
  release.
- **Phases 2 and 3:** four to six weeks for macOS. The core exists; the
  screens are new GPUI code against the same view-models. The owner's
  looks set the end more than building does.
- **Phase 4:** Windows three to five weeks (no Rust UI has ever run on the
  PC), Linux two to three, side by side.
- **Phase 5:** six to ten weeks, mostly waiting that agents cannot
  shorten: an Electron release carrying Phase 1, the owner's week, two
  weeks of beta, then Windows acceptance.

That puts a macOS beta in March 2027 at the earliest and the macOS switch
in April, Windows some weeks later. It is an estimate from plan 220's pace,
not a commitment, and it holds only if D7 stops the drift and Phase 0
passes without a toolkit fork.

## Risks

| Risk | Mitigation |
| --- | --- |
| GPUI has no stable release; weekly snapshots break the build | Pin `gpui-pre` and gpui-component to exact versions (D1); bump on purpose, at most monthly, in one slice that runs the gallery, the headless tests and the preview probes; S0.9 rehearses a bump |
| GPUI is built for Zed first: on 2025-12-12 Zed declined outside PRs with no Zed use case (custom shaders, a tray), and that still holds; `NativeView` is one day old | The core stays framework-free (the test is kept), so a swap costs the kit and screens only; any patch is kept in a fork of the platform crates and sent upstream; a fourth patch is a STOP |
| Native views exist only on macOS | S0.2 and S0.3 measure Windows and Linux routes before any screen; a miss on every Windows route is a STOP |
| Liquid Chrome needs multi-stop and radial gradients | S0.4 by the owner's eye before the kit is built |
| The drift: Electron gains features weekly | Phase 1 lands the core early; D7's rule; a drift list per phase |
| `use-studio.tsx` (22,187 lines) hides behaviour | app-core already ports it with tests (`studio-state-port.md`); S1.6's catch-up re-reads the diff since the copy; the smokes run through both apps |
| Rooms move from Chromium to libwebrtc in the backend | S0.8 measures first; the fallback is `livekit-client` in the page host; P5-D12 lets the beta start without the room if the owner keeps it |
| Text: IME, selectable text, spellcheck | S0.5 lists the gaps; D13 sets the bar; Electron's spellcheck has no Rust equivalent and waits |
| Accessibility is newer in GPUI than in Slint | S0.6 with VoiceOver and Narrator before screens; every screen's done check names its controls |
| Build cost on a shared Mac | S0.9 measures; one GPUI compile at a time, `CARGO_BUILD_JOBS` capped, as the Slint lanes did |
| The update from Electron into the GPUI app fails | S5.0 proves it before any release slice; the fallback is a one-time manual download |
| The Developer ID certificate expires on 2027-02-01, before the earliest switch | Renew it and the Videorc Camera profile before the bridge release (`docs/releases/macos-signing.md`) |
| Two UIs maintained for months | D7's rule and a fixed end: Electron bug fixes only from the GPUI beta |

## Owner decisions

Recommended defaults first. Nothing is decided yet.

- **D1. How GPUI is consumed.** (a) `gpui-pre` snapshots from crates.io,
  pinned exactly, with gpui-component at the matching version; (b) a git
  pin of `zed-industries/zed` at a commit; (c) our own fork of the GPUI
  crates. **Recommended: (a)**, bumped on purpose at most monthly, with a
  fork of only the crates we must patch (the Windows native view, maybe
  gradients) through `[patch.crates-io]`, each patch sent upstream.
- **D2. Where the work happens.** (a) In `TheOrcDev/videorc`: land
  `videorc-rust`'s framework-free crates there (Phase 1), build the GPUI
  app beside Electron, archive `videorc-rust`; (b) continue in
  `videorc-rust`, swapping Slint for GPUI, and merge at the end as plan 220
  planned; (c) start over from Electron and port `use-studio.tsx` again.
  **Recommended: (a).** It ends the 885-commit gap instead of growing it,
  and each move ships to streamers in Electron as it lands.
- **D3. The look's building blocks.** (a) `videorc-kit` as Videorc's
  styled layer over gpui-kit's unstyled `gpui-base` (the way shadcn sits
  over Base UI today), borrowing gpui-component's input, editor, virtual
  list and table where `gpui-base` has none; (b) only our own primitives
  on bare GPUI; (c) gpui-component's own theme, restyled. **Recommended:
  (a)**, taken after S0.4's looks.
- **D4. One process or two.** **Recommended: two, as today** (plan 220
  D2): a UI crash never ends a live stream.
- **D5. How to switch.** **Recommended: build beside Electron to parity,
  then switch in one release per platform** (plan 220 D3).
- **D6. Slint.** **Recommended: stop now.** No more Slint slices; the
  Slint crates stay in `videorc-rust` until it is archived.
- **D7. Electron during the rewrite.** (a) New behaviour lands in the
  backend or app-core in the same PR as Electron's UI for it, and Electron
  takes bug fixes only from the GPUI beta; (b) Electron keeps taking
  features freely until the beta (plan 220's revised D4, whose batch 1
  grew from 2 to 19 slices); (c) Electron freezes now. **Recommended:
  (a).**
- **D8. Platform order.** **Recommended: macOS, then Windows on a physical
  PC with no waiver, then Linux** (plan 220 D12). Electron keeps shipping
  on every platform that has not switched.
- **D9. Rooms.** (a) LiveKit's Rust SDK in the backend; (b)
  `livekit-client` kept inside the Chromium page host. **Recommended:
  (a)**, taken on S0.8's numbers. And: may the macOS beta start without
  the room (plan 220 P5-D12, taken for Slint)? **Recommended: yes**, with
  the room required before Electron is deleted.
- **D10. videorc-ui and ui.videorc.com.** **Recommended:** the registry
  stays the reference while screens are ported, freezes at the macOS
  switch and is archived in Phase 6; the GPUI design system lives in
  `crates/videorc-kit`. No GPUI registry is published.
- **D11. Plan 220's settled decisions carry over:** two processes, the
  executor in the core, a small Rust updater on today's feed and a second
  feed, the backend draws stream graphics and decodes Library playback,
  same bundle id, data directory and `videorc://` scheme, and a Chromium
  page host fetched on first use for HTML banners. **Recommended: yes, all
  of them.**
- **D12. Windows preview route.** Taken on S0.2's numbers. **Recommended
  if the numbers allow: (a), a native view for Windows contributed to
  GPUI**, with (d) CPU frames as the fallback for machines without a
  shared texture.
- **D13. The bar for text and accessibility at the switch.**
  **Recommended:** IME, colour emoji, inline emotes, selectable chat and
  Notes text, and screen-reader names on every control are required;
  spellcheck in the chat composer and Notes waits for a follow-up (no Rust
  toolkit has it; Electron gets it from Chromium).

## Questions for the owner

- **Slint: what did you see?** The Slint app draws on the GPU (Skia on
  wgpu, and a Metal layer for the preview). If "without GPU" was about
  something you saw or felt (smoothness of scrolling or animation, the
  look of the chrome, text rendering, start-up), Phase 0 should measure
  that exact thing in GPUI before any screen is built.
- **Windows and Linux at the switch.** Is a macOS-first GPUI beta, with
  Electron still shipping on Windows and Linux for some weeks, acceptable?

## STOP conditions

- Phase 0 misses a pass line on macOS (S0.1): stop, report, start no
  screen.
- Every Windows preview route misses its lines (S0.2): stop before Phase
  4 and bring it to the owner.
- GPUI needs a fork of more than the platform crates, or a fourth patch:
  stop and bring it to the owner.
- A Phase 1 PR changes a recording, a stream or a remote's behaviour:
  stop. Phase 1 moves code; it must not change behaviour.
- A design owner call can't be met in GPUI: ask the owner; never bend the
  call.
- The crossover cannot update an installed Electron app into the GPUI app
  and a manual download is not accepted: stop before the release slices.

## Routing (CLAUDE.md)

- The program: Orchestrator · `fable-5.1` · 10 (cross-cutting,
  release-critical, already failed once on another framework).
- Phase 0: Diagnose/Research · `fable-5.1` · 9, except S0.4 (UI/Product
  Design · `opus-5.5` · 9) and S0.7, S0.9, S0.10 (`gpt-6.1-sol` · 7–8).
- Later phases: each slice above carries its own line.

## Sources

- Code: `TheOrcDev/videorc` `origin/main` `c0cdc36f0` (file:line refs
  above); `TheOrcDev/videorc-rust` `main` `1e097e52c` (refs prefixed
  `videorc-rust:`), its `plans/220-*.md` and `videorc-rust:docs/rust-ui/*.md`.
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
