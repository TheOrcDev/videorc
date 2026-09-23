# Real glass: accessibility, capture, and cost (plan 050, S7)

Date: 2026-09-23 · macOS 26.5.1 (Apple M4, built-in Retina display) · Electron
39.8.10 · branch `feat/real-glass`.

## Reduce Transparency and Increase Contrast

The renderer answers the OS settings through `prefers-reduced-transparency`
and `prefers-contrast` (`styles.css`). Reduce Transparency swaps both coats
for `--glass-solid`. Increase Contrast thickens the window coat, strengthens
hairlines and chip rims, and lifts the secondary text tier. When both are on,
Reduce Transparency wins: its block comes after the contrast block.

Claude did not flip the owner's System Settings. The media features were
emulated per window through CDP (`Emulation.setEmulatedMedia`), with region
captures over red, blue, and white backdrops. Transmission is the red-to-blue
colour distance through the glass. Contrast is the secondary text token over
the white-backdrop capture.

| Emulated setting    | Main transmission | Chat transmission | Secondary text over white |
| ------------------- | ----------------: | ----------------: | ------------------------: |
| None                |             24.04 |             24.76 |               6.03 / 5.97 |
| Reduce Transparency |              0.00 |              0.00 |               7.83 / 7.83 |
| Increase Contrast   |             16.97 |             16.28 |               6.69 / 6.69 |
| Both                |              0.00 |              0.00 |               7.83 / 7.83 |

- Reduce Transparency turns both windows fully solid (transmission 0).
- Increase Contrast keeps the glass but thickens it and raises contrast.
- The pinned-dark windows follow the same tokens, because the media queries
  cover `.dark` too.

Owner check (pending): toggle Reduce Transparency and Increase Contrast in
System Settings → Accessibility → Display with all five windows open. Each
window must turn solid or denser and stay readable. The OS also paints the
material itself solid under Reduce Transparency, which the emulation cannot
show.

## Theme round trip

`probe:ui-glass --gate` passes 12/12 samples in both themes. Its pinned-dark
check reads luminance over a white backdrop after the main window turns light.
Electron resets every window's appearance when `nativeTheme.themeSource`
changes, so main re-pins the dark-always windows after the theme IPC and on
`nativeTheme` `updated`. Chat, Captions, Notes, and Preview stay dark while
main is light.

## Fullscreen and minimize

- Native fullscreen hides the traffic lights. `useTrafficLightGutter()` then
  drops the 88 px gutter to `pl-3`. Detection is by size: a fullscreen window
  covers the whole screen, menu bar included, and a zoomed window never does.
  `window-frame.test.ts` pins that rule.
- Owner check (pending): enter fullscreen and minimize/restore each window.
  The glass must survive both, and in fullscreen the header text must not sit
  under the (hidden) lights.

## Captured windows

- **Display capture.** A display source records what the compositor shows:
  the same composited glass the probe's region captures measure.
- **Window capture.** A standalone ScreenCaptureKit tool captured the glass
  Chat window as a window source, using
  `SCContentFilter(desktopIndependentWindow:)`, the filter the backend's
  window sources use. The frame is opaque, neutral dark glass: mean
  rgb(31, 32, 33), alpha 255. The window region is not black or garbage.
  SCK composites the window without the desktop behind it, so the material
  reads as its dark base. With `VIDEORC_GLASS=0` the same capture is
  rgb(9, 9, 11).
- No per-capture solid mitigation is needed.
- Owner checkpoint 1 still covers a live session with Chat and Captions on
  stream.

## Cost: glass against `VIDEORC_GLASS=0`

All five windows are open and cascaded over the animated preview
(`VIDEORC_SMOKE_PREVIEW_MOTION=1`). This is the worst case for behind-window
blur, because every glass window re-blurs what the 60 fps preview draws under
it. After a 20 s settle, `top` is sampled once a second for 15 s. The runs
alternate modes so drift cancels. Sampling is read-only and never sends a
signal.

S7 run (after S7):

| Run | Mode  | WindowServer | App total | Electron main | Main renderer | Backend |
| --- | ----- | -----------: | --------: | ------------: | ------------: | ------: |
| 1   | glass |        62.7% |     21.3% |          9.6% |          3.5% |    4.6% |
| 2   | solid |        46.7% |     14.8% |          6.2% |          3.1% |    3.0% |
| 3   | glass |        47.1% |     18.5% |          8.0% |          4.0% |    3.7% |
| 4   | solid |        44.2% |     15.2% |          6.1% |          3.4% |    3.0% |

Confirmation run (S22, the finished branch):

| Run | Mode  | WindowServer | App total | Electron main | Main renderer | Backend |
| --- | ----- | -----------: | --------: | ------------: | ------------: | ------: |
| 1   | glass |        52.0% |     17.7% |          6.2% |          4.2% |    3.9% |
| 2   | solid |        61.3% |     22.7% |          8.9% |          4.8% |    5.2% |
| 3   | glass |        49.9% |     18.2% |          6.0% |          4.5% |    4.3% |
| 4   | solid |        56.9% |     23.3% |         10.1% |          4.7% |    4.7% |

- No measurable cost. Across all eight runs, WindowServer averages 52.9%
  with glass and 52.3% solid (+0.6 pp, inside the +3 pp budget). App CPU
  averages 18.9% with glass and 19.0% solid.
- Runs of the same mode vary by about ±10 pp: the arrangement of other
  apps' windows moves WindowServer more than the material does.
- Per-process CPU stays inside the plan's +5 pp budget in every run.
