# spike-text (plan 260 S0.5, WC-0.7)

**Question:** does GPUI's text stack carry Videorc's text: IME (Japanese,
Chinese), colour emoji, font fallback, selectable text, tabular numbers,
and a 10,000-row chat with inline animated WebP emotes that scrolls at
60 fps, costs at most 100 MB extra and paints first within 100 ms?

**Answer on macOS: yes, with four gaps that each have a known fix**
(verdicts below). Scrolling, memory, emoji, fallback, tabular numbers and
the IME path pass. First paint is about 11 ms over the line at the window
level, and the chat adds only about 15 ms of that. GPUI has no selectable
text and animates emotes wastefully; this spike shows the fix for both.

## Verdicts on macOS (2026-11-23)

The owner's M4 MacBook Pro, macOS 26, 120 Hz built-in display, release
build, load average 3 to 5 from other agents' builds and GUI runs.

| Check | Line | Result | Verdict |
| --- | --- | --- | --- |
| IME, Japanese and Chinese | Commits correctly | All 6 steps right: romaji `nihon` marked → kana `にほん` marked → `日本` committed; pinyin `zhong wen` marked → `中文` committed; an emoji-picker insert. `hasMarkedText` is true while composing, and the candidate rect sits at the input | **PASS** (the input method's calls, sent to GPUI's `NSTextInputClient` view; a session with the real Kotoeri and Pinyin needs those input sources, which this Mac doesn't have enabled) |
| Colour emoji | Draw in colour | Skin tones, ZWJ sequences (👩‍💻, 🧑🏿‍🚀), flags, ❤️ | **PASS** |
| Font fallback | No missing glyphs | Japanese, both Chinese scripts, Korean, Arabic and Hebrew (right to left, joined), Thai, Hindi, Greek and Cyrillic, from the system's fallbacks | **PASS, one gap:** Devanagari is measured narrower than it draws, so a shrink-to-fit box wraps it one word early |
| Selectable text | Select and copy | GPUI has none. The spike's `Selectable` (`StyledText` plus `TextLayout::index_for_position`, about 90 lines) selected across a wrapped line and over whole CJK characters, and ⌘C copied exactly the selection | **PASS** with our own element |
| Tabular numbers | Equal digit widths | `.SystemUIFont` at 15 px: `1111111111` 67.24 px and `8888888888` 93.46 px proportional, both 92.14 px with `tnum` | **PASS** |
| 10,000-row chat, scrolling | 60 fps | 24 pt a frame for 6 s: 119.7 fps, p95 8.42 ms, worst 19.5 ms, 1 frame of 718 over 16.7 ms, about 19,000 rows built (the same with timer-driven emotes: 119.3 fps, p95 8.48 ms) | **PASS** |
| Memory | ≤ 100 MB extra | Peak 105.4 MB with 10,000 rows, against 88.9 MB with none: **+16.5 MB** | **PASS** |
| First paint | ≤ 100 ms | Window open to first frame, 5 warm starts: 100.5 to 122 ms (median 110.8) with 10,000 rows, 92 to 96 ms with an empty chat. Reopening the full chat (`ListState::reset` on 10,000 rows) to the next frame: 10.6 to 16 ms. Process start to first frame: 152 to 178 ms | **MISS by about 11 ms** at the window level under load; the chat's own cost is within the line. S0.9 owns start-up against Electron |
| Animated WebP emotes | Animate inline | They draw and wrap inline. GPUI's `img` animates only with an element id, only in the active window, and then redraws the whole window every display frame: idle with emotes on screen, **63.7 % of a core at 120 redraws/s**. Frames swapped by an 80 ms timer (`--emotes timer`): **8.8 % at 11.4 redraws/s** | **Gap, fix shown:** an animated-image element in the kit that redraws at the image's own frame rate |

Process CPU averaged over a whole 31 s run (6 s of scrolling at 120 fps,
the rest mostly idle): 13.1 % of a core with still emotes, 20.2 % with
timer-driven emotes, 61.7 % with GPUI's animated `img`.
[summary.example.json](summary.example.json) is the `--emotes gpui
--no-inactive-cap` run.

## Found

- **GPUI caps an inactive window at about 30 fps**
  (`WindowOptions::inactive_frame_interval`). A scroll test in a window
  that had lost focus ran at exactly 30.0 fps; `--no-inactive-cap` sets it
  to `None`. Stream Manager and the chat pop-out usually run inactive while
  the streamer is elsewhere, so the app should choose this per window.
- **Animated images freeze in inactive windows** (GPUI's `img` checks
  `is_window_active`), and redraw at display rate in the active one. The
  kit's emote element should drive frames by a timer, as `--emotes timer`
  does, in any window.
- **No selectable text element in GPUI.** One message is easy (this spike).
  Selecting across chat rows, or across words laid out as separate
  elements, needs each message drawn as one `StyledText` with the emotes
  placed at glyph positions. That is a kit job for the chat screen.
- **Devanagari wraps one word early** in a shrink-to-fit box (`लाइव शुरू`
  / `करें`): its intrinsic width is under-measured. To report upstream with
  this sample; until then give such labels a definite width or no wrap.
- Driving IME calls from inside a GPUI `update` does nothing, and
  `Window::request_animation_frame` outside a render panics
  (`current_view` unwraps `None`). The spike sends the calls from outside
  any update, as AppKit does.

## Gaps against D13

D13 requires IME, colour emoji, inline emotes, selectable chat and Notes
text, and screen-reader names on all three platforms (spellcheck waits):

| D13 item | macOS state | Needs |
| --- | --- | --- |
| IME | GPUI's input path is right for Japanese and Chinese composition | A session with the real input methods (owner, or a contributor); Windows (WC-0.7: IMM32). Linux: Wayland passes; X11 needs the XIM patch (see Linux) |
| Colour emoji | Pass | Windows shots; Linux passes but for `❤️` (VS16) |
| Inline emotes | They draw and wrap inline; animation is wasteful | The kit's timer-driven animated image (small, no GPUI patch) |
| Selectable chat and Notes text | One block works (spike) | Chat rows as one `StyledText` each; Notes on the kit's input/editor (gpui-component, D3) |
| Screen-reader names | Not in this spike | S0.6 |

## Verdicts on Linux (ogre, 2026-11-24, lane L5)

ogre: Omarchy, Hyprland 0.56.2, fcitx5 5.1.23 with Mozc (Japanese) and
Pinyin. The owner's session was locked, so the spike ran in a **nested
Hyprland** (same build) on the lab output (`videorc-lab`, 1920 x 1080 at
**30 Hz**), with its own Xwayland for X11 and a **private fcitx5** (its own
D-Bus session with no activatable services, a copy of the config) connected
only to the nested display. Keys were typed into the nested compositor
only (`linux/ime-drive-*.sh` refuse any other target): `wtype` on Wayland,
`xdotool` on the nested Xwayland. Clocks flipped between 800 MHz (the T2
PROCHOT) and 4 GHz; each run's clock is given.

| Check | Line | Wayland (text-input-v3) | X11 (XIM, Xwayland) | Verdict |
| --- | --- | --- | --- | --- |
| IME, Japanese (Mozc) | Commits correctly | `nihon` composes `にほん` underlined inline, Space converts to `日本`, Enter commits it | Only with the GPUI fix below, plus fcitx5's on-the-spot style: `にほん` composes inline, converts to `日本`, commits | **Wayland PASS; X11 FAIL as shipped, PASS with a 9-line GPUI patch** |
| IME, Chinese (Pinyin) | Commits correctly | `zhongwen` composes `zhong wen`, Space commits `中文` | Same as Japanese: commits `中文` with the patch (inline composition needs on-the-spot) | Same |
| Candidate window | Sits at the input | GPUI sends the cursor rectangle (`set_cursor_rectangle`) and the XIM spot location; **no candidate window appeared in any screenshot of the nested compositor** | Same | **Unverified:** needs the owner's look on a real session |
| Colour emoji | Draw in colour | Skin tones, ZWJ sequences, the flag in colour; **`❤️` draws as a white text heart** (VS16 ignored) | Same text system | **PASS, one gap** |
| Font fallback | No missing glyphs | Japanese, both Chinese scripts, Korean, Arabic and Hebrew (right to left, joined), Thai, Hindi (shaped), Greek, Cyrillic | Same | **PASS** |
| Tabular numbers | Equal digit widths | `1111111111` 61.01 px and `8888888888` 92.80 px, **the same with `tnum`** | Same | **FAIL: cause found** (below) |
| 10,000-row chat, scrolling | 60 fps | Lab output (30 Hz): 30.0 fps, p95 33.5 ms. **A 60 Hz output: 48.7, 48.2 and 48.3 fps** (three runs), interval p50 20.5 ms, p95 22.6 to 22.9 ms, worst 33.6 ms, **at 800 MHz** | 30 Hz output: 30.0 fps. **60 Hz output: 29.9 fps**, p95 33.4 ms | **MISS at 800 MHz on Wayland; X11 held at 30.** Open: a run at the box's normal clock (expected to clear 60: 20.5 ms at a fifth of the clock), and why GPUI paces X11 at 30 Hz on Xwayland |
| Memory | +100 MB at most | 103.5 MB with 10,000 rows, 89.8 MB with none: **+13.7 MB** | 103.0 vs 89.5 MB: **+13.5 MB** | **PASS** |
| First paint | 100 ms | Window open to first frame: 144 ms at 4 GHz (`--emotes timer` run), 600 ms at 800 MHz | 131 to 156 ms at 4 GHz, 506 to 524 ms at 800 MHz | **MISS** (as on macOS; S0.9 owns start-up) |
| Animated emotes | Animate inline | GPUI's `img`: 61 % of a core at 30 redraws/s (800 MHz); timer-driven: 5.9 % at 12.6 redraws/s (4 GHz) | 63 % / 5.8 % | Same gap and fix as macOS |

The 60 Hz scroll runs (2026-11-24) used a temporary 1920 x 1080 at 60 Hz
headless output of the owner's Hyprland, removed after the runs. Every core
stayed pinned at 800 MHz (the T2 PROCHOT) for all of them, so they measure
GPUI at a fifth of the box's clock. **Two points stay open:** the 60 fps
line at normal clocks, and X11 (Xwayland) pacing at exactly 30 Hz on a
60 Hz output (the rate Xwayland reports to GPUI was not checked; ogre has
no `xrandr`).

Found on Linux:

- **GPUI's X11 XIM handshake breaks on focus.** `FocusIn` calls
  `enable_ime`, which sends `CreateIc` (and `FocusOut` sends `ResetIc`)
  with input method 0 while `Open` is still in flight. fcitx5 answers with
  an error that `zed-xim` cannot parse (`XIMClientError: Can't read xim
  message: Invalid Data`), GPUI drops XIM for the session, and every key
  goes in raw. [`linux/gpui-x11-xim-handshake.patch`](linux/gpui-x11-xim-handshake.patch)
  (against `gpui-pre-linux` 0.3.14, 9 lines) skips both until the
  handshake has finished; with it the handshake completes, and Pinyin and
  Mozc commit through XIM. The same code is in Zed's `gpui_linux`, so it
  goes upstream. It was tested through a local `[patch.crates-io]`, not
  added to this workspace.
- **GPUI never sends `XIM_SET_IC_FOCUS`.** fcitx5 learns which context is
  focused only from the first key, so an input method switched before any
  key (`fcitx5-remote -s`) applies to no context. A small addition to the
  same patch.
- **fcitx5's XIM frontend draws composition in its own window by default**
  (over the spot). GPUI asks for `PREEDIT_CALLBACKS`; with fcitx5's
  `UseOnTheSpot=True` the composition shows inline in GPUI's input, as on
  Wayland.
- **`.SystemUIFont` is "IBM Plex Sans" on Linux** (hard-coded in
  `gpui-pre-linux`), which Omarchy does not ship. cosmic-text then picks a
  fallback face, and GPUI loads fallback faces with **empty font features**
  (`cosmic_text_system.rs`, `font_id_for_cosmic_id`), so `tnum` is lost.
  The kit should name the font Videorc bundles on Linux, never
  `.SystemUIFont`; with a named, installed family the features are passed
  through (not measured here).
- `wtype` cannot type into X11 windows on Xwayland (its keymap does not
  carry over); `xdotool` on the nested Xwayland does.

Linux flags: `--ime-wait <ms>` pauses the script for typing with the real
input method and records every change of the committed and composing text
in `ime_observed`; `SPIKE_LOG=info|debug` prints GPUI's own log lines
(the XIM and text-input handshakes).

## What it does

One window (1650 × 962; smaller screens clamp it):

- **Left:** a text input (GPUI's own `examples/input.rs`, Apache-2.0, in
  [`src/input.rs`](src/input.rs): `EntityInputHandler`, marked text,
  `bounds_for_range` for the candidate window), a line saying what is
  committed and what is still composing, ten script and emoji samples, the
  same numbers set proportional and tabular (`tnum`), and a selectable
  paragraph.
- **Right:** the chat, GPUI's `list()` over `--rows` rows (default 10,000):
  a coloured name and a message whose words and 28 pt animated WebP emotes
  wrap inline (each word and emote is its own element in a wrapping row).
  The six emotes in [`assets/`](assets/) are generated (12 frames, 56 px,
  lossless), not anyone's art.
- **Selectable text:** GPUI has no selectable text element, so the spike
  has the smallest one: `StyledText` for layout, its `TextLayout` to map
  the mouse to a character index, a highlight for the selection, ⌘C to
  copy.

Then it runs a script and writes the summary:

1. Measures the width of `1111111111` and `8888888888` with and without
   `tnum` in the window's font.
2. `--simulate-ime` (macOS): sends the input the calls an input method
   sends (`setMarkedText:…`, `insertText:…`, `firstRectForCharacterRange:…`)
   through GPUI's own `NSTextInputClient` view, as Kotoeri (Japanese,
   Romaji) and Pinyin do, and checks the committed and composing text after
   each.
