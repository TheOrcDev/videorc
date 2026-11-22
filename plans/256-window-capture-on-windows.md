# Plan 256: Window capture on Windows

Plan 210 left this one open: "Window capture on Windows
(`CreateForWindow`) gets its own plan" (D12, and Out of scope). This is that
plan. It was written as research notes during an overnight Windows sweep,
not at the owner's request, so every decision below is a recommendation the
owner can overrule (see Owner checks).

Facts are read from desktop `origin/main` `dbda7f43d` (2026-11-21).
External facts carry a link. Nothing here was run: no app, no smoke, no
product code.

## Status and scope

- **Status: PLANNED 2026-11-21 (research draft).** A plan only: a spike
  (S0) and seven slices.
- **In scope:** listing app windows on Windows, choosing one in Sources,
  showing it in the Preview, recording and streaming it, Hide screen while
  it is the source, and a smoke that proves it with a fixture window.
- **Out of scope:**
  - Plan 210's app scenes, Follow and the password-manager hide on Windows
    (D12 keeps them macOS only). They need this plan first, and their own
    decisions after it.
  - Menus, popups and dropdowns that are separate windows
    (`IncludeSecondaryWindows`, D9).
  - Several windows capturing at once (plan 210's D5 alternative).
  - Linux window capture (the portal has one window slot,
    `linux_portal_capture.rs`).
- **Number:** 256 is the next free number after 255 (SRT Camera, #1606).

## What exists

Read from the code. Line numbers are at `dbda7f43d`.

### Windows lists displays only

- `screen_capture.rs` `windows_native::list_native_capture_sources`
  (`:788-808`) pushes one `DeviceKind::Screen` per DXGI output, with the id
  `screen:dxgi:{adapter luid:016x}:{output index}` (`:611-613`) and the name
  "Display N". If DXGI fails or finds nothing, it offers the gdigrab
  "Desktop" device (`:653-670`). Nothing on Windows ever makes a
  `DeviceKind::Window`.
- `protocol.rs:348` says so on the enum:
  `#[cfg_attr(target_os = "windows", allow(dead_code))] // Windows lists no window sources yet`.
- `devices.rs` `windows_device_list_from_parts` (`:213-229`) concatenates
  capture sources, cameras, microphones and system audio, with no kind
  logic. Its test, `windows_devices_expose_native_rows_without_avfoundation_fallbacks`
  (`:1392`), pins the exact id list.

### What a macOS window carries

`screen_capture.rs` `devices_from_shareable_content` (`:1799-1810`):
the id `window:screencapturekit:{CGWindowID}`, the name "App - Title",
`app: Some(DeviceApp { bundle_id, name, pid })` (`protocol.rs:298-302`),
`window_title`, and the window frame as width and height. `include_window`
(`:1855` on) drops off-screen windows, negative layers, `loginwindow` and
Videorc's own Notes window. Placeholder ids cover a missing permission or an
unavailable source.

### Where a window is refused on Windows today

| Where | What happens |
| --- | --- |
| `preview_screen.rs:5060-5082` `selected_screen_source` (not cfg-gated) | A `window:` id is accepted only for a portal id or when `parse_screencapturekit_window_id` parses it. Anything else returns `None`, so the Preview says "No screen or window source is selected" (`:1844-1846`). |
| `preview_screen.rs:5128-5136` `windows_screen_preview_backend` | "Windows FFmpeg screen preview does not support window sources yet." It is unreachable for a Windows id, because of the row above. |
| `preview_screen.rs:6443-6445` | The WGC preview runs only for a `screen:dxgi:` id. |
| `live_layout.rs:783-793` | A live switch to any `window:` id bails: "Live Windows window capture is unavailable in the current capture adapter. Choose an available display; the current source is preserved." No test covers it. |
| `live_layout.rs:537-563` | `window_source_is_native` is true only for `window:screencapturekit:`. |
| `windows_d3d11_session.rs:596-602` | `window_selected` (`recording.rs:5354`) gives the named fallback `windows-d3d11-media-window-capture-unsupported`. |
| `windows_d3d11_session.rs:537-555` | A visible scene `Window` layer gives the `window-source` unsupported feature ("would be drawn from the display"). |
| `windows_d3d11_session.rs:3811-3815` | The scene plan maps `Screen | Window` to `Display`. A `Window` kind exists in `windows_d3d11_compositor.rs:297`, but only tests use it. |
| `recording.rs:15597-15625` `resolve_primary_screen_video_input` | Reads `screen_id` only. On the legacy FFmpeg graph a window becomes a test pattern (`:15432`, warning at `:15549-15555`). |
| `recording.rs:18454-18473` | The direct D3D11 record preflight needs `window_id.is_none()`. |
| `screen_capture.rs:473-489`, `:144-154` | `resolve_app_window` and `app_previews` are macOS only. |
| `capture_recovery.rs:511-531` | Window presence is macOS only and keyed on ScreenCaptureKit ids. |

Some of the Windows plumbing is already window-aware. The D3D11 media
loop keys its BGRA route on `window_id.or(screen_id)`
(`windows_d3d11_session.rs:1155-1164`, `:2822-2839`), and
`live_source_switch.rs:272-290` accepts `Screen | Window` devices.

### The two WGC users

| | `windows_graphics_capture.rs` (Preview, CPU and direct-D3D11 record) | `windows_d3d11_capture.rs` (D3D11 media session; the #906 cross-adapter route) |
| --- | --- | --- |
| Item | `CreateForMonitor` (`:580-587`), local to `start()` | `CreateForMonitor` (`:2017-2023`), kept in the struct, closed in `Drop` |
| Device | Its own, on the source's adapter | The session's shared media device |
| Pool | `CreateFreeThreaded`, BGRA8, 2 buffers, `item.Size()` read once (`:305-329`), never recreated | The same, and the item size must equal the DXGI output exactly (`:2058-2068`) |
| Content size | Read per frame (`:482`); `OwnedFrameSlots` copies the whole pool texture (`:133-163`); readback refuses content larger than the texture (`:622-629`) | `validate_copy_contract` needs an exact match (`:1722-1752`) |
| Cursor | `SetIsCursorCaptureEnabled` (`:333-335`) | Set and read back (`:2088-2114`) |
| Border, `Closed` | Neither | Neither |
| Interval | `SetMinUpdateInterval` (`:336-338`) | Not set |

A monitor never changes size under a session, so neither user handles a
resize. A window does.

### Sources, scenes and Hide screen in the renderer

- Window ids are filtered by prefix, not platform:
  `capture.ts:2714-2716` `isNativeWindowSourceId` is
  `startsWith('window:screencapturekit:')`. It feeds the picker
  (`capturePickerDevices`, `:2842-2864`), `hasSelectedScreenSource`
  (`:625-631`), `window-source-rebind.ts` and the Preview hint in
  `use-studio.tsx:2513-2521`.
- The scene picker is gated on `mac` (`scene-picker-dialog.tsx:119-123`,
  `:211`, `:235`, `:270`; test `scene-picker-dialog.test.ts:317`, "offers
  Displays and Camera only on Windows and Linux, never Apps").
- No copy tells a Windows user that window capture is missing.
- Hide screen: the hidden still is sized from the capture texture's
  descriptor (`screen_privacy.rs:602-615` `still_texture`), and the CPU
  still is reused only when its size equals the frame's
  (`preview_screen.rs:1512-1515`). A window's pool texture can be larger
  than its content after a resize, so the two stills would disagree.

## What Windows gives us

- `IGraphicsCaptureItemInterop::CreateForWindow(HWND)` makes a capture item
  for one top-level window. The same frame pool and session code as a
  monitor, already in both WGC users
  ([screen capture guide](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)).
- **Resize.** The frame's `ContentSize` follows the window. The documented
  answer is `Direct3D11CaptureFramePool::Recreate` with the new size, after
  draining pending frames
  ([Recreate](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.recreate?view=winrt-19041)).
  OBS reads the real size from the texture rather than trusting
  `ContentSize` alone, and recreates on change
  ([OBS `winrt-capture.cpp`](https://sources.debian.org/src/obs-studio/32.0.4%2Bds1-1/libobs-winrt/winrt-capture.cpp)).
- **Minimized.** OBS checks `IsIconic` before trusting the frame size; a
  minimized window stops delivering useful frames. Qt treats empty frames as
  normal and retries `CreateForWindow` on `E_INVALIDARG`
  ([Qt `qffmpegwindowcapture_uwp.cpp`](https://contribute.qt-project.org/doc/d6/dc8/qffmpegwindowcapture__uwp_8cpp_source.html)).
  Microsoft does not document either; S0 confirms them.
- **The yellow border.** `GraphicsCaptureSession.IsBorderRequired` exists
  from Windows 10 2104 (build 20348)
  ([IsBorderRequired](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)).
  Turning it off needs consent through
  `GraphicsCaptureAccess.RequestAccessAsync(Borderless)`
  ([RequestAccessAsync](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscaptureaccess.requestaccessasync?view=winrt-20348)).
  For a packaged app that also takes the `graphicsCaptureWithoutBorder`
  capability. A declined request still lets the property be set, but the
  border stays. What an unpackaged NSIS app like Videorc gets is not
  documented; S0 answers it.
- **HWND fits in 32 bits.** User handles are 32-bit significant on 64-bit
  Windows, so they may be truncated and sign-extended
  ([interprocess communication](https://learn.microsoft.com/en-us/windows/win32/winprog64/interprocess-communication)).
  The existing `window_id: Option<u32>` fields (`preview_screen.rs:5045`,
  `:6122`) can carry one.

## Decisions

### D1. The id: `window:wgc:<hwnd>:<pid>`

`<hwnd>` in lowercase hex, `<pid>` decimal. An HWND is reused after its
window closes, so the pid makes a stale id fail instead of capturing a
stranger's window. At open, check `IsWindow` and that
`GetWindowThreadProcessId` still returns the pid; otherwise the source is
missing.

- *Alternative:* HWND only. Shorter, but a reopened app can land a different
  window on a saved HWND.
- *Alternative:* exe path plus title, resolved at open. Survives a relaunch,
  but titles change (a browser tab, an editor's file) and two windows can
  match. Plan 210's app scenes need that kind of matching; this plan keeps
  the exact window and leaves rebinding to them.

### D2. Which windows are listed

`EnumWindows` over top-level windows that are visible, not cloaked
(`DwmGetWindowAttribute(DWMWA_CLOAKED)`, which hides UWP shells and windows
on other virtual desktops), not `WS_EX_TOOLWINDOW`, not owned, titled, at
least 1×1, and not Videorc's own process. A minimized window is listed with
its status, the way macOS lists an off-screen one: unavailable, with a
detail.

`app` is `DeviceApp { bundle_id: <exe path, lowercased>, name: <file
description, else exe stem>, pid }`. For a UWP app hosted by
`ApplicationFrameHost.exe`, the AUMID (`GetApplicationUserModelId` on the
child process) stands in for the path. The renderer's `isAppWindow`
(`scene-app-picker.ts:81-90`) only needs `bundleId` to be present.

The width and height are the client area in physical pixels, read in a
per-monitor DPI-aware thread (the 150% laptop has been bitten before; see
#1272).

### D3. Capture: the Preview's WGC user grows a window item

`windows_graphics_capture.rs` takes a `WindowsCaptureTarget { Monitor,
Window { hwnd, pid } }` in place of a DXGI source id. A window:

- makes its item with `CreateForWindow`, on the adapter that drives the
  monitor the window is on (`MonitorFromWindow`, then the DXGI output
  lookup that monitors already use);
- recreates the pool when the frame's texture size changes, after
  draining, and publishes frames at their content size (crop, not the
  whole pool texture);
- subscribes to `Closed` and reports the source missing;
- treats `IsIconic` as paused: no new frames, the Preview keeps the last
  one, and the status says the window is minimized.

The compositor already fits a source into its layer, so a changing source
size needs no layout work. S2 proves it with a resize mid-recording.

### D4. Recording: through the compositor bridge first

The CPU compositor bridge reads the Preview store, so once S2 lands a
window records and streams through it with no recording change. The D3D11
media session keeps its named fallback
(`windows-d3d11-media-window-capture-unsupported`) until S6 gives it a
window input with a sub-rect copy contract and resize. That fallback is
already diagnosed and visible in Health, which is the project's rule for
fallbacks.

- *Alternative:* go straight to the D3D11 media path. Faster on the UHD 620,
  but it puts the copy-contract change, a resize under the encoder, and the
  #906 adapter question into the first slice. Not recommended.

### D5. The border: off when Windows lets us, otherwise said once

Try `RequestAccessAsync(Borderless)` and `IsBorderRequired = false` at the
first window capture. If the border stays, say so once on the source row
("Windows draws a yellow frame around a captured window; viewers don't see
it"). The border is drawn on the screen, not in the captured frame, so
viewers never see it. S0 confirms that too.

### D6. Minimized, closed, elevated

- **Minimized:** paused, last frame held, "Minimized" on the source row.
  Restored, it resumes on the same item.
- **Closed:** `Closed`, or a failed `IsWindow`/pid check, makes the source
  missing. The recording keeps going on the held frame, as the macOS window
  path does (`capture_recovery.rs`), and Health says which window went away.
- **Elevated windows:** what an unelevated Videorc gets from an elevated
  window under WGC is not documented. S0 finds out. If it is black, D2
  lists the window as unavailable with a reason instead of offering a black
  source.

### D7. Cursor

`IsCursorCaptureEnabled` follows the session's cursor setting, as for a
display.

### D8. Hide screen

The hidden still is sized from the frame's content size, not the pool
texture's descriptor (`screen_privacy.rs` `still_texture` takes the size it
should draw), so the D3D11 and CPU stills agree for a resized window. A
window source is still a "screen" for Hide screen: the frost covers it on
every leg (plan 210 D8).

### D9. Menus and popups are separate windows

WGC's window item does not include an app's menus and popups.
`IncludeSecondaryWindows` exists on newer Windows 11 builds, but its version
is not on the page read for this plan. Out of scope; say it in the source
row's detail ("Menus and popups aren't captured").

### D10. Sources UI, not scenes

Windows windows appear in Sources under their own group, with the app's
name. `isNativeWindowSourceId` learns `window:wgc:`. The scene picker stays
Displays and Camera on Windows (plan 210 D12 and its test), until a later
plan brings app scenes.

## Slices

| Slice | What | Proof |
| --- | --- | --- |
| S0 | Spike, not shipped: `scripts/probe-windows-window-capture.mjs` driving a small Rust example. On the laptop and one discrete-GPU box: border control from an unpackaged process, an elevated window, minimize and restore, resize, a cloaked UWP window, a window moved across monitors on different adapters. Findings go back into D5, D6 and D2. | A record under `docs/acceptance/` |
| S1 | Listing: `EnumWindows` + filters (D2), the `window:wgc:` id and its parser, `DeviceApp`. Remove the `allow(dead_code)` on `DeviceKind::Window`. | Rust tests on the filters (pure), the id round trip, and the updated `devices.rs` list test |
| S2 | Preview: the WGC user's window target (D3), `selected_screen_source` and `windows_screen_preview_backend` accept `window:wgc:`, resize, minimize, closed | Rust tests for the target/id plumbing and the resize bookkeeping (pure); the smoke from S7 on the laptop |
| S3 | Record and stream through the compositor bridge; `live_layout.rs:783-793` lets a `window:wgc:` switch through; the legacy FFmpeg graph refuses a window by name instead of drawing a test pattern | Rust tests for the live switch and the refusal; S7 |
| S4 | Hide screen sizing (D8) | A Rust test: a still for a cropped frame has the content size; `smoke:hide-screen:windows` with a window source |
| S5 | Renderer: the prefix, the Sources group, the source-row details (D5, D6, D9), and `window-source-rebind.ts` | Unit tests in `capture.test.ts` and the Sources components |
| S6 | D3D11 media path: a window input with a sub-rect copy contract and resize; the named fallback goes away for a window on the session's adapter | Rust tests on the copy contract; `smoke:windows-d3d11-media` with a window |
| S7 | `smoke:windows-window-capture`: a borderless fixture window (the one `smoke:hide-screen:windows` already uses) painted with a known colour code. It picks the window, records, resizes it mid-recording, minimizes and restores it, closes it, and reads the blocks back from the artifact with ffmpeg. Silent: no audio. | The smoke itself, on the laptop |

S1 to S5 make window capture work on the CPU compositor path. S6 makes it
fast. S0 comes first because D5 and D6 depend on it.

## Tests per layer

- **Rust, pure:** the window filter (visible, cloaked, tool, owned,
  titled, own process), the id parse and the stale-pid check, resize
  bookkeeping (when to recreate, what size to publish), the still size,
  the live-switch acceptance and the legacy refusal.
- **Rust, Windows CI:** the `devices.rs` list with a fake window, and the
  D3D11 copy contract for a sub-rect (S6).
- **Renderer:** the prefix helpers and the picker groups.
- **App smokes (laptop):** S7, `smoke:hide-screen:windows` with a window,
  `smoke:windows-d3d11-media` with a window (S6), and
  `pnpm smoke:recording-studio` before handing off any capture slice
  (AGENTS.md).

## Owner checks

Each has a default; the plan proceeds on the default unless the owner
says otherwise.

1. **Is this wanted now?** Default: yes, after #173's D3D11 work in flight
   (#1610, #1612, #1622) lands, so S6 builds on it.
2. **The id (D1).** Default `window:wgc:<hwnd>:<pid>`.
3. **CPU path first (D4).** Default yes.
4. **The border copy (D5)** if Windows keeps the border. Default: one line
   on the source row.
5. **App scenes on Windows.** Default: a later plan, not this one.

## Not covered here

- Region capture and whole-app capture.
- Capturing a window that is on another virtual desktop (cloaked, D2
  hides it).
- Anything Linux.

## Found on the way (not this plan)

- **The legacy ddagrab input drops the adapter.** A `screen:dxgi:<luid>:<n>`
  id becomes `ddagrab=output_idx=<n>` (`recording.rs:15606-15609`,
  `capture_input.rs:115-158`), and the Preview's `display_id` keeps only the
  output index (`preview_screen.rs:5094-5101`). FFmpeg's ddagrab creates its
  D3D11 device on the default adapter and looks the index up there
  (`libavfilter/vsrc_ddagrab.c` n8.0: `av_hwdevice_ctx_create(..., NULL, ...)`
  at `:876`, `IDXGIAdapter_EnumOutputs(dxgi_adapter, dda->output_idx, ...)`
  at `:203`). On a machine whose display hangs off a second adapter, the
  legacy path opens the wrong output or none. Only the legacy FFmpeg graph
  and the Preview's FFmpeg fallback use it (the compositor bridge and the
  D3D11 path go through WGC or Desktop Duplication on the right adapter).
- **A non-ScreenCaptureKit window id fails silently.** It never reaches the
  Windows "does not support window sources" message; it fails earlier as "No
  screen or window source is selected" (`preview_screen.rs:5060-5082`).
