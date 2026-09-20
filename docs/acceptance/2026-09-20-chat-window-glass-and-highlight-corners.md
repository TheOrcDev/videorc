# Chat window glass, highlight corners and card layout — acceptance

Date: 2026-09-20
Branch: `feat/chat-window-glass-highlight-corners`
Companion web change: `videorc-web` #24 (co-host question summaries and replies pinned to English).
Plan: vault `plans/planned/2026-09-20 - Videorc Chat Window Glass, Highlight Corners And English Co-host Plan.md`.

## What changed

- **Rename.** The detached Comments window is the **Chat** window everywhere a
  user can read it: OS window title, header, footer button, command palette,
  shortcuts (label and the `Chat` group), Library menu, Go Live dialog, toasts,
  row actions ("Show this message on the stream") and operator error strings.
  Identifiers, IPC channels (`comments-window:*`), RPCs (`comments.*`),
  `VIDEORC_COMMENTS_WINDOW`, `comments-window.json` and script names are
  unchanged. Historical changelogs and release docs are not rewritten.
- **Username beside the avatar.** In Chat rows the username was centred above
  the message: a highlightable row is a `Button`, and the `flex-1` name
  inherited its centred text. The name is now left-aligned next to the avatar.
  The on-stream card follows the same shape: an identity row (small avatar with
  the username beside it) and the message below at full card width.
- **Highlight corner.** The streamer picks top left, top right, bottom left or
  bottom right from the Chat window header (`Highlight position`). The pick is
  owned by main (`comments-window.json`, surfaced on `CommentsWindowState`), so
  highlights fired with the window closed (shortcut, deck, co-host) honour it.
  Changing the corner while a card is live moves the card (the same message is
  re-sent; the 10 s TTL restarts). Default: `bottom-left` (owner call after
  the first by-eye pass).
- **Compositor.** New wire enum `CommentHighlightAnchor` (kebab-case, default
  `bottom-left`); captions keep `CaptionOverlayPosition` and gain no corners. One
  layout oracle (`caption_overlay_layout_with_inset`) still serves the CPU
  blit, the Metal source placement and the Windows D3D11 layer transform. Side
  margin equals the vertical margin (4 % of canvas height). Captions yield to
  the card only when they share the vertical edge AND their x-ranges overlap.
  A retired `"position"` field is accepted and ignored.
- **Glass.** Chat and Captions windows are black glass on macOS: transparent
  backing, `GlassWallpaperUnderlay` and the specular sweep, with per-window
  wallpaper geometry from main. The duplicate `bg-background` coat on both
  window roots is gone. Off macOS, or with glass opted out, they keep the
  solid palette base.
- **Header alignment.** The header is a fixed 40 px strip and the traffic-light
  offset derives from one constant (`auxWindowChromeOptions`). The "Clear view
  keeps Library history." hint moved into the Clear view tooltip. Measured on
  an owner screenshot of the real window: lights, "Chat" and the badge share
  one centre line to within a fraction of a pixel, but the three 14 px lights
  end 74 px in, leaving the old 78 px gutter only ~5 px of air. The gutter is
  now 88 px (and the header title probe region moved with it).

## Evidence

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm --filter @videorc/desktop test` | 1690 passed, 1 skipped, 2 failed — both in `backendClient.test.ts` (1 s `vi.waitFor` on a dynamic import). Same two tests fail on a clean checkout of `origin/main` in 1 of 2 full runs and pass alone: pre-existing load flake, not from this branch. |
| `pnpm test:scripts` | 1370 passed, 0 failed |
| `cargo fmt --check --all` | pass |
| targeted `cargo test -p videorc-backend` (`comment_highlight`, `caption_`, `highlight`, `overlay`) | 14 + 43 + 21 + 45 (+1) passed, 0 failed |
| `cargo clippy -p videorc-backend -- -D warnings` | pass |
| `cargo build --release -p videorc-backend` | pass (23 warnings, none in touched code) |
| `cargo xwin check --target x86_64-pc-windows-msvc --tests` | pass (type-check only; not executed on Windows) |
| `pnpm probe:comments-window` | PASS, including the new checks: header reads `Chat`, glass underlay mounted, picker shows the default, main reports the pick, picker follows the pick, unknown corner normalises to the default |
| `pnpm smoke:comment-highlight-stream` | PASS — run 1: `top-left` + `bottom-right`; run 2 (after the default changed): `bottom-left` default (30 of 32 frames lean to that corner, captions coexist in 14) + `top-right` pick (30 of 31), legacy path at `bottom-left` (31 of 32) |
| `pnpm smoke:live-chat-fake-providers` | exit 0 (off-stream highlight with `anchor` is rejected explicitly) |
| `pnpm smoke:recording-studio` | gates 1–17 pass; gate 18 (`smoke:live-layout-switch-recording`) died on a missing import that is also broken on `main` — fixed in this branch and passing; remaining gates run individually, results on the PR |

Corner proof on the encoded stream files from the smoke run, re-judged against
the right and the wrong corner:

| Stream | Judged as | Card frames | Frames leaning to that corner | Verdict |
| --- | --- | --- | --- | --- |
| `stream-only` | `top-left` | 15 | 30 | pass |
| `stream-only` | `top-right` | 0 | 0 | fail (correct) |
| `split-record-stream` | `bottom-right` | 29 | 31 | pass |
| `split-record-stream` | `bottom-left` | 14 | 0 | fail (correct) |

The `bottom-left` row is why the analyzer gained the left/right dark-asymmetry
check: the caption bar is dark glass on the same edge, and the region scan
alone reported 14 "card" frames in the wrong corner.

By eye on extracted stream frames: the card sits in the picked corner with
equal side and top/bottom margins, the username is beside the avatar with the
message below, and in the `bottom-right` run the caption bar moved up above the
card instead of overlapping it.

## Not verified

- **Traffic-light gutter after the 88 px change** needs one more owner look
  (`capturePage` does not include the OS lights). Vertical alignment was
  confirmed on the owner's screenshot.
- **Glass with the real wallpaper.** The probe accepts the underlay or its
  solid fallback (the wallpaper needs the Automation grant). Needs an owner
  look next to the main window over the same wallpaper.
- **Idle GPU/CPU cost** of a second blurred layer while streaming: not
  measured.
- **Vertical (1080×1920) output** is covered by Rust layout and pixel tests,
  not by a recorded stream.
- **Windows**: compiled through xwin only.
- **Web**: `pnpm smoke:ai-cohost-live` (real model, Spanish fixture) not run.

## Owner checklist

- [ ] Header: lights, "Chat", badge and right-hand controls on one line.
- [ ] Chat and Captions windows match the main window's glass.
- [ ] Each of the four corners on a real stream; change the corner mid-highlight.
- [ ] Card reads well at 1080p and on a vertical output.
- [ ] Co-host drafts are English with non-English chat or notes (after web #24 deploys).