3. `--scroll-test`: scrolls the chat by `--step` points (default 24) once
   per frame for 6 s and records every frame interval.
4. Five idle seconds with emotes on screen: CPU and redraws.
5. Resets the whole chat (as opening the chat page would) and times the
   next frame.

| Flag | Meaning |
| --- | --- |
| `--rows <n>` | Chat rows (default 10,000; 0 for the memory baseline) |
| `--emotes gpui` / `--emotes timer` | GPUI's animated `img` (default), or frames swapped by an 80 ms timer |
| `--no-inactive-cap` | Lift GPUI's 30 fps cap for inactive windows |
| `--step <pt>` | Scroll per frame in the scroll test (default 24) |

`SPIKE_START_DELAY_MS` (default 800) delays the script so a driver can
bring the window to the front first.

## Run it

```sh
cd spikes/gpui
cargo build --release -p spike-text
cargo run --release -p spike-text -- --seconds 25 --scroll-test --simulate-ime
cargo run --release -p spike-text -- --seconds 15 --rows 0    # the memory baseline
```

`--rows 0` gives the memory baseline; the 10,000-row run's `peak_rss_mb`
minus it is the chat's cost. Keep the window in front during the scroll
test (`frames_with_window_active` in the summary says whether it was), or
pass `--no-inactive-cap`.

**On Windows (WC-0.7) and Linux (L5)** `--simulate-ime` is macOS only:
type into the input with the real IME instead (Microsoft IME Japanese and
Pinyin on Windows; fcitx5 on Wayland and XIM on X11), and check that the
composing text shows underlined, the candidate window sits under it, and
Enter commits it.

## Summary fields

The common fields, plus `renders`, `ui_redraws_per_second_idle`,
`startup_to_first_paint_ms`, and this spike's own (in
[SUMMARY.md](../SUMMARY.md)): `chat_rows`, `chat_data_ms`,
`chat_rows_built`, `chat_remount_to_frame_ms`,
`window_open_to_first_paint_ms`, `emotes`, `scroll`, `ime_steps`,
`numbers`, `idle_with_emotes`, `selected_text`.
